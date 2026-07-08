/**
 * INV-DEMO-STATE-REAP — stale デモ projection 行の boot 時 GC (real PG・SEC-2 sweep task 019f38b9).
 *
 * `reapStaleDemoSessionState` が固定する不変条件:
 *  - **prefix + TTL の両方に一致した session_state 行のみ**削除する (fresh なデモ行・非デモ行は残す)。
 *  - **projection のみ削除**: sessions / events は append-only の監査証跡として残る。
 *  - **LIKE メタ文字を escape**: prefix 中の `_` がワイルドカード解釈されて無関係 id を巻き込まない。
 *  - **冪等**: 2 回目の呼び出しは 0 行。
 *
 * 検証は隔離 prefix (`demo-safety-reaptest-*`) の直接 seed で行い、共有 dev DB の実デモ行を
 * テストから削除しない (boot の実 GC は index.ts が SAFETY_DEMO_SESSION_PREFIX で行う)。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { reapStaleDemoSessionState } from "../src/ingest-store.js";
import { cleanupSessions, dbReachable } from "./helpers.js";

const DATABASE_URL = process.env.DATABASE_URL;
const reachable = DATABASE_URL ? await dbReachable(DATABASE_URL) : false;

// 隔離 prefix (実運用の "demo-safety-" 空間の中の、テスト専用サブ空間)。
const PREFIX = "demo-safety-reaptest-";
const STALE = `${PREFIX}stale`;
const FRESH = `${PREFIX}fresh`;
const NON_DEMO = "sess-reaptest-stale";
// LIKE escape 検証: prefix に `_` を含め、ワイルドカード解釈なら誤マッチする id を並べる。
const ESC_PREFIX = "demo_esc-reaptest-";
const ESC_TRUE = `${ESC_PREFIX}stale`; // 正しく先頭一致する行
const ESC_VICTIM = "demoXesc-reaptest-stale"; // `_`→任意1文字 だと誤マッチする行

const ALL_IDS = [STALE, FRESH, NON_DEMO, ESC_TRUE, ESC_VICTIM] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/** sessions + session_state を直接 seed する (projection 削除対象の最小構成)。 */
async function seed(pool: Pool, sessionId: string, lastEventAtMs: number): Promise<void> {
  await pool.query(
    `INSERT INTO sessions (session_id, provider, source) VALUES ($1, 'claude_code', 'hooks')
     ON CONFLICT (session_id) DO NOTHING`,
    [sessionId],
  );
  await pool.query(
    `INSERT INTO session_state (session_id, state, last_event_at, updated_at)
     VALUES ($1, 'idle', $2::timestamptz, $2::timestamptz)
     ON CONFLICT (session_id) DO UPDATE SET
       last_event_at = EXCLUDED.last_event_at, updated_at = EXCLUDED.updated_at`,
    [sessionId, new Date(lastEventAtMs).toISOString()],
  );
}

