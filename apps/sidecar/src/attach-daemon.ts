/**
 * attach-daemon — Attach Mode の常駐 daemon (ADR 019ea476 D1/D3/D4/D6/D7)。
 *
 * 単一 daemon = 単一 egress WS = 複数 attach session の多重観測。Managed の `Sidecar` と異なり
 * **CC を spawn しない** (起動を所有しない)。安定 hook endpoint へ CC の settings を配線し、
 * 以降この scope で起動・継続する CC を hooks 経由で後付け capture する。起動所有ではないため
 * stop/kill は no-op だが、Claude Code hook 応答による approval relay とは直交する。
 *
 *   HookReceiver(authToken 必須) ─► EventSink (redact→parse→persist) ─► EventStore ─► WsClient ─► backend
 *   AttachSessionRegistry(per-session identity/GitWatcher) ─┘
 *
 * 不変条件:
 * - INV-ATTACH-HOOK-AUTH: HookReceiver は authToken 必須で構築する (requireAuthToken=true)。
 * - INV-ATTACH-NO-KILL: interrupt 要求が来ても **非所有 PID を kill しない** (no-op + 観測)。
 *   managed runner を一切保持しないため stop/kill 経路が構造的に存在しない。
 * - INV-ATTACH-REDACTION: 全 emit (hook 正規化 / git diff) は sink.emit choke を通る。
 * - INV-ATTACH-MULTIPLEX: registry が session_id ごとに独立 identity/projection を持つ。
 */
import { randomBytes, randomUUID } from "node:crypto";

import {
  APPROVAL_DECISIONS,
  parseCodexSpawnRequest,
  type ApprovalDecision,
  type CodexSpawnResult,
} from "@actradeck/event-model";

import { computeAgentVisibilityWire } from "./agent-visibility.js";
import { AttachSessionRegistry } from "./attach-session-registry.js";
import { ApprovalBridge } from "./approval-bridge.js";
import { buildApprovalPersistConfig, makeRepoScopeResolver } from "./approval-persist-config.js";
import { buildBridgePolicyOptions } from "./approval-policy-store.js";
import { CodexSpawnManager } from "./codex-spawn-manager.js";
import { buildAllowlistResponse } from "./allowlist-relay.js";
import { buildPolicyResponse } from "./policy-relay.js";
import { generateRedactedDiff } from "./diff-provider.js";
import { buildEvent } from "./event-factory.js";
import { HookReceiver } from "./hook-receiver.js";
import { generateHookToken } from "./settings-injection.js";
import { EventSink, type OutOfOrderObservation } from "./sink.js";
import { EventStore } from "./store.js";
import { daemonCountersFromBridge, pendingIdsFromBridge, WsClient } from "./ws-client.js";

export interface AttachDaemonOptions {
  readonly wsUrl: string;
  readonly dbPath: string;
  readonly host?: string;
  readonly hookPort?: number;
  readonly approvalTimeoutMs?: number;
  /** backend ingestion (/ingest/ws) の Bearer トークン (env: INGEST_TOKEN)。値はログに出さない。 */
  readonly ingestToken?: string;
  /** literal token-mode で settings に書く nonce を上書き (省略時は crypto 採番)。 */
  readonly hookToken?: string;
  readonly onHook?: (eventName: string) => void;
  readonly onValidationError?: (eventType: string, message: string) => void;
  readonly onOutOfOrder?: (obs: OutOfOrderObservation) => void;
  /** interrupt 要求の観測フック (no-kill を可視化, INV-ATTACH-NO-KILL)。 */
  readonly onInterruptIgnored?: (sessionId: string | undefined) => void;
  /**
   * ADR 019f4206 A段: cockpit からの Codex Managed spawn を許可するか (契約点2)。既定は
   * `ACTRADECK_ENABLE_CODEX_SPAWN==="1"` (out-of-box OFF)。false のとき spawn_capable を広告せず、
   * 受信しても値ベース spawn_disabled deny (attach daemon の観測専念を壊さない)。
   */
  readonly enableCodexSpawn?: boolean;
  /** ADR 019f4206: 同時 managed codex 数の cap (既定 ACTRADECK_CODEX_SPAWN_MAX or DEFAULT_CODEX_SPAWN_MAX)。 */
  readonly codexSpawnMax?: number;
  /** spawn 要求の観測フック (診断のみ・NO-RAW: 成否 boolean + closed enum code のみ・prompt/cwd 非含)。 */
  readonly onSpawnHandled?: (ok: boolean, code?: string) => void;
  /** L2(b) (decision 019f0e5d): 承認 disk-write 失敗の operator 可視化フック (件数のみ・NO-RAW)。 */
  readonly onPersistFailure?: (count: number) => void;
  /**
   * idle reaper の idle-TTL (ms)。省略時 registry 既定 (DEFAULT_ATTACH_IDLE_TTL_MS=30min)。
   * env ACTRADECK_ATTACH_IDLE_TTL_MS から cli が解決 (QA-2 / ADR 019eb448, 誤 reap 窓の運用調整)。
   */
  readonly idleTtlMs?: number;
  /** idle sweep 間隔 (ms)。0 で無効。省略時 registry 既定 (DEFAULT_ATTACH_REAPER_INTERVAL_MS=60s)。 */
  readonly reaperIntervalMs?: number;
  /** AttachSessionRegistry の注入 (テスト用)。onGitEvent は capture_mode=attach + sink.emit 済。 */
  readonly registryFactory?: (
    onGitEvent: (ev: ReturnType<typeof buildEvent>) => void,
  ) => AttachSessionRegistry;
}

