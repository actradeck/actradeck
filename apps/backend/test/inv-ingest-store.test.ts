/**
 * INV-IDEMPOTENCY / INV-EVENT-ORDER (P0, REAL PostgreSQL)。
 *
 * 実 PG (DATABASE_URL, port 55432 local / 5432 CI) に接続し、冪等 append + projection +
 * liveness を実データで検証する (REAL DATA ONLY: モック DB 無し)。
 *
 *  - INV-IDEMPOTENCY: 同一 event_id を N 回投入 → events 1 行 / session_state 一意。
 *    projection も二重適用しない (delta storm でも state が一意収束)。
 *  - INV-EVENT-ORDER: out-of-order timestamp を MonotonicTimestampChecker で観測
 *    (monotonic=false を返す) が、イベントは落とさず append-only で永続化する。
 *  - 受け入れ: tool call イベントが 1s 以内に projection 反映。
 *
 * DB 未到達なら describe.skipIf で skip (CI では実走必須。silent green 禁止)。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newEventId } from "@actradeck/event-model";
import { Pool } from "pg";

import { IngestStore } from "../src/ingest-store.js";
import { RealtimeStore } from "../src/realtime-store.js";
import { cleanupSessions, dbReachable, iso, makeEvent } from "./helpers.js";

const DATABASE_URL = process.env.DATABASE_URL;
const reachable = DATABASE_URL ? await dbReachable(DATABASE_URL) : false;

describe.skipIf(!reachable)("INV-IDEMPOTENCY / INV-EVENT-ORDER (real Postgres)", () => {
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

  it("INV-IDEMPOTENCY: same event_id ingested N times ⇒ exactly 1 event row", async () => {
    const store = new IngestStore({ pool });
    const sid = newSession("sess_idem");
    const eid = newEventId();
    const ev = makeEvent({
      event_id: eid,
      session_id: sid,
      state: "running.command_executing",
      event_type: "command.started",
      payload: { kind: "command.started", command: "npm test" },
    });

    const r1 = await store.ingest(ev);
    const r2 = await store.ingest(ev);
    const r3 = await store.ingest(ev);

    expect(r1.inserted).toBe(true);
    expect(r2.inserted).toBe(false); // 冪等 no-op
    expect(r3.inserted).toBe(false);

    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM events WHERE event_id = $1`, [
      eid,
    ]);
    expect(rows[0].n).toBe(1); // 重複行ゼロ

    const ss = await pool.query(
      `SELECT count(*)::int AS n FROM session_state WHERE session_id = $1`,
      [sid],
    );
    expect(ss.rows[0].n).toBe(1); // projection 一意
  });

  it("INV-IDEMPOTENCY: projection is NOT double-applied on resend (counter stays consistent)", async () => {
    const store = new IngestStore({ pool });
    const sid = newSession("sess_idem_proj");
    // created → starting → running は妥当。invalid を 1 回だけ起こすイベントを作る。
    await store.ingest(
      makeEvent({ session_id: sid, state: "created", event_type: "session.started" }),
    );
    const invalidEv = makeEvent({
      session_id: sid,
      state: "running.command_executing",
      event_type: "command.started",
      payload: { kind: "command.started", command: "x" },
    });
    // created → running.command_executing は不正遷移 (created は starting/disconnected/failed のみ)。
    const a = await store.ingest(invalidEv);
    expect(a.invalidTransition).toBe(true);
    // 同じ不正イベントを再送しても invalid_transition_count は二重加算されない (冪等)。
    await store.ingest(invalidEv);
    await store.ingest(invalidEv);

    const { rows } = await pool.query(
      `SELECT liveness->>'invalid_transition_count' AS c FROM session_state WHERE session_id = $1`,
      [sid],
    );
    expect(Number(rows[0].c)).toBe(1); // 再送で増えない
  });

  it("QA-2 (INV-SECRET-DETECTED-IDEMPOTENCY, real PG): same event_id resend does NOT double-count secret_redaction_count", async () => {
    // redaction_count>0 の event を同一 event_id で 2 回 ingest し、session_state の
    // secret_redaction_count が二重加算されない (= 1 回分のみ) ことを実 PG で pin する。
    // ingest-store の `if (!inserted)` early-return (冪等 no-op で projection を再適用しない) が
    // 効いていることの falsifiable な担保。mutation (early-return 除去) で本テストは赤化する。
    const store = new IngestStore({ pool });
    const sid = newSession("sess_secret_idem");
    await store.ingest(
      makeEvent({ session_id: sid, state: "starting", event_type: "session.started" }),
    );
    const secretEv = makeEvent({
      session_id: sid,
      event_type: "agent.message.delta",
      payload: { kind: "agent.message.delta", delta: "redacted body" },
      redaction_count: 3,
      redaction_count_by_kind: { "github-token": 2, "aws-access-key-id": 1 },
    });
    const r1 = await store.ingest(secretEv);
    const r2 = await store.ingest(secretEv);
    const r3 = await store.ingest(secretEv);
    expect(r1.inserted).toBe(true);
    expect(r2.inserted).toBe(false); // 冪等 no-op
    expect(r3.inserted).toBe(false);
    // projection (no-op で読み出した値) も 1 回分のみ。
    expect(r1.projection.secret_redaction_count).toBe(3);
    expect(r1.projection.secret_detected).toBe(true);
    expect(r1.projection.secret_redaction_count_by_kind).toEqual({
      "github-token": 2,
      "aws-access-key-id": 1,
    });
    expect(r3.projection.secret_redaction_count).toBe(3);
    expect(r3.projection.secret_redaction_count_by_kind).toEqual({
      "github-token": 2,
      "aws-access-key-id": 1,
    });

    // 永続列も二重加算されない (DB が真実)。
    const { rows } = await pool.query(
      `SELECT secret_detected, secret_redaction_count, secret_redaction_count_by_kind
         FROM session_state WHERE session_id = $1`,
      [sid],
    );
    expect(rows[0].secret_detected).toBe(true);
    expect(Number(rows[0].secret_redaction_count)).toBe(3); // 再送で増えない
    // jsonb 列も kind 別に 1 回分のみ (再送で増えない)。
    expect(rows[0].secret_redaction_count_by_kind).toEqual({
      "github-token": 2,
      "aws-access-key-id": 1,
    });

    // DTO 投影でも kind 別件数が SessionDetail に載る。
    const detail = await new RealtimeStore(pool).detail(sid);
    expect(detail?.secret_redaction_count_by_kind).toEqual({
      "github-token": 2,
      "aws-access-key-id": 1,
    });
    const sum = Object.values(detail!.secret_redaction_count_by_kind!).reduce((a, b) => a + b, 0);
    expect(sum).toBe(detail!.secret_redaction_count);
  });

  it("強み(a)③ (real PG): 複数 event で secret_redaction_count_by_kind が kind 別に累積する", async () => {
    const store = new IngestStore({ pool });
    const sid = newSession("sess_secret_bykind_merge");
    await store.ingest(
      makeEvent({ session_id: sid, state: "starting", event_type: "session.started" }),
    );
    await store.ingest(
      makeEvent({
        session_id: sid,
        event_type: "agent.message.delta",
        timestamp: iso(Date.now(), 1),
        redaction_count: 3,
        redaction_count_by_kind: { "github-token": 2, "aws-access-key-id": 1 },
      }),
    );
    const last = await store.ingest(
      makeEvent({
        session_id: sid,
        event_type: "agent.message.delta",
        timestamp: iso(Date.now(), 2),
        redaction_count: 2,
        redaction_count_by_kind: { "github-token": 1, "high-entropy-secret": 1 },
      }),
    );
    // 各 kind が合算される。
    expect(last.projection.secret_redaction_count_by_kind).toEqual({
      "github-token": 3,
      "aws-access-key-id": 1,
      "high-entropy-secret": 1,
    });
    // INV: sum(by_kind) === secret_redaction_count (DB 跨ぎでも成立)。
    const { rows } = await pool.query(
      `SELECT secret_redaction_count, secret_redaction_count_by_kind
         FROM session_state WHERE session_id = $1`,
      [sid],
    );
    const byKind = rows[0].secret_redaction_count_by_kind as Record<string, number>;
    const sum = Object.values(byKind).reduce((a, b) => a + b, 0);
    expect(sum).toBe(Number(rows[0].secret_redaction_count));
    expect(sum).toBe(5);
  });

  it("SEC-3 (real PG): crafted event の phantom/任意 kind は jsonb 永続+DTO へ漏れない (closed-enum gate)", async () => {
    // round-2 CONDITIONAL 解消 (decision 019ec720): token 認証された crafted event が任意 kind 名
    //   (phantom / secret 形文字列の key 注入) を redaction_count_by_kind に載せても、projection の
    //   allowlist gate (REDACTION_KINDS_SET) が捨てるため session_state jsonb 列・SessionDetail DTO
    //   へ漏れないことを実 PG round-trip で pin する。raw 受信→parseEvent (loose schema)→applyEvent→
    //   jsonb upsert→DTO の全経路を貫通させる。mutation 反証: projection gate を外すと jsonb に
    //   foo-bar 等が永続し本テスト赤化。
    const store = new IngestStore({ pool });
    const sid = newSession("sess_secret_phantom_gate");
    await store.ingest(
      makeEvent({ session_id: sid, state: "starting", event_type: "session.started" }),
    );
    const r = await store.ingest(
      makeEvent({
        session_id: sid,
        event_type: "agent.message.delta",
        timestamp: iso(Date.now(), 1),
        redaction_count: 4,
        // 既知 1 + phantom 2 + secret 形 key 注入 1。phantom/注入は gate で捨てられる。
        redaction_count_by_kind: {
          "github-token": 1,
          "foo-bar": 2,
          "totally-fake": 3,
          ghpfakeinjectedkindname: 1,
        },
      }),
    );
    // projection: 既知 kind のみ。
    expect(r.projection.secret_redaction_count_by_kind).toEqual({ "github-token": 1 });
    // 永続 jsonb 列にも phantom/注入 kind が存在しない (DB が真実)。
    const { rows } = await pool.query(
      `SELECT secret_redaction_count_by_kind FROM session_state WHERE session_id = $1`,
      [sid],
    );
    expect(rows[0].secret_redaction_count_by_kind).toEqual({ "github-token": 1 });
    const persistedKeys = Object.keys(
      rows[0].secret_redaction_count_by_kind as Record<string, number>,
    );
    expect(persistedKeys).not.toContain("foo-bar");
    expect(persistedKeys).not.toContain("totally-fake");
    expect(persistedKeys).not.toContain("ghpfakeinjectedkindname");
    // DTO 投影でも phantom 漏れなし。
    const detail = await new RealtimeStore(pool).detail(sid);
    expect(detail?.secret_redaction_count_by_kind).toEqual({ "github-token": 1 });
  });

  it("INV-EVENT-ORDER: out-of-order timestamp is observed (monotonic=false) but NOT dropped", async () => {
    const store = new IngestStore({ pool });
    const sid = newSession("sess_order");
    const base = Date.now();
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
    expect(r3.monotonic).toBe(false); // 巻き戻りを検知

    // しかし e3 は落とさず永続化されている (append-only)。
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM events WHERE session_id = $1`,
      [sid],
    );
    expect(rows[0].n).toBe(3);
  });

  it("INV-EVENT-ORDER: session-scoped — different sessions do not interfere", async () => {
    const store = new IngestStore({ pool });
    const sidA = newSession("sess_order_a");
    const sidB = newSession("sess_order_b");
    const base = Date.now();
    await store.ingest(
      makeEvent({
        session_id: sidA,
        event_type: "heartbeat",
        timestamp: iso(base, 10_000),
        payload: { kind: "heartbeat", process_alive: true },
      }),
    );
    // sidB の早い時刻は sidA の進行と独立 → monotonic=true であるべき。
    const rB = await store.ingest(
      makeEvent({
        session_id: sidB,
        event_type: "heartbeat",
        timestamp: iso(base, 1_000),
        payload: { kind: "heartbeat", process_alive: true },
      }),
    );
    expect(rB.monotonic).toBe(true);
  });

  it("acceptance: a tool call event reflects in the projection within 1s", async () => {
    const store = new IngestStore({ pool });
    const sid = newSession("sess_perf");
    await store.ingest(
      makeEvent({ session_id: sid, state: "starting", event_type: "session.started" }),
    );
    const t0 = Date.now();
    const r = await store.ingest(
      makeEvent({
        session_id: sid,
        state: "running.tool_preparing",
        event_type: "tool.started",
        summary: "Bash: npm test",
        payload: { kind: "tool.started", tool_name: "Bash" },
      }),
    );
    const elapsed = Date.now() - t0;
    expect(r.inserted).toBe(true);
    expect(r.projection.state).toBe("running.tool_preparing");
    expect(r.projection.current_action).toBe("Bash: npm test");
    // projection が DB に反映されていることを実読で確認。
    const { rows } = await pool.query(
      `SELECT state, current_action FROM session_state WHERE session_id = $1`,
      [sid],
    );
    expect(rows[0].state).toBe("running.tool_preparing");
    expect(rows[0].current_action).toBe("Bash: npm test");
    expect(elapsed).toBeLessThan(1_000); // 1s 以内
  });

  it("INV-STALLED (real PG): liveness projection records decomposed evidence; stalled only when dead+stale", async () => {
    const sid = newSession("sess_live");
    const base = Date.now();
    // 全イベントを 90s 前に固定し、process dead heartbeat を入れる。
    // nowMs を base+90s に固定して age=90s を作る (DEFAULT_STALE 60s 超)。
    const store = new IngestStore({ pool, livenessOptions: { nowMs: base } });
    await store.ingest(
      makeEvent({
        session_id: sid,
        state: "running.command_executing",
        event_type: "command.started",
        timestamp: iso(base, -90_000),
        payload: { kind: "command.started", command: "npm test" },
      }),
    );
    const r = await store.ingest(
      makeEvent({
        session_id: sid,
        event_type: "heartbeat",
        timestamp: iso(base, -90_000),
        payload: { kind: "heartbeat", process_alive: false },
      }),
    );

    expect(r.liveness.state).toBe("stalled");
    expect(r.liveness.evidence.process?.alive).toBe(false);

    const { rows } = await pool.query(
      `SELECT liveness, needs_attention FROM session_state WHERE session_id = $1`,
      [sid],
    );
    const liveness = rows[0].liveness as {
      state: string;
      evidence: Record<string, unknown>;
      stalled_suspected: boolean;
    };
    expect(liveness.state).toBe("stalled");
    expect(liveness.stalled_suspected).toBe(true);
    expect(liveness.evidence).toHaveProperty("process"); // 根拠分解が永続化されている
    expect(rows[0].needs_attention).toBe(true); // stalled 候補は注意喚起
  });

  it("TDA-1 (INV-STALLED, real PG): a naked heartbeat (no process_alive) keeps a live session live — NOT stalled", async () => {
    // 退行ガード: TDA-2 の SQL FILTER (3値論理) が naked heartbeat (payload に process_alive
    // 無し) を event(活動) シグナルから脱落させると、生存セッションが SQL 経路で誤って stalled
    // 化する。SQL は naked heartbeat を **活動**として数えねばならない (TS observeFromEvents と一致)。
    //
    // シナリオ: 唯一来ているのが naked heartbeat (-2s, fresh)。process_alive 不明なので
    // process 消滅は確定していない → stalled にしてはならない。fresh な活動があるので live。
    const sid = newSession("sess_tda1_naked");
    const base = Date.now();
    const store = new IngestStore({ pool, livenessOptions: { nowMs: base } });

    const nakedHb = makeEvent({
      session_id: sid,
      event_type: "heartbeat",
      timestamp: iso(base, -2_000), // 直近 (fresh)
      payload: { kind: "heartbeat" }, // ★ process_alive を持たない naked heartbeat
    });
    const r = await store.ingest(nakedHb);

    // SQL 経路の liveness は naked heartbeat を活動として数え、live (= not stalled)。
    expect(r.liveness.state).not.toBe("stalled");
    expect(r.liveness.stalledSuspected).toBe(false);
    expect(r.liveness.state).toBe("live");
    // process は未観測 (naked なので生死シグナルにならない)。event のみ fresh。
    expect(r.liveness.evidence.process).toBeUndefined();

    // 永続化された projection も stalled 化しない。
    const { rows } = await pool.query(
      `SELECT liveness, needs_attention FROM session_state WHERE session_id = $1`,
      [sid],
    );
    const liveness = rows[0].liveness as { state: string; stalled_suspected: boolean };
    expect(liveness.state).toBe("live");
    expect(liveness.stalled_suspected).toBe(false);
    expect(rows[0].needs_attention).toBe(false);
  });

  it("TDA-1 (INV-STALLED, real PG): naked heartbeat mixed with a stale command keeps session live via fresh naked beat", async () => {
    // naked heartbeat が活動として数えられることを「古い別シグナル」と混在させて確認する。
    // 古い command.started (-90s) があっても、fresh な naked heartbeat (-2s) が event を
    // fresh に保ち live。SQL が naked を脱落させると event 最新は -90s となり stale → 誤 stalled。
    const sid = newSession("sess_tda1_naked_mix");
    const base = Date.now();
    const store = new IngestStore({ pool, livenessOptions: { nowMs: base } });
    await store.ingest(
      makeEvent({
        session_id: sid,
        state: "running.command_executing",
        event_type: "command.started",
        timestamp: iso(base, -90_000), // 古い (stale)
        payload: { kind: "command.started", command: "npm test" },
      }),
    );
    const r = await store.ingest(
      makeEvent({
        session_id: sid,
        event_type: "heartbeat",
        timestamp: iso(base, -2_000), // fresh naked beat
        payload: { kind: "heartbeat" },
      }),
    );
    expect(r.liveness.state).toBe("live");
    expect(r.liveness.evidence.event?.ageMs).toBe(2_000); // naked beat が event 最新
  });

  it("TDA-3: monotonic checker stays bounded under many distinct sessions (no unbounded Map growth)", async () => {
    // 上限を小さく (8) して、それを大きく超える distinct session_id を投入する。
    // terminal reset に頼らず LRU で bound されることを実 ingest 経路で確認する。
    const MAX = 8;
    const store = new IngestStore({ pool, monotonicMaxSessions: MAX });
    const prefix = `sess_tda3_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const created: string[] = [];
    for (let i = 0; i < 40; i++) {
      const sid = `${prefix}_${i}`;
      created.push(sid);
      sessions.push(sid); // afterAll cleanup 対象
      await store.ingest(
        makeEvent({
          session_id: sid,
          state: "starting",
          event_type: "session.started",
          timestamp: iso(Date.now(), i),
        }),
      );
    }
    // 40 distinct を投入しても順序チェッカの保持数は上限内 (無制限増加しない)。
    expect(store.monotonicTrackedSessions).toBeLessThanOrEqual(MAX);
    expect(store.monotonicTrackedSessions).toBe(MAX);

    // append-only の DB には全 40 セッション分が残っている (bound は in-memory 診断のみ)。
    const { rows } = await pool.query(
      `SELECT count(DISTINCT session_id)::int AS n FROM events WHERE session_id = ANY($1::text[])`,
      [created],
    );
    expect(rows[0].n).toBe(40);
  });

  it("TDA-2: idempotent no-op returns persisted liveness without recomputing (state matches first insert)", async () => {
    const sid = newSession("sess_tda2_noop");
    const base = Date.now();
    const store = new IngestStore({ pool, livenessOptions: { nowMs: base } });
    await store.ingest(
      makeEvent({
        session_id: sid,
        state: "running.command_executing",
        event_type: "command.started",
        timestamp: iso(base, -90_000),
        payload: { kind: "command.started", command: "npm test" },
      }),
    );
    const deadHb = makeEvent({
      session_id: sid,
      event_type: "heartbeat",
      timestamp: iso(base, -90_000),
      payload: { kind: "heartbeat", process_alive: false },
    });
    const first = await store.ingest(deadHb);
    expect(first.inserted).toBe(true);
    expect(first.liveness.state).toBe("stalled"); // 永続化される値

    // ★ DB を「裏で」改変: dead heartbeat を fresh (now) へ書き換える。これにより
    //   "もし no-op が再計算したら" liveness は live になる (process は dead だが event が fresh
    //   になり得る…ではなく、fresh な alive 化はしないので state が変わることを確実にするため、
    //   command.started を fresh 化して live を作る)。
    await pool.query(
      `UPDATE events SET timestamp = $2::timestamptz
         WHERE session_id = $1 AND event_type = 'command.started'`,
      [sid, new Date(base).toISOString()], // -90s → now (fresh)
    );
    // 再計算すれば command.started が fresh → live。永続値なら stalled のまま。

    const resend = await store.ingest(deadHb);
    expect(resend.inserted).toBe(false); // no-op
    // TDA-2: no-op は再計算しない → 改変を観測せず **永続値 (stalled)** を返す。
    //   もし再計算していたら fresh な command.started を観測して "live" になり、ここで赤になる。
    expect(resend.liveness.state).toBe("stalled");
    expect(resend.liveness.stalledSuspected).toBe(true);
    expect(resend.liveness.evidence).toHaveProperty("process");
    // projection も永続値の読出 (再 reduce しない)。
    expect(resend.projection.state).toBe("running.command_executing");
  });

  it("TDA-1 (INV-STATE-TRANSITION, real PG): a state-less first event must NOT pin session_state to 'created' and block running.* across ingests", async () => {
    // 退行ガード (TDA-1, M): state-less な初イベント (heartbeat 等) が session_state を
    // "created" として永続すると、次の ingest で UserPromptSubmit→running.model_wait 等が
    // 来たとき DB round-trip 後の prev.state="created" により isValidTransition(created,
    // running.model_wait)=false で **state が created に貼り付く** → plan.md 最重要 KPI
    // 「観測された実際の作業状態のみ表示」違反 (実走中セッションが UI で created 停止に見える)。
    //
    // first-observation 意味論 (reducer): state-less な初観測は state=undefined のまま通る。
    // これを DB 跨ぎで **NULL** として round-trip し、次の running.* を created 経由でなく
    // first-observation として accept しなければならない。
    //
    // ★ 純 reducer テストでは捕捉できない: 純 reducer は単一プロセス内で state=undefined を
    //   保つが、本番は ingest 毎に session_state を読み戻す。`?? "created"` がここに介入する。
    //   よって本テストは **2 回の独立 ingest を DB round-trip で貫通**させる (修正前は赤)。
    const sid = newSession("sess_tda1_stateless_first");
    const store = new IngestStore({ pool });

    // ingest #1: state を持たない heartbeat (process_alive 無し)。session.started 前に到達しうる。
    const r1 = await store.ingest(
      makeEvent({
        session_id: sid,
        event_type: "heartbeat",
        payload: { kind: "heartbeat" }, // state なし → first-observation は未確定 (undefined)
      }),
    );
    expect(r1.inserted).toBe(true);
    // state-less 初観測 → projection.state は未確定 (undefined)。created を勝手に貼らない。
    expect(r1.projection.state).toBeUndefined();

    // 永続層も "created" を貼り付けず NULL で round-trip すること。
    const after1 = await pool.query(`SELECT state FROM session_state WHERE session_id = $1`, [sid]);
    expect(after1.rows[0].state).toBeNull();

    // ingest #2: UserPromptSubmit 相当の running.model_wait が **別 ingest** で到達。
    //   DB から prev を読み戻す → prev.state が NULL(undefined) なら first-observation として
    //   running.model_wait を accept する (created→running の不正遷移として詰まってはならない)。
    const r2 = await store.ingest(
      makeEvent({
        session_id: sid,
        state: "running.model_wait",
        event_type: "turn.started",
        summary: "モデル応答待ち",
      }),
    );
    expect(r2.inserted).toBe(true);
    // ★ 修正前はここが "created" のまま (invalidTransition=true) で赤になる。
    expect(r2.invalidTransition).toBe(false);
    expect(r2.projection.state).toBe("running.model_wait");

    // 永続化された session_state も running.model_wait に確定していること (created に詰まらない)。
    const after2 = await pool.query(
      `SELECT state, liveness->>'invalid_transition_count' AS itc
         FROM session_state WHERE session_id = $1`,
      [sid],
    );
    expect(after2.rows[0].state).toBe("running.model_wait");
    expect(Number(after2.rows[0].itc)).toBe(0); // 不正遷移カウントも増えない
  });

  it("TDA-2: no-op safely falls back to unknown when persisted liveness jsonb is corrupt", async () => {
    const sid = newSession("sess_tda2_corrupt");
    const base = Date.now();
    const store = new IngestStore({ pool, livenessOptions: { nowMs: base } });
    const ev = makeEvent({
      session_id: sid,
      state: "running.command_executing",
      event_type: "command.started",
      timestamp: iso(base, -90_000),
      payload: { kind: "command.started", command: "x" },
    });
    await store.ingest(ev);

    // session_state.liveness を壊す (state が enum 外 / 構造欠損)。reconstructLiveness は
    // 安全側 (unknown) に倒すべき。
    await pool.query(`UPDATE session_state SET liveness = $2::jsonb WHERE session_id = $1`, [
      sid,
      JSON.stringify({ state: "not_a_real_state", garbage: true }),
    ]);

    const resend = await store.ingest(ev); // 冪等 no-op → 永続値 (壊れている) を復元。
    expect(resend.inserted).toBe(false);
    expect(resend.liveness.state).toBe("unknown"); // 安全側へ
    expect(resend.liveness.stalledSuspected).toBe(false);
  });

  // --- ADR 019e9999: pending_approvals 往復 (ingest → 永続 jsonb → RealtimeStore.detail) ----

  it("ADR 019e9999: tool.permission.requested persists pending_approvals readable via RealtimeStore.detail", async () => {
    const sid = newSession("sess_appr_rt");
    const base = Date.now();
    const store = new IngestStore({ pool, livenessOptions: { nowMs: base } });
    const rt = new RealtimeStore(pool);
    const reqId = `${sid}:apr-xyz`;

    await store.ingest(
      makeEvent({
        session_id: sid,
        event_type: "tool.permission.requested",
        state: "waiting.approval",
        timestamp: iso(base, -1000),
        payload: {
          request_id: reqId,
          tool_name: "Bash",
          command: "rm -rf /tmp/x",
          risk_level: "high",
        },
      }),
    );

    const detail = await rt.detail(sid);
    expect(detail).toBeDefined();
    expect(detail!.needs_attention).toBe(true);
    expect(detail!.pending_approvals).toHaveLength(1);
    const p = detail!.pending_approvals[0]!;
    expect(p.request_id).toBe(reqId);
    expect(p.command).toBe("rm -rf /tmp/x");
    expect(p.risk_level).toBe("high");

    // resolved (同 request_id) で pending が消え、注意が解ける。
    await store.ingest(
      makeEvent({
        session_id: sid,
        event_type: "tool.permission.resolved",
        state: "running.tool_preparing",
        timestamp: iso(base, -500),
        payload: { request_id: reqId, decision: "allow" },
      }),
    );
    const after = await rt.detail(sid);
    expect(after!.pending_approvals).toHaveLength(0);
    expect(after!.needs_attention).toBe(false);
  });

  it("structural confinement (real PG): only allow-listed PendingApproval fields persist — rogue payload keys never leak", async () => {
    const sid = newSession("sess_appr_confine");
    const base = Date.now();
    const store = new IngestStore({ pool, livenessOptions: { nowMs: base } });
    const rt = new RealtimeStore(pool);
    const reqId = `${sid}:apr-confine`;
    const rogueSecret = "ghp_1234567890abcdefABCDEF1234567890abcd";

    // 承認 redaction の正典は sidecar choke point (normalize.summarize) で、その INV は
    // normalize.test.ts が固定する。backend 側の不変条件は **構造的封じ込め**:
    // reducer は allow-list したフィールドのみを pending へ畳み込み、payload の他キー
    // (ここでは rogue_secret) を projection・jsonb・DTO へ素通ししない。再 redaction しない
    // backend が新規露出面を作らないことを実 PG 経路で固定する。
    await store.ingest(
      makeEvent({
        session_id: sid,
        event_type: "tool.permission.requested",
        state: "waiting.approval",
        timestamp: iso(base, -1000),
        payload: {
          request_id: reqId,
          tool_name: "Bash",
          command: "rm -rf /tmp/x",
          risk_level: "high",
          // 自動ガード (ADR 019ecc70 D3): guard 理由 (closed-enum allow-list 内)。
          trigger: "both",
          // 既知 kind + raw secret 混入: closed-enum 防御が raw を drop し語彙のみ残すべき。
          secret_kinds: ["github-token", rogueSecret],
          persistable: true, // ADR 019ee0c0: 永続化可否 (closed-enum boolean) を carry。
          rogue_secret: rogueSecret, // allow-list 外 → 落ちるべき。
        },
      }),
    );

    // ADR 019ecc70 D3 + 019ee0c0: allow-list は 7→9→10 キー (trigger / secret_kinds / persistable を additive)。
    const ALLOWED = [
      "command",
      "path",
      "request_id",
      "requested_at",
      "risk_level",
      "session_id",
      "tool_name",
      "trigger",
      "secret_kinds",
      "persistable",
    ].sort();

    // 1) DTO は allow-list フィールドのみ。rogue_secret を持たない。
    const detail = await rt.detail(sid);
    expect(detail!.pending_approvals).toHaveLength(1);
    const dtoEntry = detail!.pending_approvals[0]!;
    expect(Object.keys(dtoEntry).sort()).toEqual(ALLOWED);
    // guard 理由は closed-enum 防御を通過: trigger=both 保持、secret_kinds は語彙のみ (raw drop)。
    expect(dtoEntry.trigger).toBe("both");
    expect(dtoEntry.secret_kinds).toEqual(["github-token"]);
    // ADR 019ee0c0: persistable=true (リテラル) を carry。
    expect(dtoEntry.persistable).toBe(true);
    // INV-AUTOGUARD-NO-RAW: raw secret は DTO の文字列化に一切現れない。
    expect(JSON.stringify(dtoEntry)).not.toContain("ghp_");

    // 2) 永続 jsonb も allow-list の部分集合のみ (undefined は JSON で省略される)。
    //    生 rogue secret はどこにも現れず、allow-list 外のキーも持ち込まない。
    const { rows } = await pool.query(
      `SELECT pending_approvals::text AS pa FROM session_state WHERE session_id = $1`,
      [sid],
    );
    expect(rows[0].pa).not.toContain(rogueSecret);
    expect(rows[0].pa).not.toContain("ghp_");
    const persisted = JSON.parse(rows[0].pa) as Array<Record<string, unknown>>;
    for (const k of Object.keys(persisted[0]!)) expect(ALLOWED).toContain(k);
    expect(persisted[0]!.command).toBe("rm -rf /tmp/x"); // allow-list 値は保持。
    // 永続 jsonb でも raw は落ち語彙のみ (sidecar choke の at-rest 後に closed-enum 防御)。
    expect(persisted[0]!.secret_kinds).toEqual(["github-token"]);
    expect(persisted[0]!.trigger).toBe("both");
  });

  it("INV-DETAIL-CAPTURE-BADGE (real PG): capture_mode=attach が sessions 列→Detail へ投影される", async () => {
    const store = new IngestStore({ pool });
    const rt = new RealtimeStore(pool);
    const sid = newSession("sess_capmode");
    await store.ingest(
      makeEvent({
        session_id: sid,
        state: "starting",
        event_type: "session.started",
        capture_mode: "attach",
      }),
    );
    // sessions 列に attach が永続する。
    const { rows } = await pool.query(`SELECT capture_mode FROM sessions WHERE session_id = $1`, [
      sid,
    ]);
    expect(rows[0].capture_mode).toBe("attach");
    // realtime-store の投影が DTO へ載せる (UI バッジの出所)。
    const detail = await rt.detail(sid);
    expect(detail?.capture_mode).toBe("attach");
  });

  it("capture_mode は sticky (COALESCE): 後続の欠落イベントで managed へ戻さない", async () => {
    const store = new IngestStore({ pool });
    const rt = new RealtimeStore(pool);
    const sid = newSession("sess_capmode_sticky");
    await store.ingest(
      makeEvent({
        session_id: sid,
        state: "starting",
        event_type: "session.started",
        capture_mode: "attach",
      }),
    );
    // capture_mode を載せない後続イベント (欠落) を ingest。
    await store.ingest(
      makeEvent({
        session_id: sid,
        state: "running.command_executing",
        event_type: "command.started",
        payload: { kind: "command.started", command: "echo hi" },
      }),
    );
    const detail = await rt.detail(sid);
    expect(detail?.capture_mode).toBe("attach"); // attach のまま (欠落で上書きしない)。
  });

  it("capture_mode 未指定の managed セッションは Detail で undefined (UI 側 managed 既定)", async () => {
    const store = new IngestStore({ pool });
    const rt = new RealtimeStore(pool);
    const sid = newSession("sess_capmode_managed");
    await store.ingest(
      makeEvent({ session_id: sid, state: "starting", event_type: "session.started" }),
    );
    const detail = await rt.detail(sid);
    expect(detail?.capture_mode).toBeUndefined();
  });

  describe("INV-CURRENT-ACTION-KIND/SUBJECT (real PG round-trip) — ADR 019eeac6", () => {
    it("kind/subject が session_state へ永続し DTO へ往復する (idempotent・二重加算なし)", async () => {
      const store = new IngestStore({ pool });
      const rt = new RealtimeStore(pool);
      const sid = newSession("sess_curaction");
      const eid = newEventId();
      const ev = makeEvent({
        event_id: eid,
        session_id: sid,
        state: "running.command_executing",
        event_type: "command.started",
        summary: "コマンド実行: npm test", // legacy summary (日本語焼付け) は据置
        payload: { kind: "command.started", command: "npm test" },
      });

      const r1 = await store.ingest(ev);
      expect(r1.inserted).toBe(true);
      expect(r1.projection.current_action_kind).toBe("command");
      expect(r1.projection.current_action_subject).toBe("npm test");

      // DB round-trip: DTO (read 層) でも kind/subject が出る + legacy current_action 保持。
      const d1 = await rt.detail(sid);
      expect(d1?.current_action_kind).toBe("command");
      expect(d1?.current_action_subject).toBe("npm test");
      expect(d1?.current_action).toBe("コマンド実行: npm test");

      // 冪等: 同一 event_id 再投入で no-op (kind/subject が変わらない)。
      const r2 = await store.ingest(ev);
      expect(r2.inserted).toBe(false);
      expect(r2.projection.current_action_kind).toBe("command");
      expect(r2.projection.current_action_subject).toBe("npm test");
    });

    it("kind は最新イベント由来で更新される (古い subject を残さない)", async () => {
      const store = new IngestStore({ pool });
      const rt = new RealtimeStore(pool);
      const sid = newSession("sess_curaction_seq");
      await store.ingest(
        makeEvent({
          session_id: sid,
          state: "running.command_executing",
          event_type: "command.started",
          payload: { kind: "command.started", command: "npm test" },
        }),
      );
      // 後続イベント (web 検索) で kind/subject が世代更新される。
      await store.ingest(
        makeEvent({
          session_id: sid,
          state: "running.tool_preparing",
          event_type: "web.search.started",
          timestamp: new Date(Date.now() + 1000).toISOString(),
          payload: { kind: "web.search.started", query: "OTLP GenAI" },
        }),
      );
      const d = await rt.detail(sid);
      expect(d?.current_action_kind).toBe("web");
      expect(d?.current_action_subject).toBe("OTLP GenAI");
    });

    it("INV-CURRENT-ACTION-NO-LEAK: subject は payload 由来のみ (redacted 値そのまま・raw 混入なし)", async () => {
      // backend は再 redaction しない (sidecar choke が権威)。ここでは「emit 時点で既に redacted な
      // payload を渡せば、persist された subject に marker のみが出て raw secret は出ない」を pin する
      // (= projection が payload を写すだけで再解釈しない)。raw を仕込んだ summary は subject に出ない。
      const store = new IngestStore({ pool });
      const rt = new RealtimeStore(pool);
      const sid = newSession("sess_curaction_noleak");
      await store.ingest(
        makeEvent({
          session_id: sid,
          state: "running.command_executing",
          event_type: "command.started",
          // summary には raw を仕込むが subject の出所ではない (payload のみが出所)。
          summary: "コマンド実行: ghp_RAWSECRETMUSTNOTLEAK0000000000",
          payload: { kind: "command.started", command: "deploy [REDACTED:github-token]" },
        }),
      );
      const d = await rt.detail(sid);
      expect(d?.current_action_subject).toBe("deploy [REDACTED:github-token]");
      // raw secret 形が subject に絶対に出ないこと (load-bearing 安全性)。
      expect(d?.current_action_subject).not.toContain("ghp_RAWSECRETMUSTNOTLEAK");
      expect(d?.current_action_subject).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
    });
  });
});
