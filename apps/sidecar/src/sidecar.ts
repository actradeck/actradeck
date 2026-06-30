/**
 * Sidecar — Phase2 の配線をまとめる組み立て役。
 *
 *   HookReceiver ──┐
 *   ManagedRunner ─┼─► EventSink (redact→parse→persist) ─► EventStore ─► WsClient ─► backend/sink
 *   GitWatcher ────┘                                            ▲
 *                                                  ApprovalBridge ◄── WsClient.approval (UI 決定)
 */
import { randomBytes } from "node:crypto";

import { generateRedactedDiff } from "./diff-provider.js";
import { findRepoRoot, GitWatcher } from "./git-watcher.js";
import { HookReceiver } from "./hook-receiver.js";
import { ApprovalBridge } from "./approval-bridge.js";
import { buildApprovalPersistConfig } from "./approval-persist-config.js";
import { buildBridgePolicyOptions } from "./approval-policy-store.js";
import { buildAllowlistResponse } from "./allowlist-relay.js";
import { buildPolicyResponse } from "./policy-relay.js";
import { SessionIdentity } from "./session-identity.js";
import { generateHookToken } from "./settings-injection.js";
import { EventSink, type OutOfOrderObservation } from "./sink.js";
import { EventStore } from "./store.js";
import { startManagedClaude, type ManagedSession } from "./managed-runner.js";
import { startManagedCodex, type CodexManagedSession } from "./codex-runner.js";
import { WsClient } from "./ws-client.js";

export interface SidecarOptions {
  /**
   * fallback / ローカル相関 id (= ACTRADECK_SESSION、または CLI 自動採番 `sess_<id>`)。
   * canonical 確定前の暫定 session_id 兼、hook 皆無経路の last-resort (ADR 019e9462 降格)。
   */
  readonly sessionId: string;
  /**
   * ADR 019e9462: `sessionId` が **外部明示指定** (ACTRADECK_SESSION / テスト / Attach) のとき true。
   * true → SessionIdentity を即確定モードにし、learn を待たず canonical=sessionId で固定する
   *        (既存テスト/Attach/egress-handshake の sessionIds:["s1"] 等を温存)。
   * false / 未指定 → CLI 自動採番とみなし learn (hook session_id) を待つ。確定前の監視イベントは
   *        hold され、タイムアウトで fallback (sessionId) へ flush される。
   */
  readonly explicitSession?: boolean;
  /**
   * ADR 019e9462: canonical 確定タイムアウト (ms)。hook が来ないまま経過したら hold buffer を
   * fallback id で flush し永久 hold を避ける。既定 30s。explicitSession 時は無視 (即確定)。
   */
  readonly sessionResolveTimeoutMs?: number;
  readonly wsUrl: string;
  readonly dbPath: string;
  readonly cwd?: string;
  readonly host?: string;
  readonly hookPort?: number;
  readonly approvalTimeoutMs?: number;
  /**
   * SEC-2 (egress): backend ingestion (/ingest/ws) の Bearer 認証トークン (env: INGEST_TOKEN 由来)。
   * WsClient へ渡し upgrade リクエストの Authorization ヘッダに載せる。未設定なら無認証接続
   * (本番 backend は 401)。値はログ・throw に出さない。
   */
  readonly ingestToken?: string;
  readonly onHook?: (eventName: string) => void;
  readonly onValidationError?: (eventType: string, message: string) => void;
  /** 3#QA-2: out-of-order 観測フック (INV-EVENT-ORDER 可視化)。 */
  readonly onOutOfOrder?: (obs: OutOfOrderObservation) => void;
  /** L2(b) (decision 019f0e5d): 承認 disk-write 失敗の operator 可視化フック (件数のみ・NO-RAW)。 */
  readonly onPersistFailure?: (count: number) => void;
}

