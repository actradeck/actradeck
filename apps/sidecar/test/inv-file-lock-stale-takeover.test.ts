/**
 * INV-FILELOCK-STALE-TAKEOVER-IDENTITY: `withFileLock` の **stale 奪取は、判定した当の lock を
 * 消したときにだけ成立する**。判定 (holder 読取り) と取り外しの間に前保持者が解放し、別プロセスが
 * 新しい lock を立てた場合、その**生きた lock を消してはならない**。
 *
 * 根因 (修正前): 取得ループの EEXIST 枝が
 *   `holder = readLockPid(lockPath)` → `holder === undefined || holder === pid || !isAlive(holder)`
 *   → `unlinkSync(lockPath)`
 * という **非原子** な read-then-unlink で、判定と unlink の間に保持者 A が解放し C が新しい lock を
 * 立てると、B は (a) ENOENT → `undefined` = 「壊れた lock」扱い、または (b) A の pid を読んだ後に
 * A が exit → `!isAlive` のどちらでも **C の生きた lock を unlink** してしまい、B と C が二重に
 * critical section へ入る (= lost-update)。PR #46 CI run 33187020993 で
 * INV-FILELOCK-NO-EMPTY-WINDOW の round 2 が 8→7 になった実観測がこれ。
 * `linkSync` 化 (decision 019f2e51) は「作成と pid 書込の間」の窓しか閉じておらず、この窓は残っていた。
 *
 * 修正 (T1): 奪取は `renameSync(lockPath, <lockPath>.stale-<pid>-<seq>)` で **原子的に取り外し**、
 * 取り外したファイルの内容が判定時に読んだ逐語内容と一致するときだけ unlink する。不一致なら
 * `linkSync` で復元して backoff retry (復元不能なら fail-loud)。`absent` (ENOENT) は stale ではなく
 * 「解放直後」として **unlink せず即 re-link 再試行**する。
 *
 * 検証方法: **実プロセス (distinct pid) 3 本**でレースを組み、順序は sleep でなく file-lock の
 * テスト用 seam (`isAlive` / `onLockContended` / `onHolderObserved`) + ファイル sentinel で
 * **決定的に**作る。スレッドでは検証できない — stale 判定が `holder === process.pid` を
 * 「自分の残骸」として奪うため、同一 pid を共有するスレッドでは偽陽性になる。
 *
 * falsifiability (本 PR turn で実走確認): file-lock.ts を修正前 (HEAD) へ戻すと 2 本とも RED
 * (violation sentinel + 保持区間の重なり)。修正版のまま「rename 後の内容再検証」を外して
 * 無条件 unlink にしても RED。
 *
 * 🔴 すべて os.tmpdir() 配下。実 ~/.actradeck / 実 settings 不可侵。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../../..");
const sidecarRoot = resolve(testDir, "..");
// pnpm の strict (非 hoist) レイアウトと hoist 済み dev レイアウトの双方で tsx を解決する
// (inv-approval-allowlist-store.test.ts と同じ骨格)。
const tsxBin =
  [join(sidecarRoot, "node_modules/.bin/tsx"), join(repoRoot, "node_modules/.bin/tsx")].find((p) =>
    existsSync(p),
  ) ?? join(repoRoot, "node_modules/.bin/tsx");
const workerPath = join(testDir, "helpers/file-lock-race-worker.mts");

/** レース 1 本の観測結果 (sentinel を temp dir 削除前に吸い上げたもの)。 */
interface RaceOutcome {
  readonly codes: readonly number[];
  readonly sentinels: Readonly<Record<string, string | undefined>>;
  readonly lockLeftBehind: boolean;
}

function spawnWorker(env: Record<string, string>): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(tsxBin, [workerPath], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "ignore", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code) => resolvePromise(code ?? -1));
  });
}

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}

const SENTINELS = [
  "a-pid",
  "a-enter",
  "a-exit",
  "b-observed",
  "b-enter",
  "b-inside",
  "b-exit",
  "c-enter",
  "c-inside",
  "c-exit",
  "violation",
  "holder-error",
  "taker-error",
  "contender-error",
] as const;

/**
 * A(holder) → B(contender) → C(taker) の 3 プロセスでレースを 1 本走らせる。
 * B が「A の lock を stale と判定した直後・取り外す直前」で止まっている間に A が解放し C が取得する。
 */
