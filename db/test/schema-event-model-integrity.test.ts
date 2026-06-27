/**
 * Phase 1-3: DB (events.event_type/state TEXT) ↔ event-model enum 整合テスト。
 *
 * 目的:
 * - event-model の T1 enum (state / event_type) 値が、実 Postgres の events TEXT 列に
 *   そのまま INSERT/SELECT 往復できることを実データで確認する (モック禁止 / REAL DATA ONLY)。
 * - event_id UNIQUE による冪等性 (二重取り込み拒否) を実 DB で確認する。
 * - 現状 TEXT(CHECK 未付与) のため「想定外 (enum 外) の値も DB は受理する」=ドリフト面を
 *   明示し、方針判断 (CHECK 制約付与 vs app 層検証) の根拠を残す。
 *
 * 接続: DATABASE_URL (port 55432, docker actradeck-postgres-dev)。.env から注入。
 * DB 未起動時は describe.skip でスキップ (CI 環境差で赤くしない / 実 DB ありなら必ず走る)。
 */
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ALL_EVENT_TYPES, ALL_STATES, newEventId } from "@actradeck/event-model";

const DATABASE_URL = process.env.DATABASE_URL;
const TEST_SESSION = `sess_inv_event_${Date.now()}`;

/** DB が到達可能か (起動していなければ統合テストはスキップ)。 */
async function dbReachable(url: string): Promise<boolean> {
  const c = new Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  try {
    await c.connect();
    await c.end();
    return true;
  } catch {
    return false;
  }
}

const reachable = DATABASE_URL ? await dbReachable(DATABASE_URL) : false;

describe.skipIf(!reachable)("INV-EVENT-DB-INTEGRITY (real Postgres)", () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: DATABASE_URL });
    await client.connect();
    // FK 整合のため親セッションを用意。
    await client.query(
      `INSERT INTO sessions (session_id, provider, source)
       VALUES ($1, 'claude_code', 'hooks')
       ON CONFLICT (session_id) DO NOTHING`,
      [TEST_SESSION],
    );
  });

  afterAll(async () => {
    if (client) {
      // events は CASCADE 削除されるが、テストデータは明示的に掃除する。
      await client.query(`DELETE FROM sessions WHERE session_id = $1`, [TEST_SESSION]);
      await client.end();
    }
  });

  async function insertEvent(eventType: string, state: string | null): Promise<string> {
    const eventId = newEventId();
    await client.query(
      `INSERT INTO events
         (id, event_id, provider, source, session_id, event_type, state, timestamp, payload, metrics)
       VALUES ($1, $2, 'claude_code', 'hooks', $3, $4, $5, now(), '{}'::jsonb, '{}'::jsonb)`,
      [newEventId(), eventId, TEST_SESSION, eventType, state],
    );
    return eventId;
  }

  it("round-trips every T1 state enum value through events.state (TEXT)", async () => {
    for (const state of ALL_STATES) {
      const eventId = await insertEvent("heartbeat", state);
      const { rows } = await client.query(`SELECT state FROM events WHERE event_id = $1`, [
        eventId,
      ]);
      expect(rows[0].state).toBe(state);
    }
  });

  it("round-trips every T1 event_type enum value through events.event_type (TEXT)", async () => {
    for (const eventType of ALL_EVENT_TYPES) {
      const eventId = await insertEvent(eventType, null);
      const { rows } = await client.query(`SELECT event_type FROM events WHERE event_id = $1`, [
        eventId,
      ]);
      expect(rows[0].event_type).toBe(eventType);
    }
  });

  it("stores the minted UUIDv7 event_id verbatim and is queryable", async () => {
    const eventId = await insertEvent("session.started", "created");
    const { rows } = await client.query(`SELECT event_id FROM events WHERE event_id = $1`, [
      eventId,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].event_id).toBe(eventId);
  });

  it("enforces event_id idempotency via UNIQUE (duplicate ingest rejected)", async () => {
    const eventId = newEventId();
    await client.query(
      `INSERT INTO events (id, event_id, provider, source, session_id, event_type, timestamp)
       VALUES ($1, $2, 'claude_code', 'hooks', $3, 'heartbeat', now())`,
      [newEventId(), eventId, TEST_SESSION],
    );
    // 同一 event_id の二重 INSERT は UNIQUE 違反で拒否されること。
    await expect(
      client.query(
        `INSERT INTO events (id, event_id, provider, source, session_id, event_type, timestamp)
         VALUES ($1, $2, 'claude_code', 'hooks', $3, 'heartbeat', now())`,
        [newEventId(), eventId, TEST_SESSION],
      ),
    ).rejects.toThrow(/duplicate key|unique/i);

    // at-least-once 前提の冪等取り込み (ON CONFLICT DO NOTHING) は受理 (rowCount 0)。
    const res = await client.query(
      `INSERT INTO events (id, event_id, provider, source, session_id, event_type, timestamp)
       VALUES ($1, $2, 'claude_code', 'hooks', $3, 'heartbeat', now())
       ON CONFLICT (event_id) DO NOTHING`,
      [newEventId(), eventId, TEST_SESSION],
    );
    expect(res.rowCount).toBe(0);
  });

  it("DRIFT WITNESS: TEXT column currently accepts out-of-enum values (no CHECK)", async () => {
    // この振る舞いは「現状の前方互換設計」を記録する証拠テスト。
    // 将来 CHECK を付ける/付けない方針判断の基準。enum 外値が通ること自体は
    // 現時点では設計通り (T1 = app 層が gate) であることを明示する。
    const bogusState = "running.totally_made_up";
    const eventId = await insertEvent("heartbeat", bogusState);
    const { rows } = await client.query(`SELECT state FROM events WHERE event_id = $1`, [eventId]);
    expect(rows[0].state).toBe(bogusState);
    // T1 (event-model) は同じ値を拒否する — DB と app 層の検証責務の差を可視化。
    expect(ALL_STATES as readonly string[]).not.toContain(bogusState);
  });
});
