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
    projectScope?: readonly string[];
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
      // 既定は空 scope (無制限) を明示注入し、env ACTRADECK_PROJECT_SCOPE の混入を排除して決定論化する。
      projectScope: deps.projectScope ?? [],
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

  // --- ADR 019f0c3e Phase 2: policy get/set routes (allowlist と対称) ------------------------
  it("policy get: empty session_id → 400 missing session_id", async () => {
    await mount({});
    const res = await app.inject({
      method: "GET",
      url: "/realtime/sessions//approvals/policy",
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "missing session_id" });
  });

  it("policy get: unregistered session → 404 (not registered)", async () => {
    await mount({});
    const res = await app.inject({
      method: "GET",
      url: "/realtime/sessions/sess_never/approvals/policy",
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });

  it("policy get: registered but disconnected link → 503 (transient)", async () => {
    const link = new MutableLink();
    registry.add(link);
    registry.handleHello(link, {
      type: "hello",
      control_token: "ctl-pol-disc",
      session_ids: ["sess_pol_disc"],
    });
    link.open = false;
    await mount({});
    const res = await app.inject({
      method: "GET",
      url: "/realtime/sessions/sess_pol_disc/approvals/policy",
      headers: auth,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: "sidecar disconnected" });
  });

  it("policy get: success round-trip returns {enabled, categories, env_gate_enabled} (closed-enum)", async () => {
    // send で policy.request を捕捉し即 resolvePolicy する応答 link。敵対 raw category を混ぜる。
    class RespondingLink implements SidecarLink {
      open = true;
      send(data: string): void {
        const m = JSON.parse(data) as { type?: string; request_id?: string };
        if (m.type === "policy.request" && typeof m.request_id === "string") {
          const rid = m.request_id;
          queueMicrotask(() =>
            registry.resolvePolicy({
              request_id: rid,
              enabled: true,
              categories: ["recursive-rm", "rm -rf / SHOULD_NOT_LEAK", "secret-egress"],
              env_gate_enabled: true,
            }),
          );
        }
      }
    }
    const link = new RespondingLink();
    registry.add(link);
    registry.handleHello(link, {
      type: "hello",
      control_token: "ctl-pol-ok",
      session_ids: ["sess_pol_ok"],
    });
    await mount({});
    const res = await app.inject({
      method: "GET",
      url: "/realtime/sessions/sess_pol_ok/approvals/policy",
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      enabled: boolean;
      categories: string[];
      env_gate_enabled: boolean;
    };
    expect(body.enabled).toBe(true);
    expect(body.categories).toEqual(["recursive-rm", "secret-egress"]); // closed-enum 投影 + 安定順。
    expect(body.env_gate_enabled).toBe(true);
    // 敵対 raw category は backend 投影で落ちる。
    expect(JSON.stringify(body)).not.toContain("SHOULD_NOT_LEAK");
  });

  it("QA-4: policy get で sidecar が error を返すと 404 (非 transient・error passthrough・route 層)", async () => {
    // relay 単体の error passthrough は別テスト。ここは route 層: sidecar 由来の error (timeout/disconnected
    // 以外) が 503 でなく 404 にマップされることを固定する (transient 判定の取り違えを捕捉)。
    class ErroringLink implements SidecarLink {
      open = true;
      send(data: string): void {
        const m = JSON.parse(data) as { type?: string; request_id?: string };
        if (m.type === "policy.request" && typeof m.request_id === "string") {
          const rid = m.request_id;
          queueMicrotask(() =>
            registry.resolvePolicy({ request_id: rid, error: "policy rejected" }),
          );
        }
      }
    }
    const link = new ErroringLink();
    registry.add(link);
    registry.handleHello(link, {
      type: "hello",
      control_token: "ctl-pol-err",
      session_ids: ["sess_pol_err"],
    });
    await mount({});
    const res = await app.inject({
      method: "GET",
      url: "/realtime/sessions/sess_pol_err/approvals/policy",
      headers: auth,
    });
    expect(res.statusCode).toBe(404); // sidecar error は非 transient → 404
  });

  it("policy set: non-boolean enabled → 400 (relay されない)", async () => {
    await mount({});
    const res = await app.inject({
      method: "POST",
      url: "/realtime/sessions/sess_any/approvals/policy/set",
      headers: auth,
      payload: { enabled: "yes" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid enabled (expected boolean)" });
  });

  it("policy set: non-array categories → 400", async () => {
    await mount({});
    const res = await app.inject({
      method: "POST",
      url: "/realtime/sessions/sess_any/approvals/policy/set",
      headers: auth,
      payload: { categories: "recursive-rm" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid categories (expected array)" });
  });

  it("policy set: valid body on unregistered session → 404 (relay 境界)", async () => {
    await mount({});
    const res = await app.inject({
      method: "POST",
      url: "/realtime/sessions/sess_never/approvals/policy/set",
      headers: auth,
      payload: { enabled: true, categories: ["recursive-rm"] },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "session not registered" });
  });

  it("policy set: success round-trip returns updated state", async () => {
    class RespondingLink implements SidecarLink {
      open = true;
      send(data: string): void {
        const m = JSON.parse(data) as {
          type?: string;
          request_id?: string;
          op?: string;
          categories?: unknown;
        };
        if (m.type === "policy.request" && typeof m.request_id === "string") {
          const rid = m.request_id;
          // set のとき送られた categories をそのまま反映して返す (sidecar の権威更新を模倣)。
          const cats = Array.isArray(m.categories) ? (m.categories as string[]) : [];
          queueMicrotask(() =>
            registry.resolvePolicy({
              request_id: rid,
              enabled: true,
              categories: cats,
              env_gate_enabled: true,
            }),
          );
        }
      }
    }
    const link = new RespondingLink();
    registry.add(link);
    registry.handleHello(link, {
      type: "hello",
      control_token: "ctl-pol-set",
      session_ids: ["sess_pol_set"],
    });
    await mount({});
    const res = await app.inject({
      method: "POST",
      url: "/realtime/sessions/sess_pol_set/approvals/policy/set",
      headers: auth,
      payload: { enabled: true, categories: ["disk-destroy", "db-drop"] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { enabled: boolean; categories: string[] };
    expect(body.enabled).toBe(true);
    expect(body.categories).toEqual(["disk-destroy", "db-drop"]);
  });

  // --- ADR 019f0eca per-repo policy routes (get?repo_scope / list / set repo / unset) -----------
  /**
   * policy.request を捕捉して `received` に最後の 1 件を記録し、即 resolvePolicy で応答する link。
   * repo_scope/op/repo_label の forward を assert するために使う (敵対 raw は混ぜない最小応答)。
   */
  class CapturingPolicyLink implements SidecarLink {
    open = true;
    received: Record<string, unknown> | undefined;
    constructor(
      private readonly reply: (msg: Record<string, unknown>) => Record<string, unknown>,
    ) {}
    send(data: string): void {
      const m = JSON.parse(data) as Record<string, unknown>;
      if (m.type === "policy.request" && typeof m.request_id === "string") {
        this.received = m;
        const rid = m.request_id;
        queueMicrotask(() => registry.resolvePolicy({ request_id: rid, ...this.reply(m) }));
      }
    }
  }

  it("per-repo get: ?repo_scope を relay へ forward し repo_scope/repo_label/is_override を返す", async () => {
    const link = new CapturingPolicyLink(() => ({
      enabled: true,
      categories: ["db-drop"],
      env_gate_enabled: true,
      repo_scope: "aaaa0001",
      repo_label: "sandbox",
      is_override: true,
    }));
    registry.add(link);
    registry.handleHello(link, {
      type: "hello",
      control_token: "ctl-pol-repo-get",
      session_ids: ["sess_pol_repo_get"],
    });
    await mount({});
    const res = await app.inject({
      method: "GET",
      url: "/realtime/sessions/sess_pol_repo_get/approvals/policy?repo_scope=aaaa0001",
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(link.received?.op).toBe("get");
    expect(link.received?.repo_scope).toBe("aaaa0001"); // hex は forward。
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      enabled: true,
      categories: ["db-drop"],
      repo_scope: "aaaa0001",
      repo_label: "sandbox",
      is_override: true,
    });
  });

  it("per-repo get: 不正 repo_scope は forward せず default 扱い (NO-RAW)", async () => {
    const link = new CapturingPolicyLink(() => ({
      enabled: true,
      categories: ["recursive-rm"],
      env_gate_enabled: true,
    }));
    registry.add(link);
    registry.handleHello(link, {
      type: "hello",
      control_token: "ctl-pol-repo-bad",
      session_ids: ["sess_pol_repo_bad"],
    });
    await mount({});
    // 生 path 風の不正 scope は弾かれ relay へ載らない (default を読む)。
    const res = await app.inject({
      method: "GET",
      url: "/realtime/sessions/sess_pol_repo_bad/approvals/policy?repo_scope=%2Fhome%2Fme",
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(link.received?.repo_scope).toBeUndefined(); // 非 hex は forward しない。
  });

  it("per-repo list: default + repos[] (closed-enum 投影) を返す", async () => {
    const link = new CapturingPolicyLink(() => ({
      enabled: true,
      categories: ["recursive-rm"],
      env_gate_enabled: true,
      repos: [
        {
          repo_scope: "aaaa0001",
          repo_label: "sandbox",
          enabled: true,
          categories: ["db-drop", "rm -rf SHOULD_NOT_LEAK"],
        },
      ],
    }));
    registry.add(link);
    registry.handleHello(link, {
      type: "hello",
      control_token: "ctl-pol-list",
      session_ids: ["sess_pol_list"],
    });
    await mount({});
    const res = await app.inject({
      method: "GET",
      url: "/realtime/sessions/sess_pol_list/approvals/policy/list",
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(link.received?.op).toBe("list");
    const body = res.json() as { repos: Array<{ repo_scope: string; categories: string[] }> };
    expect(body.repos).toHaveLength(1);
    expect(body.repos[0]!.repo_scope).toBe("aaaa0001");
    expect(body.repos[0]!.categories).toEqual(["db-drop"]); // raw は投影で落ちる。
    expect(JSON.stringify(body)).not.toContain("SHOULD_NOT_LEAK");
  });

  it("per-repo set: repo_scope/repo_label を relay へ forward する", async () => {
    const link = new CapturingPolicyLink((m) => ({
      enabled: true,
      categories: Array.isArray(m.categories) ? (m.categories as string[]) : [],
      env_gate_enabled: true,
      repo_scope: m.repo_scope,
      repo_label: m.repo_label,
      is_override: true,
    }));
    registry.add(link);
    registry.handleHello(link, {
      type: "hello",
      control_token: "ctl-pol-repo-set",
      session_ids: ["sess_pol_repo_set"],
    });
    await mount({});
    const res = await app.inject({
      method: "POST",
      url: "/realtime/sessions/sess_pol_repo_set/approvals/policy/set",
      headers: auth,
      payload: {
        enabled: true,
        categories: ["db-drop"],
        repo_scope: "bbbb0002",
        repo_label: "prod",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(link.received?.op).toBe("set");
    expect(link.received?.repo_scope).toBe("bbbb0002");
    expect(link.received?.repo_label).toBe("prod");
    expect(res.json()).toMatchObject({ repo_scope: "bbbb0002", is_override: true });
  });

  it("SEC-4: repo_label は basename へサニタイズして relay する (絶対パス/制御文字を at-rest へ載せない)", async () => {
    const link = new CapturingPolicyLink((m) => ({
      enabled: true,
      categories: [],
      env_gate_enabled: true,
      repo_scope: m.repo_scope,
      repo_label: m.repo_label,
      is_override: true,
    }));
    registry.add(link);
    registry.handleHello(link, {
      type: "hello",
      control_token: "ctl-pol-label",
      session_ids: ["sess_pol_label"],
    });
    await mount({});
    // 絶対パスは最終 path segment (basename) へ畳む。
    const r1 = await app.inject({
      method: "POST",
      url: "/realtime/sessions/sess_pol_label/approvals/policy/set",
      headers: auth,
      payload: { categories: [], repo_scope: "cccc0003", repo_label: "/home/me/secret-repo" },
    });
    expect(r1.statusCode).toBe(200);
    expect(link.received?.repo_label).toBe("secret-repo"); // 絶対パスは載らない。
    expect(String(link.received?.repo_label)).not.toContain("/");

    // 制御文字 (改行/復帰) は除去する (複数行注入を防ぐ)。
    const r2 = await app.inject({
      method: "POST",
      url: "/realtime/sessions/sess_pol_label/approvals/policy/set",
      headers: auth,
      payload: { categories: [], repo_scope: "cccc0003", repo_label: "evil\nname\r" },
    });
    expect(r2.statusCode).toBe(200);
    expect(link.received?.repo_label).toBe("evilname"); // 制御文字を除去。
  });

  it("per-repo set: 不正 repo_scope → 400 (relay されない)", async () => {
    await mount({});
    const res = await app.inject({
      method: "POST",
      url: "/realtime/sessions/sess_any/approvals/policy/set",
      headers: auth,
      payload: { categories: ["db-drop"], repo_scope: "/abs/path" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid repo_scope (expected sha256 hex)" });
  });

  it("per-repo unset: 正常 repo_scope を relay へ forward し更新後状態を返す", async () => {
    const link = new CapturingPolicyLink((m) => ({
      enabled: true,
      categories: ["recursive-rm"], // default 継承後。
      env_gate_enabled: true,
      repo_scope: m.repo_scope,
      is_override: false,
    }));
    registry.add(link);
    registry.handleHello(link, {
      type: "hello",
      control_token: "ctl-pol-unset",
      session_ids: ["sess_pol_unset"],
    });
    await mount({});
    const res = await app.inject({
      method: "POST",
      url: "/realtime/sessions/sess_pol_unset/approvals/policy/unset",
      headers: auth,
      payload: { repo_scope: "bbbb0002" },
    });
    expect(res.statusCode).toBe(200);
    expect(link.received?.op).toBe("unset");
    expect(link.received?.repo_scope).toBe("bbbb0002");
    expect(res.json()).toMatchObject({ is_override: false, categories: ["recursive-rm"] });
  });

  it("per-repo unset: repo_scope 欠落 → 400 (default は unset 不可)", async () => {
    await mount({});
    const res = await app.inject({
      method: "POST",
      url: "/realtime/sessions/sess_any/approvals/policy/unset",
      headers: auth,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: "invalid or missing repo_scope (expected sha256 hex)",
    });
  });

  // --- ADR 019f0eca 方式B: policy resolve route (path→scope・project-scope 封じ込め) -------------
  it("resolve: path 欠落 → 400 missing path", async () => {
    await mount({});
    const res = await app.inject({
      method: "POST",
      url: "/realtime/sessions/sess_any/approvals/policy/resolve",
      headers: auth,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "missing path" });
  });

  it("resolve: project-scope 外の path → 403 (relay されない・封じ込め)", async () => {
    const link = new CapturingPolicyLink(() => ({
      enabled: true,
      categories: [],
      env_gate_enabled: true,
    }));
    registry.add(link);
    registry.handleHello(link, {
      type: "hello",
      control_token: "ctl-pol-res-scope",
      session_ids: ["sess_pol_res_scope"],
    });
    await mount({ projectScope: ["/home/me/work"] });
    const res = await app.inject({
      method: "POST",
      url: "/realtime/sessions/sess_pol_res_scope/approvals/policy/resolve",
      headers: auth,
      payload: { path: "/home/me/secret" }, // scope 外。
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: "path outside project scope" });
    expect(link.received).toBeUndefined(); // relay されない。
  });

  it("resolve: scope 内 path を relay し scope+label+is_override を返す (path を echo しない)", async () => {
    const link = new CapturingPolicyLink((m) => {
      // sidecar 模倣: path を解決した体で scope+label+effective を返す (path は echo しない)。
      expect(typeof m.path).toBe("string");
      return {
        enabled: true,
        categories: ["recursive-rm"],
        env_gate_enabled: true,
        repo_scope: "abcdef012345",
        repo_label: "work",
        is_override: false,
      };
    });
    registry.add(link);
    registry.handleHello(link, {
      type: "hello",
      control_token: "ctl-pol-res-ok",
      session_ids: ["sess_pol_res_ok"],
    });
    await mount({ projectScope: ["/home/me/work"] });
    const res = await app.inject({
      method: "POST",
      url: "/realtime/sessions/sess_pol_res_ok/approvals/policy/resolve",
      headers: auth,
      payload: { path: "/home/me/work/sandbox" },
    });
    expect(res.statusCode).toBe(200);
    expect(link.received?.op).toBe("resolve");
    expect(link.received?.path).toBe("/home/me/work/sandbox"); // relay へ forward。
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      repo_scope: "abcdef012345",
      repo_label: "work",
      is_override: false,
    });
    // backend 応答に生 path を含めない (NO-RAW: scope/label のみ)。
    expect(JSON.stringify(body)).not.toContain("/home/me/work/sandbox");
  });

  it("resolve: scope 無制限 (projectScope 空) なら任意 path を relay する", async () => {
    const link = new CapturingPolicyLink((m) => ({
      enabled: true,
      categories: [],
      env_gate_enabled: true,
      repo_scope: "000000000000",
      repo_label: typeof m.path === "string" ? "anyrepo" : undefined,
      is_override: false,
    }));
    registry.add(link);
    registry.handleHello(link, {
      type: "hello",
      control_token: "ctl-pol-res-open",
      session_ids: ["sess_pol_res_open"],
    });
    await mount({ projectScope: [] }); // 無制限。
    const res = await app.inject({
      method: "POST",
      url: "/realtime/sessions/sess_pol_res_open/approvals/policy/resolve",
      headers: auth,
      payload: { path: "/anywhere/repo" },
    });
    expect(res.statusCode).toBe(200);
    expect(link.received?.path).toBe("/anywhere/repo");
  });

  it("resolve: sidecar が解決不能 error を返すと 404 (固定文言・非 transient)", async () => {
    const link = new CapturingPolicyLink(() => ({
      error: "path is not a resolvable git repository",
    }));
    registry.add(link);
    registry.handleHello(link, {
      type: "hello",
      control_token: "ctl-pol-res-err",
      session_ids: ["sess_pol_res_err"],
    });
    await mount({});
    const res = await app.inject({
      method: "POST",
      url: "/realtime/sessions/sess_pol_res_err/approvals/policy/resolve",
      headers: auth,
      payload: { path: "/not/a/repo" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "path is not a resolvable git repository" });
  });

  // --- ADR 019f1582: daemon-addressed policy relay routes -----------------------------------
  // session を所有しない接続中 daemon 経由で policy を設定できることを固定する。approve/interrupt/diff/
  // allowlist の daemon-addressed route は **存在しない** (session-scoped 維持・INV-REALTIME-RELAY-SCOPE)。
  it("GET /realtime/daemons: relay 可能な接続中 daemon の id を列挙する (session 不要)", async () => {
    const link = new MutableLink();
    registry.add(link);
    registry.handleHello(link, {
      type: "hello",
      control_token: "ctl-daemon-list",
      session_ids: [], // エージェント未稼働 = owned session ゼロ。
      policy_capable: true, // attach daemon = policy 対応 (connectedDaemons に含める)。
    });
    await mount({});
    const res = await app.inject({ method: "GET", url: "/realtime/daemons", headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { daemons: Array<{ id: string }> };
    expect(body.daemons).toHaveLength(1);
    expect(body.daemons[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  // SEC-3: daemon path も /realtime prefix の onRequest Bearer gate に服する。401 gate は
  // prefix 一括 (audit sessions の :282 で固定済) だが、daemon path 専用の no-token 401 を
  // 明示し belt-and-suspenders で回帰固定する (auth 隣接 L・co-land)。
  it("GET /realtime/daemons: missing token → 401 (prefix Bearer gate が daemon path も被覆)", async () => {
    await mount({});
    const res = await app.inject({ method: "GET", url: "/realtime/daemons" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "unauthorized" });
  });

  it("daemon policy get: 奇形 daemonId → 400 invalid daemon id", async () => {
    await mount({});
    const res = await app.inject({
      method: "GET",
      url: "/realtime/daemons/not-a-uuid/approvals/policy",
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid daemon id" });
  });

  it("daemon policy get: 未知 (整形済) daemonId → 404 daemon not registered", async () => {
    await mount({});
    const res = await app.inject({
      method: "GET",
      url: "/realtime/daemons/00000000-0000-0000-0000-000000000000/approvals/policy",
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "daemon not registered" });
  });

  it("daemon policy get: 接続中 daemon (session 無) 経由で success round-trip (closed-enum 投影)", async () => {
    class RespondingLink implements SidecarLink {
      open = true;
      send(data: string): void {
        const m = JSON.parse(data) as { type?: string; request_id?: string };
        if (m.type === "policy.request" && typeof m.request_id === "string") {
          const rid = m.request_id;
          queueMicrotask(() =>
            registry.resolvePolicy({
              request_id: rid,
              enabled: true,
              categories: ["recursive-rm", "rm -rf / SHOULD_NOT_LEAK", "secret-egress"],
              env_gate_enabled: true,
            }),
          );
        }
      }
    }
    const link = new RespondingLink();
    registry.add(link);
    registry.handleHello(link, {
      type: "hello",
      control_token: "ctl-daemon-ok",
      session_ids: [], // session 無しでも policy は応答できる (machine-global)。
      policy_capable: true, // policy 対応を広告 (connectedDaemons に含める)。
    });
    await mount({});
    const id = registry.connectedDaemons()[0].id;
    const res = await app.inject({
      method: "GET",
      url: `/realtime/daemons/${id}/approvals/policy`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      enabled: boolean;
      categories: string[];
      env_gate_enabled: boolean;
    };
    expect(body.enabled).toBe(true);
    expect(body.categories).toEqual(["recursive-rm", "secret-egress"]); // closed-enum 投影 + 安定順。
    expect(JSON.stringify(body)).not.toContain("SHOULD_NOT_LEAK"); // 敵対 raw は落ちる。
  });

  it("daemon policy list: 接続中 daemon (session 無) 経由で default + repos[] を返す (closed-enum 投影)", async () => {
    const link = new CapturingPolicyLink(() => ({
      enabled: true,
      categories: ["recursive-rm"],
      env_gate_enabled: true,
      repos: [
        {
          repo_scope: "cccc0003",
          repo_label: "agentless",
          enabled: true,
          categories: ["db-drop", "rm -rf SHOULD_NOT_LEAK"],
        },
      ],
    }));
    registry.add(link);
    registry.handleHello(link, {
      type: "hello",
      control_token: "ctl-daemon-list-op",
      session_ids: [], // session 無しでも list できる (machine-global)。
      policy_capable: true,
    });
    await mount({});
    const id = registry.connectedDaemons()[0]!.id;
    const res = await app.inject({
      method: "GET",
      url: `/realtime/daemons/${id}/approvals/policy/list`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(link.received?.op).toBe("list");
    const body = res.json() as { repos: Array<{ repo_scope: string; categories: string[] }> };
    expect(body.repos).toHaveLength(1);
    expect(body.repos[0]!.categories).toEqual(["db-drop"]); // raw は投影で落ちる。
    expect(JSON.stringify(body)).not.toContain("SHOULD_NOT_LEAK");
  });

  it("daemon policy set: 接続中 daemon 経由で repo_scope/repo_label を relay へ forward する", async () => {
    const link = new CapturingPolicyLink((m) => ({
      enabled: true,
      categories: Array.isArray(m.categories) ? (m.categories as string[]) : [],
      env_gate_enabled: true,
      repo_scope: m.repo_scope,
      repo_label: m.repo_label,
      is_override: true,
    }));
    registry.add(link);
    registry.handleHello(link, {
      type: "hello",
      control_token: "ctl-daemon-set-op",
      session_ids: [],
      policy_capable: true,
    });
    await mount({});
    const id = registry.connectedDaemons()[0]!.id;
    const res = await app.inject({
      method: "POST",
      url: `/realtime/daemons/${id}/approvals/policy/set`,
      headers: auth,
      payload: {
        enabled: true,
        categories: ["db-drop"],
        repo_scope: "dddd0004",
        repo_label: "prod",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(link.received?.op).toBe("set");
    expect(link.received?.repo_scope).toBe("dddd0004");
    expect(res.json()).toMatchObject({ repo_scope: "dddd0004", is_override: true });
  });

  it("daemon policy unset: 接続中 daemon 経由で repo_scope を relay へ forward し更新後状態を返す", async () => {
    const link = new CapturingPolicyLink((m) => ({
      enabled: true,
      categories: ["recursive-rm"],
      env_gate_enabled: true,
      repo_scope: m.repo_scope,
      is_override: false,
    }));
    registry.add(link);
    registry.handleHello(link, {
      type: "hello",
      control_token: "ctl-daemon-unset-op",
      session_ids: [],
      policy_capable: true,
    });
    await mount({});
    const id = registry.connectedDaemons()[0]!.id;
    const res = await app.inject({
      method: "POST",
      url: `/realtime/daemons/${id}/approvals/policy/unset`,
      headers: auth,
      payload: { repo_scope: "dddd0004" },
    });
    expect(res.statusCode).toBe(200);
    expect(link.received?.op).toBe("unset");
    expect(link.received?.repo_scope).toBe("dddd0004");
    expect(res.json()).toMatchObject({ is_override: false });
  });

  it("daemon policy resolve: 接続中 daemon 経由で path を git root 解決し scope+label を返す (path を echo しない)", async () => {
    const link = new CapturingPolicyLink((m) => {
      expect(typeof m.path).toBe("string");
      return {
        enabled: true,
        categories: ["recursive-rm"],
        env_gate_enabled: true,
        repo_scope: "eeee0005",
        repo_label: "agentless-repo",
        is_override: false,
      };
    });
    registry.add(link);
    registry.handleHello(link, {
      type: "hello",
      control_token: "ctl-daemon-resolve-op",
      session_ids: [],
      policy_capable: true,
    });
    await mount({ projectScope: [] }); // 無制限 (封じ込めは session resolve テストで個別検証済)。
    const id = registry.connectedDaemons()[0]!.id;
    const res = await app.inject({
      method: "POST",
      url: `/realtime/daemons/${id}/approvals/policy/resolve`,
      headers: auth,
      payload: { path: "/home/me/agentless-repo" },
    });
    expect(res.statusCode).toBe(200);
    expect(link.received?.op).toBe("resolve");
    expect(link.received?.path).toBe("/home/me/agentless-repo"); // relay へ forward。
    const body = res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ repo_scope: "eeee0005", repo_label: "agentless-repo" });
    expect(JSON.stringify(body)).not.toContain("/home/me/agentless-repo"); // NO-RAW: 生 path 非 echo。
  });

  it("daemon policy set/unset/resolve: 奇形 daemonId → 400 invalid daemon id (各 route の id ゲート)", async () => {
    await mount({});
    for (const path of ["set", "unset", "resolve"]) {
      const res = await app.inject({
        method: "POST",
        url: `/realtime/daemons/not-a-uuid/approvals/policy/${path}`,
        headers: auth,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: "invalid daemon id" });
    }
    const listRes = await app.inject({
      method: "GET",
      url: "/realtime/daemons/not-a-uuid/approvals/policy/list",
      headers: auth,
    });
    expect(listRes.statusCode).toBe(400);
    expect(listRes.json()).toMatchObject({ error: "invalid daemon id" });
  });

  it("回帰ガード: approve/interrupt/diff/allowlist の daemon-addressed route は存在しない (session-scoped 維持)", async () => {
    const link = new MutableLink();
    registry.add(link);
    registry.handleHello(link, {
      type: "hello",
      control_token: "ctl-daemon-guard",
      session_ids: [],
      policy_capable: true, // policy 対応を広告 (connectedDaemons に含める)。
    });
    await mount({});
    const id = registry.connectedDaemons()[0].id;
    // policy 以外を daemon-addressed しても route が無い → 404 (auth は通るが routing で no-match)。
    for (const url of [
      `/realtime/daemons/${id}/diff`,
      `/realtime/daemons/${id}/approvals/allowlist`,
    ]) {
      const res = await app.inject({ method: "GET", url, headers: auth });
      expect(res.statusCode).toBe(404);
    }
    const post = await app.inject({
      method: "POST",
      url: `/realtime/daemons/${id}/interrupt`,
      headers: auth,
      payload: {},
    });
    expect(post.statusCode).toBe(404);
  });
});
