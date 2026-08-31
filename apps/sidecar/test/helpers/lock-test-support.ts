/**
 * lock 系 INV テストの共有ハーネス (test only)。
 *
 * - **実プロセス spawn** (`tsxBin` 解決 + spawn Promise ラッパ): file-lock の直列化・奪取・
 *   同一性は `holder === process.pid` を「自分の残骸」として扱うため、**スレッドでは検証できない**
 *   (同一 pid で self-steal になり偽陽性)。distinct pid の実プロセスでのみ正しく検証できる。
 *   FL-L5b (TDA-FL-9): 同じ骨格が 2 ファイルに複製されていたので、3 コピー目が必要になった
 *   (identity v2 の 4 役 race) タイミングでここへ集約した。
 * - **temp dir の追跡と後始末** (FL-L9 / QA-FL-R2-3): 失敗した run が
 *   `/tmp/actradeck-*` を残さないよう、作った dir を追跡してまとめて掃除する。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const helpersDir = dirname(fileURLToPath(import.meta.url));
const sidecarRoot = resolve(helpersDir, "../..");
const repoRoot = resolve(helpersDir, "../../../..");

/**
 * `tsx` は `@actradeck/sidecar` の devDependency。pnpm の strict (非 hoist) レイアウト
 * (fresh clone の既定) ではパッケージ自身の `node_modules` 配下に、hoist 済みの dev レイアウトでは
 * workspace root に bin が置かれる。双方で解決して fresh clone でも INV が走るようにする。
 */
export const tsxBin =
  [join(sidecarRoot, "node_modules/.bin/tsx"), join(repoRoot, "node_modules/.bin/tsx")].find((p) =>
    existsSync(p),
  ) ?? join(repoRoot, "node_modules/.bin/tsx");

/** worker helper (`test/helpers/*.mts`) の絶対パス。 */
export function workerScript(name: string): string {
  return join(helpersDir, name);
}

/**
 * worker を 1 プロセス spawn し exit code を待つ (spawn 失敗は reject)。
 * stdout は捨て、stderr は親へ流す (失敗時の診断)。
 */
export function spawnWorker(workerPath: string, env: Record<string, string>): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(tsxBin, [workerPath], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "ignore", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code) => resolvePromise(code ?? -1));
  });
}

/** ファイルが現れるまで (または timeout まで) 非同期に待つ。 */
export async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}

const tracked: string[] = [];

/**
 * `os.tmpdir()` 配下に temp dir を作り、{@link cleanupTempDirs} の対象として追跡する。
 * 🔴 実 `~/.actradeck` / 実 settings には触れない。
 */
export function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tracked.push(dir);
  return dir;
}

/**
 * 追跡中の temp dir をすべて best-effort で掃除する (FL-L9)。
 * テストが**失敗した run でも** afterEach / afterAll から呼べば残骸を残さない。
 */
export function cleanupTempDirs(): void {
  while (tracked.length > 0) {
    const dir = tracked.pop();
    if (dir === undefined) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}
