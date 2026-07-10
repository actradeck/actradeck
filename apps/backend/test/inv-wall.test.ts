/**
 * Live Wall 段階1 (ADR 019ead7a D1) の不変条件 — REAL PostgreSQL + REAL WS。
 *
 * 縛る不変条件 (falsifiable・mutation で赤):
 *  - INV-WALL-AGGREGATE: `GET /realtime/wall` は **connected(接続在席=isLive)な全 live session** の
 *    直近 N events を横断レーンで返す。connected でない session(events あり)は含めない。各レーンの
 *    events は session ごと timestamp ASC, event_id ASC(REPLAY_ORDER)で、per-session 行数は
 *    per_session 上限以内 = 最新 N 件。connected フィルタや N 上限を外す mutation で赤。
 *  - INV-WALL-RELAY-AUTH: `/realtime/wall` は REALTIME_TOKEN 必須(no/wrong/ingest token→401)。
 *    onRequest gate を外す mutation で赤。
 *  - INV-WALL-REDACTION: 集約応答は **ReplayEventDTO の allow-list フィールドのみ**で、raw secret
 *    prefix(ghp_)・allow-list 外の生 payload フィールドは出ない。events(sidecar redaction 済 at-rest)
 *    を allow-list 投影(rowToReplayEvent)で再利用する。backend は ingress redaction 床
 *    (ADR 019f2d2c・既 redacted に冪等) を持ち、raw 露出せず allow-list 外の生フィールドも応答に出ない。
 *
 * REAL DATA ONLY: 実 PG に永続して検証。DB 未到達なら skip。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import type { FastifyInstance } from "fastify";
import { Pool } from "pg";

import { buildIngestionServer } from "../src/ingestion-server.js";
import { cleanupSessions, dbReachable, makeEvent } from "./helpers.js";

const DATABASE_URL = process.env.DATABASE_URL;
const reachable = DATABASE_URL ? await dbReachable(DATABASE_URL) : false;
const INGEST_TOKEN = "test-ingest-token-wall-1234567890";
const REALTIME_TOKEN = "test-realtime-token-wall-abcdefghij";

interface Frame {
  type: string;
  ok?: boolean;
}

interface WallResponse {
  lanes: Array<{
    session: { session_id: string; connected: boolean; provider: string; source: string };
    events: Array<Record<string, unknown>>;
  }>;
}

const ALLOW_KEYS = new Set([
  "event_id",
  "provider",
  "source",
  "session_id",
  "event_type",
  "kind",
  "timestamp",
  "state",
  "cwd",
  "summary",
  "display_text",
  "subject",
  "request_id",
  "tool_name",
  "command",
  "path",
  "risk_level",
  "decision",
  "auto_allowed",
  "exit_code",
  "elapsed_ms",
]);

describe.skipIf(!reachable)("INV-WALL (real PG + real WS)", () => {
  let pool: Pool;
  let app: FastifyInstance;
  let base: string;
  const sessions: string[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
    app = await buildIngestionServer({
      pool,
      ingestToken: INGEST_TOKEN,
      realtimeToken: REALTIME_TOKEN,
      maxPayloadBytes: 512 * 1024,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (addr === null || typeof addr === "string") throw new Error("no port");
    base = `ws://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await cleanupSessions(pool, sessions);
    if (app) await app.close();
    if (pool) await pool.end();
  });

  function newSession(prefix: string): string {
    const sid = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    sessions.push(sid);
    return sid;
  }

  /** sidecar として hello を送り、与えた session 群を connected(在席)にする (ack 待ち)。 */
  function openOwner(controlToken: string, sessionIds: string[]): Promise<{ close: () => void }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${base}/ingest/ws`, {
        headers: { authorization: `Bearer ${INGEST_TOKEN}` },
      });
      const timer = setTimeout(() => reject(new Error("sidecar connect timeout")), 4_000);
      ws.on("open", () => {
        ws.send(
          JSON.stringify({ type: "hello", control_token: controlToken, session_ids: sessionIds }),
        );
      });
      ws.on("message", (d: Buffer) => {
        const f = JSON.parse(d.toString("utf8")) as Frame;
        if (f.type === "ack" && f.ok === true) {
          clearTimeout(timer);
          resolve({ close: () => ws.close() });
        }
      });
      ws.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  async function ingest(ev: unknown): Promise<void> {
    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      headers: { authorization: `Bearer ${INGEST_TOKEN}` },
      payload: ev as object,
    });
    if (res.statusCode !== 200) throw new Error(`ingest failed: ${res.statusCode} ${res.body}`);
  }

  /** 1 event を投影する (command 系・タイムスタンプ昇順を caller が制御)。 */
  async function ingestEvent(
    sid: string,
    eventType: string,
    tsIso: string,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    await ingest(makeEvent({ session_id: sid, event_type: eventType, timestamp: tsIso, payload }));
  }

  async function getWall(
    token = REALTIME_TOKEN,
    perSession?: number,
  ): Promise<{ status: number; body: WallResponse; rawText: string }> {
    const qs = perSession !== undefined ? `?per_session=${perSession}` : "";
    const res = await app.inject({
      method: "GET",
      url: `/realtime/wall${qs}`,
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: res.statusCode, body: res.json() as WallResponse, rawText: res.body };
  }

  // --- INV-WALL-RELAY-AUTH: token gate (新 route も既存 onRequest gate を継承) ----------
  it("wall endpoint: no token → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/realtime/wall" });
    expect(res.statusCode).toBe(401);
  });

  it("wall endpoint: wrong token → 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/realtime/wall",
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("wall endpoint: ingest token (separate auth boundary) → 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/realtime/wall",
      headers: { authorization: `Bearer ${INGEST_TOKEN}` },
    });
    expect(res.statusCode).toBe(401);
  });

  // --- INV-WALL-AGGREGATE: connected な全 live session の直近 N を横断集約 ----------------
  it("aggregates recent events across connected sessions; excludes disconnected; ASC; bounded N", async () => {
    const s1 = newSession("wall_c1"); // connected
    const s2 = newSession("wall_c2"); // connected
    const s3 = newSession("wall_disc"); // events あるが disconnected

    const owner = await openOwner("ctrl-token-wall-aaaaaaaaaa", [s1, s2]);
    try {
      // s1: 4 events を時刻昇順で。per_session=2 で最新 2 件のみに絞られること(N 上限)を確認。
      await ingestEvent(s1, "command.started", "2026-06-05T00:00:01.000Z", { command: "echo 1" });
      await ingestEvent(s1, "command.completed", "2026-06-05T00:00:02.000Z", { exit_code: 0 });
      await ingestEvent(s1, "command.started", "2026-06-05T00:00:03.000Z", { command: "echo 2" });
      await ingestEvent(s1, "command.completed", "2026-06-05T00:00:04.000Z", { exit_code: 0 });
      // s2: 1 event。
      await ingestEvent(s2, "command.started", "2026-06-05T00:00:05.000Z", {
        command: "git status",
        risk_level: "low",
      });
      // s3: connected でない → 横断に出ない。
      await ingestEvent(s3, "command.started", "2026-06-05T00:00:06.000Z", {
        command: "rm -rf /x",
      });

      const { status, body } = await getWall(REALTIME_TOKEN, 2);
      expect(status).toBe(200);

      const byId = new Map(body.lanes.map((l) => [l.session.session_id, l]));
      // connected の s1/s2 はレーンを持つ。
      expect(byId.has(s1)).toBe(true);
      expect(byId.has(s2)).toBe(true);
      // disconnected の s3 は含まれない。
      expect(byId.has(s3)).toBe(false);
      // 本テストの自 session s1/s2 は connected(presence あり)として出る。
      expect(byId.get(s1)!.session.connected).toBe(true);
      expect(byId.get(s2)!.session.connected).toBe(true);
      // ADR 019f474e (isolation fix): wall は connected 在席「または」external adapter の直近 active
      //   (connected=false・source=external・recency proxy)を DB 横断で含むようになった。ゆえ「全レーンが
      //   connected」は不成立で、正しい不変条件は **「非 external が混ざるなら必ず connected」**
      //   = 停止した managed/attach を開示しない、である。旧 every(connected===true) は shared :55432 /
      //   並走 test が残す external-recent 行の混入で flaky だった(base commit の recency 導入に起因・
      //   本 fold で判定を正準不変条件へ更新)。
      expect(
        body.lanes.every((l) => l.session.connected === true || l.session.source === "external"),
      ).toBe(true);
      // SEC-1 (test-isolation): 本テストは自前の server+sidecarRegistry を建てるため、**connected(在席)な
      //   レーンは本テストの自 session に閉じる**(live stack :55410/:55400 や並走 test の connected は
      //   isLive=false で横断に混入不能)。external-recent は presence を持たず isLive 非依存で DB 横断に
      //   出るため isolation guard の対象外(connected レーンにのみ isolation を主張する)。
      expect(
        body.lanes
          .filter((l) => l.session.connected === true)
          .every((l) => sessions.includes(l.session.session_id)),
      ).toBe(true);

      const s1lane = byId.get(s1)!;
      // per_session=2 → 最新 2 件に有界。
      expect(s1lane.events.length).toBe(2);
      // 最新 2 件 = ts 03/04。timestamp ASC で並ぶ。
      const ts = s1lane.events.map((e) => e.timestamp);
      expect(ts).toEqual(["2026-06-05T00:00:03.000Z", "2026-06-05T00:00:04.000Z"]);
      // s2 は 1 件。
      expect(byId.get(s2)!.events.length).toBe(1);
    } finally {
      owner.close();
    }
  });

  it("returns empty lanes when no session is connected (disconnected events not disclosed)", async () => {
    const s = newSession("wall_offline");
    await ingestEvent(s, "command.started", "2026-06-05T00:00:01.000Z", { command: "ls" });
    // sidecar を開かない → isLive=false → このレーンは出ない。
    const { status, body } = await getWall();
    expect(status).toBe(200);
    expect(body.lanes.some((l) => l.session.session_id === s)).toBe(false);
  });

  // --- INV-WALL-REDACTION: allow-list 投影のみ素通し・raw 漏れなし -----------------------
  it("returns allow-listed ReplayEventDTO fields only (raw secret absent, no non-allow payload field)", async () => {
    const sid = newSession("wall_redact");
    const owner = await openOwner("ctrl-token-wall-bbbbbbbbbb", [sid]);
    try {
      // sidecar は redaction 済みで ingest する (command は [REDACTED] 形)。加えて allow-list 外の
      // 生フィールド(secret_blob)を payload に混ぜ、read が allow-list 投影で raw を素通りさせない
      // ことを固定する。
      await ingestEvent(sid, "command.started", "2026-06-05T00:00:01.000Z", {
        command: "export TOKEN=[REDACTED:credential-assignment]",
        risk_level: "high",
        secret_blob: "ghp_SHOULD_NOT_LEAK_0123456789",
      });

      const { status, body, rawText } = await getWall();
      expect(status).toBe(200);
      const lane = body.lanes.find((l) => l.session.session_id === sid);
      expect(lane).toBeDefined();
      const ev = lane!.events[0]!;

      // redaction 済み値は素通り、raw secret prefix は応答全体に存在しない。
      expect(String(ev.command)).toContain("[REDACTED:credential-assignment]");
      expect(rawText).not.toContain("ghp_");
      expect(rawText).not.toContain("SHOULD_NOT_LEAK");
      // 各キーは ReplayEventDTO allow-list の部分集合であること (allow-list 外の生フィールドは出ない)。
      for (const k of Object.keys(ev)) {
        expect(ALLOW_KEYS.has(k), `unexpected (non-allow-list) field leaked: ${k}`).toBe(true);
      }
      expect(ev).not.toHaveProperty("secret_blob");
      expect(ev).not.toHaveProperty("payload");
    } finally {
      owner.close();
    }
  });

  // --- INV-WALL-RECENT-EXTERNAL (ADR 019f474e): external adapter は WS を張れず connected=false に
  //     なるため、直近 active (last_event_at が WALL_RECENT_MS 内) を presence の代理として横断集約に
  //     含める。managed/attach 相当 (source!=external) は connected 据え置きで recency proxy 対象外。
  //     wall filter を `isPresentOrRecentlyActive` から `s.connected` 単独へ戻す mutation で赤。 ----

  /** external adapter として HTTP POST で ingest (WS は張らない → connected=false)。 */
  async function ingestExternal(
    sid: string,
    eventType: string,
    tsIso: string,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    await ingest(
      makeEvent({
        session_id: sid,
        event_type: eventType,
        timestamp: tsIso,
        payload,
        provider: "gemini",
        source: "external",
      }),
    );
  }

  it("includes external-recent (connected=false, source=external, age<=WALL_RECENT_MS); excludes stale-external and recent-non-external", async () => {
    const now = Date.now();
    const ext = newSession("wall_ext_recent"); // external ∧ recent → 出る
    const extStale = newSession("wall_ext_stale"); // external ∧ 古い → 出ない
    const nonExt = newSession("wall_nonext_recent"); // 非 external ∧ !connected → 出ない

    // external-recent: 30s 前の event (WALL_RECENT_MS=120s 以内)。WS は張らない。
    await ingestExternal(ext, "command.started", new Date(now - 30_000).toISOString(), {
      command: "gemini run",
    });
    // stale external: WALL_RECENT_MS を大きく超過 (10 分前) → recency proxy 対象外。
    await ingestExternal(extStale, "command.started", new Date(now - 600_000).toISOString(), {
      command: "old gemini",
    });
    // 非 external (hooks) ∧ 直近だが WS 未接続 (connected=false) → recency proxy は external 限定ゆえ出ない。
    await ingestEvent(nonExt, "command.started", new Date(now - 5_000).toISOString(), {
      command: "ls",
    });

    const { status, body } = await getWall();
    expect(status).toBe(200);
    const byId = new Map(body.lanes.map((l) => [l.session.session_id, l]));

    // external-recent は connected=false でも presence 代理で出る。
    expect(byId.has(ext)).toBe(true);
    expect(byId.get(ext)!.session.connected).toBe(false); // 真の presence は false (正直)。
    expect(byId.get(ext)!.session.source).toBe("external");
    expect(byId.get(ext)!.events.length).toBeGreaterThanOrEqual(1);

    // stale external は閾値超過で除外。
    expect(byId.has(extStale)).toBe(false);
    // 非 external ∧ !connected は recency proxy 対象外で除外 (managed/attach disconnect→offline 不変)。
    expect(byId.has(nonExt)).toBe(false);
  });

  // --- INV-WALL-ENDED-EXTERNAL (ADR 019f4c19 wall-ended-badge): terminal(completed/failed/interrupted)な
  //     external セッションは last_event_at が WALL_RECENT_MS 窓内でも LiveWall に出さない。
  //     session.ended→completed を発火した external が緑 ✓LIVE で残る誤表示 (実機 2026-07-10 gemini
  //     session 1025b431) を塞ぐ。terminal 除外を撤去する mutation (presence.ts の isTerminalStateValue
  //     枝を消す) で赤 = falsifiable。activeexternal (非 terminal) は従来通り出ること (非退行) も固定。 --

  /** external adapter として state を明示して ingest (WS は張らない → connected=false)。 */
  async function ingestExternalWithState(
    sid: string,
    eventType: string,
    state: string,
    tsIso: string,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    await ingest(
      makeEvent({
        session_id: sid,
        event_type: eventType,
        timestamp: tsIso,
        payload,
        provider: "gemini",
        source: "external",
        state,
      }),
    );
  }

  it("excludes terminal external (state=completed via session.ended) even when last_event_at is recent; keeps active external", async () => {
    const now = Date.now();
    const ended = newSession("wall_ext_ended"); // external ∧ 直近 ∧ terminal(completed) → 出ない
    const active = newSession("wall_ext_active"); // external ∧ 直近 ∧ 非 terminal(running) → 出る

    // 実機バグ再現: 昨日 running 開始 → 今日 session.ended(reason=exit)で completed へ。
    //   最終イベント(session.ended)は WALL_RECENT_MS(120s)窓内だが、terminal ゆえ LiveWall から落とす。
    await ingestExternalWithState(
      ended,
      "command.started",
      "running.command_executing",
      new Date(now - 90_000).toISOString(),
      { command: "gemini run" },
    );
    await ingestExternalWithState(
      ended,
      "session.ended",
      "completed",
      new Date(now - 30_000).toISOString(), // 窓内 (30s 前) だが terminal
      { reason: "exit" },
    );
    // active external: 直近かつ running のまま (まだ活動中) → 従来通り出る (非退行)。
    await ingestExternalWithState(
      active,
      "command.started",
      "running.command_executing",
      new Date(now - 30_000).toISOString(),
      { command: "gemini run" },
    );

    const { status, body } = await getWall();
    expect(status).toBe(200);
    const byId = new Map(body.lanes.map((l) => [l.session.session_id, l]));

    // terminal external は last_event_at が窓内でも LiveWall から落ちる (✓LIVE 誤表示の解消)。
    expect(byId.has(ended)).toBe(false);
    // 非 terminal (活動中) external は従来通り presence 代理で出る。
    expect(byId.has(active)).toBe(true);
    expect(byId.get(active)!.session.connected).toBe(false);
    expect(byId.get(active)!.session.source).toBe("external");
  });

  it("INV-WALL-REDACTION holds for external-recent events (allow-list projection, raw secret absent)", async () => {
    const now = Date.now();
    const ext = newSession("wall_ext_redact");
    await ingestExternal(ext, "command.started", new Date(now - 10_000).toISOString(), {
      command: "export TOKEN=[REDACTED:credential-assignment]",
      risk_level: "high",
      secret_blob: "ghp_EXTERNAL_SHOULD_NOT_LEAK_0123456789",
    });

    const { status, body, rawText } = await getWall();
    expect(status).toBe(200);
    const lane = body.lanes.find((l) => l.session.session_id === ext);
    expect(lane).toBeDefined();
    const ev = lane!.events[0]!;
    // redaction 済み値は素通り・raw secret prefix は応答全体に不在 (external-recent でも床は不変)。
    expect(String(ev.command)).toContain("[REDACTED:credential-assignment]");
    expect(rawText).not.toContain("ghp_");
    expect(rawText).not.toContain("SHOULD_NOT_LEAK");
    for (const k of Object.keys(ev)) {
      expect(ALLOW_KEYS.has(k), `unexpected (non-allow-list) field leaked: ${k}`).toBe(true);
    }
    expect(ev).not.toHaveProperty("secret_blob");
  });
});

// --- INV-WALL-RECENT-EXTERNAL (c): cwd scope 外の external-recent は横断に出ない --------------
//   cwdScopeClause は listSnapshot の SQL WHERE で isPresentOrRecentlyActive 述語より **前** に
//   適用されるため、scope 外 session は list に載らず recency proxy でも救われない (scope バイパス無し)。
//   専用 scope 付き server を立てて検証する (env は本ブロック内で set→restore・process-global 汚染回避)。
describe.skipIf(!reachable)("INV-WALL-RECENT-EXTERNAL scope containment (real PG)", () => {
  let pool: Pool;
  let app: FastifyInstance;
  const sessions: string[] = [];
  const SCOPE = "/home/user/actradeck-wall-scope-fixture";
  let prevScope: string | undefined;

  beforeAll(async () => {
    prevScope = process.env.ACTRADECK_PROJECT_SCOPE;
    process.env.ACTRADECK_PROJECT_SCOPE = SCOPE;
    pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
    app = await buildIngestionServer({
      pool,
      ingestToken: INGEST_TOKEN,
      realtimeToken: REALTIME_TOKEN,
      maxPayloadBytes: 512 * 1024,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
  });

  afterAll(async () => {
    await cleanupSessions(pool, sessions);
    if (app) await app.close();
    if (pool) await pool.end();
    if (prevScope === undefined) delete process.env.ACTRADECK_PROJECT_SCOPE;
    else process.env.ACTRADECK_PROJECT_SCOPE = prevScope;
  });

  it("external-recent outside cwd scope is not disclosed by wall", async () => {
    const now = Date.now();
    const inScope = `wall_scope_in_${now}_${Math.random().toString(36).slice(2, 8)}`;
    const outScope = `wall_scope_out_${now}_${Math.random().toString(36).slice(2, 8)}`;
    sessions.push(inScope, outScope);

    async function ingestExt(sid: string, cwd: string): Promise<void> {
      const res = await app.inject({
        method: "POST",
        url: "/ingest",
        headers: { authorization: `Bearer ${INGEST_TOKEN}` },
        payload: makeEvent({
          session_id: sid,
          event_type: "command.started",
          timestamp: new Date(now - 10_000).toISOString(),
          payload: { command: "gemini run" },
          provider: "gemini",
          source: "external",
          cwd,
        }) as object,
      });
      if (res.statusCode !== 200) throw new Error(`ingest ${res.statusCode}`);
    }

    await ingestExt(inScope, `${SCOPE}/proj-a`); // scope 配下
    await ingestExt(outScope, "/home/user/other-repo"); // scope 外

    const res = await app.inject({
      method: "GET",
      url: "/realtime/wall",
      headers: { authorization: `Bearer ${REALTIME_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as WallResponse;
    const ids = new Set(body.lanes.map((l) => l.session.session_id));
    // scope 配下の external-recent は出る。scope 外は cwdScopeClause で list から落ち recency でも救われない。
    expect(ids.has(inScope)).toBe(true);
    expect(ids.has(outScope)).toBe(false);
  });
});
