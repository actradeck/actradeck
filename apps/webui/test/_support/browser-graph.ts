/**
 * 共有: ブラウザバンドルに載るグラフ (browser graph) の **immutable スナップショット** を作る。
 *
 * TDA-1 (audit ad14a947): 静的 INV テスト (inv-token-isolation / inv-bff-token-no-leak) は live
 * source を runtime に readFileSync していたため、並行 next build / coverage 書き込みと競合して
 * 非原子読み取り → phantom offender で flaky 赤 (再現済)。
 *  → 本モジュールの **module top-level** で walk + readFileSync を一度だけ実行し、各テストは
 *    この凍結スナップショット (path → bytes) を検査する。テスト実行中はソースを再読み取りしない。
 *
 * TDA-5: 両テストで重複していた walk() / BROWSER_GLOBS 走査をここへ一本化 (dedup)。これにより
 * SEC-5 の dynamic import 検出等の改良が片方だけに入る drift を防ぐ。
 *
 * ⚠️ test 専用ユーティリティ。`.js` 拡張で import される (test/** は bundled-by-Next graph 外)。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** apps/webui ルート (test/_support の 2 つ上)。 */
export const WEBUI_ROOT = resolve(here, "..", "..");
const SRC = join(WEBUI_ROOT, "src");
const APP = join(WEBUI_ROOT, "app");

/** server 専用 bff.ts (REALTIME_TOKEN 保持・正規 relay)。browser graph 走査から除外。 */
export const BFF_PATH = join(SRC, "realtime", "bff.ts");

/**
 * ブラウザバンドルに載るグラフ (server 専用 bff.ts / backend を value-import してはいけない)。
 * SEC-4: client.ts 単体でなく realtime/** 全体 (transitive 依存も browser バンドルに載る) + ui/ + app。
 */
export const BROWSER_GLOBS = [join(SRC, "ui"), join(SRC, "realtime"), join(SRC, "replay"), APP];

function walk(path: string): string[] {
  let isDir = false;
  try {
    isDir = statSync(path).isDirectory();
  } catch {
    return [];
  }
  if (!isDir) {
    return [".ts", ".tsx"].includes(extname(path)) ? [path] : [];
  }
  const out: string[] = [];
  for (const name of readdirSync(path)) {
    const full = join(path, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if ([".ts", ".tsx"].includes(extname(name))) out.push(full);
  }
  return out;
}

/** ブラウザグラフのソースファイル 1 件の凍結スナップショット。 */
export interface BrowserSource {
  /** 絶対パス。 */
  readonly path: string;
  /** 読み取り時点のソース bytes (UTF-8 文字列)。テスト中は再読み取りしない。 */
  readonly source: string;
}

/**
 * module load 時に **一度だけ** walk + readFileSync して凍結する。bff.ts は除外。
 * 並行ビルドが走っても、テストはこの時点のバイト列だけを見る (非原子読み取りを起こさない)。
 */
export const BROWSER_SOURCES: readonly BrowserSource[] = Object.freeze(
  BROWSER_GLOBS.flatMap(walk)
    .filter((f) => f !== BFF_PATH)
    .map((path) => Object.freeze({ path, source: readFileSync(path, "utf8") })),
);
