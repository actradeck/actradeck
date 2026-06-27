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
import { randomBytes } from "node:crypto";

import { AttachSessionRegistry } from "./attach-session-registry.js";
import { ApprovalBridge } from "./approval-bridge.js";
import { buildApprovalPersistConfig } from "./approval-persist-config.js";
import { buildAllowlistResponse } from "./allowlist-relay.js";
import { generateRedactedDiff } from "./diff-provider.js";
import { buildEvent } from "./event-factory.js";
import { HookReceiver } from "./hook-receiver.js";
import { generateHookToken } from "./settings-injection.js";
import { EventSink, type OutOfOrderObservation } from "./sink.js";
import { EventStore } from "./store.js";
import { WsClient } from "./ws-client.js";

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
  /** literal token-mode で settings に配線する hook 認証トークン (nonce, 再起動で rotation)。 */
  private readonly hookToken: string;
  /** inbound 制御チャネルトークン (approval は honor、interrupt は no-kill)。 */
  private readonly controlToken: string;
  private readonly onInterruptIgnored: ((sessionId: string | undefined) => void) | undefined;
  private started = false;

  constructor(opts: AttachDaemonOptions) {
    this.hookToken =
      opts.hookToken !== undefined && opts.hookToken.length > 0
        ? opts.hookToken
        : generateHookToken();
    this.controlToken = randomBytes(32).toString("base64url");
    this.onInterruptIgnored = opts.onInterruptIgnored;
    this.store = new EventStore(opts.dbPath);

    this.wsClient = new WsClient({
      url: opts.wsUrl,
      store: this.store,
      controlToken: this.controlToken,
      // hello.session_ids = 観測中の全 attach canonical (ADR D1: 複数 id 可)。
      sessionIdsProvider: () => this.registry.sessionIds(),
      ...(opts.ingestToken !== undefined && opts.ingestToken.length > 0
        ? { ingestToken: opts.ingestToken }
        : {}),
    });

    this.approvalBridge = new ApprovalBridge({
      ...(opts.approvalTimeoutMs !== undefined ? { timeoutMs: opts.approvalTimeoutMs } : {}),
      // ADR 019ee0c0: 承認の再起動跨ぎ永続化。env 既定 OFF (ACTRADECK_PERSIST_APPROVALS で opt-in)。
      persist: buildApprovalPersistConfig(),
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

    this.hookReceiver = new HookReceiver({
      sink: this.sink,
      approvalBridge: this.approvalBridge,
      // ADR D3: authToken 必須化 (無認証 loopback 注入を到達不能化)。
      authToken: this.hookToken,
      requireAuthToken: true,
      // ADR D8: 全 emit に capture_mode="attach"。
      captureMode: "attach",
      // ADR D6: per-session identity を registry から解決 (初出で entry/GitWatcher 起動)。
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

  /** graceful shutdown: registry 停止 → 未送信 flush → close。 */
  async shutdown(): Promise<void> {
    await this.registry.dispose();
    this.approvalBridge.drain();
    await this.hookReceiver.close();
    this.wsClient.notifyAppended();
    this.wsClient.close();
    this.store.close();
  }
}
