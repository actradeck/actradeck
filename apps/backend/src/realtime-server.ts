/**
 * UI 向け Realtime WS ルート (/realtime/ws) — Phase 3 ③.
 *
 * ingestion(/ingest/ws, sidecar向け) とは **別経路・別認証**:
 *  - 認証: REALTIME_TOKEN を Authorization: Bearer で upgrade 前検証 (timingSafeEqual)。
 *    ?token= は受理しない (SEC-1: query はログ漏れの温床)。無認証 peer に session データを
 *    配信しない (INV-REALTIME-AUTH)。
 *  - backend→UI: 接続直後に list snapshot → 以降 delta。subscribe で per-session 詳細
 *    snapshot + delta を受ける。push 順序は 1 接続あたり逐次 send で保つ (INV-REALTIME-ORDER)。
 *  - UI→Sidecar: approve(allow/allow_for_session/deny/cancel) / interrupt を
 *    SidecarRegistry 経由で対象 session の sidecar へ中継。承認なし自動実行は作らない
 *    (INV-APPROVAL)。中継先は登録済みセッションに限定 (SSRF/任意PID 到達防止)。
 *
 * 認証は **本ルート専用の onRequest フック (registerRealtimeRoute 内)** が唯一の番人。
 * ingestion-server 側の onRequest は /ingest 以外を early return するため /realtime は認証しない。
 * かつ本ルートは realtimeToken が設定されたときのみ mount される (ingestion-server)。
 * (SEC-1: 旧コメントは「ingestion フックが /realtime も認証」と誤記。T1=コード優先で修正。
 *  この認証契約は 401 e2e 2 ケース inv-realtime-server.test.ts が固定している。)
 */
import { timingSafeEqual } from "node:crypto";

import { ApprovalDecision } from "@actradeck/event-model";

import type { ClientFrame, RealtimeHub, RealtimeSink } from "./realtime-hub.js";
import {
  decodeReplayCursor,
  MAX_WALL_SESSIONS,
  normalizeOutputTail,
  normalizeReplayLimit,
  normalizeWallPerSession,
  type ReplayStore,
} from "./replay-store.js";
import {
  auditReportToCsv,
  normalizeAuditInstant,
  normalizeAuditLimit,
  normalizeRedactionKind,
  normalizeRedactionOccurrenceLimit,
} from "./audit-contract.js";
import type { AuditRangeReport } from "./audit-contract.js";
import type { AuditStore } from "./audit-store.js";
import type { RealtimeStore } from "./realtime-store.js";
import type { SidecarRegistry } from "./sidecar-registry.js";
import type { FastifyInstance, FastifyReply } from "fastify";

export interface RealtimeRouteOptions {
  readonly realtimeToken: string;
  readonly hub: RealtimeHub;
  readonly store: RealtimeStore;
  readonly replayStore: ReplayStore;
  readonly auditStore: AuditStore;
  readonly sidecarRegistry: SidecarRegistry;
}

const VALID_DECISIONS: ReadonlySet<string> = new Set(ApprovalDecision.options);

