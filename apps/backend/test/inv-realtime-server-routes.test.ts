/**
 * INV-REALTIME pull-route guards (純ロジック・DB/WS 不要): registerRealtimeRoute の
 * HTTP ハンドラ分岐を偽 store/replay-store と REAL SidecarRegistry で固定する。
 *
 * 縛る不変条件 (falsifiable・mutation で赤):
 *  - INV-REALTIME-PARAM-GUARD: `/events` `/commands/:eventId/output` `/diff` は空 session_id
 *    (URL `/realtime/sessions//…`) を 400 `missing session_id` で fail-safe に弾く (本文を出さない)。
 *    各ガード (realtime-server.ts:102/128/148) を外す mutation で赤。
 *  - INV-DETAIL-OUTPUT-NO-ANCHOR: command output route は **空 eventId** (URL `…/commands//output`)
 *    のとき eventId を anchor として渡さず whole-session モードへ落とす (realtime-server.ts:133 の
 *    `eventId.length > 0` 偽枝)。anchor 強制 mutation で渡し方が変わると偽の anchor が混入し赤。
 *  - INV-DETAIL-DIFF-TRANSIENT: 登録済だが link が切断中 (`sidecar disconnected`) の diff は **503**
 *    (一時不調) で返す。未登録 (`session not registered`) は 404。transient 判定 (realtime-server.ts:157)
 *    を外す mutation で 404↔503 が入れ替わり赤。
 *  - INV-WALL-EMPTY-LANE: connected だが events を 1 件も持たない session も wall レーンに現れ、
 *    events は空配列で返る (realtime-server.ts:190 の `?? []` フォールバック)。`?? []` を外す mutation
 *    (undefined 素通り) で lane.events が非配列となり赤。
 *
 * REAL DATA ONLY 規律: 本 suite は backend ルーティング/ガードの純ロジックを対象とし、PG/WS の
 * 振る舞い (集約 SQL・redaction・presence) は real-PG e2e (inv-detail-pull / inv-wall /
 * inv-replay-history / inv-realtime-server) が実データで担保する。ここでは store/replay-store の
 * **返り値形状のみ**を偽装し、ルート層の分岐到達を決定論的に固定する (DB 未到達でも実走する)。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";

import type { FastifyInstance } from "fastify";

import type { ReplayEventDTO } from "../src/replay-contract.js";
import type { RealtimeHub } from "../src/realtime-hub.js";
import type { ReplayStore } from "../src/replay-store.js";
import type { AuditStore } from "../src/audit-store.js";
import type { RealtimeStore } from "../src/realtime-store.js";
import { registerRealtimeRoute } from "../src/realtime-server.js";
import { SidecarRegistry, type SidecarLink } from "../src/sidecar-registry.js";

const REALTIME_TOKEN = "test-realtime-token-routes-abcdefghij";

/** open を切替え可能な偽 sidecar link (切断中= open:false を再現)。送信は捨てる。 */
class MutableLink implements SidecarLink {
  open = true;
  send(_data: string): void {
    /* relay 送信先は本 suite の対象外 (registry の open ゲートのみ検証)。 */
  }
}

/**
 * listSnapshot の最小 SessionListItem を作る (route が触る session_id/connected のみ load-bearing)。
 * 他フィールドは route を素通りするだけなのでプレースホルダで埋める。
 */
function listItem(session_id: string, connected: boolean): Record<string, unknown> {
  return {
    session_id,
    provider: "claude_code",
    source: "hooks",
    agent_id: undefined,
    repo: undefined,
    branch: undefined,
    cwd: undefined,
    state: "running.model_wait",
    current_action: undefined,
    last_event_at: undefined,
    needs_attention: false,
    liveness_state: "live",
    stalled_suspected: false,
    connected,
    capture_mode: undefined,
  };
}

interface FakeReplayCalls {
  commandOutputArgs: Array<{ sessionId: string; eventId?: string; tail: number }>;
}

