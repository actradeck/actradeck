/**
 * INV-AUDIT report route ガード (純ロジック・DB/WS 不要): 単一セッション詳細レポート route
 * `/realtime/audit/sessions/:sessionId/report` の HTTP 分岐を偽 store と偽 SidecarRegistry で
 * 決定論的に固定する (P2 ADR 019f2326)。real-PG e2e (inv-audit-report-route) が実データ側を担保し、
 * 本 suite はルート層の分岐到達 (404 / 500 / pagination / diff on/off / format) を falsifiable に縛る。
 *
 * 縛る不変条件:
 *  - 空 session_id (`/sessions//report`) は 400 (本文を出さない)。
 *  - 未知 session (sessionSummary undefined) は 404。
 *  - sessionSummary throw は 500 静的エラー (内部詳細を漏らさない・catch 経路)。
 *  - 時系列は has_more の続き cursor を辿り、上限ページで打ち切る (events_truncated)。
 *  - ?diff=1: requestDiff ok → diff.available=true 投影 / not ok → available=false graceful (500 でない)。
 *  - ?diff 無指定は requestDiff を呼ばない (report は純読取り既定)。
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";

import type { FastifyInstance } from "fastify";

import type { AuditSessionSummary } from "../src/audit-contract.js";
import type { ReplayEventDTO, ReplayEventsPage } from "../src/replay-contract.js";
import type { RealtimeHub } from "../src/realtime-hub.js";
import type { ReplayStore } from "../src/replay-store.js";
import { encodeReplayCursor } from "../src/replay-store.js";
import type { AuditStore } from "../src/audit-store.js";
import type { RealtimeStore } from "../src/realtime-store.js";
import type { UsageStore } from "../src/usage-store.js";
import { registerRealtimeRoute } from "../src/realtime-server.js";
import type { DiffRelayResult, SidecarRegistry } from "../src/sidecar-registry.js";

const REALTIME_TOKEN = "test-realtime-token-report-abcdefghij";
const auth = { authorization: `Bearer ${REALTIME_TOKEN}` };

function summary(id = "sess_r"): AuditSessionSummary {
  return {
    session_id: id,
    provider: "claude_code",
    source: "hooks",
    agent_id: undefined,
    repo: undefined,
    branch: undefined,
    cwd: "/home/u/proj",
    capture_mode: undefined,
    permission_mode: undefined,
    state: "running.model_wait",
    started_at: undefined,
    ended_at: undefined,
    last_event_at: undefined,
    secret_detected: false,
    secret_redaction_count: 0,
    secret_redaction_count_by_kind: {},
    approvals: {
      total: 0,
      by_decision: { allow: 0, allow_for_session: 0, deny: 0, cancel: 0 },
      synthetic_retired: 0,
      pending: 0,
    },
    high_risk_op_count: 0,
    auto_allowed_count: 0,
    entries: [],
  };
}

function event(overrides: Partial<ReplayEventDTO> = {}): ReplayEventDTO {
  return {
    event_id: "ev",
    provider: "claude_code",
    source: "hooks",
    session_id: "sess_r",
    event_type: "command.started",
    kind: "command",
    timestamp: "2099-06-15T12:01:00.000Z",
    state: undefined,
    cwd: undefined,
    summary: undefined,
    display_text: "",
    subject: undefined,
    request_id: undefined,
    tool_name: "Bash",
    command: "echo [REDACTED:github-token]",
    path: undefined,
    risk_level: undefined,
    decision: undefined,
    auto_allowed: undefined,
    exit_code: 0,
    elapsed_ms: undefined,
    ...overrides,
  };
}

describe("INV-AUDIT-REPORT route guards (fakes)", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  async function mount(deps: {
    sessionSummary: () => Promise<AuditSessionSummary | undefined>;
    eventsPage?: () => Promise<ReplayEventsPage>;
    requestDiff?: (sid: string) => Promise<DiffRelayResult>;
    diffCalls?: { n: number };
  }): Promise<void> {
    const replayStore = {
      eventsPage:
        deps.eventsPage ??
        (async (): Promise<ReplayEventsPage> => ({
          session_id: "sess_r",
          order: "timestamp_event_id_asc",
          events: [event()],
          limit: 500,
          has_more: false,
          next_cursor: undefined,
        })),
    } as unknown as ReplayStore;
    const auditStore = { sessionSummary: deps.sessionSummary } as unknown as AuditStore;
    const sidecarRegistry = {
      isLive: () => false,
      requestDiff:
        deps.requestDiff ??
        (async (): Promise<DiffRelayResult> => {
          if (deps.diffCalls) deps.diffCalls.n += 1;
          return { ok: false, error: "session not registered" };
        }),
    } as unknown as SidecarRegistry;
    const store = { listSnapshot: async () => [] } as unknown as RealtimeStore;
    const hub = {
      register: () => ({ subscribe() {}, unsubscribe() {}, remove() {} }),
      sendListSnapshot() {},
      sendDetailSnapshot() {},
      sendAck() {},
    } as unknown as RealtimeHub;

    app = Fastify();
    await app.register(fastifyWebsocket);
    registerRealtimeRoute(app, {
      realtimeToken: REALTIME_TOKEN,
      hub,
      store,
      replayStore,
      auditStore,
      usageStore: {} as unknown as UsageStore,
      sidecarRegistry,
      projectScope: [],
    });
    await app.ready();
  }

  it("空 session_id (/sessions//report) → 400 missing session_id", async () => {
    await mount({ sessionSummary: async () => summary() });
    const res = await app.inject({
      method: "GET",
      url: "/realtime/audit/sessions//report",
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "missing session_id" });
  });

  it("未知 session → 404", async () => {
    await mount({ sessionSummary: async () => undefined });
    const res = await app.inject({
      method: "GET",
      url: "/realtime/audit/sessions/sess_r/report",
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });

  it("sessionSummary throw → 静的 500 (内部詳細を漏らさない)", async () => {
    await mount({
      sessionSummary: async () => {
        throw new Error("boom internal detail");
      },
    });
    const res = await app.inject({
      method: "GET",
      url: "/realtime/audit/sessions/sess_r/report",
      headers: auth,
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: "internal error" });
    expect(res.body).not.toContain("boom internal detail");
  });

  it("has_more の続き cursor を辿り、上限ページで events_truncated=true に倒す", async () => {
    // 常に has_more:true を返し、20 ページ (MAX_REPORT_PAGES) の continuation + 打ち切りを踏ませる。
    let calls = 0;
    await mount({
      sessionSummary: async () => summary(),
      eventsPage: async (): Promise<ReplayEventsPage> => {
        calls += 1;
        return {
          session_id: "sess_r",
          order: "timestamp_event_id_asc",
          events: [event({ event_id: `ev${calls}` })],
          limit: 500,
          has_more: true,
          next_cursor: encodeReplayCursor({
            timestamp: "2099-06-15T12:01:00.000Z",
            event_id: `ev${calls}`,
          }),
        };
      },
    });
    const res = await app.inject({
      method: "GET",
      url: "/realtime/audit/sessions/sess_r/report",
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { events: unknown[]; events_truncated: boolean };
    expect(body.events_truncated).toBe(true);
    expect(body.events.length).toBe(20); // MAX_REPORT_PAGES ページ分
    expect(calls).toBe(20);
  });

  it("?diff 無指定は requestDiff を呼ばず diff フィールドも付かない", async () => {
    const diffCalls = { n: 0 };
    await mount({ sessionSummary: async () => summary(), diffCalls });
    const res = await app.inject({
      method: "GET",
      url: "/realtime/audit/sessions/sess_r/report",
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(diffCalls.n).toBe(0);
    expect(res.json()).not.toHaveProperty("diff");
  });

  it("?diff=1 requestDiff ok → diff.available=true + redacted 本文/メタ投影", async () => {
    await mount({
      sessionSummary: async () => summary(),
      requestDiff: async () => ({
        ok: true,
        diff: {
          body: "diff --git a/x b/x\n+ [REDACTED:github-token]",
          truncated: false,
          secret_detected: true,
          redaction_count: 1,
        },
      }),
    });
    const json = await app.inject({
      method: "GET",
      url: "/realtime/audit/sessions/sess_r/report?diff=1",
      headers: auth,
    });
    expect(json.statusCode).toBe(200);
    const body = json.json() as {
      diff?: { available: boolean; body?: string; redaction_count?: number };
    };
    expect(body.diff?.available).toBe(true);
    expect(body.diff?.redaction_count).toBe(1);
    expect(body.diff?.body).toContain("[REDACTED:github-token]");

    // html でも diff セクションが redacted 本文で描画される。
    const html = await app.inject({
      method: "GET",
      url: "/realtime/audit/sessions/sess_r/report?format=html&diff=1",
      headers: auth,
    });
    expect(html.statusCode).toBe(200);
    expect(html.body).toContain("Diff (redacted)");
    expect(html.body).toContain("[REDACTED:github-token]");
  });

  it("?diff=1 requestDiff not ok → available=false graceful (200・切断メッセージ)", async () => {
    await mount({
      sessionSummary: async () => summary(),
      requestDiff: async () => ({ ok: false, error: "session not registered" }),
    });
    const md = await app.inject({
      method: "GET",
      url: "/realtime/audit/sessions/sess_r/report?format=md&diff=1",
      headers: auth,
    });
    expect(md.statusCode).toBe(200);
    expect(md.body).toContain("diff 取得不可 (session 切断)");
  });

  // --- ADR 6点強化 #2 レビュー・パケット route の分岐 (buildSessionReport 共有・catch/400/404) ---

  it("packet: sessions 欠落 → 400", async () => {
    await mount({ sessionSummary: async () => summary() });
    const res = await app.inject({
      method: "GET",
      url: "/realtime/audit/packet",
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
  });

  it("packet: 未知 session → 404 (どのセッションが無いか明示)", async () => {
    await mount({ sessionSummary: async () => undefined });
    const res = await app.inject({
      method: "GET",
      url: "/realtime/audit/packet?sessions=nope",
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });

  it("packet: sessionSummary throw → 静的 500 (内部詳細を漏らさない・catch 経路)", async () => {
    await mount({
      sessionSummary: async () => {
        throw new Error("boom packet internal");
      },
    });
    const res = await app.inject({
      method: "GET",
      url: "/realtime/audit/packet?sessions=sess_r",
      headers: auth,
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: "internal error" });
    expect(res.body).not.toContain("boom packet internal");
  });

  it("packet: json 集約 (governance) を返す", async () => {
    await mount({ sessionSummary: async () => summary() });
    const res = await app.inject({
      method: "GET",
      url: "/realtime/audit/packet?sessions=sess_r",
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      governance: { session_count: number };
      manifest: { root: string };
    };
    expect(body.governance.session_count).toBe(1);
    expect(typeof body.manifest.root).toBe("string");
  });

  it("packet: 重複 session を dedup する (sessions=x,x → session_count=1・packet root 決定論)", async () => {
    await mount({ sessionSummary: async () => summary() });
    const res = await app.inject({
      method: "GET",
      url: "/realtime/audit/packet?sessions=sess_r,sess_r",
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { governance: { session_count: number } }).governance.session_count).toBe(
      1,
    );
  });

  it("packet: MAX_PACKET_SESSIONS(25) 超 → 400 (over-fetch 有界化)", async () => {
    await mount({ sessionSummary: async () => summary() });
    const many = Array.from({ length: 26 }, (_, i) => `s${i}`).join(",");
    const res = await app.inject({
      method: "GET",
      url: `/realtime/audit/packet?sessions=${many}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
  });

  it("packet verify: manifest 欠落 → 400・malformed manifest → ok=false (200・500 でない)", async () => {
    await mount({ sessionSummary: async () => summary() });
    const missing = await app.inject({
      method: "POST",
      url: "/realtime/audit/packet/verify",
      headers: auth,
      payload: {},
    });
    expect(missing.statusCode).toBe(400);
    const malformed = await app.inject({
      method: "POST",
      url: "/realtime/audit/packet/verify",
      headers: auth,
      payload: { manifest: { version: "wrong" } },
    });
    expect(malformed.statusCode).toBe(200);
    expect(malformed.json()).toMatchObject({ ok: false });
  });
});
