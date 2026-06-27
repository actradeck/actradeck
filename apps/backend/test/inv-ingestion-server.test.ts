/**
 * Ingestion server (WS + HTTP) 受信検証テスト (REAL PostgreSQL + REAL WS)。
 *
 * 検証する不変条件 / 防御:
 *  - upgrade 前認証: token 不正/不在は 401 (WS upgrade させない / HTTP も 401)。
 *  - parseEvent 検証必須: 不正 payload は ack エラーで拒否 (接続維持・落とさない)。
 *  - 冪等: WS 経由でも同一 event_id 再送は duplicate ack。
 *  - HTTP POST fallback: 単体 / 配列バッチを取り込む。
 *  - サイズ上限: 過大 payload を拒否。
 *
 * REAL DATA ONLY: 実 PG に永続化して検証する。DB 未到達なら skip。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { newEventId } from "@actradeck/event-model";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";

import { buildIngestionServer } from "../src/ingestion-server.js";
import { cleanupSessions, dbReachable, makeEvent } from "./helpers.js";

const DATABASE_URL = process.env.DATABASE_URL;
const reachable = DATABASE_URL ? await dbReachable(DATABASE_URL) : false;
const TOKEN = "test-ingest-token-1234567890";

interface Ack {
  type: string;
  ok: boolean;
  inserted?: boolean;
  duplicate?: boolean;
  error?: string;
  event_id?: string;
}

describe.skipIf(!reachable)("Ingestion server WS+HTTP (real PG + real WS)", () => {
  let pool: Pool;
  let app: FastifyInstance;
  let wsBase: string;
  const sessions: string[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
    app = await buildIngestionServer({ pool, ingestToken: TOKEN, maxPayloadBytes: 64 * 1024 });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (addr === null || typeof addr === "string") throw new Error("no port");
    wsBase = `ws://127.0.0.1:${addr.port}`;
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

  /** SEC-1: token は Authorization: Bearer ヘッダ (upgrade リクエスト) で渡す。 */
  function authHeaders(): { headers: { authorization: string } } {
    return { headers: { authorization: `Bearer ${TOKEN}` } };
  }

  /** WS 接続を開き、1 メッセージ送って 1 ack を受け取る。 */
  function wsRoundTrip(url: string, payload: unknown): Promise<Ack> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, authHeaders());
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error("ws timeout"));
      }, 4_000);
      ws.on("open", () => ws.send(JSON.stringify(payload)));
      ws.on("message", (data: Buffer) => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(data.toString("utf8")) as Ack);
        } catch (e) {
          reject(e as Error);
        }
        ws.close();
      });
      ws.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  // --- upgrade 前認証 ---------------------------------------------------
  it("rejects WS upgrade without a valid token (401, no upgrade)", async () => {
    const failed = await new Promise<{ code?: number; upgraded: boolean }>((resolve) => {
      const ws = new WebSocket(`${wsBase}/ingest/ws`); // token 無し
      let upgraded = false;
      ws.on("open", () => {
        upgraded = true;
        ws.close();
        resolve({ upgraded });
      });
      ws.on("unexpected-response", (_req, res) => {
        resolve({ code: res.statusCode, upgraded });
      });
      ws.on("error", () => resolve({ upgraded }));
    });
    expect(failed.upgraded).toBe(false);
    expect(failed.code).toBe(401);
  });

  it("rejects HTTP POST without a valid token (401)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      payload: makeEvent({ session_id: newSession("sess_noauth") }),
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects HTTP POST with a wrong token (401)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      headers: { authorization: "Bearer wrong-token" },
      payload: makeEvent({ session_id: newSession("sess_wrongauth") }),
    });
    expect(res.statusCode).toBe(401);
  });

  // --- parseEvent 検証 --------------------------------------------------
  it("WS: rejects malformed event with an error ack but keeps the connection", async () => {
    const ack = await wsRoundTrip(`${wsBase}/ingest/ws`, { not: "a valid event" });
    expect(ack.ok).toBe(false);
    expect(ack.error).toMatch(/invalid event/i);
  });

  it("WS: rejects invalid JSON with an error ack", async () => {
    const ack = await new Promise<Ack>((resolve, reject) => {
      const ws = new WebSocket(`${wsBase}/ingest/ws`, authHeaders());
      const timer = setTimeout(() => reject(new Error("timeout")), 4_000);
      ws.on("open", () => ws.send("{ broken json"));
      ws.on("message", (d: Buffer) => {
        clearTimeout(timer);
        resolve(JSON.parse(d.toString("utf8")) as Ack);
        ws.close();
      });
      ws.on("error", reject);
    });
    expect(ack.ok).toBe(false);
    expect(ack.error).toMatch(/json/i);
  });

  // --- 正常取り込み + 冪等 ---------------------------------------------
  it("WS: ingests a valid event and is idempotent on resend", async () => {
    const sid = newSession("sess_ws_idem");
    const ev = makeEvent({
      event_id: newEventId(),
      session_id: sid,
      state: "starting",
      event_type: "session.started",
    });
    const a1 = await wsRoundTrip(`${wsBase}/ingest/ws`, ev);
    expect(a1.ok).toBe(true);
    expect(a1.inserted).toBe(true);
    const a2 = await wsRoundTrip(`${wsBase}/ingest/ws`, ev);
    expect(a2.ok).toBe(true);
    expect(a2.inserted).toBe(false);
    expect(a2.duplicate).toBe(true);

    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM events WHERE event_id = $1`, [
      ev.event_id,
    ]);
    expect(rows[0].n).toBe(1);
  });

  // --- HTTP fallback ----------------------------------------------------
  it("HTTP POST: ingests a single event", async () => {
    const sid = newSession("sess_http_single");
    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: makeEvent({ session_id: sid, state: "starting", event_type: "session.started" }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { results: Ack[] };
    expect(body.results[0]?.ok).toBe(true);
  });

  it("HTTP POST: ingests an array batch in order", async () => {
    const sid = newSession("sess_http_batch");
    const batch = [
      makeEvent({ session_id: sid, state: "starting", event_type: "session.started" }),
      makeEvent({ session_id: sid, state: "running.model_wait", event_type: "turn.started" }),
      makeEvent({
        session_id: sid,
        state: "running.command_executing",
        event_type: "command.started",
        payload: { kind: "command.started", command: "ls" },
      }),
    ];
    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: batch,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { results: Ack[] };
    expect(body.results).toHaveLength(3);
    expect(body.results.every((r) => r.ok)).toBe(true);
    const { rows } = await pool.query(`SELECT state FROM session_state WHERE session_id = $1`, [
      sid,
    ]);
    expect(rows[0].state).toBe("running.command_executing");
  });

  it("HTTP POST: invalid event yields 422 with error ack (not 500)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { garbage: true },
    });
    expect(res.statusCode).toBe(422);
    const body = res.json() as { results: Ack[] };
    expect(body.results[0]?.ok).toBe(false);
  });

  // --- サイズ上限 -------------------------------------------------------
  it("HTTP POST: rejects an oversized payload (body limit)", async () => {
    const huge = "x".repeat(80 * 1024); // 64 KiB 上限を超える
    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      payload: makeEvent({ session_id: newSession("sess_huge"), summary: huge }),
    });
    expect(res.statusCode).toBe(413); // Payload Too Large
  });

  it("health endpoint is open (no auth)", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});