describe("INV-REALTIME pull-route guards (fakes + real SidecarRegistry)", () => {
  let app: FastifyInstance;
  let registry: SidecarRegistry;

  beforeEach(() => {
    registry = new SidecarRegistry();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  /** 共通: registerRealtimeRoute を websocket plugin 配下で mount する。 */
  async function mount(deps: {
    listSnapshot?: Array<Record<string, unknown>>;
    recent?: Map<string, ReplayEventDTO[]>;
    calls?: FakeReplayCalls;
    auditStore?: AuditStore;
  }): Promise<FakeReplayCalls> {
    const calls: FakeReplayCalls = deps.calls ?? { commandOutputArgs: [] };
    const store = {
      listSnapshot: async () => deps.listSnapshot ?? [],
    } as unknown as RealtimeStore;
    const replayStore = {
      eventsPage: async () => ({
        events: [],
        order: "timestamp_event_id_asc",
        next_cursor: null,
      }),
      commandOutput: async (o: { sessionId: string; eventId?: string; tail: number }) => {
        calls.commandOutputArgs.push(o);
        return {
          output_excerpt: "",
          anchor_event_id: undefined,
          truncated: false,
          not_found: false,
        };
      },
      recentEventsForSessions: async () => deps.recent ?? new Map<string, ReplayEventDTO[]>(),
    } as unknown as ReplayStore;
    const auditStore =
      deps.auditStore ??
      ({
        rangeReport: async () => ({
          from: undefined,
          to: undefined,
          generated_at: "1970-01-01T00:00:00.000Z",
          session_count: 0,
          totals: {
            secret_redaction_count: 0,
            secret_redaction_count_by_kind: {},
            approvals_by_decision: { allow: 0, allow_for_session: 0, deny: 0, cancel: 0 },
            approval_total: 0,
            high_risk_op_count: 0,
            sessions_with_secret: 0,
          },
          sessions: [],
          limit: 100,
          has_more: false,
        }),
        sessionSummary: async () => undefined,
      } as unknown as AuditStore);
    const hub = {
      register: () => ({ subscribe() {}, unsubscribe() {}, remove() {} }),
      sendListSnapshot() {},
      sendDetailSnapshot() {},
      sendAck() {},
    } as unknown as RealtimeHub;

    app = Fastify();
    // registerRealtimeRoute は /realtime/ws を websocket route として宣言するため plugin が要る。
    await app.register(fastifyWebsocket);
    registerRealtimeRoute(app, {
      realtimeToken: REALTIME_TOKEN,
      hub,
      store,
      replayStore,
      auditStore,
      sidecarRegistry: registry,
    });
    await app.ready();
    return calls;
  }

  const auth = { authorization: `Bearer ${REALTIME_TOKEN}` };

  // --- INV-REALTIME-PARAM-GUARD: 空 session_id は 400 (本文を出さない) ----------------------
  it("events: empty session_id → 400 missing session_id", async () => {
    await mount({});
    const res = await app.inject({
      method: "GET",
      url: "/realtime/sessions//events",
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "missing session_id" });
  });

  it("command output: empty session_id → 400 missing session_id", async () => {
    await mount({});
    const res = await app.inject({
      method: "GET",
      url: "/realtime/sessions//commands/e1/output",
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "missing session_id" });
  });

  it("diff: empty session_id → 400 missing session_id", async () => {
    await mount({});
    const res = await app.inject({ method: "GET", url: "/realtime/sessions//diff", headers: auth });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "missing session_id" });
  });

  // --- INV-DETAIL-OUTPUT-NO-ANCHOR: 空 eventId は anchor として渡さない (whole-session) --------
  it("command output: empty eventId → no anchor passed to commandOutput (whole-session mode)", async () => {
    const calls = await mount({});
    const res = await app.inject({
      method: "GET",
      url: "/realtime/sessions/sess_x/commands//output",
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(calls.commandOutputArgs).toHaveLength(1);
    const arg = calls.commandOutputArgs[0]!;
    expect(arg.sessionId).toBe("sess_x");
    // 空 eventId は anchor として渡らない (eventId キー自体が省かれる = whole-session)。
    expect("eventId" in arg).toBe(false);
  });

  it("command output: non-empty eventId → anchor passed through", async () => {
    const calls = await mount({});
    const res = await app.inject({
      method: "GET",
      url: "/realtime/sessions/sess_x/commands/evt-123/output",
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const arg = calls.commandOutputArgs[0]!;
    expect(arg.eventId).toBe("evt-123");
  });

  // --- INV-DETAIL-DIFF-TRANSIENT: 切断中 link は 503 / 未登録は 404 -------------------------
  it("diff: registered but disconnected link → 503 (transient), not 404", async () => {
    const link = new MutableLink();
    registry.add(link);
    registry.handleHello(link, {
      type: "hello",
      control_token: "ctl-routes-disc",
      session_ids: ["sess_disc"],
    });
    // 登録は保ったまま link を切断状態にする (close イベント未到達の半切断窓を再現)。
    link.open = false;

    await mount({});
    const res = await app.inject({
      method: "GET",
      url: "/realtime/sessions/sess_disc/diff",
      headers: auth,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: "sidecar disconnected" });
  });

  it("diff: unregistered session → 404 (not transient)", async () => {
    await mount({});
    const res = await app.inject({
      method: "GET",
      url: "/realtime/sessions/sess_never/diff",
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "session not registered" });
  });

  // --- INV-WALL-EMPTY-LANE: connected だが events 0 の session も空配列レーンで現れる -----------
  it("wall: connected session with no events yields a lane with empty events array", async () => {
    // SidecarRegistry が当該 session を live と判定するよう登録する (route の isLive=registry.isLive)。
    const link = new MutableLink();
    registry.add(link);
    registry.handleHello(link, {
      type: "hello",
      control_token: "ctl-routes-wall",
      session_ids: ["sess_empty"],
    });
    // listSnapshot は connected=true の session を 1 件返すが recentEventsForSessions は空 Map。
    await mount({ listSnapshot: [listItem("sess_empty", true)], recent: new Map() });

    const res = await app.inject({ method: "GET", url: "/realtime/wall", headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      lanes: Array<{ session: { session_id: string }; events: unknown }>;
    };
    const lane = body.lanes.find((l) => l.session.session_id === "sess_empty");
    expect(lane).toBeDefined();
    // `?? []` フォールバックで events は (undefined でなく) 空配列。
    expect(Array.isArray(lane!.events)).toBe(true);
    expect(lane!.events).toEqual([]);
  });

  // --- 強み(a) 監査ビュー route guards (QA-5: fake を実 GET で live 化 / SEC-1: エラー漏洩防止) ----
  it("audit sessions: missing token → 401 (onRequest Bearer gate が /realtime/audit を被覆)", async () => {
    await mount({});
    const res = await app.inject({ method: "GET", url: "/realtime/audit/sessions" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "unauthorized" });
  });

  it("audit sessions: authed → 200 で range レポート形状 (fake store)", async () => {
    await mount({});
    const res = await app.inject({ method: "GET", url: "/realtime/audit/sessions", headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { session_count: number; sessions: unknown[] };
    expect(body.session_count).toBe(0);
    expect(Array.isArray(body.sessions)).toBe(true);
  });

  // SEC-1: store が throw しても pg/内部エラー詳細を本文へ漏らさない (静的 500)。
  //   try/catch を外す mutation で Fastify 既定 handler が message/code を echo し赤化する。
  it("audit sessions: store throws → 500 静的本文 (pg 内部詳細を漏らさない) [SEC-1]", async () => {
    const SECRET_DETAIL = 'invalid input syntax for type timestamptz: "LEAKME-PGDETAIL"';
    const throwing = {
      rangeReport: async () => {
        const e = new Error(SECRET_DETAIL) as Error & { code?: string };
        e.code = "22007";
        throw e;
      },
      sessionSummary: async () => undefined,
    } as unknown as AuditStore;
    await mount({ auditStore: throwing });
    const res = await app.inject({ method: "GET", url: "/realtime/audit/sessions", headers: auth });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: "internal error" });
    expect(res.body).not.toContain("LEAKME-PGDETAIL");
    expect(res.body).not.toContain("22007");
    expect(res.body).not.toContain("timestamptz");
  });

  it("audit session detail: store throws → 500 静的本文 (内部詳細を漏らさない) [SEC-1]", async () => {
    const throwing = {
      rangeReport: async () => {
        throw new Error("unused");
      },
      sessionSummary: async () => {
        throw new Error("LEAKME-DETAIL-PGSTATE");
      },
    } as unknown as AuditStore;
    await mount({ auditStore: throwing });
    const res = await app.inject({
      method: "GET",
      url: "/realtime/audit/sessions/sess_x",
      headers: auth,
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: "internal error" });
    expect(res.body).not.toContain("LEAKME-DETAIL-PGSTATE");
  });

  // SEC-1r2: 単一セッション CSV export の Content-Disposition filename へ無検証 session_id を
  //   補間しない (allow-list 文字へ sanitize)。sanitize を外す mutation で裸の `"` が出て赤化する。
  it("audit session CSV: 危険な session_id を Content-Disposition filename で sanitize する [SEC-1r2]", async () => {
    const summary = {
      session_id: "x",
      provider: "claude_code",
      source: "hooks",
      secret_detected: false,
      secret_redaction_count: 0,
      secret_redaction_count_by_kind: {},
      approvals: {
        total: 0,
        by_decision: { allow: 0, allow_for_session: 0, deny: 0, cancel: 0 },
        pending: 0,
      },
      high_risk_op_count: 0,
    };
    const fake = {
      rangeReport: async () => {
        throw new Error("unused");
      },
      sessionSummary: async () => summary,
    } as unknown as AuditStore;
    await mount({ auditStore: fake });
    const res = await app.inject({
      method: "GET",
      url: `/realtime/audit/sessions/${encodeURIComponent('evil"; bad=1')}?format=csv`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const cd = res.headers["content-disposition"] as string;
    // sanitize 後は英数._- のみ → 注入 `"`/`;`/space は `_` 化される。
    expect(cd).toBe('attachment; filename="audit-evil___bad_1.csv"');
    expect(cd).not.toContain('"; bad'); // 裸の `"` で filename を早期に閉じない
  });

  // --- PAL-v2 (ADR 019ee147・QA-2): allowlist list/revoke route guards ----------------------
  const SIG64 = "a".repeat(64);

  it("allowlist list: unregistered session → 404 (not registered)", async () => {
    await mount({});
    const res = await app.inject({
      method: "GET",
      url: "/realtime/sessions/sess_never/approvals/allowlist",
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "session not registered" });
  });

  it("allowlist list: registered but disconnected link → 503 (transient)", async () => {
    const link = new MutableLink();
    registry.add(link);
    registry.handleHello(link, {
      type: "hello",
      control_token: "ctl-al-disc",
      session_ids: ["sess_al_disc"],
    });
    link.open = false;
    await mount({});
    const res = await app.inject({
      method: "GET",
      url: "/realtime/sessions/sess_al_disc/approvals/allowlist",
      headers: auth,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: "sidecar disconnected" });
  });

  it("allowlist list: success round-trip returns {enabled, entries} (NO-RAW)", async () => {
    // send で allowlist.request を捕捉し即 resolveAllowlist する応答 link (round-trip 成立)。
    class RespondingLink implements SidecarLink {
      open = true;
      send(data: string): void {
        const m = JSON.parse(data) as { type?: string; request_id?: string };
        if (m.type === "allowlist.request" && typeof m.request_id === "string") {
          const rid = m.request_id;
          queueMicrotask(() =>
            registry.resolveAllowlist({
              request_id: rid,
              enabled: true,
              entries: [
                {
                  signature: SIG64,
                  repo_scope: "scopeX",
                  repo_label: "repoX",
                  risk: "medium",
                  created_at_ms: 1,
                  expires_at_ms: 2,
                  command: "rm -rf / SHOULD_NOT_LEAK", // 敵対余剰 raw
                },
              ],
            }),
          );
        }
      }
    }
    const link = new RespondingLink();
    registry.add(link);
    registry.handleHello(link, {
      type: "hello",
      control_token: "ctl-al-ok",
      session_ids: ["sess_al_ok"],
    });
    await mount({});
    const res = await app.inject({
      method: "GET",
      url: "/realtime/sessions/sess_al_ok/approvals/allowlist",
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { enabled: boolean; entries: Array<Record<string, unknown>> };
    expect(body.enabled).toBe(true);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]!.signature).toBe(SIG64);
    // NO-RAW: backend 投影が敵対余剰 raw を落とす。
    expect(JSON.stringify(body)).not.toContain("SHOULD_NOT_LEAK");
  });

  it("allowlist revoke: non-hex signature → 400 (relay されない)", async () => {
    await mount({});
    const res = await app.inject({
      method: "POST",
      url: "/realtime/sessions/sess_any/approvals/allowlist/revoke",
      headers: auth,
      payload: { signature: "not-a-sha256" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid signature (expected sha256 hex)" });
  });

  it("allowlist revoke: missing signature → 400", async () => {
    await mount({});
    const res = await app.inject({
      method: "POST",
      url: "/realtime/sessions/sess_any/approvals/allowlist/revoke",
      headers: auth,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("allowlist revoke: valid signature on unregistered session → 404", async () => {
    await mount({});
    const res = await app.inject({
      method: "POST",
      url: "/realtime/sessions/sess_never/approvals/allowlist/revoke",
      headers: auth,
      payload: { signature: SIG64 },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "session not registered" });
  });
});