/** 定数時間トークン比較 (ingestion と同じ様式)。 */
function realtimeTokenEquals(expected: string, provided: string | undefined): boolean {
  if (!provided) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * /realtime/ws を Fastify app に登録する。upgrade 前認証 (onRequest) も掛ける。
 * 認証フック: /realtime で始まる URL に Bearer token を要求し、不一致は 401 で upgrade させない。
 */
export function registerRealtimeRoute(app: FastifyInstance, opts: RealtimeRouteOptions): void {
  // upgrade 前認証 (ingestion の onRequest とは別経路・別 token)。
  app.addHook("onRequest", async (req, reply) => {
    if (!req.url.startsWith("/realtime")) return;
    const auth = req.headers["authorization"];
    const token =
      typeof auth === "string" && auth.startsWith("Bearer ")
        ? auth.slice("Bearer ".length).trim()
        : undefined;
    if (!realtimeTokenEquals(opts.realtimeToken, token)) {
      await reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/realtime/ws", { websocket: true }, (socket) => {
    const sink: RealtimeSink = {
      send: (data: string) => socket.send(data),
      get open() {
        return socket.readyState === socket.OPEN;
      },
    };
    const handle = opts.hub.register(sink);
    // presence 述語: snapshot/detail の connected(接続在席)を registry から被せる(ADR 019ea2bf)。
    const isLive = (sid: string): boolean => opts.sidecarRegistry.isLive(sid);

    // 接続直後: list snapshot を送る (初期同期)。失敗は接続を保つ。
    void opts.store
      .listSnapshot(undefined, isLive)
      .then((sessions) => opts.hub.sendListSnapshot(handle, sessions))
      .catch(() => {});

    socket.on("message", (raw: Buffer) => {
      void handleClientFrame(raw, opts, handle);
    });
    socket.on("close", () => handle.remove());
  });

  app.get<{
    Params: { sessionId: string };
    Querystring: { cursor?: string; limit?: string };
  }>("/realtime/sessions/:sessionId/events", async (req, reply) => {
    const sessionId = req.params.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return reply.code(400).send({ error: "missing session_id" });
    }
    let cursor: ReturnType<typeof decodeReplayCursor>;
    try {
      cursor = decodeReplayCursor(req.query.cursor);
    } catch {
      return reply.code(400).send({ error: "invalid cursor" });
    }
    const page = await opts.replayStore.eventsPage({
      sessionId,
      limit: normalizeReplayLimit(req.query.limit),
      ...(cursor !== undefined ? { cursor } : {}),
    });
    return reply.send(page);
  });

  // 段階2 (ADR 019ea4ba D2-A): command stdout 本文 tail の on-demand pull。
  //   出所 command.output.delta.delta は既に redaction 済み (sidecar choke)。backend は再 redaction
  //   しない。REALTIME_TOKEN gate (上の onRequest) 背後。新規 raw 露出面は作らない (allow-list delta)。
  app.get<{
    Params: { sessionId: string; eventId: string };
    Querystring: { tail?: string };
  }>("/realtime/sessions/:sessionId/commands/:eventId/output", async (req, reply) => {
    const sessionId = req.params.sessionId;
    const eventId = req.params.eventId;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return reply.code(400).send({ error: "missing session_id" });
    }
    const excerpt = await opts.replayStore.commandOutput({
      sessionId,
      ...(typeof eventId === "string" && eventId.length > 0 ? { eventId } : {}),
      tail: normalizeOutputTail(req.query.tail),
    });
    return reply.send(excerpt);
  });

  // 段階2 (ADR 019ea4ba D2-B): git 全体 diff 本文の on-demand pull (真の新経路)。
  //   REALTIME_TOKEN gate 背後 + SidecarRegistry の controlToken relay (登録済 session 限定・SSRF/任意
  //   PID 不可)。sidecar が git diff 生成→redactDeep 透過→サイズ切詰めした **redaction 済み本文**を
  //   round-trip で取得し、backend は再 redaction も永続もせず直渡しする。未登録/切断/未 handshake/
  //   タイムアウトは安全側のエラーで返す (本文を at-rest に貯めない・常時 push しない)。
  app.get<{ Params: { sessionId: string } }>(
    "/realtime/sessions/:sessionId/diff",
    async (req, reply) => {
      const sessionId = req.params.sessionId;
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        return reply.code(400).send({ error: "missing session_id" });
      }
      const res = await opts.sidecarRegistry.requestDiff(sessionId);
      if (!res.ok) {
        // 未登録 session / 切断 / handshake 未了 → 404 (foreign/未登録は本文を出さない)。
        // タイムアウト等の一時不調 → 503。SSRF: 登録済 session のみ到達 (registry 境界)。
        const transient =
          res.error === "diff request timed out" || res.error === "sidecar disconnected";
        return reply.code(transient ? 503 : 404).send({ error: res.error });
      }
      return reply.send(res.diff);
    },
  );

  // PAL-v2 (ADR 019ee147): 永続承認 allowlist の in-UI 一覧 (list)。
  //   REALTIME_TOKEN gate 背後 + SidecarRegistry の controlToken relay (登録済 session 限定・SSRF/任意
  //   PID 不可)。allowlist は machine-global ゆえ session_id は宛先解決のみに使い、entries は NO-RAW
  //   (sha256 署名/scope/basename/risk/時刻)。backend は entries を生成も永続もしない (sidecar 直渡し)。
  app.get<{ Params: { sessionId: string } }>(
    "/realtime/sessions/:sessionId/approvals/allowlist",
    async (req, reply) => {
      const sessionId = req.params.sessionId;
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        return reply.code(400).send({ error: "missing session_id" });
      }
      const res = await opts.sidecarRegistry.requestAllowlist(sessionId, "list");
      if (!res.ok) {
        const transient =
          res.error === "allowlist request timed out" || res.error === "sidecar disconnected";
        return reply.code(transient ? 503 : 404).send({ error: res.error });
      }
      return reply.send({ enabled: res.enabled, entries: res.entries });
    },
  );

  // PAL-v2: 永続承認の in-UI 失効 (revoke)。除去は新規 grant を作らない安全方向。
  //   signature は sha256 hex を厳格検証 (garbage relay 防止)。repo_scope 省略時は全 scope の同一署名。
  //   revoke 後の最新一覧を 1 応答で返す (UI が即時更新できる)。enabled OFF でも revoke 可 (dormant 掃除)。
  app.post<{
    Params: { sessionId: string };
    Body: { signature?: string; repo_scope?: string };
  }>("/realtime/sessions/:sessionId/approvals/allowlist/revoke", async (req, reply) => {
    const sessionId = req.params.sessionId;
    if (typeof sessionId !== "string" || sessionId.length === 0) {
      return reply.code(400).send({ error: "missing session_id" });
    }
    const body = req.body ?? {};
    const signature = body.signature;
    if (typeof signature !== "string" || !/^[0-9a-f]{64}$/.test(signature)) {
      return reply.code(400).send({ error: "invalid signature (expected sha256 hex)" });
    }
    // repo_scope は省略可。指定時は sha256 短縮 (hex) のみ許容 (それ以外は無視=全 scope 失効)。
    const repoScope =
      typeof body.repo_scope === "string" && /^[0-9a-f]{1,64}$/.test(body.repo_scope)
        ? body.repo_scope
        : undefined;
    const res = await opts.sidecarRegistry.requestAllowlist(
      sessionId,
      "revoke",
      signature,
      repoScope,
    );
    if (!res.ok) {
      const transient =
        res.error === "allowlist request timed out" || res.error === "sidecar disconnected";
      return reply.code(transient ? 503 : 404).send({ error: res.error });
    }
    return reply.send({ enabled: res.enabled, entries: res.entries, removed: res.removed ?? 0 });
  });

  // 段階1 (ADR 019ead14 D1): 横断 Approval Inbox の集約 pull。
  //   connected(接続在席)かつ pending_approvals 非空の全 session の承認待ちを 1 応答へ集約する。
  //   REALTIME_TOKEN gate (上の onRequest) 背後。session_state.pending_approvals(sidecar redaction
  //   済 jsonb)を再利用するため **新 redaction 面ゼロ**(backend は再 redaction しない)。
  //   approve の中継は既存 /realtime/ws の approve フレーム(relayApproval)をそのまま使う
  //   (Inbox 入口が増えても relay 境界=canRelay は session_id で不変・INV-REALTIME-RELAY-SCOPE)。
  app.get("/realtime/approvals", async (_req, reply) => {
    const isLive = (sid: string): boolean => opts.sidecarRegistry.isLive(sid);
    const approvals = await opts.store.approvalsSnapshot(isLive);
    return reply.send({ approvals });
  });

  // 段階1 (ADR 019ead7a D1): Live Wall の横断フィード集約 pull。
  //   connected(接続在席=isLive)な全 live session の **直近 N events** を 1 応答へ横断集約する。
  //   REALTIME_TOKEN gate (上の onRequest) 背後。データ源は既存 events の allow-list 投影
  //   (ReplayEventDTO) を再利用するため **新 redaction 面ゼロ**(backend は再 redaction しない)。
  //   presence は listSnapshot の connected で絞り (切断/履歴は出さない)、横断 session 数は
  //   MAX_WALL_SESSIONS、per-session 行数は per_session(既定/上限あり)で有界化する(back-pressure)。
  app.get<{ Querystring: { per_session?: string } }>("/realtime/wall", async (req, reply) => {
    const isLive = (sid: string): boolean => opts.sidecarRegistry.isLive(sid);
    const list = await opts.store.listSnapshot(undefined, isLive);
    const connected = list.filter((s) => s.connected).slice(0, MAX_WALL_SESSIONS);
    const ids = connected.map((s) => s.session_id);
    const perSession = normalizeWallPerSession(req.query.per_session);
    const eventsBySession = await opts.replayStore.recentEventsForSessions(ids, perSession);
    const lanes = connected.map((session) => ({
      session,
      events: eventsBySession.get(session.session_id) ?? [],
    }));
    return reply.send({ lanes });
  });

  // 強み(a) 監査ビュー (ADR 019ed1f9): 期間/複数セッションのガバナンス監査集約 pull。
  //   REALTIME_TOKEN gate (上の onRequest) 背後。データ源は sessions/session_state/events の
  //   allow-list 投影 (redacted-at-rest) のみで **新 redaction 面ゼロ** (backend は再 redaction しない)。
  //   redaction kind 別件数は closed-enum gate を再適用 (SEC-1r 二重防御)。
  //   ?format=csv で監査台帳 CSV (集計値・enum・メタのみ・原文非載せ = INV-AUDIT-EXPORT-NO-RAW)。
  app.get<{ Querystring: { from?: string; to?: string; limit?: string; format?: string } }>(
    "/realtime/audit/sessions",
    async (req, reply) => {
      try {
        const from = normalizeAuditInstant(req.query.from);
        const to = normalizeAuditInstant(req.query.to);
        const report = await opts.auditStore.rangeReport({
          ...(from !== undefined ? { from } : {}),
          ...(to !== undefined ? { to } : {}),
          limit: normalizeAuditLimit(req.query.limit),
          now: new Date().toISOString(),
        });
        return sendAudit(reply, report, req.query.format, "audit-sessions");
      } catch (err) {
        // SEC-1: 監査クエリ失敗時に pg/内部エラー詳細をクライアントへ返さない (静的 500・内部はログのみ)。
        req.log.error({ err }, "audit range query failed");
        return reply.code(500).send({ error: "internal error" });
      }
    },
  );

  // 1 セッションの監査詳細 (承認エントリ allow-list 込み)。?format=csv は当該 1 行の CSV。
  app.get<{ Params: { sessionId: string }; Querystring: { format?: string } }>(
    "/realtime/audit/sessions/:sessionId",
    async (req, reply) => {
      try {
        const sessionId = req.params.sessionId;
        if (typeof sessionId !== "string" || sessionId.length === 0) {
          return reply.code(400).send({ error: "missing session_id" });
        }
        const summary = await opts.auditStore.sessionSummary(sessionId, { detail: true });
        if (summary === undefined) return reply.code(404).send({ error: "session not found" });
        if ((req.query.format ?? "").toLowerCase() === "csv") {
          // CSV は range レポート整形を単一セッションで再利用 (列契約を一本化)。
          const single: AuditRangeReport = {
            from: undefined,
            to: undefined,
            generated_at: new Date().toISOString(),
            session_count: 1,
            totals: {
              secret_redaction_count: summary.secret_redaction_count,
              secret_redaction_count_by_kind: summary.secret_redaction_count_by_kind,
              approvals_by_decision: summary.approvals.by_decision,
              approval_total: summary.approvals.total,
              high_risk_op_count: summary.high_risk_op_count,
              sessions_with_secret: summary.secret_detected ? 1 : 0,
            },
            sessions: [summary],
            limit: 1,
            has_more: false,
          };
          return sendCsv(reply, auditReportToCsv(single), `audit-${sessionId}`);
        }
        return reply.send(summary);
      } catch (err) {
        req.log.error({ err }, "audit session query failed");
        return reply.code(500).send({ error: "internal error" });
      }
    },
  );

  // 強み(a) 監査ビュー drill-down (decision 019f03cc): kind 別件数 → 個別イベント展開。
  //   監査詳細の `high-entropy-secret ×N` 等から「どのイベントで・いつ」その redaction が起きたかを
  //   辿る。REALTIME_TOKEN gate (上の onRequest) 背後。kind は closed-enum (REDACTION_KINDS) で検証し
  //   未知/不正は 400 (phantom kind をスキャンしない)。per-event 件数は at-rest redacted マーカー
  //   (`[REDACTED:<kind>]`) から再導出し、backend は再 redaction しない。原文非載せ
  //   (INV-AUDIT-EXPORT-NO-RAW): kind enum + 非負件数 + redacted command/path のみ。
  app.get<{
    Params: { sessionId: string };
    Querystring: { kind?: string; limit?: string };
  }>("/realtime/audit/sessions/:sessionId/redactions", async (req, reply) => {
    try {
      const sessionId = req.params.sessionId;
      if (typeof sessionId !== "string" || sessionId.length === 0) {
        return reply.code(400).send({ error: "missing session_id" });
      }
      const kind = normalizeRedactionKind(req.query.kind);
      if (kind === undefined) {
        return reply.code(400).send({ error: "invalid or missing kind" });
      }
      const result = await opts.auditStore.redactionOccurrences({
        sessionId,
        kind,
        limit: normalizeRedactionOccurrenceLimit(req.query.limit),
      });
      return reply.send(result);
    } catch (err) {
      req.log.error({ err }, "audit redaction occurrences query failed");
      return reply.code(500).send({ error: "internal error" });
    }
  });
}