async function runRace(mode: "dead-pid" | "absent"): Promise<RaceOutcome> {
  const dir = mkdtempSync(join(tmpdir(), "actradeck-filelock-race-"));
  const sigDir = join(dir, "sig");
  mkdirSync(sigDir);
  const target = join(dir, "target.json");
  const base = { SIG_DIR: sigDir, TARGET: target, WAIT_MS: "15000" };
  try {
    const holder = spawnWorker({ ...base, ROLE: "holder" });
    // A が critical section に入り、自 pid を公示するまで待つ (B はそれを読む)。
    const ready =
      (await waitForFile(join(sigDir, "a-inside"), 15_000)) &&
      (await waitForFile(join(sigDir, "a-pid"), 15_000));
    expect(ready, "holder(A) never entered the critical section").toBe(true);
    const taker = spawnWorker({ ...base, ROLE: "taker", C_HOLD_MS: "700" });
    const contender = spawnWorker({ ...base, ROLE: "contender", MODE: mode });
    const codes = await Promise.all([holder, contender, taker]);
    const sentinels: Record<string, string | undefined> = {};
    for (const name of SENTINELS) {
      const p = join(sigDir, name);
      sentinels[name] = existsSync(p) ? readFileSync(p, "utf8") : undefined;
    }
    return { codes, sentinels, lockLeftBehind: existsSync(`${target}.actradeck-lock`) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** [enter, exit] 区間が重なっていないこと (= 同時に 2 プロセスが保持していない)。 */
function overlaps(a: readonly [number, number], b: readonly [number, number]): boolean {
  return !(a[1] <= b[0] || b[1] <= a[0]);
}

function heldInterval(
  sentinels: Readonly<Record<string, string | undefined>>,
  role: "a" | "b" | "c",
): [number, number] {
  const enter = sentinels[`${role}-enter`];
  const exit = sentinels[`${role}-exit`];
  expect(enter, `${role}: never entered the critical section`).toBeDefined();
  expect(exit, `${role}: never left the critical section`).toBeDefined();
  return [Number(enter), Number(exit)];
}

function assertNoDoubleHold(outcome: RaceOutcome): void {
  // 1) どのワーカーも異常終了していない (fail-loud throw も含めて 0 で揃う)。
  expect(
    outcome.codes,
    `worker exit codes (holder, contender, taker); errors: ` +
      `${JSON.stringify({
        holder: outcome.sentinels["holder-error"],
        contender: outcome.sentinels["contender-error"],
        taker: outcome.sentinels["taker-error"],
      })}`,
  ).toEqual([0, 0, 0]);

  // 2) 3 者の保持区間が pairwise に重ならない (= 二重保持ゼロ)。
  const a = heldInterval(outcome.sentinels, "a");
  const b = heldInterval(outcome.sentinels, "b");
  const c = heldInterval(outcome.sentinels, "c");
  expect(overlaps(a, c), `A and C held the lock at the same time: ${a} / ${c}`).toBe(false);
  expect(overlaps(a, b), `A and B held the lock at the same time: ${a} / ${b}`).toBe(false);
  expect(overlaps(b, c), `B and C held the lock at the same time: ${b} / ${c}`).toBe(false);
  // B は C が解放した後にしか入れない (レース構成上 B が最後)。
  expect(b[0], "B entered before C released the lock").toBeGreaterThanOrEqual(c[1]);

  // 3) B 自身が critical section 内で観測した二重保持 (直接証拠)。
  expect(outcome.sentinels["violation"], "contender observed a double hold").toBeUndefined();

  // 4) lock file が残っていない (解放漏れなし)。
  expect(outcome.lockLeftBehind).toBe(false);
}

describe("INV-FILELOCK-STALE-TAKEOVER-IDENTITY: 奪取は取り外す lock の同一性を保証する", () => {
  it("dead-pid 判定と取り外しの間に別プロセスが lock を立て直しても二重保持しない", async () => {
    const outcome = await runRace("dead-pid");
    // vacuity guard: B が本当に **A の pid** を holder として読んでいたことを固定する
    // (読めていなければレースが組めておらず、緑は無意味)。
    expect(outcome.sentinels["b-observed"]?.trim(), "contender did not observe A's pid").toBe(
      outcome.sentinels["a-pid"]?.trim(),
    );
    // vacuity guard: C が実際に「A 解放後の新しい lock」を取っていた。
    expect(outcome.sentinels["c-inside"], "taker never acquired the lock").toBeDefined();
    assertNoDoubleHold(outcome);
  }, 120_000);

  it("解放直後の absent 観測と取り外しの間に別プロセスが lock を立て直しても二重保持しない", async () => {
    const outcome = await runRace("absent");
    // vacuity guard: B が本当に ENOENT (= `absent`) を観測していた。
    expect(
      outcome.sentinels["b-observed"]?.trim(),
      "contender did not observe an absent lock",
    ).toBe("absent");
    expect(outcome.sentinels["c-inside"], "taker never acquired the lock").toBeDefined();
    assertNoDoubleHold(outcome);
  }, 120_000);
});
