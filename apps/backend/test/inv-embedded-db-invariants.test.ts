/**
 * INV-EMBEDDED-DB-INVARIANTS — QA-1 carryover (decision 019f1bae / Phase 1c・ADR 019f1b71)。
 *
 * 埋込 PGlite の socket 経路で、SQL 依存の T1 不変条件を real-PG 版と **同型** に再検証する。
 * 埋込 (PGlite = WASM 上の実 PostgreSQL) と CI/本番の外部 Postgres の間で SQL dialect が
 * 乖離すると、埋込を既定にした後にその乖離が「移行時に見えなくなる」死角になる
 * (memory never-run-ci-latent-failures-faithful-repro-needs-ci-true)。同一 INV を両エンジンで
 * 走らせて乖離を赤で捕らえる。
 *
 * REAL DATA ONLY: モック無し。PGlite は自己完結ゆえ DATABASE_URL / Docker 不要で **無条件実走**
 * する (skipIf 無し = CI の通常 backend test job で必ず走る)。real-PG 版 (inv-ingest-store /
 * inv-liveness-parity) は DATABASE_URL 到達時のみ走るのと対をなす。
 *
 * 対象 INV (SQL dialect-sensitive):
 *  - INV-EVENT-ORDER (embedded): out-of-order timestamp → monotonic=false + append-only。
 *  - INV-LIVENESS-PARITY (embedded): aggregateObservationSql(SQL 集約) === observeFromEvents(TS)。
 *    最大の dialect 面 (window/DISTINCT ON/jsonb 抽出を含む集約 SQL) を埋込エンジンで固定する。
 *    real-PG 版が持つ最も dialect-sensitive な 2 敵対ケースを埋込側でも走らせる (QA-1・下記):
 *      · TDA-1 tie-break: 同一 max-timestamp・逆 process_alive で SQL の `ORDER BY timestamp
 *        DESC, event_id DESC` (旧 `id DESC` バグの回帰ガード) を検証。
 *      · TDA-2 non-boolean: 文字列 "false" / 数値 0 の process_alive で SQL の jsonb-boolean
 *        判定 (`= 'false'::jsonb` / `IN ('true','false'::jsonb)`・旧 `->>` text 比較バグの回帰
 *        ガード) を検証。PGlite の jsonb boolean 比較が外部 PG と一致することを固定する。
 *
 * STALLED / APPROVAL は純関数 (DB 非依存・inv-stalled / inv-approval-projection) ゆえ dialect
 * 不変で、埋込 socket 経路の再検証は不要 (エンジンを跨いでも同一 TS ロジック)。
 *
 * insertRaw はローカル定義 (real-PG 版 inv-liveness-parity.test.ts と同一シグネチャ:
 * pkId + rawPayload)。テストヘルパの軽微重複は Phase 1c tech-debt sweep で helpers.ts へ
 * 集約する (real-PG 版は本機で DATABASE_URL 無しには verify 不能ゆえ本 PR では触らない)。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { newEventId, type NormalizedEvent } from "@actradeck/event-model";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPool } from "../src/index.js";
import { EMBEDDED_POOL_MAX, startEmbeddedPg, type EmbeddedDb } from "../src/embedded-db.js";
import { aggregateObservationSql, IngestStore } from "../src/ingest-store.js";
import { observeFromEvents, type LivenessObservation } from "../src/liveness.js";
import { iso, makeEvent } from "./helpers.js";

/**
 * raw events を直接 INSERT する (reducer/projection を介さず純粋な集約 parity を見るため)。
 * inv-liveness-parity.test.ts のローカル insertRaw と同型 (埋込 pool 経由・socket 透過)。
 *
 * `pkId`: PK id (events.id) を明示指定できる。TDA-1 tie-break で「PK id 順 != event_id 順」を
 *   作り、SQL の ORDER BY が id でなく event_id で tie-break することを埋込エンジンで固定する
 *   (UUIDv7 採番だと id 順==event_id 順==挿入順で三者整合し tie-break 乖離を覆い隠すため)。
 * `rawPayload`: parseEvent を通さない生 jsonb を書き込む。TDA-2 で文字列 "false" / 数値 0 の
 *   process_alive (boolean でない loose record) を再現する。
 */
