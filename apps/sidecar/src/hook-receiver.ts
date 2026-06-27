/**
 * ローカル HTTP hook receiver — Claude Code hooks を受信し EventSink へ流す。
 *
 * - POST /hook : Claude Code が各 hook で叩く endpoint。body は共通入力 JSON。
 * - 各 hook を normalizeHook で NormalizedEvent 候補へ → sink.emit (redact→parse→persist→send)。
 * - 承認ブリッジ: PreToolUse / PermissionRequest は応答 JSON で permission を制御する。
 *   既定は「安全側 (ask)」。UI から allow/deny が来ていればそれを返す。タイムアウトは ask/deny。
 *
 * 仕様 (WebSearch 2026-06):
 * - HTTP hook 応答が 2xx + JSON のとき JSON output schema として解釈される。
 * - PreToolUse は { hookSpecificOutput: { hookEventName, permissionDecision, permissionDecisionReason } }。
 * - PermissionRequest は { hookSpecificOutput: { hookEventName, decision: { behavior } } }。
 */
import { timingSafeEqual } from "node:crypto";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";

import { buildEvent } from "./event-factory.js";
import { type HookCommonInput, type NormalizeContext, normalizeHook } from "./normalize.js";
import type { SessionIdentity } from "./session-identity.js";
import { HOOK_TOKEN_HEADER } from "./settings-injection.js";
import type { EventSink } from "./sink.js";
import type { ApprovalBridge } from "./approval-bridge.js";

export interface HookReceiverOptions {
  readonly sink: EventSink;
  readonly approvalBridge: ApprovalBridge;
  /**
   * session 識別の権威 (ADR 019e9462)。検証済み hook の `session_id` を learn-once で
   * canonical として確定する (最初の任意 hook で確定 = SessionStart 限定にしない)。
   * 初確定で監視イベントの hold buffer が canonical id で発生時刻順に flush される。
   * 省略時 (Attach 等で identity 未配線) は learn を呼ばず従来挙動 (後方互換)。
   */
  readonly identity?: SessionIdentity;
  /**
   * Attach multiplex (ADR 019ea476 D6): hook の session_id (+cwd) から per-session の
   * SessionIdentity を解決する。設定時は静的 `identity` より優先し、これを learn 対象にする。
   * registry が初出 session の entry 生成 / GitWatcher 起動を担う (副作用は resolver 側)。
   */
  readonly resolveIdentity?: (sessionId: string, cwd?: string) => SessionIdentity;
  /**
   * 観測モード (ADR 019ea476 D8)。Attach 構成では "attach" を渡し、全 emit に
   * capture_mode="attach" を付与する (UI の attach バッジ用)。省略時は付与しない (managed 既定)。
   */
  readonly captureMode?: "managed" | "attach";
  /**
   * Attach 構成では authToken を **必須** にする (ADR 019ea476 D3, INV-ATTACH-HOOK-AUTH)。
   * true かつ authToken 未設定なら construct 時に throw し、無認証 loopback 注入経路を
   * 構造的に到達不能化する。managed は既存どおり false (token は別途設定済)。
   */
  readonly requireAuthToken?: boolean;
  readonly host?: string;
  readonly port?: number;
  /**
   * SEC-3: per-launch 認証トークン。設定時は全リクエストが HOOK_TOKEN_HEADER で
   * 一致トークンを提示しなければ 403 + event を一切 emit しない。
   * 未設定 (Attach 等トークン注入できない構成) では認証スキップだが loopback 検証は維持。
   */
  readonly authToken?: string;
  /** 受信フックを観測するためのコールバック (テスト・ロギング)。 */
  readonly onHook?: (eventName: string) => void;
  /**
   * SessionEnd hook 受信時に session_id で発火 (ADR 019eb365)。daemon が registry.reap を配線し、
   * 終了した attach session を即時 reap して presence release + GitWatcher 停止する。
   */
  readonly onSessionEnd?: (sessionId: string) => void;
}

/** loopback ホストのみ許可 (DNS-rebinding 遮断)。 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Host / Origin ヘッダのホスト部が loopback かを判定する。 */
function isLoopbackHostHeader(value: string | undefined): boolean {
  if (value === undefined) return true; // ヘッダ欠如は許容 (curl 等)。偽ホスト名のみ弾く。
  // Origin は scheme://host[:port]、Host は host[:port]。
  let host = value.trim();
  const schemeIdx = host.indexOf("://");
  if (schemeIdx >= 0) host = host.slice(schemeIdx + 3);
  // IPv6 bracket を保持しつつ port を剥がす。
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    host = host.slice(0, end + 1);
  } else {
    const colon = host.indexOf(":");
    if (colon >= 0) host = host.slice(0, colon);
  }
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

