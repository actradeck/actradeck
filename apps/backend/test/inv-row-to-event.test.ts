/**
 * INV-EVENT-CONTRACT (TDA-6 / M4, P0 適性, REAL PostgreSQL)。
 *
 * T1 (@actradeck/event-model) は ActraDeck の唯一の契約。Event Store から読み出した
 * 行も例外なく T1 を満たす必要がある。`rowToEvent` の二重キャスト
 * (`as unknown as NormalizedEvent`) は T1 検証を **迂回**し、enum 外 event_type / state
 * や非有限 timestamp を含む不正行を `observeFromEvents` (liveness 合成) へ流入させていた。
 *
 * 本テストは「DB に混入した不正行が liveness 合成を汚染しない」ことを実 PG で検証する:
 *  - 不正 event_type を持つ **fresh** な行を events に直接 INSERT (ingest の parseEvent 境界を
 *    回避 = 将来のスキーマドリフト / 別経路書込 / データ破損の模擬)。
 *  - その後 ingest() が走り loadEventsForLiveness → rowToEvent が全行を読む。
 *  - 不正行が **skip** されれば、残る正規行 (古い command.started + dead heartbeat) だけで
 *    合成され liveness は "stalled"。skip されなければ不正 fresh 行が event シグナルを
 *    新鮮化し "live" へ誤判定する。
 *
 * 修正前: 不正 fresh 行が event シグナルを汚染 → "live" (赤)。
 * 修正後: safeParseEvent が不正行を弾き skip → "stalled" (緑)。
 *
 * DB 未到達なら describe.skipIf で skip (CI では実走必須。silent green 禁止)。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newEventId } from "@actradeck/event-model";
import { Pool } from "pg";

import { IngestStore } from "../src/ingest-store.js";
import { cleanupSessions, dbReachable, iso, makeEvent } from "./helpers.js";

const DATABASE_URL = process.env.DATABASE_URL;
const reachable = DATABASE_URL ? await dbReachable(DATABASE_URL) : false;

describe.skipIf(!reachable)(
  "INV-EVENT-CONTRACT: rowToEvent validates via T1 (real Postgres)",
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

    /** events に行を直接 INSERT (ingest の parseEvent 境界を回避してデータ破損を模擬)。 */
    async function rawInsertEvent(
      sid: string,
      row: {
        event_type: string;
        state?: string | null;
        timestamp: string;
        payload: unknown;
        provider?: string;
        agent_id?: string | null;
        thread_id?: string | null;
        turn_id?: string | null;
        cwd?: string | null;
        summary?: string | null;
      },
    ): Promise<void> {
      await pool.query(
        `INSERT INTO events
         (id, event_id, provider, source, session_id, thread_id, turn_id, agent_id,
          event_type, state, timestamp, cwd, summary, payload, metrics)
       VALUES ($1,$2,$3,'hooks',$4,$5,$6,$7,$8,$9,$10::timestamptz,$11,$12,$13::jsonb,'{}'::jsonb)`,
        [
          newEventId(),
          newEventId(),
          row.provider ?? "claude_code",
          sid,
          row.thread_id ?? null,
          row.turn_id ?? null,
          row.agent_id ?? null,
          row.event_type,
          row.state ?? null,
          row.timestamp,
          row.cwd ?? null,
          row.summary ?? null,
          JSON.stringify(row.payload ?? {}),
        ],
      );
    }

    it("INV-EVENT-CONTRACT: a corrupt fresh row (invalid event_type) must NOT pollute liveness synthesis", async () => {
      const sid = newSession("sess_rowcontract");
      const base = Date.now();
      // 評価基準を base に固定。正規行は base-90s (stale)、不正行は base-1s (fresh)。
      const store = new IngestStore({ pool, livenessOptions: { nowMs: base } });

      // sessions FK を満たすため、正規の session.started を ingest 経由で先に作る (古い時刻)。
      await store.ingest(
        makeEvent({
          session_id: sid,
          state: "starting",
          event_type: "session.started",
          timestamp: iso(base, -91_000),
        }),
      );
      await store.ingest(
        makeEvent({
          session_id: sid,
          state: "running.command_executing",
          event_type: "command.started",
          timestamp: iso(base, -90_000),
          payload: { kind: "command.started", command: "npm test" },
        }),
      );

      // 不正 fresh 行を直接 INSERT: event_type が T1 enum 外。これが skip されなければ
      // event シグナルを新鮮化してしまう。
      await rawInsertEvent(sid, {
        event_type: "totally.not.a.real.event_type",
        timestamp: iso(base, -1_000),
        payload: {},
      });

      // dead heartbeat (古い) を ingest 経由で投入 → これが最後の ingest として liveness を再合成。
      const r = await store.ingest(
        makeEvent({
          session_id: sid,
          event_type: "heartbeat",
          timestamp: iso(base, -90_000),
          payload: { kind: "heartbeat", process_alive: false },
        }),
      );

      // 不正 fresh 行が skip されれば、残る正規行は全て stale + process dead → stalled。
      // skip されなければ不正行が event=fresh を作り live へ誤判定する。
      expect(r.liveness.evidence.process?.alive).toBe(false);
      expect(r.liveness.state).toBe("stalled");
    });

    it("INV-EVENT-CONTRACT: a corrupt row with out-of-enum state is rejected (not surfaced as valid event)", async () => {
      const sid = newSession("sess_rowstate");
      const base = Date.now();
      const store = new IngestStore({ pool, livenessOptions: { nowMs: base } });

      await store.ingest(
        makeEvent({
          session_id: sid,
          state: "starting",
          event_type: "session.started",
          timestamp: iso(base, -90_000),
        }),
      );

      // event_type は妥当だが state が enum 外 → T1 不正。fresh だが skip されるべき。
      await rawInsertEvent(sid, {
        event_type: "turn.started",
        state: "running.not_a_real_state",
        timestamp: iso(base, -1_000),
        payload: {},
      });

      const r = await store.ingest(
        makeEvent({
          session_id: sid,
          event_type: "heartbeat",
          timestamp: iso(base, -90_000),
          payload: { kind: "heartbeat", process_alive: false },
        }),
      );

      // 不正 state 行が skip されれば fresh event シグナルは無く stalled。
      expect(r.liveness.state).toBe("stalled");
    });

    it("M4: a contract-invalid HEARTBEAT row (bad provider) is excluded from process observation", async () => {
      // 集約クエリは event_type/state を enum で絞るが provider は絞らない。最新 heartbeat 行は
      // validateRowForLiveness で full T1 検証され、provider が enum 外なら process 未観測扱い。
      const sid = newSession("sess_hbcontract");
      const base = Date.now();
      const store = new IngestStore({ pool, livenessOptions: { nowMs: base } });

      // 正規の fresh な活動 (stdout) を入れておく → これがあるので live になりうる。
      await store.ingest(
        makeEvent({
          session_id: sid,
          state: "running.command_executing",
          event_type: "command.started",
          timestamp: iso(base, -1_000),
          payload: { kind: "command.started", command: "npm test" },
        }),
      );
      await store.ingest(
        makeEvent({
          session_id: sid,
          event_type: "command.output.delta",
          timestamp: iso(base, -500),
          payload: { kind: "command.output.delta", stream: "stdout", delta: "x" },
        }),
      );

      // 契約違反の heartbeat 行 (provider が enum 外) を直接 INSERT。最新 heartbeat だが
      // safeParseEvent 失敗 → process シグナル未観測になるべき。
      await rawInsertEvent(sid, {
        event_type: "heartbeat",
        timestamp: iso(base, -200),
        provider: "bogus_provider_not_in_enum",
        payload: { kind: "heartbeat", process_alive: false },
      });

      // 不正 heartbeat を観測すると process.alive=false が混ざるが、検証で除外されるので
      // process は evidence に現れず、fresh な stdout により live。
      const r = await store.ingest(
        makeEvent({
          session_id: sid,
          event_type: "command.output.delta",
          timestamp: iso(base, -100),
          payload: { kind: "command.output.delta", stream: "stdout", delta: "y" },
        }),
      );
      expect(r.liveness.evidence.process).toBeUndefined(); // 契約違反 heartbeat は除外
      expect(r.liveness.state).toBe("live"); // fresh stdout による
    });

    it("M4: a VALID heartbeat row with optional fields (agent_id/thread_id/turn_id/cwd/summary) is observed", async () => {
      // validateRowForLiveness の optional フィールド分岐を実データで通す + 正常 process 観測。
      const sid = newSession("sess_hbvalid");
      const base = Date.now();
      const store = new IngestStore({ pool, livenessOptions: { nowMs: base } });

      // sessions FK を満たすため session.started は ingest 経由で作る。
      await store.ingest(
        makeEvent({
          session_id: sid,
          state: "starting",
          event_type: "session.started",
          timestamp: iso(base, -90_000),
        }),
      );
      await rawInsertEvent(sid, {
        event_type: "heartbeat",
        timestamp: iso(base, -90_000),
        agent_id: "agent-1",
        thread_id: "thread-1",
        turn_id: "turn-1",
        cwd: "/work",
        summary: "alive ping",
        payload: { kind: "heartbeat", process_alive: false },
      });

      const r = await store.ingest(
        makeEvent({
          session_id: sid,
          event_type: "heartbeat",
          timestamp: iso(base, -90_000),
          payload: { kind: "heartbeat", process_alive: false },
        }),
      );
      // 妥当な dead heartbeat が観測され、全活動 stale + dead → stalled。
      expect(r.liveness.evidence.process?.alive).toBe(false);
      expect(r.liveness.state).toBe("stalled");
    });
  },
);
