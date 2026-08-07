/**
 * INV-AUDIT-COVERAGE — 監査欠落の検知 (audit-gap visibility・ADR 019f4cdb Phase 1・real PG)。
 *
 * `AuditStore.providerCoverage` は per-provider の「最終受信サーバ時刻」と「監査できていない時間
 * (gap 候補)」を集約する。実 PG で固定する不変条件:
 *
 *  (a) **ingested_at 権威 (§6-5)**: last_received / gap は `MAX(events.ingested_at)` (サーバ受信 clock)
 *      由来。adapter 申告 `timestamp` を『今』へ後ろ倒しにしても gap は隠れない。
 *      falsify: SQL が MAX(timestamp) を last_received に使うと gap≈0 になり本テスト RED。
 *  (b) **非稼働 ≠ gap (§6-6)**: 非 terminal (稼働中) session が 0 の provider は gap_candidate_ms=null。
 *      terminal 判定は `ended_at IS NOT NULL OR state ∈ TERMINAL_STATES` の両分岐を pin。
 *      falsify: terminal 判定を落とすと稼働扱いになり gap 非 null で RED。
 *  (c) **NO-RAW**: 応答に生 cwd/パス/secret/session 内容が出ない (provider slug + ISO 時刻 + 非負整数 +
 *      gap ms のみ)。余剰 field 到達なし。
 *
 * 各テストは **一意な synthetic provider slug** を使い、共有 DB 内で当該 provider の集約を完全隔離する
 * (providerCoverage は provider 別に全件を畳むため)。DB 未到達なら skip (CI では実走必須)。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { IngestStore } from "../src/ingest-store.js";
import { AuditStore } from "../src/audit-store.js";
import { cleanupSessions, dbReachable, makeEvent } from "./helpers.js";

import { evaluateSeqMissing } from "@actradeck/event-model";
import type { AuditProviderCoverage } from "@actradeck/event-model";

const DATABASE_URL = process.env.DATABASE_URL;
const reachable = DATABASE_URL ? await dbReachable(DATABASE_URL) : false;

// 遠未来を基準時刻にし、既存データ・実時刻から隔離する。
const NOW = new Date("2099-08-01T12:00:00.000Z");
const NOW_MS = NOW.getTime();
const MIN = 60_000;

describe.skipIf(!reachable)("INV-AUDIT-COVERAGE: 監査欠落の検知 (real PG)", () => {
  let pool: Pool;
  let store: IngestStore;
  let audit: AuditStore;
  const sessions: string[] = [];

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    store = new IngestStore({ pool });
    audit = new AuditStore(pool);
  });

  afterAll(async () => {
    if (pool) {
      await cleanupSessions(pool, sessions);
      await pool.end();
    }
  });

  /** 一意 provider slug (`^[a-z][a-z0-9_-]{0,31}$`)。 */
  function newProvider(tag: string): string {
    return `covt${tag}${Math.random().toString(36).slice(2, 8)}`.toLowerCase();
  }
  function newSession(provider: string): string {
    const sid = `sess_cov_${provider}_${Math.random().toString(36).slice(2, 6)}`;
    sessions.push(sid);
    return sid;
  }

  /**
   * 実 ingest 経路で 1 session + 1 heartbeat を作り、その後 ingested_at を backdate する
   * (ingested_at はサーバ受信 clock ＝ ingest では now() 既定で、唯一 test が制御できないため UPDATE)。
   */
  async function seedSession(
    provider: string,
    opts: {
      adapterTsMs: number;
      ingestedAtMs: number;
      cwd?: string;
      payload?: Record<string, unknown>;
      endedAtMs?: number;
      terminalState?: string;
    },
  ): Promise<string> {
    const sid = newSession(provider);
    await store.ingest(
      makeEvent({
        session_id: sid,
        provider,
        event_type: "heartbeat",
        timestamp: new Date(opts.adapterTsMs).toISOString(),
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts.payload !== undefined ? { payload: opts.payload } : {}),
      }),
    );
    await pool.query(`UPDATE events SET ingested_at = $1 WHERE session_id = $2`, [
      new Date(opts.ingestedAtMs).toISOString(),
      sid,
    ]);
    if (opts.endedAtMs !== undefined) {
      await pool.query(`UPDATE sessions SET ended_at = $1 WHERE session_id = $2`, [
        new Date(opts.endedAtMs).toISOString(),
        sid,
      ]);
    }
    if (opts.terminalState !== undefined) {
      const { rowCount } = await pool.query(
        `UPDATE session_state SET state = $1 WHERE session_id = $2`,
        [opts.terminalState, sid],
      );
      // projection が session_state 行を作っている前提を pin (無ければ terminal-state 分岐が空振り)。
      expect(rowCount).toBe(1);
    }
    return sid;
  }

  async function coverageFor(provider: string): Promise<AuditProviderCoverage | undefined> {
    const report = await audit.providerCoverage({ now: NOW });
    expect(report.generated_at).toBe(NOW.toISOString());
    return report.providers.find((p) => p.provider === provider);
  }

  it("(a) gap は ingested_at 権威 — adapter timestamp を『今』へ後ろ倒ししても gap は隠れない", async () => {
    const provider = newProvider("a");
    // adapter 申告 timestamp = 1 分前 (recent・gap を隠す方向)。ingested_at = 40 分前 (真の受信)。
    await seedSession(provider, {
      adapterTsMs: NOW_MS - 1 * MIN,
      ingestedAtMs: NOW_MS - 40 * MIN,
    });
    const c = await coverageFor(provider);
    expect(c).toBeDefined();
    // gap は ingested_at 由来 (40 分)。timestamp を使うなら ≈1 分に潰れる (mutant で RED)。
    expect(c!.gap_candidate_ms).toBe(40 * MIN);
    expect(c!.last_received_at).toBe(new Date(NOW_MS - 40 * MIN).toISOString());
    // 表示補助として adapter timestamp も返す (但し gap 非権威)。
    expect(c!.last_event_timestamp).toBe(new Date(NOW_MS - 1 * MIN).toISOString());
    expect(c!.active_session_count).toBe(1);
  });

  it("(b) 非稼働 (terminal via ended_at) provider は last_received が古くても gap_candidate_ms=null", async () => {
    const provider = newProvider("b");
    await seedSession(provider, {
      adapterTsMs: NOW_MS - 300 * MIN,
      ingestedAtMs: NOW_MS - 300 * MIN, // 5 時間前 (巨大 age)
      endedAtMs: NOW_MS - 200 * MIN,
    });
    const c = await coverageFor(provider);
    expect(c).toBeDefined();
    expect(c!.active_session_count).toBe(0);
    expect(c!.total_session_count).toBe(1);
    expect(c!.gap_candidate_ms).toBeNull(); // 誤警報しない
    // 最終受信時刻自体は表示のため保持 (gap alarm のみ抑止)。
    expect(c!.last_received_at).toBe(new Date(NOW_MS - 300 * MIN).toISOString());
  });

  it("(b) 非稼働 (terminal via state ∈ TERMINAL_STATES) も gap_candidate_ms=null", async () => {
    const provider = newProvider("bs");
    await seedSession(provider, {
      adapterTsMs: NOW_MS - 120 * MIN,
      ingestedAtMs: NOW_MS - 120 * MIN,
      terminalState: "completed", // ended_at は NULL・state のみで terminal
    });
    const c = await coverageFor(provider);
    expect(c).toBeDefined();
    expect(c!.active_session_count).toBe(0);
    expect(c!.gap_candidate_ms).toBeNull();
  });

  it("(b) 稼働あり provider は同じ古い last_received でも gap を出す (guard の positive control)", async () => {
    const provider = newProvider("d");
    // ended_at 無し・state は heartbeat 由来の非 terminal ⇒ active。
    await seedSession(provider, {
      adapterTsMs: NOW_MS - 90 * MIN,
      ingestedAtMs: NOW_MS - 90 * MIN,
    });
    const c = await coverageFor(provider);
    expect(c).toBeDefined();
    expect(c!.active_session_count).toBe(1);
    expect(c!.gap_candidate_ms).toBe(90 * MIN);
  });

  it("(b) provider の稼働/非稼働が混在しても、稼働 1 つでも gap を出す (active fold)", async () => {
    const provider = newProvider("mix");
    await seedSession(provider, {
      adapterTsMs: NOW_MS - 500 * MIN,
      ingestedAtMs: NOW_MS - 500 * MIN,
      endedAtMs: NOW_MS - 400 * MIN, // terminal
    });
    await seedSession(provider, {
      adapterTsMs: NOW_MS - 15 * MIN,
      ingestedAtMs: NOW_MS - 15 * MIN, // active・最新受信
    });
    const c = await coverageFor(provider);
    expect(c).toBeDefined();
    expect(c!.total_session_count).toBe(2);
    expect(c!.active_session_count).toBe(1);
    // last_received は 2 session の MAX(ingested_at) = 15 分前。gap = 15 分。
    expect(c!.gap_candidate_ms).toBe(15 * MIN);
    expect(c!.last_received_at).toBe(new Date(NOW_MS - 15 * MIN).toISOString());
  });

  it("(b') QA-R3-3: relay_lost 合成 retire は last_received を前進させない (SEC-R2-2 第3面の pin)", async () => {
    // 消えた provider の唯一の「最近のイベント」が backend 合成の relay_lost cancel でも、
    // 受信 gap は隠れない。SQL FILTER (liveness) / observeFromEvents (TS) は R3 で pin 済み —
    // 3 面のうち未 pin だった coverage の WHERE 除外をここで固定する (除外句を消すと RED)。
    const provider = newProvider("rl");
    const sid = await seedSession(provider, {
      adapterTsMs: NOW_MS - 50 * MIN,
      ingestedAtMs: NOW_MS - 50 * MIN, // provider からの真の最終受信
    });
    // backend 合成の relay_lost cancel を通常 ingress で追加し、ingested_at を「最近」へ。
    await store.ingest(
      makeEvent({
        session_id: sid,
        provider,
        event_type: "tool.permission.resolved",
        timestamp: new Date(NOW_MS - 1 * MIN).toISOString(),
        payload: {
          request_id: "q-rl",
          decision: "cancel",
          resolution_origin: "relay_lost",
          delivery_status: "not_sent",
        },
      }),
    );
    await pool.query(
      `UPDATE events SET ingested_at = $1 WHERE session_id = $2 AND event_type = 'tool.permission.resolved'`,
      [new Date(NOW_MS - 1 * MIN).toISOString(), sid],
    );
    const c = await coverageFor(provider);
    expect(c).toBeDefined();
    // 合成 retire を受信扱いすると gap≈1 分に潰れる (mutant で RED)。真の受信 = 50 分前。
    expect(c!.last_received_at).toBe(new Date(NOW_MS - 50 * MIN).toISOString());
    expect(c!.gap_candidate_ms).toBe(50 * MIN);
  });

  it("(b'') positive control: operator 解決は受信として last_received を前進させる (除外の過剰適用防止)", async () => {
    const provider = newProvider("op");
    const sid = await seedSession(provider, {
      adapterTsMs: NOW_MS - 50 * MIN,
      ingestedAtMs: NOW_MS - 50 * MIN,
    });
    await store.ingest(
      makeEvent({
        session_id: sid,
        provider,
        event_type: "tool.permission.resolved",
        timestamp: new Date(NOW_MS - 1 * MIN).toISOString(),
        payload: {
          request_id: "q-op",
          decision: "cancel",
          resolution_origin: "operator",
          delivery_status: "sent",
        },
      }),
    );
    await pool.query(
      `UPDATE events SET ingested_at = $1 WHERE session_id = $2 AND event_type = 'tool.permission.resolved'`,
      [new Date(NOW_MS - 1 * MIN).toISOString(), sid],
    );
    const c = await coverageFor(provider);
    expect(c).toBeDefined();
    // operator 解決は provider 経路の実受信 — 除外してはならない (過剰除外 mutant で RED)。
    expect(c!.last_received_at).toBe(new Date(NOW_MS - 1 * MIN).toISOString());
    expect(c!.gap_candidate_ms).toBe(1 * MIN);
  });

  it("(c) NO-RAW — 応答に生 cwd/パス/secret が出ず closed shape のみ", async () => {
    const provider = newProvider("noraw");
    const secretCwd = "/home/user/covsecret-project-xyz";
    await seedSession(provider, {
      adapterTsMs: NOW_MS - 5 * MIN,
      ingestedAtMs: NOW_MS - 5 * MIN,
      cwd: secretCwd,
      payload: { note: "ghp_covfaketokenAAAAAAAAAAAAAAAAAAAAAA" },
    });
    const report = await audit.providerCoverage({ now: NOW });
    const c = report.providers.find((p) => p.provider === provider);
    expect(c).toBeDefined();
    // closed shape: 既知キーのみ。
    expect(Object.keys(c!).sort()).toEqual([
      "active_session_count",
      "gap_candidate_ms",
      "last_event_timestamp",
      "last_received_at",
      "provider",
      "seq_missing_lower_bound",
      "seq_suppressed_session_count",
      "seq_tracked_session_count",
      "total_session_count",
    ]);
    // レポート全体を直列化して生 cwd / secret が一切現れないことを確認 (余剰 field 到達なし)。
    const blob = JSON.stringify(report);
    expect(blob).not.toContain(secretCwd);
    expect(blob).not.toContain("covsecret-project");
    expect(blob).not.toContain("ghp_covfaketoken");
  });

  // ── (e) seq-drop 下限検知 + 密性抑制 (ADR 019f4cdb Phase2・decision 019f502c + 抑制規則) ────
  //   client 申告 seq を実 ingest 経路で保存し、AuditStore.providerCoverage の provider 別集約が
  //   欠落を下限で数え、密性違反 session を抑制することを実 PG で pin。
  //   INV-SEQ-DROP-PARITY: SQL の per-session 寄与は TS 正準 evaluateSeqMissing().missing (抑制込み) と一致。

  /** 実 ingest 経路で 1 session に seq 付きイベント列を投入する (seq は各イベントの top-level field)。 */
  async function seedSeqSession(provider: string, seqs: number[]): Promise<string> {
    const sid = newSession(provider);
    let i = 0;
    for (const seq of seqs) {
      await store.ingest(
        makeEvent({
          session_id: sid,
          provider,
          event_type: "heartbeat",
          timestamp: new Date(NOW_MS - (100 - i) * 1000).toISOString(),
          seq,
        }),
      );
      i += 1;
    }
    return sid;
  }

  it("(e) seq が events テーブルに保存される (bigint 列・at-rest 実測)", async () => {
    const provider = newProvider("seqstore");
    const sid = await seedSeqSession(provider, [0, 1, 2]);
    const { rows } = await pool.query<{ seq: string | null }>(
      `SELECT seq FROM events WHERE session_id = $1 ORDER BY seq`,
      [sid],
    );
    // bigint は pg から文字列で届く。3 件・0,1,2 が保存されている。
    expect(rows.map((r) => r.seq)).toEqual(["0", "1", "2"]);
  });

  it("(e) 連続 seq (穴なし) は seq_missing_lower_bound=0・tracked=1・suppressed=0", async () => {
    const provider = newProvider("seqok");
    await seedSeqSession(provider, [0, 1, 2, 3, 4]);
    const c = await coverageFor(provider);
    expect(c).toBeDefined();
    expect(c!.seq_missing_lower_bound).toBe(0);
    expect(c!.seq_tracked_session_count).toBe(1);
    expect(c!.seq_suppressed_session_count).toBe(0);
  });

  it("(e) 人工 drop (区間内の穴) を seq_missing_lower_bound>=1 で検出 (parity: evaluateSeqMissing)", async () => {
    const provider = newProvider("seqhole");
    // seq=2 を意図的に欠落させる (0,1,_,3,4)。下限 = (4-0+1) - 4 = 1・非抑制 (1 <= distinct 4)。
    const seqs = [0, 1, 3, 4];
    await seedSeqSession(provider, seqs);
    const c = await coverageFor(provider);
    expect(c).toBeDefined();
    expect(c!.seq_missing_lower_bound).toBeGreaterThanOrEqual(1);
    // INV-SEQ-DROP-PARITY: SQL の寄与 == TS 正準 evaluateSeqMissing().missing (抑制込み)。
    expect(c!.seq_missing_lower_bound).toBe(evaluateSeqMissing(seqs).missing);
    expect(c!.seq_tracked_session_count).toBe(1);
    expect(c!.seq_suppressed_session_count).toBe(0);
  });

  it("(e) QA-1: dup+穴 fixture [0,0,3] は missing=2 (DISTINCT が retry を畳む・非抑制)", async () => {
    const provider = newProvider("seqduphole");
    // [0,0,3]: 非 DISTINCT 計数だと (3-0+1)-3=1 (誤)、DISTINCT だと (3-0+1)-2=2 (正)。両者非負ゆえ
    //   clamp に吸収されない = DISTINCT 除去 mutation が本テストで RED になる。raw_missing 2 <= distinct 2
    //   ゆえ非抑制。
    const seqs = [0, 0, 3];
    await seedSeqSession(provider, seqs);
    const c = await coverageFor(provider);
    expect(c).toBeDefined();
    expect(c!.seq_missing_lower_bound).toBe(2);
    expect(evaluateSeqMissing(seqs).missing).toBe(2); // parity: TS 正準も 2
    expect(c!.seq_suppressed_session_count).toBe(0);
  });

  it("(e) 複数穴 + 複数 session を provider へ総和 (下限の加法性・parity)", async () => {
    const provider = newProvider("seqsum");
    const s1 = [0, 1, 4]; // 穴 2 個 (2,3)・distinct 3 → 非抑制
    const s2 = [10, 12]; // 穴 1 個 (11)・distinct 2 → 非抑制
    await seedSeqSession(provider, s1);
    await seedSeqSession(provider, s2);
    const c = await coverageFor(provider);
    expect(c).toBeDefined();
    const expected = evaluateSeqMissing(s1).missing + evaluateSeqMissing(s2).missing;
    expect(c!.seq_missing_lower_bound).toBe(expected); // 2 + 1 = 3
    expect(c!.seq_tracked_session_count).toBe(2);
    expect(c!.seq_suppressed_session_count).toBe(0);
  });

  it("(e) 重複 seq (retry) は欠落を捏造しない (distinct collapse)", async () => {
    const provider = newProvider("seqdup");
    // 同一 seq を二重 ingest しても event_id 冪等 + distinct で欠落 0 のまま。
    // seedSeqSession は各 seq に別 event_id を採番するため、二重ぶんも別行として保存されるが distinct が畳む。
    await seedSeqSession(provider, [0, 1, 1, 2, 2]);
    const c = await coverageFor(provider);
    expect(c).toBeDefined();
    expect(c!.seq_missing_lower_bound).toBe(0);
    expect(c!.seq_tracked_session_count).toBe(1);
  });

  it("(e) SEC-1: global カウンタ模擬 (3-way interleave) は抑制され偽警報が消える", async () => {
    const provider = newProvider("seqglobal");
    // global カウンタを 3 session が分け合う模擬: 各 session は every-3rd の seq を見る。
    //   sA=[0,3,6,9] sB=[1,4,7,10] sC=[2,5,8,11]。各 span=10 distinct=4 raw_missing=6 → 6>4 で抑制。
    const sA = [0, 3, 6, 9];
    const sB = [1, 4, 7, 10];
    const sC = [2, 5, 8, 11];
    await seedSeqSession(provider, sA);
    await seedSeqSession(provider, sB);
    await seedSeqSession(provider, sC);
    const c = await coverageFor(provider);
    expect(c).toBeDefined();
    // 全 session 抑制 → 偽の巨大欠落 (6+6+6=18) を出さず 0。TS 正準と一致 (parity)。
    expect(evaluateSeqMissing(sA).suppressed).toBe(true);
    expect(c!.seq_missing_lower_bound).toBe(0);
    expect(c!.seq_tracked_session_count).toBe(3);
    expect(c!.seq_suppressed_session_count).toBe(3); // 3 session とも抑制 = 可観測
  });

  it("(e) 密 session と非密 session の混在: 密のみ検知・非密は抑制 (混在集約)", async () => {
    const provider = newProvider("seqmix");
    const dense = [0, 1, 3]; // raw_missing=1 distinct=3 → 非抑制・寄与 1
    const sparse = [0, 100]; // raw_missing=100 distinct=2 → 抑制・寄与 0
    await seedSeqSession(provider, dense);
    await seedSeqSession(provider, sparse);
    const c = await coverageFor(provider);
    expect(c).toBeDefined();
    expect(evaluateSeqMissing(dense).suppressed).toBe(false);
    expect(evaluateSeqMissing(sparse).suppressed).toBe(true);
    expect(c!.seq_missing_lower_bound).toBe(1); // 密 session の 1 のみ (sparse の 100 は抑制)
    expect(c!.seq_tracked_session_count).toBe(2);
    expect(c!.seq_suppressed_session_count).toBe(1);
  });

  it("(e) seq 無し provider は seq_missing_lower_bound=null (検知対象外)・tracked=0・suppressed=0", async () => {
    const provider = newProvider("seqnull");
    // seq を一切載せない (既存 adapter 相当)。
    await seedSession(provider, { adapterTsMs: NOW_MS - 5 * MIN, ingestedAtMs: NOW_MS - 5 * MIN });
    const c = await coverageFor(provider);
    expect(c).toBeDefined();
    expect(c!.seq_missing_lower_bound).toBeNull();
    expect(c!.seq_tracked_session_count).toBe(0);
    expect(c!.seq_suppressed_session_count).toBe(0);
  });

  it("(e) CHECK 制約: 負の seq を直接書込しようとすると DB が拒否 (SEC-2≡TDA-2)", async () => {
    // まず正常 session を作り (FK 親)、その後 events へ負 seq を直接 INSERT して CHECK 違反を確認。
    const provider = newProvider("seqcheck");
    const sid = await seedSeqSession(provider, [0, 1, 2]);
    await expect(
      pool.query(
        `INSERT INTO events (id, event_id, provider, source, session_id, event_type, timestamp, seq)
         VALUES (gen_random_uuid(), $1, $2, 'external', $3, 'heartbeat', now(), -1)`,
        [`neg_${Math.random().toString(36).slice(2)}`, provider, sid],
      ),
    ).rejects.toThrow(/events_seq_nonneg|check constraint/i);
  });
});