/** 監査レポートを JSON か CSV (?format=csv) で返す。 */
function sendAudit(
  reply: FastifyReply,
  report: AuditRangeReport,
  format: string | undefined,
  basename: string,
): unknown {
  if ((format ?? "").toLowerCase() === "csv") {
    return sendCsv(reply, auditReportToCsv(report), basename);
  }
  return reply.send(report);
}

/** CSV を text/csv + ダウンロード Content-Disposition で返す。 */
function sendCsv(reply: FastifyReply, csv: string, basename: string): unknown {
  // SEC-1r2: Content-Disposition filename へ補間する前に allow-list 文字へ畳む。basename には
  //   無検証の session_id (URL param 由来) が混ざりうるため、裸の `"`/`;`/制御文字で filename
  //   パラメータ injection されないよう英数._- 以外を `_` 化する (空なら "audit" にフォールバック)。
  const safeName = basename.replace(/[^A-Za-z0-9._-]/g, "_") || "audit";
  return reply
    .header("content-type", "text/csv; charset=utf-8")
    .header("content-disposition", `attachment; filename="${safeName}.csv"`)
    .send(csv);
}

/** UI からの 1 フレームを処理する (subscribe/unsubscribe/approve/interrupt)。 */
async function handleClientFrame(
  raw: Buffer,
  opts: RealtimeRouteOptions,
  handle: ReturnType<RealtimeHub["register"]>,
): Promise<void> {
  let frame: ClientFrame;
  try {
    frame = JSON.parse(raw.toString("utf8")) as ClientFrame;
  } catch {
    return; // 不正 JSON は黙殺 (接続維持)。
  }
  switch (frame.type) {
    case "subscribe": {
      if (typeof frame.session_id !== "string" || frame.session_id.length === 0) {
        opts.hub.sendAck(handle, {
          type: "ack",
          action: "subscribe",
          ok: false,
          error: "missing session_id",
        });
        return;
      }
      handle.subscribe(frame.session_id);
      // subscribe 直後に detail snapshot を送る (購読登録の後に送ることで以降の
      // delta.detail を取りこぼさない: 登録 → snapshot → delta の順)。
      try {
        const detail = await opts.store.detail(frame.session_id, (sid) =>
          opts.sidecarRegistry.isLive(sid),
        );
        if (detail) opts.hub.sendDetailSnapshot(handle, frame.session_id, detail);
      } catch {
        // snapshot 失敗でも購読は有効。以降の delta で追従する。
      }
      opts.hub.sendAck(handle, {
        type: "ack",
        action: "subscribe",
        ok: true,
        session_id: frame.session_id,
      });
      return;
    }
    case "unsubscribe": {
      if (typeof frame.session_id === "string") handle.unsubscribe(frame.session_id);
      opts.hub.sendAck(handle, {
        type: "ack",
        action: "unsubscribe",
        ok: true,
        session_id: frame.session_id,
      });
      return;
    }
    case "approve": {
      relayApprove(frame, opts, handle);
      return;
    }
    case "interrupt": {
      relayInterrupt(frame, opts, handle);
      return;
    }
    default:
      // 未知 type は黙殺 (接続維持)。
      return;
  }
}