/**
 * 定数時間トークン比較 (タイミング攻撃耐性) — SEC-2。
 *
 * 素の `provided !== expected` は不一致位置で早期 return しうるため、トークンの長さ・内容を
 * タイミングで推測する side-channel を残す。長さ不一致は先行 false で弾き、同長は
 * node:crypto.timingSafeEqual で比較する。挙動は素の比較と非破壊 (一致/不一致の結果は不変)。
 * backend の ingestion-server.ts:tokenEquals と同型に統一する (正典一本化)。
 */
export function tokenEquals(expected: string, provided: string | undefined): boolean {
  if (provided === undefined) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false; // 長さ不一致は timingSafeEqual の前提 (同長) を満たさない。
  return timingSafeEqual(a, b);
}

const MAX_BODY = 4 * 1024 * 1024; // 4MB 上限 (巨大 payload 防御)。

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export class HookReceiver {
  private server: Server | undefined;
  private readonly sink: EventSink;
  private readonly approvalBridge: ApprovalBridge;
  private readonly identity: SessionIdentity | undefined;
  private readonly resolveIdentity:
    | ((sessionId: string, cwd?: string) => SessionIdentity)
    | undefined;
  private readonly captureMode: "managed" | "attach" | undefined;
  private readonly host: string;
  private readonly desiredPort: number;
  private readonly authToken: string | undefined;
  private readonly onHook: ((eventName: string) => void) | undefined;
  private readonly onSessionEnd: ((sessionId: string) => void) | undefined;
  private boundPort = 0;

  constructor(opts: HookReceiverOptions) {
    // ADR 019ea476 D3 (INV-ATTACH-HOOK-AUTH): Attach は authToken 必須。未設定での起動を
    // **construct 時に禁止** し、無認証 loopback 注入経路 (authToken===undefined) を到達不能化する。
    if (
      opts.requireAuthToken === true &&
      (opts.authToken === undefined || opts.authToken.length === 0)
    ) {
      throw new Error(
        "HookReceiver: authToken is required in Attach mode (no unauthenticated hook ingestion)",
      );
    }
    this.sink = opts.sink;
    this.approvalBridge = opts.approvalBridge;
    this.identity = opts.identity;
    this.resolveIdentity = opts.resolveIdentity;
    this.captureMode = opts.captureMode;
    this.host = opts.host ?? "127.0.0.1";
    this.desiredPort = opts.port ?? 0; // 0 = OS 割当 (ephemeral)。
    this.authToken = opts.authToken;
    this.onHook = opts.onHook;
    this.onSessionEnd = opts.onSessionEnd;
  }

  /** 実際に bind されたポート。listen 後に有効。 */
  get port(): number {
    return this.boundPort;
  }

  get endpoint(): string {
    return `http://${this.host}:${this.boundPort}/hook`;
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        this.handle(req, res).catch(() => this.respond(res, 200, {}));
      });
      server.on("error", reject);
      server.listen(this.desiredPort, this.host, () => {
        const addr = server.address();
        this.boundPort = typeof addr === "object" && addr ? addr.port : this.desiredPort;
        this.server = server;
        resolve(this.boundPort);
      });
    });
  }

  private respond(res: ServerResponse, status: number, body: unknown): void {
    const json = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(json);
  }

  /**
   * SEC-3: 認証 + loopback ガード。失敗時は 403 を返し、呼び出し元は emit しない。
   * トークン照合と Host/Origin loopback 検証を body 解釈・emit の「前」に行う。
   */
  private isAuthorized(req: IncomingMessage): boolean {
    // DNS-rebinding 遮断: Host / Origin が偽の (非 loopback) ホスト名なら拒否。
    const hostHeader = req.headers.host;
    const originHeader = Array.isArray(req.headers.origin)
      ? req.headers.origin[0]
      : req.headers.origin;
    if (!isLoopbackHostHeader(hostHeader) || !isLoopbackHostHeader(originHeader)) {
      return false;
    }
    // per-launch トークン照合 (設定時のみ)。SEC-2: 定数時間比較 (timingSafeEqual)。
    if (this.authToken !== undefined) {
      const provided = req.headers[HOOK_TOKEN_HEADER.toLowerCase()];
      const value = Array.isArray(provided) ? provided[0] : provided;
      if (!tokenEquals(this.authToken, value)) return false;
    }
    return true;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST" || !req.url?.startsWith("/hook")) {
      this.respond(res, 404, { error: "not found" });
      return;
    }
    // 認証 / loopback 検証を「最初」に行う。失敗時は body を読まず・emit せず 403。
    if (!this.isAuthorized(req)) {
      // body を破棄してソケットを閉じる (未読データで hang しないように)。
      req.resume();
      this.respond(res, 403, { error: "forbidden" });
      return;
    }
    const raw = await readBody(req);
    let input: HookCommonInput;
    try {
      input = JSON.parse(raw) as HookCommonInput;
    } catch {
      this.respond(res, 200, {}); // 安全側: 解釈不能でも非ブロッキングで通す。
      return;
    }
    if (typeof input.session_id !== "string" || typeof input.hook_event_name !== "string") {
      this.respond(res, 200, {});
      return;
    }

    // ADR 019e9462: 検証済み hook の session_id を learn-once で canonical 確定する。
    // **emit より前**に呼ぶことで、初確定時に held 監視イベント (heartbeat/diff/output) が
    // canonical id で発生時刻順 flush され、その後に本 hook イベントが ingest される
    // (順序: 確定 → buffer flush → hook ingest)。learn は idempotent (後勝ちしない)。
    //
    // Attach multiplex (ADR 019ea476 D6): resolveIdentity があれば hook の session_id で
    // per-session identity を解決 (初出 entry 生成 / GitWatcher 起動は registry 側の副作用)。
    // 解決した identity を learn する (explicitSessionId 即確定なので learn は no-op だが、
    // registry の lastHookAt 更新と GitWatcher 起動の起点になる)。
    if (this.resolveIdentity !== undefined) {
      const id = this.resolveIdentity(input.session_id, input.cwd);
      id.learn(input.session_id);
    } else {
      this.identity?.learn(input.session_id);
    }

    this.onHook?.(input.hook_event_name);

    // 承認ゲート: PermissionRequest / PreToolUse は承認ブリッジへ。
    if (input.hook_event_name === "PermissionRequest" || input.hook_event_name === "PreToolUse") {
      await this.handleApprovalGate(input, res);
      return;
    }

    // 通常 hook: 正規化 → sink。応答は空 (非ブロッキング)。
    this.ingest(input);
    // SessionEnd は session.ended を ingest した**後**に reap を促す (event 永続化 → presence release
    // の順序を保つ・ADR 019eb365)。registry が GitWatcher を止め hello 再送で connected を落とす。
    if (input.hook_event_name === "SessionEnd") {
      this.onSessionEnd?.(input.session_id);
    }
    this.respond(res, 200, {});
  }

  private ingest(input: HookCommonInput, ctx: NormalizeContext = {}): void {
    // ADR 019ea476 D8: Attach 構成では全候補に capture_mode="attach" を被せる。
    const merged: NormalizeContext =
      this.captureMode !== undefined ? { ...ctx, captureMode: this.captureMode } : ctx;
    const candidates = normalizeHook(input, merged);
    for (const ev of candidates) this.sink.emit(ev);
  }

  /**
   * 承認ゲート: 高リスク操作は UI 承認を待つ。PermissionRequest を正本とし、
   * PreToolUse は high-risk のみゲート (それ以外は defer して通常フローへ)。
   */
  private async handleApprovalGate(input: HookCommonInput, res: ServerResponse): Promise<void> {
    // 承認ブリッジが採番した request_id を捕捉し、解決イベント (resolved) にも載せて
    // reducer が pending_approvals から該当 request_id を除去できるようにする (ADR 019e9999)。
    // low-risk (defer) では emitRequest が呼ばれず undefined のまま (resolved も emit しない)。
    let capturedRequestId: string | undefined;
    const decision = await this.approvalBridge.requestApproval(input, (requestId, reason) => {
      capturedRequestId = requestId;
      // 承認要求イベントを正規化して emit (UI が承認カードを出せる)。
      // 自動ガード (ADR 019ecc70 D4): guard 理由 (trigger / secret_kinds) を ingest へ渡し、
      // normalize が tool.permission.requested payload に載せる。INV-AUTOGUARD-NO-RAW: kind 名のみ。
      this.ingest(input, {
        approvalRequestId: requestId,
        guardTrigger: reason.trigger,
        ...(reason.secretKinds.length > 0 ? { guardSecretKinds: reason.secretKinds } : {}),
        // ADR 019ee0c0: 永続化可能なときのみ UI へ persistable を伝える。
        ...(reason.persistable ? { guardPersistable: true } : {}),
      });
    });

    // defer はゲート対象外 (low-risk)。承認イベントを出さず、通常 permission flow に委ねる。
    // ⚠️ force-allow しない (INV-APPROVAL): 空 JSON を返す。
    //
    // INV-HOOK-SUBAGENT-COMPAT: ここで `permissionDecision: "defer"` を返してはならない。
    // CC 2.1.17x の background subagent ランナーは "defer" 応答を処理できず、同一セッション内の
    // **全 subagent ツール結果**が "[Tool result missing due to internal error]" に化ける
    // (A/B/A + 中間 proxy の応答書換で実証・upstream anthropics/claude-code#67221。
    // 空 {} と明示 allow/deny は main / subagent 両方で正常)。空 JSON は仕様上
    // 「no opinion = 通常 permission flow へ委譲」で "defer" と意味的に同一。
    if (decision.behavior === "defer") {
      // PreToolUse は payload を normalize して観測 (command.started 等) する。
      // PermissionRequest の defer はそのまま通常フローへ (waiting.approval を出さない)。
      if (input.hook_event_name === "PreToolUse") this.ingest(input);
      this.respond(res, 200, {});
      return;
    }

    // 段階③: allow_for_session の同一署名キャッシュ命中で自動承認された場合。
    // emitRequest を経ていない (capturedRequestId 未定) ため、**resolved を出さない**
    // (request_id 無しの resolved は reducer が他 pending を誤消去するため)。代わりに
    // 通常観測 (command.started 等) を出して allow を返す。人間が既に許可した署名なので
    // INV-APPROVAL を満たす (force-allow ではなく人間同意の再適用)。
    if (decision.autoAllowed === true) {
      // SEC-2 (ADR 019e9b89): auto-allow された高リスク操作を監査ログで「session-grant 由来の
      // 自動許可」として識別できるよう auto_allowed マーカーを付けて観測する (low-risk defer と
      // 区別不能だった証跡の痩せを解消)。over-allow ではない (人間が同一署名を1回明示同意済み)。
      if (input.hook_event_name === "PreToolUse")
        this.ingest(input, {
          autoAllowed: true,
          // ADR 019ee0c0: 再起動跨ぎ disk grant 由来の auto-allow は persist_grant で識別する。
          ...(decision.persistGrant === true ? { persistGrant: true } : {}),
        });
      if (input.hook_event_name === "PermissionRequest") {
        this.respond(res, 200, {
          hookSpecificOutput: {
            hookEventName: "PermissionRequest",
            decision: { behavior: "allow" },
          },
        });
      } else {
        this.respond(res, 200, {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            permissionDecisionReason: decision.reason ?? "ActraDeck allow_for_session",
          },
        });
      }
      return;
    }

    // ここに来るのは UI 承認 (allow/allow_for_session) / 拒否・タイムアウト (deny/cancel) のみ。
    const allowed = decision.behavior === "allow";

    // 解決イベントを emit (waiting.approval の解消)。
    // event-factory (buildEvent) に統一: event_id 採番 / provider / source / timestamp /
    // metrics のデフォルトを一箇所 (T1 正典経由) に集約し、手組みリテラルの drift を防ぐ。
    this.sink.emit(
      buildEvent({
        session_id: input.session_id,
        event_type: "tool.permission.resolved",
        state: allowed ? "running.tool_preparing" : "running.model_wait",
        ...(this.captureMode !== undefined ? { capture_mode: this.captureMode } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
        summary: `承認 ${allowed ? "許可" : "拒否"}`,
        payload: {
          kind: "tool.permission.resolved",
          ...(capturedRequestId !== undefined ? { request_id: capturedRequestId } : {}),
          // 段階③: UI が選んだ実 4 値 decision を載せる (allow_for_session/cancel を表示で区別)。
          // timeout/drain など decision 不在時は effective な allow/deny に倒す。
          decision: decision.decision ?? (allowed ? "allow" : "deny"),
        },
      }),
    );

    // hook 種別ごとの応答形式 (WebFetch code.claude.com/docs/en/hooks 2026-06)。
    if (input.hook_event_name === "PermissionRequest") {
      this.respond(res, 200, {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: allowed ? "allow" : "deny" },
        },
      });
    } else {
      this.respond(res, 200, {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: allowed ? "allow" : "deny",
          permissionDecisionReason: decision.reason ?? "ActraDeck approval bridge",
        },
      });
    }
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }
}