export class Sidecar {
  readonly store: EventStore;
  readonly wsClient: WsClient;
  readonly sink: EventSink;
  readonly approvalBridge: ApprovalBridge;
  readonly hookReceiver: HookReceiver;
  /** ADR 019e9462: session 識別の権威 (learn-once canonical + early-event hold/flush)。 */
  readonly identity: SessionIdentity;
  /** SEC-3: per-launch hook 認証トークン (settings へ注入し receiver で照合)。 */
  private readonly hookToken: string;
  /** 3#SEC-1: per-session 制御チャネルトークン (inbound approval/interrupt の認証)。 */
  private readonly controlToken: string;
  private gitWatcher: GitWatcher | undefined;
  /**
   * 段階2 (ADR 019ea4ba D2-B): diff 本文 on-demand 生成の repo root。start() で findRepoRoot
   * により確定し、diff.request 受信時に都度 git diff を生成する。git 管理外なら undefined
   * (diff 要求には空 body で応答)。
   */
  private repoRoot: string | undefined;
  private managed: ManagedSession | undefined;
  /** Codex managed セッション (provider=codex のとき)。interrupt は turn/interrupt を使う。 */
  private managedCodex: CodexManagedSession | undefined;
  private readonly opts: SidecarOptions;

  constructor(opts: SidecarOptions) {
    this.opts = opts;
    this.hookToken = generateHookToken();
    // 3#SEC-1: 制御チャネルトークンを暗号乱数で発行 (32 byte = 256bit)。backend ハンドシェイク
    // 確立まで peer は知り得ない → inbound approval/interrupt は実質全破棄 (fail-safe deny)。
    this.controlToken = randomBytes(32).toString("base64url");
    this.store = new EventStore(opts.dbPath);

    // ADR 019e9462: session 識別の権威。明示指定 (ACTRADECK_SESSION/テスト/Attach) なら即確定、
    // CLI 自動採番なら learn (最初の hook session_id) を待ち、確定前の監視イベントを hold する。
    this.identity = new SessionIdentity({
      fallbackSessionId: opts.sessionId,
      ...(opts.explicitSession === true ? { explicitSessionId: opts.sessionId } : {}),
      ...(opts.explicitSession === true
        ? {}
        : { flushTimeoutMs: opts.sessionResolveTimeoutMs ?? 30_000 }),
    });

    this.wsClient = new WsClient({
      url: opts.wsUrl,
      store: this.store,
      controlToken: this.controlToken,
      // ADR 019f1582 follow-up: managed sidecar は policyRequest を処理する (buildPolicyResponse) ゆえ
      // policy 対応を広告する (attach と対称・connectedDaemons に含める)。
      policyCapable: true,
      // ADR 019e9462: hello は送信時点で canonical を動的解決する (未確定時は fallback)。
      // 確定前に hello を送っても backend は ingest 流の observeSession で canonical 所有を
      // 学習するため relay は壊れない。
      sessionIdsProvider: () => [this.identity.currentSessionId()],
      // SEC-2 (egress): env 由来の Bearer トークン (未設定なら付けない = 後方互換)。
      ...(opts.ingestToken !== undefined && opts.ingestToken.length > 0
        ? { ingestToken: opts.ingestToken }
        : {}),
    });
    this.approvalBridge = new ApprovalBridge({
      ...(opts.approvalTimeoutMs !== undefined ? { timeoutMs: opts.approvalTimeoutMs } : {}),
      // ADR 019ee0c0: 承認の再起動跨ぎ永続化。env 既定 OFF (ACTRADECK_PERSIST_APPROVALS で opt-in)。
      persist: buildApprovalPersistConfig(),
      // ADR 019f0c3e: bypass/YOLO の high-risk カテゴリ承認ポリシー (既定 ON・既定プリセット・
      //   ACTRADECK_BYPASS_CATASTROPHIC_GATE=0 で純パススルー)。memory-authoritative (起動時 once load)。
      //   Phase 2: file-level + env を分離して渡し、認証済 relay の setPolicyConfig が memory+disk 追従する。
      ...buildBridgePolicyOptions(),
      // L2(b): persist 失敗 (allowlist/policy disk-write) を operator へ件数のみ surface。
      ...(opts.onPersistFailure !== undefined ? { onPersistFailure: opts.onPersistFailure } : {}),
    });
    this.sink = new EventSink({
      store: this.store,
      wsClient: this.wsClient,
      ...(opts.onValidationError !== undefined
        ? { onValidationError: opts.onValidationError }
        : {}),
      ...(opts.onOutOfOrder !== undefined ? { onOutOfOrder: opts.onOutOfOrder } : {}),
    });
    this.hookReceiver = new HookReceiver({
      sink: this.sink,
      approvalBridge: this.approvalBridge,
      // ADR 019e9462: 検証済み hook の session_id を learn-once で canonical 確定する。
      identity: this.identity,
      authToken: this.hookToken,
      ...(opts.host !== undefined ? { host: opts.host } : {}),
      ...(opts.hookPort !== undefined ? { port: opts.hookPort } : {}),
      ...(opts.onHook !== undefined ? { onHook: opts.onHook } : {}),
    });

    // UI からの承認決定を承認ブリッジへ中継。
    // SEC-2: resolve は自 sidecar の sessionId スコープの request_id のみ受理する。
    // foreign / unknown request_id は ApprovalBridge.resolve が false を返し無視される。
    // 3#SEC-1: WsClient が token 検証済みのメッセージのみ emit する。さらに decision を
    //   T1 ApprovalDecision (4 値) で enum 検証し、enum 外 (型崩れ・任意文字列) は破棄する。
    // 段階③: allow_for_session/cancel を honor (allow_for_session→allow+署名登録、cancel→deny)。
    this.wsClient.on(
      "approval",
      (msg: { request_id: string; decision: unknown; reason?: string; persist?: unknown }) => {
        if (typeof msg.request_id !== "string") return;
        if (
          msg.decision !== "allow" &&
          msg.decision !== "allow_for_session" &&
          msg.decision !== "deny" &&
          msg.decision !== "cancel"
        ) {
          return; // enum 外は破棄 (fail-safe)
        }
        // ADR 019ee0c0: persist は boolean のときのみ honor (型崩れは false 扱い=fail-safe)。
        const persist = msg.persist === true;
        this.approvalBridge.resolve(msg.request_id, msg.decision, msg.reason, persist);
      },
    );
    // SEC-2: interrupt は **自セッション宛のみ** managed を stop する。
    // msg.session_id が自 sidecar の sessionId と一致しない (foreign) / 欠落は無視 (reject)。
    // 他セッションの停止要求で無関係なプロセスを巻き込まない (sidecar.md: PID 限定)。
    this.wsClient.on("interrupt", (msg: { session_id?: string }) => {
      // ADR 019e9462: UI は canonical session_id で interrupt を中継する。canonical (確定後) /
      // fallback (= ローカル相関 id) のいずれかに一致する自セッション宛のみ受理する。
      // session_id 欠落 / どちらにも一致しない foreign は無視 (sidecar.md: PID 限定で
      // 無関係 PID を巻き込まない)。canonical 未確定時の undefined と msg 欠落の undefined が
      // 偶然一致しないよう、まず msg.session_id の存在を確認する。
      if (typeof msg.session_id !== "string") return; // session_id 欠落 → reject
      const canonical = this.identity.resolvedSessionId();
      if (msg.session_id !== this.identity.fallbackId && msg.session_id !== canonical) return;
      // Codex は turn/interrupt (協調的中断) を優先。claude は PID 限定 SIGINT。
      if (this.managedCodex !== undefined) {
        this.managedCodex.interrupt();
      } else {
        this.managed?.stop("SIGINT");
      }
    });

    // 段階2 (ADR 019ea4ba D2-B): diff 本文要求。WsClient が controlToken 検証済みのもののみ
    // emit する。さらに **自セッション宛のみ** 応答する (interrupt と同じ PID/session スコープ:
    // foreign session の diff を盗み見させない)。生成→redactDeep 透過→サイズ切詰めは
    // diff-provider が担い (唯一の choke + truncation-after-redaction)、本ハンドラは
    // 生 diff を一切組み立てない・永続しない (pull-only・at-rest なし)。
    this.wsClient.on("diffRequest", (msg: { request_id?: string; session_id?: string }) => {
      void this.handleDiffRequest(msg);
    });

    // PAL-v2 (ADR 019ee147): allowlist list/revoke 要求。controlToken 検証済みのみ emit される。
    // allowlist は machine-global ゆえ attach と同一の buildAllowlistResponse を共有 (NO-RAW 単一出所)。
    // diff と違い session スコープ判定は不要 (entries は session 非依存・生コマンド非含)。
    this.wsClient.on("allowlistRequest", (msg) => {
      const res = buildAllowlistResponse(this.approvalBridge, msg);
      if (res !== undefined) this.wsClient.respondAllowlist(res);
    });

    // ADR 019f0c3e Phase 2: 承認ポリシー get/set 要求。controlToken 検証済みのみ emit される。
    // policy は machine-global ゆえ attach と同一の buildPolicyResponse を共有 (closed-enum NO-RAW 単一出所)。
    this.wsClient.on("policyRequest", (msg) => {
      // TDA-R3-1 (decision 019f0e2d): crash 防止の最終 net は WsClient.handleInbound の構造 backstop。
      // この per-handler try/catch の主目的は **graceful error 応答** — 想定外 throw 時に request_id へ
      // error を返し backend の timeout 待ちを避ける (diff handler と同方針)。setPolicyConfig は disk 失敗を
      // safePersist で吸収済ゆえ通常ここには到達しない。op="resolve" は async (findRepoRoot) ゆえ await。
      void (async () => {
        try {
          const res = await buildPolicyResponse(this.approvalBridge, msg);
          if (res !== undefined) this.wsClient.respondPolicy(res);
        } catch {
          if (typeof msg.request_id === "string" && msg.request_id.length > 0) {
            this.wsClient.respondPolicy({
              type: "policy.response",
              request_id: msg.request_id,
              enabled: false,
              categories: [],
              env_gate_enabled: true,
              error: "policy request failed",
            });
          }
        }
      })().catch(() => {
        // SEC-2 (decision 019f0f2f): 構造 backstop (WsClient.handleInbound の同期 try/catch) は async IIFE の
        // 本体/catch を覆わない (microtask は handleInbound 復帰後に走る)。catch 内 respondPolicy 等が throw
        // すると void では unhandledRejection が escape する。この .catch が非同期版の最終 net — daemon は
        // 落とさない (deny-safe)。managed は onFatal 経由だが本 net で異常終了自体を未然に防ぐ。
      });
    });
  }