/** UI 承認を T1 検証してから sidecar へ中継 (INV-APPROVAL)。 */
function relayApprove(
  frame: Extract<ClientFrame, { type: "approve" }>,
  opts: RealtimeRouteOptions,
  handle: ReturnType<RealtimeHub["register"]>,
): void {
  const { session_id, request_id, decision, reason, persist } = frame;
  // T1 ApprovalDecision でない decision は中継しない (不正承認の注入を遮断)。
  if (
    typeof session_id !== "string" ||
    typeof request_id !== "string" ||
    typeof decision !== "string" ||
    !VALID_DECISIONS.has(decision)
  ) {
    opts.hub.sendAck(handle, {
      type: "ack",
      action: "approve",
      ok: false,
      ...(typeof session_id === "string" ? { session_id } : {}),
      ...(typeof request_id === "string" ? { request_id } : {}),
      error: "invalid approval (session_id/request_id/decision)",
    });
    return;
  }
  const res = opts.sidecarRegistry.relayApproval({
    session_id,
    request_id,
    decision,
    ...(typeof reason === "string" ? { reason } : {}),
    // ADR 019ee0c0: persist は boolean のときのみ中継 (sidecar が最終 eligibility 判定)。
    ...(persist === true ? { persist: true } : {}),
  });
  opts.hub.sendAck(handle, {
    type: "ack",
    action: "approve",
    ok: res.ok,
    session_id,
    request_id,
    ...(res.error ? { error: res.error } : {}),
  });
}

/** UI interrupt を sidecar へ中継 (承認と同じ認可境界)。 */
function relayInterrupt(
  frame: Extract<ClientFrame, { type: "interrupt" }>,
  opts: RealtimeRouteOptions,
  handle: ReturnType<RealtimeHub["register"]>,
): void {
  const { session_id } = frame;
  if (typeof session_id !== "string" || session_id.length === 0) {
    opts.hub.sendAck(handle, {
      type: "ack",
      action: "interrupt",
      ok: false,
      error: "missing session_id",
    });
    return;
  }
  const res = opts.sidecarRegistry.relayInterrupt(session_id);
  opts.hub.sendAck(handle, {
    type: "ack",
    action: "interrupt",
    ok: res.ok,
    session_id,
    ...(res.error ? { error: res.error } : {}),
  });
}
