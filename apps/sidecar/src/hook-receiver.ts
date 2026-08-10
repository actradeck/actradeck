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
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";

import { tokenEquals } from "@actradeck/redaction";

import { buildEvent } from "./event-factory.js";
import { type HookCommonInput, type NormalizeContext, normalizeHook } from "./normalize.js";
import type { RunIdentity, SessionIdentity } from "./session-identity.js";
import { HOOK_TOKEN_HEADER } from "./settings-injection.js";
import type { EventSink } from "./sink.js";
import type { ApprovalBridge } from "./approval-bridge.js";
import { resolutionOriginSuffix } from "./approval-bridge.js";

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
  readonly resolveIdentity?: (
    sessionId: string,
    cwd?: string,
    isSessionStart?: boolean,
  ) => SessionIdentity;
  /**
   * 観測モード (ADR 019ea476 D8)。Attach 構成では "attach" を渡し、全 emit に
   * capture_mode="attach" を付与する (UI の attach バッジ用)。省略時は付与しない (managed 既定)。
   * event-model CaptureMode の**意図的 narrow** (hook 経路は codex_rollout を通らない・TDA-1)。
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
 * 実体は `@actradeck/redaction` の正典 `tokenEquals` (TDA-5 sweep で 5 コピーを単一出所化)。
 * 既存 import 互換のためここから re-export する。
 */