  /**
   * 段階2: diff 本文要求を処理する。自セッション宛かを検証し、repo の redaction 済み diff を
   * 生成して egress WS で返す。request_id 欠落 / foreign session は黙殺 (応答しない)。
   * 例外時も raw を載せない安全側の空応答に倒す。
   */
  private async handleDiffRequest(msg: {
    request_id?: string;
    session_id?: string;
  }): Promise<void> {
    if (typeof msg.request_id !== "string" || msg.request_id.length === 0) return;
    // 自セッション宛のみ (interrupt と同じスコープ)。canonical / fallback いずれかに一致必須。
    if (typeof msg.session_id !== "string") return;
    const canonical = this.identity.resolvedSessionId();
    if (msg.session_id !== this.identity.fallbackId && msg.session_id !== canonical) return;
    try {
      const result = await generateRedactedDiff(this.repoRoot ?? "");
      this.wsClient.respondDiff({
        type: "diff.response",
        request_id: msg.request_id,
        body: result.body,
        truncated: result.truncated,
        secret_detected: result.secretDetected,
        redaction_count: result.redactionCount,
      });
    } catch {
      // 生成失敗時も raw を出さず空応答 (UI は「差分なし/取得失敗」を表示)。
      this.wsClient.respondDiff({
        type: "diff.response",
        request_id: msg.request_id,
        body: "",
        truncated: false,
        secret_detected: false,
        redaction_count: 0,
      });
    }
  }

