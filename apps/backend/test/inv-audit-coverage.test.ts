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
      "total_session_count",
    ]);
    // レポート全体を直列化して生 cwd / secret が一切現れないことを確認 (余剰 field 到達なし)。
    const blob = JSON.stringify(report);
    expect(blob).not.toContain(secretCwd);
    expect(blob).not.toContain("covsecret-project");
    expect(blob).not.toContain("ghp_covfaketoken");
  });
});