export class AttachDaemon {
  readonly store: EventStore;
  readonly wsClient: WsClient;
  readonly sink: EventSink;
  readonly approvalBridge: ApprovalBridge;
  readonly hookReceiver: HookReceiver;
  readonly registry: AttachSessionRegistry;
  /** ADR 019f4206 A段: cockpit-relayed Codex Managed spawn の in-process manager (契約点1)。 */
  readonly spawnManager: CodexSpawnManager;
  /** literal token-mode で settings に配線する hook 認証トークン (nonce, 再起動で rotation)。 */
  private readonly hookToken: string;
  /** inbound 制御チャネルトークン (approval は honor、interrupt は no-kill)。 */
  private readonly controlToken: string;
  /**
   * ADR 0014 Phase 4 (decision 019fd705 D5): daemon プロセスの runtime epoch (起動時採番・寿命内不変)。
   * hello の runtime_epoch に載せる (診断用・credential でない・NO-RAW uuid のみ)。
   */
  private readonly runtimeEpoch: string = randomUUID();
  private readonly onInterruptIgnored: ((sessionId: string | undefined) => void) | undefined;
  private readonly onSpawnHandled: ((ok: boolean, code?: string) => void) | undefined;
  private started = false;

  constructor(opts: AttachDaemonOptions) {
    this.hookToken =
      opts.hookToken !== undefined && opts.hookToken.length > 0
        ? opts.hookToken
        : generateHookToken();
    this.controlToken = randomBytes(32).toString("base64url");
    this.onInterruptIgnored = opts.onInterruptIgnored;
    this.onSpawnHandled = opts.onSpawnHandled;
    // ADR 019f4206 契約点2: codex spawn は既定 OFF (out-of-box 安全)。env opt-in か明示 option でのみ有効。
    const enableCodexSpawn =
      opts.enableCodexSpawn ?? process.env.ACTRADECK_ENABLE_CODEX_SPAWN === "1";
    this.store = new EventStore(opts.dbPath);

    this.wsClient = new WsClient({
      url: opts.wsUrl,
      store: this.store,
      controlToken: this.controlToken,
      // ADR 019f1582 follow-up: attach daemon は policyRequest を処理する (下記 wsClient.on("policyRequest"))
      // ゆえ policy 対応を広告し、backend の connectedDaemons に含めて daemon-addressed policy 設定を受ける。
      policyCapable: true,
      // ADR 019f4206 契約点2: spawn 有効時のみ spawn_capable を広告 (既定 OFF = 非広告・out-of-box 安全)。
      spawnCapable: enableCodexSpawn,
      // hello.session_ids = 観測中の全 attach canonical + spawn した managed codex の canonical (ADR D1: 複数可)。
      sessionIdsProvider: () => [
        ...this.registry.sessionIds(),
        ...this.spawnManager.activeSessionIds(),
      ],
      // ADR 019f1972 §2b: agent 観測可能性を hello に相乗り (machine-global・fresh per send・fail-safe)。
      agentVisibilityProvider: () => computeAgentVisibilityWire(),
      // ADR 0014 Phase 4 (decision 019fd705 D5): daemon プロセスの runtime epoch + 生存 pending 宣言。
      // approvalBridge は本コンストラクタで後続生成されるため provider は遅延参照する (hello 送出は
      // connect 後 = 構築完了後のみ)。未生成ガードは防御的 (構造上到達しない)。
      runtimeEpoch: this.runtimeEpoch,
      pendingApprovalIdsProvider: pendingIdsFromBridge(() => this.approvalBridge), // 正準配線 (QA-R2-4: undefined=省略・?? [] 禁止)
      // TDA-V9-7: bridge の縮退カウンタ (unstableRequestIdCount・非負整数) を hello へ相乗りさせ
      // backend の GET /realtime/readiness から観測可能にする (SEC-R4-4 の未配線解消)。同じ遅延参照。
      daemonCountersProvider: daemonCountersFromBridge(() => this.approvalBridge), // 正準配線 (未生成=省略)
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

    // per-session multiplex registry。GitWatcher emit に capture_mode="attach" を被せて sink へ。
    const onGitEvent = (ev: ReturnType<typeof buildEvent>): void => {
      this.sink.emit(this.withAttachMode(ev));
    };
    this.registry =
      opts.registryFactory !== undefined
        ? opts.registryFactory(onGitEvent)
        : new AttachSessionRegistry({
            onGitEvent,
            // ADR 019eb365: reap で session 集合が縮小したら hello 再送 → backend が authoritative
            // hello で release (presence false)。終了済 CC を Wall から落とす。
            onChange: () => this.wsClient.reannounce(),
            // QA-2 / ADR 019eb448: idle-TTL/間隔の env 上書き (省略時 registry 既定)。
            ...(opts.idleTtlMs !== undefined ? { idleTtlMs: opts.idleTtlMs } : {}),
            ...(opts.reaperIntervalMs !== undefined
              ? { reaperIntervalMs: opts.reaperIntervalMs }
              : {}),
          });

    // ADR 019f4206 A段 (契約点1): cockpit-relayed Codex Managed spawn の in-process manager。sink / approvalBridge
    // は attach daemon と同一実体を共有し (承認 relay + redaction 経路を再利用)、cwd 封じ込めは per-repo policy
    // resolve と同じ canonical makeRepoScopeResolver + isPathWithinScope を共有する (契約点3・手書きコピー禁止)。
    this.spawnManager = new CodexSpawnManager({
      sink: this.sink,
      approvalBridge: this.approvalBridge,
      resolveRepoScope: makeRepoScopeResolver(),
      enabled: enableCodexSpawn,
      ...(opts.codexSpawnMax !== undefined ? { spawnMax: opts.codexSpawnMax } : {}),
    });

    this.hookReceiver = new HookReceiver({
      sink: this.sink,
      approvalBridge: this.approvalBridge,
      // ADR D3: authToken 必須化 (無認証 loopback 注入を到達不能化)。
      authToken: this.hookToken,
      requireAuthToken: true,
      // ADR D8: 全 emit に capture_mode="attach"。
      captureMode: "attach",
      // ADR D6: per-session identity を registry から解決 (初出で entry/GitWatcher 起動)。
      // decision 019fd2ac ① 改訂: reap 跨ぎ親相関 seed (tombstone consume) は registry が
      // 任意 hook の初出で行う (SessionStart フラグ配線は撤去・承認不可視化バグの根治)。
      resolveIdentity: (sessionId, cwd) => this.registry.observeHook(sessionId, cwd).identity,
      // ADR 019eb365: SessionEnd で当該 session を即時 reap (GitWatcher 停止 + hello 再送)。
      onSessionEnd: (sessionId) => this.registry.reap(sessionId),
      ...(opts.host !== undefined ? { host: opts.host } : {}),
      ...(opts.hookPort !== undefined ? { port: opts.hookPort } : {}),
      ...(opts.onHook !== undefined ? { onHook: opts.onHook } : {}),
    });

    // UI 承認は honor する (managed と同経路, ADR D7: 承認は効くが完全性非保証)。
    this.wsClient.on(
      "approval",
      (msg: { request_id: string; decision: unknown; reason?: string; persist?: unknown }) => {
        if (typeof msg.request_id !== "string") return;
        // TDA-R6-1: 判定は正準 `APPROVAL_DECISIONS` (event-model) を消費する — sidecar.ts と同一の
        // set-equivalent ゲート (第 5 の手書き `!==` 連鎖ミラーを残さない・受理集合不変)。
        if (
          typeof msg.decision !== "string" ||
          !(APPROVAL_DECISIONS as readonly string[]).includes(msg.decision)
        ) {
          return; // enum 外は破棄 (fail-safe)
        }
        const decision = msg.decision as ApprovalDecision;
        // ADR 019ee0c0: persist は boolean のときのみ honor (型崩れは false 扱い=fail-safe)。
        const persist = msg.persist === true;
        this.approvalBridge.resolve(msg.request_id, decision, msg.reason, persist);
      },
    );

    // INV-ATTACH-NO-KILL: interrupt 要求は **no-op**。Attach 対象 CC は daemon の子でなく、
    // 非所有 PID を kill しない (sidecar.md: PID 限定 / 無関係プロセス巻き込み禁止)。
    // managed runner を保持しないため stop/kill 経路は構造的に存在しないが、観測のみ行う。
    this.wsClient.on("interrupt", (msg: { session_id?: string }) => {
      this.onInterruptIgnored?.(typeof msg.session_id === "string" ? msg.session_id : undefined);
      // 何も kill しない (no-op)。将来 PermissionRequest hook 経由の deny で間接制御は検討。
    });

    // 段階2 (ADR 019ea4ba D2-B) diff 本文要求。WsClient が controlToken 検証済みのもののみ emit する。
    // managed (Sidecar.handleDiffRequest) と **同一の generateRedactedDiff choke** を再利用し、attach 独自の
    // diff 生成・redaction 経路を一切作らない (INV-ATTACH-REDACTION)。registry 登録済 session 宛のみ応答する。
    this.wsClient.on("diffRequest", (msg: { request_id?: string; session_id?: string }) => {
      void this.handleDiffRequest(msg);
    });

    // PAL-v2 (ADR 019ee147): allowlist list/revoke 要求。WsClient が controlToken 検証済みのもののみ
    // emit する。allowlist は machine-global ゆえ managed (sidecar.ts) と同一の buildAllowlistResponse を
    // 共有し、attach 独自の list/revoke 経路を作らない。entries は ApprovalBridge の NO-RAW ビューのみ。
    this.wsClient.on("allowlistRequest", (msg) => {
      const res = buildAllowlistResponse(this.approvalBridge, msg);
      if (res !== undefined) this.wsClient.respondAllowlist(res);
    });

    // ADR 019f0c3e Phase 2: 承認ポリシー get/set 要求。controlToken 検証済みのみ emit される。
    // policy は machine-global ゆえ managed (sidecar.ts) と同一の buildPolicyResponse を共有 (closed-enum
    // NO-RAW 単一出所)。attach 独自の get/set 経路を作らない。
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
        // すると void では unhandledRejection が escape し、global net 無しの attach daemon がプロセス死する。
        // この .catch が非同期版の最終 net (構造 backstop 等価) — daemon は落とさない (deny-safe・観測も諦める)。
      });
    });

    // ADR 019f4206 A段: Codex Managed spawn 要求。WsClient が controlToken 検証済みのもののみ emit する
    // (無認証 peer は handleInbound で構造遮断・INV-SPAWN-DENY-VALUE-BASED)。処理は CodexSpawnManager の
    // **値ベース** deny (throw 禁止・SEC-R3-3)。NO-RAW: 応答は closed enum code のみで prompt/cwd を echo しない。
    this.wsClient.on("spawnRequest", (msg) => {
      void (async () => {
        try {
          const res = await this.handleSpawnRequest(msg);
          this.onSpawnHandled?.(res.ok, res.ok ? undefined : res.error);
          if (typeof msg.request_id === "string" && msg.request_id.length > 0) {
            this.wsClient.respondCodexSpawn({
              type: "codex.spawn.response",
              request_id: msg.request_id,
              ok: res.ok,
              ...(res.ok && res.session_id !== undefined ? { session_id: res.session_id } : {}),
              ...(res.ok ? {} : { error: res.error }),
            });
          }
        } catch {
          // graceful error: 想定外 throw でも closed enum の spawn_failed で応答し backend の timeout を避ける。
          if (typeof msg.request_id === "string" && msg.request_id.length > 0) {
            this.wsClient.respondCodexSpawn({
              type: "codex.spawn.response",
              request_id: msg.request_id,
              ok: false,
              error: "spawn_failed",
            });
          }
        }
      })().catch(() => {
        // 非同期版の最終 net (policyRequest と同型)。respondCodexSpawn の throw も daemon を落とさない (deny-safe)。
      });
    });
  }

  /**
   * ADR 019f4206 A段: spawn 要求を検証射影 → CodexSpawnManager へ委譲する (値ベース)。prompt/cwd は
   * event-model 正準 `parseCodexSpawnRequest` で検証射影し (余剰 field を構造的に落とす・NO-RAW by construction)、
   * 不正なら値ベース `invalid_request` deny (throw しない)。resolve_scope は封じ込め第二段の再照合 scope。
   */
  private async handleSpawnRequest(msg: {
    prompt?: string;
    cwd?: string;
    resolve_scope?: readonly string[];
  }): Promise<CodexSpawnResult> {
    const params = parseCodexSpawnRequest({ prompt: msg.prompt, cwd: msg.cwd });
    if (params === undefined) return { ok: false, error: "invalid_request" };
    const scope = Array.isArray(msg.resolve_scope)
      ? msg.resolve_scope.filter((s): s is string => typeof s === "string")
      : [];
    return this.spawnManager.handleSpawn({ ...params, resolveScope: scope });
  }

  /**
   * 段階2: attach session 宛 diff 本文要求を処理する。managed の handleDiffRequest と同型:
   * registry 登録済 session の repo root で generateRedactedDiff (生成→redactDeep 透過→
   * truncation-after-redaction の唯一 choke) を呼び、respondDiff で diff.response を返す。
   *
   * - request_id 欠落 → 黙殺 (managed と同じ)。
   * - session_id が registry に無い (unknown / reaped) → 黙殺。backend は sessionOwner 不在で先に
   *   404 を返すため、ここに到達する unknown は race のみ (foreign session の diff を盗み見させない)。
   * - 非 git ディレクトリ等で root が無い → generateRedactedDiff("") が空 diff を返す (既存挙動)。
   * - 例外時も raw を載せない空応答に倒す (managed と同じ fail-safe)。
   */
  private async handleDiffRequest(msg: {
    request_id?: string;
    session_id?: string;
  }): Promise<void> {
    if (typeof msg.request_id !== "string" || msg.request_id.length === 0) return;
    if (typeof msg.session_id !== "string") return;
    // registry 登録済 session 宛のみ応答 (unknown/reaped は黙殺)。
    const session = this.registry.get(msg.session_id);
    if (session === undefined) return;
    try {
      // repoRoot は GitWatcher 起動時に解決済 (二重解決なし)。未解決 (非 git / watcher 未起動) なら
      // "" を渡し generateRedactedDiff の既存挙動 (空 diff) に従う。
      const result = await generateRedactedDiff(session.repoRoot ?? "");
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

  /** GitWatcher 由来イベントに capture_mode="attach" を被せる (event を再構築せず複製)。 */
  private withAttachMode(ev: ReturnType<typeof buildEvent>): ReturnType<typeof buildEvent> {
    if (ev.capture_mode === "attach") return ev;
    return { ...ev, capture_mode: "attach" };
  }

  /** settings 配線で CC が提示すべき literal hook 認証トークン。 */
  get hookAuthToken(): string {
    return this.hookToken;
  }

  get controlAuthToken(): string {
    return this.controlToken;
  }

  /** 観測中の attach session 数 (status 用)。 */
  get observedSessionCount(): number {
    return this.registry.size;
  }

  /** hook receiver を起動し WS 接続を開始。endpoint を返す。 */
  async start(): Promise<{ hookEndpoint: string }> {
    if (this.started) return { hookEndpoint: this.hookReceiver.endpoint };
    await this.hookReceiver.listen();
    this.wsClient.connect();
    this.started = true;
    return { hookEndpoint: this.hookReceiver.endpoint };
  }

  /** 実際に bind された hook endpoint (listen 後)。 */
  get hookEndpoint(): string {
    return this.hookReceiver.endpoint;
  }

  /** graceful shutdown: registry 停止 → spawn した managed codex を dispose → 未送信 flush → close。 */
  async shutdown(): Promise<void> {
    await this.registry.dispose();
    this.spawnManager.dispose();
    this.approvalBridge.drain();
    await this.hookReceiver.close();
    this.wsClient.notifyAppended();
    this.wsClient.close();
    this.store.close();
  }
}
