/**
 * Programmatic migration runner (@actradeck/db).
 *
 * CLI (`pnpm db:migrate` = node-pg-migrate bin) と同じ migrations を、**接続文字列を渡して
 * コード内から**適用する。埋込 PGlite (ADR 019f1b71) の backend 起動時 in-process migration が
 * 主用途: 埋込は backend プロセス内に閉じ、別プロセスの CLI からは同じ dataDir を open できない
 * (PGlite は single-process) ため、socket 起動後に同プロセスから runner を呼ぶ。
 *
 * REAL DATA ONLY: 実 DB (実 pg or 埋込 PGlite socket) に対してのみ動く。モック無し。
 * migration ファイル (.ts) は tsx ランタイム下で動的 import される (backend は `--import tsx` 起動)。
 */
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// node-pg-migrate は migration ファイルを Node native `import()` で読むため、`.ts` は tsx 登録済み
// ランタイム (backend の `--import tsx`) でしか解決できない (vitest / plain node では
// "Unknown file extension .ts")。よって programmatic runner は**コンパイル済み `.js`**
// (dist/migrations) を参照し、ランタイム非依存にする (CLI `pnpm db:migrate` は従来どおり
// db/migrations の `.ts` + tsx を使う。両者は同一ソースからのコンパイルで常に同期)。
//
// `<pkg>/dist/migrations` は src/migrate.ts (vitest 経路) からも dist/migrate.js (production の
// package main 経路) からも同一に解決する (どちらも <pkg> 直下1階層ゆえ)。
const MIGRATIONS_DIR = resolve(PKG_ROOT, "dist", "migrations");
// 権威 `.ts` migration (db/migrations・CLI が読む dir・鮮度比較の対象)。
const SRC_MIGRATIONS_DIR = resolve(PKG_ROOT, "migrations");

/** node-pg-migrate の管理テーブル (CLI 既定と一致・ドリフトさせない)。 */
const MIGRATIONS_TABLE = "pgmigrations";

export interface RunMigrationsOptions {
  /** 方向。既定 up。 */
  readonly direction?: "up" | "down";
  /** 適用する migration 数。既定は全 pending (Infinity)。down で 1 を渡すと 1 段戻す。 */
  readonly count?: number;
}

/** ディレクトリ内の `ext` で終わるファイルの basename (拡張子除去) 集合を返す (無ければ空)。 */
function migrationBasenames(dir: string, ext: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(ext))
      .map((f) => f.slice(0, -ext.length))
      .sort();
  } catch {
    return [];
  }
}

/**
 * TDA-1 鮮度チェック (純関数・falsifiable): 権威 src `.ts` migration の basename 集合を、
 * runner が実際に読む dist `.js` の basename 集合が**包含**しているか検証する。src にあって dist に
 * 無い (= 未ビルド or stale dist) 場合は fail-loud で throw する。
 *
 * 背景: 埋込は dist/migrations/*.js を読む一方、CLI は migrations/*.ts (db/migrations) を読む。db を rebuild せず
 * backend を起動 (`pnpm --filter backend dev`) すると stale dist で schema drift が silent に起きる。
 * これを起動時に検出する。dist superset (src から消えた古い migration が dist に残る) は許容
 * (append-only 運用ゆえ稀・害なし)。
 */
export function assertMigrationsFresh(srcNames: string[], distNames: string[]): void {
  const distSet = new Set(distNames);
  const missing = srcNames.filter((n) => !distSet.has(n));
  if (missing.length > 0) {
    throw new Error(
      `@actradeck/db migrations are not built or stale (missing in dist/migrations: ${missing.join(", ")}). ` +
        `Run: pnpm --filter @actradeck/db build`,
    );
  }
}

/**
 * `databaseUrl` の DB に対し migration を適用し、**適用した migration 数**を返す。
 *
 * - `databaseUrl`: 実 pg か 埋込 PGlite socket の接続文字列 (secret を含みうるため呼び元で管理し、
 *   ここでログ出力しない)。
 * - ログは抑制する (`log: () => {}`)。secret を含みうる DB URL / クエリを stdout に出さず、
 *   呼び元が戻り値 (件数) で観測する (security.md: 原文非依存の観測)。
 */
export async function runMigrations(
  databaseUrl: string,
  opts: RunMigrationsOptions = {},
): Promise<number> {
  // TDA-1: dist(.js)↔src(.ts) 鮮度チェック。src が存在する開発/monorepo では、未ビルド/stale な
  // dist を silent に使って schema drift する事故を fail-loud で防ぐ。dist-only 配布 (src 不在) では
  // 比較対象が無いので skip し dist を信頼する。
  const srcNames = migrationBasenames(SRC_MIGRATIONS_DIR, ".ts");
  if (srcNames.length > 0) {
    assertMigrationsFresh(srcNames, migrationBasenames(MIGRATIONS_DIR, ".js"));
  }

  const applied = await runner({
    databaseUrl,
    dir: MIGRATIONS_DIR,
    direction: opts.direction ?? "up",
    migrationsTable: MIGRATIONS_TABLE,
    count: opts.count ?? Number.POSITIVE_INFINITY,
    checkOrder: true,
    log: () => {},
  });
  return applied.length;
}
