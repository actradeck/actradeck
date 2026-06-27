/**
 * INV-LIVENESS-PARITY (P0, REAL PostgreSQL) — TDA-2 回帰ガード / TDA-1 退行検出。
 *
 * liveness 観測の正典は TS リファレンス実装 `observeFromEvents` (純関数・決定論)。本番経路は
 * SQL 集約 `aggregateObservationSql`。両者が **同一イベント列に対して全フィールド一致** する
 * ことを実 PG で縛る。これにより、SQL と TS の乖離 (TDA-1: naked heartbeat の脱落で生存
 * セッションが SQL 経路でのみ stalled 化) が混入したら **この parity テストが赤になる**。
 *
 * 網羅: 各シグナル種別 (stdout/file/modelStream) / naked heartbeat (process_alive 無し) /
 * dead heartbeat (process_alive:false) / alive heartbeat (process_alive:true) / 混在 /
 * out-of-order / ランダム生成。
 *
 * memory `redaction-redos-and-real-test-gates` 教訓: 延期 (it.fails/skip 偽装) でなく通常の
 * it() で赤→緑をゲートする。DB 未到達なら describe.skipIf で skip (CI では実走必須)。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newEventId, type NormalizedEvent } from "@actradeck/event-model";
import { Pool } from "pg";

import { aggregateObservationSql } from "../src/ingest-store.js";
import { observeFromEvents, type LivenessObservation } from "../src/liveness.js";
import { cleanupSessions, dbReachable, iso, makeEvent } from "./helpers.js";

const DATABASE_URL = process.env.DATABASE_URL;
const reachable = DATABASE_URL ? await dbReachable(DATABASE_URL) : false;

/**
 * raw events を直接 INSERT する (reducer/projection を介さず純粋な集約 parity を見るため)。
 *
 * `pkId` を明示指定できる: TDA-1 tie-break 検証で「PK id 順 != 配列順」を作るのに使う
 * (insertRaw は通常 UUIDv7 を採番するため id 順 == 挿入順 == 配列順となり、SQL の
 * `ORDER BY ... id DESC` と TS の配列後勝ちが偶然一致して乖離を覆い隠す)。
 *
 * `rawPayload` を指定すると parseEvent を通さない生 jsonb を直接書き込める: TDA-2 で
 * 文字列 `process_alive:"false"` / 数値 `0` 等、loose record として保存されうるが
 * boolean ではない payload を ingest 経路に依らず再現する。
 */