async function insertRaw(
  pool: Pool,
  ev: NormalizedEvent,
  opts: { pkId?: string; rawPayload?: unknown } = {},
) {
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

/** 全ビット 0 / 全ビット f の固定 UUID。PK id の大小を明示制御する (TDA-1)。 */
const UUID_MIN = "00000000-0000-0000-0000-000000000000";
const UUID_MAX = "ffffffff-ffff-ffff-ffff-ffffffffffff";

// 埋込 PGlite は WASM boot が遅い (~秒) ため、全 embedded INV で 1 インスタンスを共有する。
let dataDir: string;
let embedded: EmbeddedDb;
let pool: Pool;

beforeAll(async () => {
  dataDir = join(mkdtempSync(join(tmpdir(), "actradeck-embed-inv-")), "pgdata");
  embedded = await startEmbeddedPg(dataDir);
  pool = createPool({ connectionString: embedded.connectionString, max: EMBEDDED_POOL_MAX });
}, 30_000);

afterAll(async () => {
  await pool?.end();
  await embedded?.close();
  if (dataDir) rmSync(join(dataDir, ".."), { recursive: true, force: true });
});

describe("INV-EVENT-ORDER (embedded PGlite + socket)", () => {
  it("out-of-order timestamp is observed (monotonic=false) but NOT dropped (append-only)", async () => {
    const store = new IngestStore({ pool });
    const sid = `sess_embed_order_${Date.now().toString(36)}`;
    const base = 1_900_000_000_000;
    const e1 = makeEvent({
      session_id: sid,
      state: "starting",
      event_type: "session.started",
      timestamp: iso(base, 0),
    });
    const e2 = makeEvent({
      session_id: sid,
      state: "running.model_wait",
      event_type: "turn.started",
      timestamp: iso(base, 5_000),
    });
    // e3 は e2 より過去 (巻き戻り)。
    const e3 = makeEvent({
      session_id: sid,
      event_type: "agent.message.delta",
      timestamp: iso(base, 2_000),
      payload: { kind: "agent.message.delta", delta: "late" },
    });

    const r1 = await store.ingest(e1);
    const r2 = await store.ingest(e2);
    const r3 = await store.ingest(e3);

    expect(r1.monotonic).toBe(true);
    expect(r2.monotonic).toBe(true);
    expect(r3.monotonic).toBe(false); // 巻き戻りを埋込エンジンでも検知

    // e3 は落とさず永続化 (append-only)。
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM events WHERE session_id = $1`,
      [sid],
    );
    expect(rows[0].n).toBe(3);
  });

  it("session-scoped: 別セッションの早い時刻は干渉しない (monotonic=true)", async () => {
    const store = new IngestStore({ pool });
    const sidA = `sess_embed_order_a_${Date.now().toString(36)}`;
    const sidB = `sess_embed_order_b_${Date.now().toString(36)}`;
    const base = 1_900_000_000_000;
    await store.ingest(
      makeEvent({
        session_id: sidA,
        event_type: "heartbeat",
        timestamp: iso(base, 10_000),
        payload: { kind: "heartbeat", process_alive: true },
      }),
    );
    const rB = await store.ingest(
      makeEvent({
        session_id: sidB,
        event_type: "heartbeat",
        timestamp: iso(base, 1_000), // sidA より過去だが別セッション
        payload: { kind: "heartbeat", process_alive: true },
      }),
    );
    expect(rB.monotonic).toBe(true);
  });
});

describe("INV-LIVENESS-PARITY (embedded PGlite + socket): SQL aggregate === TS observeFromEvents", () => {
  /** events を埋込 PG へ投入し、SQL 観測と TS 観測の全フィールド一致を assert。 */
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
    expect(
      sqlObs,
      `parity mismatch [${label}]: SQL=${JSON.stringify(sqlObs)} TS=${JSON.stringify(tsObs)}`,
    ).toEqual(tsObs);
  }

  const NOW = 1_900_000_000_000;

  it("naked heartbeat only (no process_alive) — event 活動として両方で計上", async () => {
    const sid = `sess_embed_par_naked_${Date.now().toString(36)}`;
    const events = [
      makeEvent({
        session_id: sid,
        event_type: "heartbeat",
        timestamp: iso(NOW, -2_000),
        payload: { kind: "heartbeat" },
      }),
    ];
    await assertParity("naked-only", events);
  });

  it("dead heartbeat (process_alive:false) — event 活動から除外・process=dead", async () => {
    const sid = `sess_embed_par_dead_${Date.now().toString(36)}`;
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
  });

  it("each signal kind (stdout / tool / diff / reasoning) maps identically", async () => {
    const sid = `sess_embed_par_kinds_${Date.now().toString(36)}`;
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
    const sid = `sess_embed_par_mixed_${Date.now().toString(36)}`;
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
  });

  it("randomized event series (20 cases) — SQL and TS agree on all fields", async () => {
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
      // 決定論 LCG (再現可能なランダム列)。Math.random は使わない (再現性)。
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fff_ffff;
      return seed / 0x7fff_ffff;
    };

    for (let c = 0; c < 20; c++) {
      const sid = `sess_embed_par_rnd_${c}_${Date.now().toString(36)}`;
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

  it("TDA-1: same max-timestamp opposite process_alive — SQL tie-break は event_id 最大 (PGlite の ORDER BY)", async () => {
    // 正典契約: 同一 max-timestamp の typed heartbeat が複数ある場合、SQL と TS の tie-break を
    // event_id (UUIDv7) で一致させる。埋込 (PGlite) の `ORDER BY timestamp DESC, event_id DESC`
    // が外部 PG と同じ勝者 (event_id 最大=alive=true) を選ぶことを固定する。
    // 「PK id 順 != event_id 順 != 配列順」を意図的に作る:
    //  - alive=false : 配列で先, event_id=低, PK id=UUID_MAX (旧 `id DESC` バグが掴む)
    //  - alive=true  : 配列で後, event_id=高, PK id=UUID_MIN
    // 旧 SQL (`id DESC`) なら alive=false を選び TS/event_id 正典と乖離 → 赤。修正後は両側一致。
    const sid = `sess_embed_par_tda1_${Date.now().toString(36)}`;
    const ts = iso(NOW, -2_000);

    const [idA, idB] = [newEventId(), newEventId()].sort();
    const lowEventId = idA!;
    const highEventId = idB!;

    const evFalse = makeEvent({
      event_id: lowEventId,
      session_id: sid,
      event_type: "heartbeat",
      timestamp: ts,
      payload: { kind: "heartbeat", process_alive: false },
    });
    const evTrue = makeEvent({
      event_id: highEventId,
      session_id: sid,
      event_type: "heartbeat",
      timestamp: ts,
      payload: { kind: "heartbeat", process_alive: true },
    });

    // PK id: false→UUID_MAX, true→UUID_MIN (旧 `id DESC` は false を掴む → 乖離を誘発)。
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

    // event_id 最大 (=alive=true) を両側が採用し、完全一致する。
    expect(tsObs.process?.alive, "TS tie-break should pick event_id-max (alive=true)").toBe(true);
    expect(
      sqlObs.process?.alive,
      "PGlite SQL tie-break should pick event_id-max (alive=true), not PK id",
    ).toBe(true);
    expect(
      sqlObs,
      `TDA-1 tie-break divergence: SQL=${JSON.stringify(sqlObs)} TS=${JSON.stringify(tsObs)}`,
    ).toEqual(tsObs);
  });

  it('TDA-2: non-boolean process_alive (string "false" / numeric 0) — PGlite jsonb-boolean 判定が TS と一致', async () => {
    // 正典契約: 死亡 heartbeat の除外・typed heartbeat の採用は **真の JSON boolean** のときだけ。
    // 文字列 "false" / 数値 0 は boolean でないので event 活動から除外せず、process 観測にも
    // 採用しない (TS の `typeof === 'boolean'` ゲートと鏡写し)。PGlite の jsonb 比較
    // (`= 'false'::jsonb` は text "false" に非マッチ / `IN ('true','false'::jsonb)` に非該当) が
    // 外部 PG と同じ結果を出すことを固定する (旧 `->>` text 比較は文字列 "false" を誤って死亡扱い)。

    // --- ケース A: 文字列 "false" ---
    {
      const sid = `sess_embed_par_tda2_str_${Date.now().toString(36)}`;
      const cmd = makeEvent({
        session_id: sid,
        event_type: "command.started",
        state: "running.command_executing",
        timestamp: iso(NOW, -90_000),
        payload: { kind: "command.started", command: "npm test" },
      });
      const hbStr = makeEvent({
        session_id: sid,
        event_type: "heartbeat",
        timestamp: iso(NOW, -2_000),
        payload: { kind: "heartbeat" },
      });
      await insertRaw(pool, cmd);
      await insertRaw(pool, hbStr, { rawPayload: { kind: "heartbeat", process_alive: "false" } });

      // TS は生 row を読まないので同じ非 boolean payload で評価。
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
      // 文字列 "false" は boolean でない → 活動として計上 (event 最新 = -2s) / process 未観測。
      expect(tsObs.event?.atMs).toBe(NOW - 2_000);
      expect(tsObs.process).toBeUndefined();
      expect(
        sqlObs,
        `TDA-2 string "false" divergence: SQL=${JSON.stringify(sqlObs)} TS=${JSON.stringify(tsObs)}`,
      ).toEqual(tsObs);
    }

    // --- ケース B: 数値 0 ---
    {
      const sid = `sess_embed_par_tda2_num_${Date.now().toString(36)}`;
      const hbNum = makeEvent({
        session_id: sid,
        event_type: "heartbeat",
        timestamp: iso(NOW, -2_000),
        payload: { kind: "heartbeat" },
      });
      await insertRaw(pool, hbNum, { rawPayload: { kind: "heartbeat", process_alive: 0 } });
      const tsEvents = [
        { ...hbNum, payload: { kind: "heartbeat", process_alive: 0 } } as NormalizedEvent,
      ];
      const client = await pool.connect();
      let sqlObs: LivenessObservation;
      try {
        sqlObs = await aggregateObservationSql(client, sid);
      } finally {
        client.release();
      }
      const tsObs = observeFromEvents(tsEvents);
      // 数値 0 は boolean でない → 活動として計上 / process 未採用。
      expect(tsObs.event?.atMs).toBe(NOW - 2_000);
      expect(tsObs.process).toBeUndefined();
      expect(
        sqlObs,
        `TDA-2 numeric 0 divergence: SQL=${JSON.stringify(sqlObs)} TS=${JSON.stringify(tsObs)}`,
      ).toEqual(tsObs);
    }
  });
});
