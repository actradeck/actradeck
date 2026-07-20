/**
 * ADR 0014 Phase 3b-1 — run lineage の real-PG round-trip + 親 terminal 行不変 (INV-TERMINAL-IMMUTABLE-
 * ACROSS-RESUME). sidecar が emit する形の parent/child イベント (parent started+ended、別 provider id の
 * child started with resumed_from) を実 PG へ ingest し、次を固定する:
 *  - 親 run と子 run は distinct な session 行 (INV-SEQ-RESET-PER-RUN structural: 新 run = 新 session_id)。
 *  - 子行に resumed_from_session_id=親 canonical が永続 (INV-RUN-LINEAGE-EDGE)。
 *  - 子 ingest 後も親 terminal 行 (end_kind/recoverability/start_kind 等) は **byte 不変** (再オープンしない)。
 *
 * 3a の INV-SESSIONS-LINEAGE-PERSIST (backend upsert の first-wins/last-non-null) を継承し、本 test は
 *   **2 run 分離 + 親不変** を追加する。DB 未到達なら skip (CI では実走必須・silent green 禁止)。
 *   production :55432 非接触 (使い捨て docker PG の DATABASE_URL のみ)。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Pool } from "pg";

import { IngestStore } from "../src/ingest-store.js";
import { cleanupSessions, dbReachable, iso, makeEvent } from "./helpers.js";

const DATABASE_URL = process.env.DATABASE_URL;
const reachable = DATABASE_URL ? await dbReachable(DATABASE_URL) : false;

describe.skipIf(!reachable)(
  "INV-RUN-LINEAGE / INV-TERMINAL-IMMUTABLE-ACROSS-RESUME (real PG)",
  () => {
    let pool: Pool;
    const sessions: string[] = [];

    beforeAll(() => {
      pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
    });

    afterAll(async () => {
      if (pool) {
        await cleanupSessions(pool, sessions);
        await pool.end();
      }
    });

    function newSession(prefix: string): string {
      const sid = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      sessions.push(sid);
      return sid;
    }

    it("parent run (started+ended) と別 provider id の child resume run が distinct 行になり、child が resumed_from=parent を持つ", async () => {
      const store = new IngestStore({ pool });
      const parent = newSession("sess_parent");
      const child = newSession("sess_child");
      const base = Date.now();

      // 親 run: fresh 起動 → 正常終了 (sidecar が emit する形)。
      await store.ingest(
        makeEvent({
          session_id: parent,
          provider_session_id: parent,
          state: "starting",
          event_type: "session.started",
          timestamp: iso(base, 0),
          start_kind: "fresh",
        }),
      );
      await store.ingest(
        makeEvent({
          session_id: parent,
          provider_session_id: parent,
          state: "completed",
          event_type: "session.ended",
          timestamp: iso(base, 1_000),
          end_kind: "completed",
          recoverability: "not_resumable",
        }),
      );

      // 親 terminal 行のスナップショット (子 ingest 前)。
      const parentBefore = await pool.query(
        `SELECT provider_session_id, start_kind, resumed_from_session_id, end_kind, recoverability,
              started_at, updated_at
         FROM sessions WHERE session_id = $1`,
        [parent],
      );
      expect(parentBefore.rows[0].start_kind).toBe("fresh");
      expect(parentBefore.rows[0].end_kind).toBe("completed");
      expect(parentBefore.rows[0].recoverability).toBe("not_resumable");
      expect(parentBefore.rows[0].resumed_from_session_id).toBeNull();

      // 子 run: 別 provider id での resume (resumed_from=親 canonical)。
      await store.ingest(
        makeEvent({
          session_id: child,
          provider_session_id: child,
          state: "starting",
          event_type: "session.started",
          timestamp: iso(base, 2_000),
          start_kind: "resume",
          resumed_from_session_id: parent,
        }),
      );

      // distinct 行 (INV-SEQ-RESET-PER-RUN structural: 新 run = 新 session 行)。
      const parentRow = await pool.query(`SELECT 1 FROM sessions WHERE session_id = $1`, [parent]);
      const childRow = await pool.query(
        `SELECT start_kind, resumed_from_session_id FROM sessions WHERE session_id = $1`,
        [child],
      );
      expect(parentRow.rowCount).toBe(1);
      expect(childRow.rowCount).toBe(1);
      // 子は lineage エッジを持つ (INV-RUN-LINEAGE-EDGE)。
      expect(childRow.rows[0].start_kind).toBe("resume");
      expect(childRow.rows[0].resumed_from_session_id).toBe(parent);

      // INV-TERMINAL-IMMUTABLE-ACROSS-RESUME: 子 ingest 後も親 terminal 行は byte 不変 (再オープンしない)。
      const parentAfter = await pool.query(
        `SELECT provider_session_id, start_kind, resumed_from_session_id, end_kind, recoverability,
              started_at, updated_at
         FROM sessions WHERE session_id = $1`,
        [parent],
      );
      expect(parentAfter.rows[0]).toEqual(parentBefore.rows[0]);
    });

    it("terminal-reopen synthetic child (provider id 再利用) でも親行不変・child は synthetic session_id で resumed_from=親", async () => {
      const store = new IngestStore({ pool });
      const parent = newSession("sess_treopen_parent"); // = provider id
      const synthetic = newSession("sess_treopen_child"); // synthetic canonical (別 session_id)
      const base = Date.now();

      await store.ingest(
        makeEvent({
          session_id: parent,
          provider_session_id: parent,
          state: "starting",
          event_type: "session.started",
          timestamp: iso(base, 0),
          start_kind: "fresh",
        }),
      );
      await store.ingest(
        makeEvent({
          session_id: parent,
          provider_session_id: parent,
          state: "completed",
          event_type: "session.ended",
          timestamp: iso(base, 1_000),
          end_kind: "completed",
          recoverability: "not_resumable",
        }),
      );
      const before = await pool.query(
        `SELECT end_kind, recoverability, updated_at FROM sessions WHERE session_id = $1`,
        [parent],
      );

      // terminal-reopen: synthetic canonical だが provider_session_id は再利用された parent id。
      await store.ingest(
        makeEvent({
          session_id: synthetic,
          provider_session_id: parent, // 再利用 (canonical と乖離)
          state: "starting",
          event_type: "session.started",
          timestamp: iso(base, 2_000),
          start_kind: "resume",
          resumed_from_session_id: parent,
        }),
      );

      const child = await pool.query(
        `SELECT provider_session_id, resumed_from_session_id FROM sessions WHERE session_id = $1`,
        [synthetic],
      );
      expect(child.rows[0].provider_session_id).toBe(parent); // canonical と provider が乖離した行
      expect(child.rows[0].resumed_from_session_id).toBe(parent);

      // 親 terminal 行不変。
      const after = await pool.query(
        `SELECT end_kind, recoverability, updated_at FROM sessions WHERE session_id = $1`,
        [parent],
      );
      expect(after.rows[0]).toEqual(before.rows[0]);
    });
  },
);