async function insertRaw(
  pool: Pool,
  ev: NormalizedEvent,
  opts: { pkId?: string; rawPayload?: unknown } = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO sessions (session_id, provider, source)
       VALUES ($1,$2,$3) ON CONFLICT (session_id) DO NOTHING`,
    [ev.session_id, ev.provider, ev.source],
  );
  const payloadJson = JSON.stringify(
    opts.rawPayload !== undefined ? opts.rawPayload : (ev.payload ?? {}),
  );
  await pool.query(
    `INSERT INTO events
       (id, event_id, provider, source, session_id, event_type, state, timestamp, payload, metrics)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)
     ON CONFLICT (event_id) DO NOTHING`,
    [
      opts.pkId ?? newEventId(),
      ev.event_id,
      ev.provider,
      ev.source,
      ev.session_id,
      ev.event_type,
      ev.state ?? null,
      new Date(Date.parse(ev.timestamp)).toISOString(),
      payloadJson,
      JSON.stringify(ev.metrics ?? {}),
    ],
  );
}

/** 全ビット 0 / 全ビット f の固定 UUID。PK id の大小を明示制御するのに使う (TDA-1)。 */
const UUID_MIN = "00000000-0000-0000-0000-000000000000";
const UUID_MAX = "ffffffff-ffff-ffff-ffff-ffffffffffff";

describe.skipIf(!reachable)(
  "INV-LIVENESS-PARITY: SQL aggregate === TS observeFromEvents (real PG)",
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

    /** events を実 PG へ投入し、SQL 観測と TS 観測を取得して全フィールド一致を assert。 */
    async function assertParity(label: string, events: readonly NormalizedEvent[]): Promise<void> {
      for (const ev of events) await insertRaw(pool, ev);
      const client = await pool.connect();
      let sqlObs: LivenessObservation;
      try {
        sqlObs = await aggregateObservationSql(client, events[0]!.session_id);
      } finally {
        client.release();
      }
      const tsObs = observeFromEvents(events);
      // 全フィールド一致 (process/event/stdout/file/modelStream)。toEqual は undefined 欠落も区別。
      expect(
        sqlObs,
        `parity mismatch [${label}]: SQL=${JSON.stringify(sqlObs)} TS=${JSON.stringify(tsObs)}`,
      ).toEqual(tsObs);
    }

    const NOW = 1_900_000_000_000;

    it("naked heartbeat only (no process_alive) — counts as activity in BOTH (TDA-1 guard)", async () => {
      const sid = newSession("sess_par_naked");
      const events = [
        makeEvent({
          session_id: sid,
          event_type: "heartbeat",
          timestamp: iso(NOW, -2_000),
          payload: { kind: "heartbeat" }, // process_alive 無し
        }),
      ];
      await assertParity("naked-only", events);
      // 明示的に: naked heartbeat は event 活動として両方で数えられ、process は未観測。
      const tsObs = observeFromEvents(events);
      expect(tsObs.event?.atMs).toBe(NOW - 2_000);
      expect(tsObs.process).toBeUndefined();
    });

    it("dead heartbeat (process_alive:false) — excluded from event activity in BOTH", async () => {
      const sid = newSession("sess_par_dead");
      const events = [
        makeEvent({
          session_id: sid,
          event_type: "command.started",
          state: "running.command_executing",
          timestamp: iso(NOW, -90_000),
          payload: { kind: "command.started", command: "npm test" },
        }),
        makeEvent({
          session_id: sid,
          event_type: "heartbeat",
          timestamp: iso(NOW, -2_000),
          payload: { kind: "heartbeat", process_alive: false },
        }),
      ];
      await assertParity("dead", events);
      const tsObs = observeFromEvents(events);
      // 死亡 heartbeat は event に寄与しない → 最後の活動は command.started (-90s)。
      expect(tsObs.event?.atMs).toBe(NOW - 90_000);
      expect(tsObs.process).toEqual({ alive: false, atMs: NOW - 2_000 });
    });

    it("alive heartbeat (process_alive:true) — counts as activity in BOTH", async () => {
      const sid = newSession("sess_par_alive");
      const events = [
        makeEvent({
          session_id: sid,
          event_type: "heartbeat",
          timestamp: iso(NOW, -2_000),
          payload: { kind: "heartbeat", process_alive: true },
        }),
      ];
      await assertParity("alive", events);
    });

    it("each signal kind (stdout / file / modelStream) maps identically", async () => {
      const sid = newSession("sess_par_kinds");
      const events = [
        makeEvent({
          session_id: sid,
          event_type: "command.output.delta",
          timestamp: iso(NOW, -10_000),
          payload: { kind: "command.output.delta", stream: "stdout", delta: "x" },
        }),
        makeEvent({
          session_id: sid,
          event_type: "tool.output.delta",
          timestamp: iso(NOW, -8_000),
          payload: { kind: "tool.output.delta", delta: "y" },
        }),
        makeEvent({
          session_id: sid,
          event_type: "diff.updated",
          timestamp: iso(NOW, -5_000),
          payload: { kind: "diff.updated" },
        }),
        makeEvent({
          session_id: sid,
          event_type: "agent.reasoning_summary.delta",
          timestamp: iso(NOW, -3_000),
          payload: { kind: "agent.reasoning_summary.delta", delta: "z" },
        }),
      ];
      await assertParity("kinds", events);
    });

    it("mixed signals + out-of-order delivery — latest per signal in BOTH", async () => {
      const sid = newSession("sess_par_mixed_ooo");
      const events = [
        makeEvent({
          session_id: sid,
          event_type: "heartbeat",
          timestamp: iso(NOW, -1_000), // newest heartbeat first (out of order)
          payload: { kind: "heartbeat", process_alive: false },
        }),
        makeEvent({
          session_id: sid,
          event_type: "heartbeat",
          timestamp: iso(NOW, -5_000),
          payload: { kind: "heartbeat", process_alive: true },
        }),
        makeEvent({
          session_id: sid,
          event_type: "command.output.delta",
          timestamp: iso(NOW, -7_000),
          payload: { kind: "command.output.delta", stream: "stdout", delta: "a" },
        }),
        makeEvent({
          session_id: sid,
          event_type: "heartbeat",
          timestamp: iso(NOW, -3_000), // naked, between the two typed heartbeats
          payload: { kind: "heartbeat" },
        }),
      ];
      await assertParity("mixed-ooo", events);
      // 最新 heartbeat (-1s, dead) を process に採用。event は naked/-3s ではなく…
      // -1s dead は event 除外、-3s naked は活動 → event 最新は -3s。
      const tsObs = observeFromEvents(events);
      expect(tsObs.process).toEqual({ alive: false, atMs: NOW - 1_000 });
      expect(tsObs.event?.atMs).toBe(NOW - 3_000);
    });

    it("TDA-1: same max-timestamp opposite process_alive — tie-break agrees with PK-id reversed vs array order", async () => {
      // 正典契約 (TDA-1): 同一 max-timestamp の typed heartbeat が複数ある場合の tie-break を
      // SQL と TS で一致させる。両者が共有できる安定キーは **event_id (UUIDv7)** のみ
      // (PK id は TS から見えず、配列位置は SQL から見えない)。よって両側とも
      // `timestamp 最新 → event_id 最大` を勝者とする。
      //
      // この退行ガードは「PK id 順 != 配列順 != event_id 順」を意図的に作る:
      //  - alive=false  : 配列で先, event_id=低, PK id=UUID_MAX (旧 SQL `id DESC` が掴む)
      //  - alive=true   : 配列で後, event_id=高, PK id=UUID_MIN
      // 旧 SQL (`ORDER BY timestamp DESC, id DESC`) は PK id 最大の alive=false を選び、
      // TS (配列後勝ち) と event_id 正典 (event_id 最大=alive=true) の双方と乖離 → **赤**。
      // 修正後は両側 event_id DESC で alive=true を選び一致。
      const sid = newSession("sess_par_tda1_tie");
      const ts = iso(NOW, -2_000);

      // event_id の大小を確定させる (UUIDv7 を 2 つ採番し辞書順で low/high を確定)。
      const [idA, idB] = [newEventId(), newEventId()].sort();
      const lowEventId = idA!;
      const highEventId = idB!;

      const evFalse = makeEvent({
        event_id: lowEventId, // event_id 低
        session_id: sid,
        event_type: "heartbeat",
        timestamp: ts,
        payload: { kind: "heartbeat", process_alive: false },
      });
      const evTrue = makeEvent({
        event_id: highEventId, // event_id 高
        session_id: sid,
        event_type: "heartbeat",
        timestamp: ts,
        payload: { kind: "heartbeat", process_alive: true },
      });

      // 配列順: false → true (TS は後勝ちで true を採用)。
      // PK id: false に UUID_MAX, true に UUID_MIN (旧 SQL `id DESC` は false を採用 → 乖離)。
      await insertRaw(pool, evFalse, { pkId: UUID_MAX });
      await insertRaw(pool, evTrue, { pkId: UUID_MIN });

      const events = [evFalse, evTrue];
      const client = await pool.connect();
      let sqlObs: LivenessObservation;
      try {
        sqlObs = await aggregateObservationSql(client, sid);
      } finally {
        client.release();
      }
      const tsObs = observeFromEvents(events);

      // 正典: timestamp 最新かつ event_id 最大 = alive=true。
      expect(tsObs.process?.alive, "TS tie-break should pick event_id-max (alive=true)").toBe(true);
      expect(sqlObs.process?.alive, "SQL tie-break should pick event_id-max (alive=true)").toBe(
        true,
      );
      // parity: 両者の process 観測が完全一致。
      expect(
        sqlObs.process?.alive,
        `TDA-1 tie-break divergence: SQL=${JSON.stringify(sqlObs.process)} TS=${JSON.stringify(tsObs.process)}`,
      ).toBe(tsObs.process?.alive);
      expect(sqlObs).toEqual(tsObs);
    });

    it('TDA-2: non-boolean process_alive (string "false" / numeric 0) — SQL and TS agree (raw rows)', async () => {
      // 正典契約 (TDA-2): 死亡 heartbeat の除外と typed heartbeat の採用は **真の JSON boolean**
      // のときだけ。文字列 "false" / "true" や数値 0 は boolean ではないので:
      //  - event(活動) からは除外しない (TS の `typeof === 'boolean'` ゲートと鏡写し)。
      //  - process 観測 (typed heartbeat) としても採用しない。
      // loose record (z.looseObject) は文字列/数値 process_alive を保存しうるため (現行 backend
      // ingest 経路でも到達可能)、生 row を直接 INSERT して parity を縛る。
      //
      // 旧 SQL は `payload->>'process_alive' = 'false'` (text 比較) で文字列 "false" を死亡扱い
      // し event から除外 / `IN ('true','false')` で typed heartbeat として誤採用 → TS と乖離 → 赤。

      // --- ケース A: 文字列 "false" ---
      {
        const sid = newSession("sess_par_tda2_strfalse");
        const cmd = makeEvent({
          session_id: sid,
          event_type: "command.started",
          state: "running.command_executing",
          timestamp: iso(NOW, -90_000),
          payload: { kind: "command.started", command: "npm test" },
        });
        // 文字列 "false" の process_alive を持つ heartbeat (boolean ではない)。
        const hbStr = makeEvent({
          session_id: sid,
          event_type: "heartbeat",
          timestamp: iso(NOW, -2_000),
          payload: { kind: "heartbeat" },
        });
        await insertRaw(pool, cmd);
        await insertRaw(pool, hbStr, {
          rawPayload: { kind: "heartbeat", process_alive: "false" },
        });

        // TS は生 row を読まないので、TS リファレンスは同じ非 boolean payload の events で評価。
        const tsEvents = [
          cmd,
          { ...hbStr, payload: { kind: "heartbeat", process_alive: "false" } } as NormalizedEvent,
        ];
        const client = await pool.connect();
        let sqlObs: LivenessObservation;
        try {
          sqlObs = await aggregateObservationSql(client, sid);
        } finally {
          client.release();
        }
        const tsObs = observeFromEvents(tsEvents);
        // 文字列 "false" は boolean でない → 活動として数える (除外しない) → event 最新 = -2s。
        // process は未観測 (typed heartbeat 不採用)。
        expect(tsObs.event?.atMs).toBe(NOW - 2_000);
        expect(tsObs.process).toBeUndefined();
        expect(
          sqlObs,
          `TDA-2 string "false" divergence: SQL=${JSON.stringify(sqlObs)} TS=${JSON.stringify(tsObs)}`,
        ).toEqual(tsObs);
      }

      // --- ケース B: 数値 0 ---
      {
        const sid = newSession("sess_par_tda2_num0");
        const hbNum = makeEvent({
          session_id: sid,
          event_type: "heartbeat",
          timestamp: iso(NOW, -2_000),
          payload: { kind: "heartbeat" },
        });
        await insertRaw(pool, hbNum, {
          rawPayload: { kind: "heartbeat", process_alive: 0 },
        });
        const tsEvents = [
          { ...hbNum, payload: { kind: "heartbeat", process_alive: 0 } } as NormalizedEvent,
        ];
        const client = await pool.connect();
        let sqlObs: LivenessObservation;
        try {
          sqlObs = await aggregateObservationSql(client, hbNum.session_id);
        } finally {
          client.release();
        }
        const tsObs = observeFromEvents(tsEvents);
        // 数値 0 は boolean でない → 活動として数える / process 未採用。
        expect(tsObs.event?.atMs).toBe(NOW - 2_000);
        expect(tsObs.process).toBeUndefined();
        expect(
          sqlObs,
          `TDA-2 numeric 0 divergence: SQL=${JSON.stringify(sqlObs)} TS=${JSON.stringify(tsObs)}`,
        ).toEqual(tsObs);
      }
    });

    it("randomized event series (50 cases) — SQL and TS agree on all fields", async () => {
      const KINDS = [
        {
          event_type: "command.output.delta",
          payload: { kind: "command.output.delta", stream: "stdout", delta: "x" },
        },
        { event_type: "tool.output.delta", payload: { kind: "tool.output.delta", delta: "x" } },
        { event_type: "diff.updated", payload: { kind: "diff.updated" } },
        {
          event_type: "file.change.proposed",
          payload: { kind: "file.change.proposed", path: "a.ts" },
        },
        { event_type: "agent.message.delta", payload: { kind: "agent.message.delta", delta: "x" } },
        {
          event_type: "agent.reasoning_summary.delta",
          payload: { kind: "agent.reasoning_summary.delta", delta: "x" },
        },
        { event_type: "heartbeat", payload: { kind: "heartbeat", process_alive: true } },
        { event_type: "heartbeat", payload: { kind: "heartbeat", process_alive: false } },
        { event_type: "heartbeat", payload: { kind: "heartbeat" } }, // naked
      ] as const;

      let seed = 0x1234_5678;
      const rnd = (): number => {
        // 決定論 LCG (再現可能なランダム列)。
        seed = (seed * 1_103_515_245 + 12_345) & 0x7fff_ffff;
        return seed / 0x7fff_ffff;
      };

      for (let c = 0; c < 50; c++) {
        const sid = newSession(`sess_par_rnd_${c}`);
        const n = 1 + Math.floor(rnd() * 8);
        const events: NormalizedEvent[] = [];
        for (let i = 0; i < n; i++) {
          const k = KINDS[Math.floor(rnd() * KINDS.length)]!;
          const offset = -Math.floor(rnd() * 120_000); // 0..-120s
          events.push(
            makeEvent({
              session_id: sid,
              event_type: k.event_type,
              timestamp: iso(NOW, offset),
              payload: { ...k.payload },
            }),
          );
        }
        await assertParity(`rnd#${c}`, events);
      }
    });
  },
);