export { tokenEquals };

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
    | ((sessionId: string, cwd?: string, isSessionStart?: boolean) => SessionIdentity)
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
        // Non-gating hook failures remain availability-biased, but never attempt a second write
        // after a response was already completed. Approval hooks are caught inside handle() and
        // receive an explicit deny instead (INV-APPROVAL-FAIL-CLOSED).
        this.handle(req, res).catch(() => this.respondCaptured(res, 200, {}));
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

    const isApprovalHook =
      input.hook_event_name === "PermissionRequest" || input.hook_event_name === "PreToolUse";
    try {
      // ADR 019e9462 / ADR 0014 Phase 3b-1: 検証済み hook の session_id を RunIdentity で解決する。
      // **emit より前**に呼ぶことで、初確定時に held 監視イベント (heartbeat/diff/output) が canonical id で
      // 発生時刻順 flush され、その後に本 hook イベントが ingest される (順序: 確定 → flush → hook ingest)。
      //
      // Attach multiplex (ADR 019ea476 D6): resolveIdentity があれば hook の session_id で per-session
      // identity を解決 (初出 entry 生成 / GitWatcher 起動は registry 側の副作用)。
      //
      // run 境界 (ADR 0014 D2): onHookSession が provider id 変化 / terminal-reopen を判定し、この hook を
      // どの canonical run へ ingest するか (start_kind / resumed_from を run 起点に載せるか) を返す。
      // 監視イベントは境界を駆動しない (D3・分裂防止)。
      // 注釈は run 語彙エイリアス RunIdentity (= SessionIdentity): ここでの用途は run 境界判定
      // (onHookSession) であり、エイリアスの意図した使用点 (3b-1 sweep TDA-1 で実体化)。
      // decision 019fd2ac ①: SessionStart フラグを registry へ伝え、reap 跨ぎ resume の初出でのみ
      // terminal tombstone を consume させる (straggler hook で phantom run を作らない)。
      const identity: RunIdentity | undefined =
        this.resolveIdentity !== undefined
          ? this.resolveIdentity(
              input.session_id,
              input.cwd,
              input.hook_event_name === "SessionStart",
            )
          : this.identity;
      let lineage: NormalizeContext = {};
      if (identity !== undefined) {
        const boundary = identity.onHookSession(input.session_id, {
          isSessionStart: input.hook_event_name === "SessionStart",
          ...(typeof input.source === "string" ? { source: input.source } : {}),
        });
        lineage = {
          // D5: 全候補の session_id は canonical run id、provider_session_id は provider raw id。
          canonicalSessionId: boundary.runId,
          providerSessionId: input.session_id,
          // D4: 境界 (or generation 0) の run 起点にのみ start_kind / resumed_from を載せる。
          ...(boundary.startKind !== undefined ? { runStartKind: boundary.startKind } : {}),
          ...(boundary.resumedFrom !== undefined
            ? { resumedFromSessionId: boundary.resumedFrom }
            : {}),
        };
      }

      this.onHook?.(input.hook_event_name);

      // 承認ゲート: PermissionRequest / PreToolUse は承認ブリッジへ。
      if (isApprovalHook) {
        await this.handleApprovalGate(input, res, lineage);
        return;
      }

      // 通常 hook: 正規化 → sink。応答は空 (非ブロッキング)。
      this.ingest(input, lineage);
      // ADR 0014 D2#2: SessionEnd を ingest した後に run を terminal 化する (以後、同一 provider id の
      // 再来は terminal-reopen として新 run を切る)。managed は静的 identity ゆえ跨いで有効。attach は
      // 直後に reap で identity が破棄されるため best-effort (次 hook は fresh gen0・親未観測 = lineage 無し)。
      if (input.hook_event_name === "SessionEnd") {
        identity?.markRunTerminal();
        // SessionEnd は session.ended を ingest した**後**に reap を促す (event 永続化 → presence release
        // の順序を保つ・ADR 019eb365)。registry が GitWatcher を止め hello 再送で connected を落とす。
        this.onSessionEnd?.(input.session_id);
      }
      this.respond(res, 200, {});
    } catch (error) {
      // Once a syntactically valid approval hook is identified, every internal failure must be
      // blocking. Returning `{}` here means "no opinion" and lets the agent's normal/YOLO flow
      // continue — exactly the fail-open condition this boundary exists to prevent.
      if (isApprovalHook) {
        this.respondApprovalFailure(input, res);
        return;
      }
      throw error;
    }
  }

  /** Valid approval hook + internal exception → provider-specific explicit deny (no raw error). */
  private respondApprovalFailure(input: HookCommonInput, res: ServerResponse): void {
    const reason = "ActraDeck approval gate failed closed";
    if (input.hook_event_name === "PermissionRequest") {
      this.respondCaptured(res, 200, {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "deny" },
        },
      });
      return;
    }
    this.respondCaptured(res, 200, {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    });
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
  private async handleApprovalGate(
    input: HookCommonInput,
    res: ServerResponse,
    lineage: NormalizeContext = {},
  ): Promise<void> {
    // 承認ブリッジが採番した request_id を捕捉し、解決イベント (resolved) にも載せて
    // reducer が pending_approvals から該当 request_id を除去できるようにする (ADR 019e9999)。
    // low-risk (defer) では emitRequest が呼ばれず undefined のまま (resolved も emit しない)。
    let capturedRequestId: string | undefined;
    // ADR 0014 Phase 4 (decision 019fd705 D3): hook クライアント (CC プロセス) が応答未送信のまま
    // 切断したら、当該 pending を **即** 安全側 deny へ解決する (origin="child_exit")。従来は 30s
    // timeout まで宙吊りになり、その後「誰も受け取っていない deny」が emit されていた不正直を閉じる。
    // 'close' は正常応答後にも発火するため writableEnded で「未応答のままの切断」のみを判定する。
    // capturedRequestId 未確定 (defer / auto-allow / emitRequest 前) は no-op。cancelPending は
    // pending 不在で no-op (冪等) ゆえ、timeout / UI 決定との race も二重解決しない。
    const onClientGone = (): void => {
      if (!res.writableEnded && capturedRequestId !== undefined) {
        this.approvalBridge.cancelPending(
          capturedRequestId,
          "child_exit",
          "hook client disconnected (safe default: deny)",
        );
      }
    };
    res.on("close", onClientGone);
    let decision: Awaited<ReturnType<ApprovalBridge["requestApproval"]>>;
    try {
      decision = await this.approvalBridge.requestApproval(input, (requestId, reason) => {
        capturedRequestId = requestId;
        // 承認要求イベントを正規化して emit (UI が承認カードを出せる)。ADR 0014: lineage (canonical /
        // provider_session_id / run 起点) を全 ingest に相乗りさせる (承認カードも同一 run へ属す)。
        // 自動ガード (ADR 019ecc70 D4): guard 理由 (trigger / secret_kinds) を ingest へ渡し、
        // normalize が tool.permission.requested payload に載せる。INV-AUTOGUARD-NO-RAW: kind 名のみ。
        this.ingest(input, {
          ...lineage,
          approvalRequestId: requestId,
          guardTrigger: reason.trigger,
          ...(reason.secretKinds.length > 0 ? { guardSecretKinds: reason.secretKinds } : {}),
          // ADR 019ee0c0: 永続化可能なときのみ UI へ persistable を伝える。
          ...(reason.persistable ? { guardPersistable: true } : {}),
        });
      });
    } finally {
      // 解決後 (throw 経路含む・SEC-7 R2) は切断検知を外す (pending は解決済みで cancelPending は
      // no-op だが、listener を残さない)。
      res.removeListener("close", onClientGone);
    }

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
      if (input.hook_event_name === "PreToolUse") this.ingest(input, lineage);
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
          ...lineage,
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

    // ここに来るのは UI 承認 (allow/allow_for_session) / 拒否・タイムアウト・切断 (deny/cancel) のみ。
    const allowed = decision.behavior === "allow";

    // hook 種別ごとの応答形式 (WebFetch code.claude.com/docs/en/hooks 2026-06)。
    // ADR 0014 Phase 4 (decision 019fd705 D4): **応答を先に書いてから** resolved を emit する。
    // delivery_status を応答書込の実結果から導出し「deny を送った」と偽らない (child_exit /
    // 切断済みソケットへの書込失敗は not_sent として監査行に残る)。
    const delivered =
      input.hook_event_name === "PermissionRequest"
        ? this.respondCaptured(res, 200, {
            hookSpecificOutput: {
              hookEventName: "PermissionRequest",
              decision: { behavior: allowed ? "allow" : "deny" },
            },
          })
        : this.respondCaptured(res, 200, {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: allowed ? "allow" : "deny",
              permissionDecisionReason: decision.reason ?? "ActraDeck approval bridge",
            },
          });

    // 解決イベントを emit (waiting.approval の解消)。
    // event-factory (buildEvent) に統一: event_id 採番 / provider / source / timestamp /
    // metrics のデフォルトを一箇所 (T1 正典経由) に集約し、手組みリテラルの drift を防ぐ。
    this.sink.emit(
      buildEvent({
        // ADR 0014 D4/D5: canonical run id + provider raw id を載せる (session.ended 等と同一 run へ属す)。
        session_id: lineage.canonicalSessionId ?? input.session_id,
        provider_session_id: lineage.providerSessionId ?? input.session_id,
        event_type: "tool.permission.resolved",
        state: allowed ? "running.tool_preparing" : "running.model_wait",
        ...(this.captureMode !== undefined ? { capture_mode: this.captureMode } : {}),
        ...(input.cwd ? { cwd: input.cwd } : {}),
        summary: `承認 ${allowed ? "許可" : "拒否"}${resolutionOriginSuffix(decision.origin)}`,
        payload: {
          kind: "tool.permission.resolved",
          ...(capturedRequestId !== undefined ? { request_id: capturedRequestId } : {}),
          // 段階③: UI が選んだ実 4 値 decision を載せる (allow_for_session/cancel を表示で区別)。
          // timeout/drain など decision 不在時は effective な allow/deny に倒す。
          decision: decision.decision ?? (allowed ? "allow" : "deny"),
          // ADR 0014 Phase 4: 出所 + 配送結果 (closed enum のみ・NO-RAW)。origin は bridge の解決
          // 経路が設定 (operator/timeout/shutdown/child_exit)。未設定 (想定外) は field 省略。
          ...(decision.origin !== undefined ? { resolution_origin: decision.origin } : {}),
          delivery_status: delivered ? "sent" : "not_sent",
        },
      }),
    );
  }

  /**
   * ADR 0014 Phase 4 (D4): 承認応答を書き、書込がソケット層に受理されたかを返す。
   * "sent" 意味論 = 切断済みでないソケットへ writeHead/end が同期成功した (相手プロセスが読んだ
   * ことまでは主張しない)。クライアント切断済み (destroyed/writableEnded)・同期 throw は false
   * (= delivery_status "not_sent")。通常 hook の respond() は従来どおり (成否を使わない)。
   */
  private respondCaptured(res: ServerResponse, status: number, body: unknown): boolean {
    if (res.writableEnded || res.destroyed) return false;
    try {
      this.respond(res, status, body);
      return !res.destroyed;
    } catch {
      return false;
    }
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }
}