  /** SEC-3: hook receiver が要求する per-launch 認証トークン (Managed が settings へ注入)。 */
  get hookAuthToken(): string {
    return this.hookToken;
  }

  /**
   * 3#SEC-1: inbound 制御チャネル (approval/interrupt) の認証トークン。
   * backend ハンドシェイクで共有する想定 (現状は未共有 = inbound 制御は全破棄)。
   */
  get controlAuthToken(): string {
    return this.controlToken;
  }

  /** hook receiver を起動し WS 接続を開始。endpoint を返す。 */
  async start(): Promise<{ hookEndpoint: string }> {
    await this.hookReceiver.listen();
    this.wsClient.connect();

    // git diff watcher: repo root を特定できれば起動。
    const root = await findRepoRoot(this.opts.cwd ?? process.cwd());
    // 段階2: diff 本文 on-demand 生成のため repo root を保持する (watcher と同じ root)。
    this.repoRoot = root;
    if (root) {
      this.gitWatcher = new GitWatcher({
        // ADR 019e9462: 固定 id を bake せず emit 時に canonical を解決 (未確定なら hold)。
        identity: this.identity,
        repoRoot: root,
        onEvent: (ev) => this.sink.emit(ev),
      });
      this.gitWatcher.start();
      // 起動直後に 1 回スナップショット (初期差分を確定)。
      void this.gitWatcher.captureAndEmit();
    }

    return { hookEndpoint: this.hookReceiver.endpoint };
  }