async function stateRowExists(pool: Pool, sessionId: string): Promise<boolean> {
  const { rows } = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM session_state WHERE session_id = $1`,
    [sessionId],
  );
  return (rows[0]?.n ?? 0) > 0;
}

describe.skipIf(!reachable)("INV-DEMO-STATE-REAP: stale デモ projection の reap (real PG)", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await cleanupSessions(pool, ALL_IDS);
    const now = Date.now();
    await seed(pool, STALE, now - 2 * DAY_MS); // TTL(24h) 超え → reap 対象
    await seed(pool, FRESH, now - 60_000); // 1 分前 → 残す
    await seed(pool, NON_DEMO, now - 2 * DAY_MS); // 非デモ prefix → 残す
    await seed(pool, ESC_TRUE, now - 2 * DAY_MS);
    await seed(pool, ESC_VICTIM, now - 2 * DAY_MS);
    // SEC-2 (裁定 019f3ed6): STALE session に event を 1 件 seed し、reap 後の存続を直接 assert
    // する (append-only 保全の明示 pin — FK topology による構造保証に加えた回帰網)。
    await pool.query(
      `INSERT INTO events (id, event_id, provider, source, session_id, event_type, timestamp)
       VALUES ('00000000-0000-7000-8000-000000000ea1'::uuid, $1, 'claude_code', 'hooks', $2,
               'session.started', $3::timestamptz)
       ON CONFLICT (event_id) DO NOTHING`,
      [`ev-reaptest-stale-1`, STALE, new Date(now - 2 * DAY_MS).toISOString()],
    );
  }, 30_000);

  afterAll(async () => {
    await cleanupSessions(pool, ALL_IDS);
    await pool.end();
  });

  it("prefix + TTL 一致の stale デモ行のみ削除し、fresh デモ / 非デモ stale は残す", async () => {
    const reaped = await reapStaleDemoSessionState(pool, { prefix: PREFIX });
    expect(reaped).toBe(1);
    expect(await stateRowExists(pool, STALE)).toBe(false);
    expect(await stateRowExists(pool, FRESH)).toBe(true);
    expect(await stateRowExists(pool, NON_DEMO)).toBe(true);
  });

  it("projection のみ削除: sessions 行 (監査証跡側) は残る (append-only 保全)", async () => {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM sessions WHERE session_id = $1`,
      [STALE],
    );
    expect(rows[0]?.n).toBe(1);
  });

  it("SEC-2: events 行 (監査証跡本体) も reap 後に残る (append-only 保全の直接 pin)", async () => {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM events WHERE session_id = $1`,
      [STALE],
    );
    expect(rows[0]?.n).toBe(1);
  });

  it("冪等: 2 回目は 0 行", async () => {
    const reaped = await reapStaleDemoSessionState(pool, { prefix: PREFIX });
    expect(reaped).toBe(0);
  });

  it("LIKE escape: prefix の `_` はワイルドカード解釈されず、無関係 id を巻き込まない", async () => {
    const reaped = await reapStaleDemoSessionState(pool, { prefix: ESC_PREFIX });
    expect(reaped).toBe(1); // ESC_TRUE のみ
    expect(await stateRowExists(pool, ESC_TRUE)).toBe(false);
    expect(await stateRowExists(pool, ESC_VICTIM)).toBe(true); // `demoXesc-…` は誤マッチしない
  });

  it("QA-4: last_event_at が NULL の行は updated_at フォールバックで staleness 判定される", async () => {
    // COALESCE(last_event_at, updated_at) の fallback 枝を直接被覆する (裁定 019f3ed6)。
    const nullLea = `${PREFIX}null-lea`;
    await pool.query(
      `INSERT INTO sessions (session_id, provider, source) VALUES ($1, 'claude_code', 'hooks')
       ON CONFLICT (session_id) DO NOTHING`,
      [nullLea],
    );
    await pool.query(
      `INSERT INTO session_state (session_id, state, last_event_at, updated_at)
       VALUES ($1, 'idle', NULL, $2::timestamptz)
       ON CONFLICT (session_id) DO UPDATE SET last_event_at = NULL, updated_at = EXCLUDED.updated_at`,
      [nullLea, new Date(Date.now() - 2 * DAY_MS).toISOString()],
    );
    try {
      expect(await reapStaleDemoSessionState(pool, { prefix: PREFIX })).toBe(1);
      expect(await stateRowExists(pool, nullLea)).toBe(false);
    } finally {
      await cleanupSessions(pool, [nullLea]);
    }
  });

  it("olderThanMs 上書き: 閾値内は削除しない / 閾値超えは削除する", async () => {
    // 専用 prefix に隔離する (PREFIX 空間の他 fixture が経過時間で閾値を跨いで巻き込まれないように)。
    const ttlPrefix = "demo-safety-reapttl-";
    const recent = `${ttlPrefix}recent`;
    await seed(pool, recent, Date.now() - 10 * 60_000); // 10 分前
    try {
      expect(
        await reapStaleDemoSessionState(pool, { prefix: ttlPrefix, olderThanMs: 60 * 60_000 }),
      ).toBe(0); // 1h 閾値: 10 分前は残す
      expect(
        await reapStaleDemoSessionState(pool, { prefix: ttlPrefix, olderThanMs: 60_000 }),
      ).toBe(1); // 1min 閾値: 削除
      expect(await stateRowExists(pool, recent)).toBe(false);
    } finally {
      await cleanupSessions(pool, [recent]);
    }
  });
});
