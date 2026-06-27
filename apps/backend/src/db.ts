/**
 * PostgreSQL 接続プール (Phase 3 backend).
 *
 * 接続文字列は env (DATABASE_URL) 経由のみ。コミットしない (.claude/rules/security.md /
 * database.md)。pool は単一生成し、ingestion / projection が共有する。
 */
import { Pool, type PoolConfig } from "pg";

export interface DbOptions {
  /** 接続文字列。省略時 process.env.DATABASE_URL。 */
  readonly connectionString?: string;
  readonly max?: number;
  readonly connectionTimeoutMillis?: number;
}

/**
 * pg Pool を生成する。connectionString が無ければ throw (実 DB 前提を明示)。
 * REAL DATA ONLY: モック接続は持たない。テストは実 Postgres へ接続する。
 */
export function createPool(opts: DbOptions = {}): Pool {
  const connectionString = opts.connectionString ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required (no mock DB; REAL DATA ONLY)");
  }
  const config: PoolConfig = {
    connectionString,
    max: opts.max ?? 10,
    connectionTimeoutMillis: opts.connectionTimeoutMillis ?? 5_000,
  };
  return new Pool(config);
}

/** DB が到達可能か (テストの skipIf / ヘルスチェック用)。 */
export async function isReachable(connectionString: string, timeoutMs = 2_000): Promise<boolean> {
  const pool = new Pool({ connectionString, connectionTimeoutMillis: timeoutMs, max: 1 });
  try {
    const client = await pool.connect();
    client.release();
    return true;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
}