  /** Managed claude を起動する。 */
  startManaged(claudeArgs: readonly string[], claudeBin?: string): ManagedSession {
    this.managed = startManagedClaude({
      sink: this.sink,
      hookEndpoint: this.hookReceiver.endpoint,
      hookToken: this.hookToken,
      // ADR 019e9462: heartbeat / PTY output は emit 時に canonical を解決 (未確定なら hold)。
      identity: this.identity,
      claudeArgs,
      ...(claudeBin !== undefined ? { claudeBin } : {}),
      ...(this.opts.cwd !== undefined ? { cwd: this.opts.cwd } : {}),
    });
    return this.managed;
  }

  /**
   * Managed codex (app-server) を起動する (ADR 019ea31b)。
   * provider=codex 分岐。承認ブリッジ・SessionIdentity・sink を Claude と同じ配線で共有する
   * (canonical=thread.id を SessionIdentity.learn で即確定)。
   */
  startManagedCodex(
    opts: {
      codexBin?: string;
      initialPrompt?: string;
      onDiagnostic?: (msg: string) => void;
    } = {},
  ): CodexManagedSession {
    this.managedCodex = startManagedCodex({
      sink: this.sink,
      approvalBridge: this.approvalBridge,
      identity: this.identity,
      ...(opts.codexBin !== undefined ? { codexBin: opts.codexBin } : {}),
      ...(opts.initialPrompt !== undefined ? { initialPrompt: opts.initialPrompt } : {}),
      ...(this.opts.cwd !== undefined ? { cwd: this.opts.cwd } : {}),
      ...(opts.onDiagnostic !== undefined ? { onDiagnostic: opts.onDiagnostic } : {}),
    });
    return this.managedCodex;
  }

  /** graceful shutdown: watcher 停止 → 未送信 flush 試行 → close。 */
  async shutdown(): Promise<void> {
    this.managed?.dispose();
    this.managedCodex?.dispose();
    await this.gitWatcher?.stop();
    // ADR 019e9462: 未確定で hold したままの監視イベントを fallback id で flush して取りこぼさない
    // (タイマー停止 + held → sink.emit。INV-REDACTION: flush も sink.emit を通る)。
    this.identity.dispose();
    this.approvalBridge.drain();
    await this.hookReceiver.close();
    // 未送信があれば最後の flush 機会を与える (接続中なら notify で送る)。
    this.wsClient.notifyAppended();
    this.wsClient.close();
    this.store.close();
  }
}
