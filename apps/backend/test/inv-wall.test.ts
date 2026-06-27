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
 *    を allow-list 投影(rowToReplayEvent)で再利用するだけで backend は再 redaction も raw 露出もしない。
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
    session: { session_id: string; connected: boolean; provider: string };
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
      // 全レーンが connected。
      expect(body.lanes.every((l) => l.session.connected === true)).toBe(true);
      // SEC-1 (test-isolation): 本テストは自前の server+sidecarRegistry を建てるため、live stack
      //   (:55410/:55400) の session は isLive=false で横断に混入し得ない。全レーンが本テストの
      //   自 session 群であることを固定し、shared :55432 でも集約が自 session のみに閉じることを保証する
      //   (ASC 順序の決定性は自 session の event 集合に対して評価される)。
      expect(body.lanes.every((l) => sessions.includes(l.session.session_id))).toBe(true);

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
        command: "export TOKEN=[REDACTED:github-token]",
        risk_level: "high",
        secret_blob: "ghp_SHOULD_NOT_LEAK_0123456789",
      });

      const { status, body, rawText } = await getWall();
      expect(status).toBe(200);
      const lane = body.lanes.find((l) => l.session.session_id === sid);
      expect(lane).toBeDefined();
      const ev = lane!.events[0]!;

      // redaction 済み値は素通り、raw secret prefix は応答全体に存在しない。
      expect(String(ev.command)).toContain("[REDACTED:github-token]");
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
});
