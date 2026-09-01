/**
 * INV-FILELOCK-STALE-TAKEOVER-IDENTITY ヘルパ (test only・vitest 非対象 = .mts):
 * `withFileLock` の **stale 奪取 TOCTOU** を実プロセス (distinct pid) で決定的に再現するワーカー。
 *
 * 3 役で 1 本のレースを組む (役は env `ROLE`)。順序は sleep でなく **ファイル sentinel + file-lock の
 * テスト用 seam (`testHooks` の `isAlive` / `onLockContended` / `onHolderObserved`)** で決定的に作る。
 *
 *   holder(A)    : lock を取り critical section に居座る。B の合図で解放する。
 *   contender(B) : A が保持中に取得を試み、**A の pid を stale と判定する寸前で停止**する。
 *                  その間に A が解放し C が新しい lock を立てる。再開後 B が奪取へ進む。
 *   taker(C)     : A の解放後に lock を取り、B が入って来ないことを確認できるまで保持する。
 *
 * MODE:
 *   `dead-pid` … B は holder を `pid` として読み、`isAlive` seam の中で A 解放 → C 取得を待つ。
 *                旧実装は「読んだ A の pid が死んでいる」だけで `unlinkSync(lockPath)` したため
 *                **C の生きた lock** を消して二重保持になった。
 *   `absent`   … B は `onLockContended` (holder 読取り前) で A の解放を待ち、`absent` (ENOENT) を
 *                観測する。`onHolderObserved` の中で C の取得を待つ。旧実装は `absent` を
 *                「壊れた lock」とみなして unlink したため、やはり C の生きた lock を消した。
 *
 * 入出力はすべて env と `SIG_DIR` 配下の sentinel ファイル (呼び元が os.tmpdir 配下を与える)。
 * 実 ~/.actradeck / 実 settings は不可侵。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { withFileLock, type FileLockTestHooks } from "../../src/file-lock.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    process.stderr.write(`file-lock-race-worker: ${name} is required\n`);
    process.exit(2);
  }
  return v;
}

const role = requireEnv("ROLE");
const sigDir = requireEnv("SIG_DIR");
const target = requireEnv("TARGET");
const waitBudgetMs = Number(process.env.WAIT_MS ?? 15_000);

const sig = (name: string): string => join(sigDir, name);
const put = (name: string, body = "1"): void => {
  writeFileSync(sig(name), body, "utf8");
};
const has = (name: string): boolean => existsSync(sig(name));
const get = (name: string): string => readFileSync(sig(name), "utf8");

/** 同期 sleep (Atomics.wait)。busy-wait で CPU を焼かない。 */
function napMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** sentinel が現れるまで同期に待つ。timeout したら false (呼び元テストが vacuity を検出する)。 */
function waitFor(name: string, timeoutMs = waitBudgetMs): boolean {
  const deadline = Date.now() + timeoutMs;
  while (!has(name)) {
    if (Date.now() >= deadline) return false;
    napMs(2);
  }
  return true;
}

function runHolder(): void {
  put("a-pid", String(process.pid));
  withFileLock(target, () => {
    put("a-enter", String(Date.now()));
    put("a-inside");
    // B が「A の lock を観測し終えた」と合図するまで critical section に居座る。
    waitFor("a-may-release");
    put("a-exit", String(Date.now()));
  });
  // withFileLock の finally が unlink し終えてから解放を宣言する。
  put("a-released");
}

function runTaker(): void {
  const holdMs = Number(process.env.C_HOLD_MS ?? 700);
  // B が「A の holder を観測し終えた」と合図するまで取得を試みない。
  waitFor("c-go");
  withFileLock(target, () => {
    put("c-enter", String(Date.now()));
    put("c-inside");
    // B が入って来たら (= 二重保持) すぐ気付けるよう待つ。来なければ holdMs で抜ける。
    waitFor("b-inside", holdMs);
    // c-exit は **fn の中** (= まだ lock を保持している間) に書く。fn を抜けた後に書くと
    // 「解放済みだが c-exit 未書込」の窓で B が誤検知しうる。
    put("c-exit", String(Date.now()));
  });
  put("c-done");
}

function runContender(): void {
  const mode = requireEnv("MODE");
  const aPid = Number(get("a-pid").trim());
  let armedIsAlive = true;
  let armedContended = true;
  let armedObserved = true;

  /** B が「A の lock を観測した」直後に走らせる合図: A を解放させ、C の取得完了を待つ。 */
  function releaseHolderThenLetTakerIn(): void {
    put("a-may-release");
    put("c-go");
    waitFor("c-inside");
  }

  // 役ごとに seam を後付けするので readonly を外した mutable 版で組み立てる。
  const hooks: { -readonly [K in keyof FileLockTestHooks]: FileLockTestHooks[K] } = {
    isAlive: (pid) => {
      if (mode === "dead-pid" && pid === aPid) {
        if (armedIsAlive) {
          armedIsAlive = false;
          // 「A の pid を読んだ」ことを記録 (テストが vacuity を排除するために照合する)。
          put("b-observed", String(pid));
          releaseHolderThenLetTakerIn();
        }
        // A は死んだ = stale と判定させる (奪取経路へ入れる)。
        return false;
      }
      // A 以外 (= C) は生存扱い。奪取ではなく backoff させる。
      return true;
    },
  };

  if (mode === "absent") {
    // holder 読取りの **前** に A を解放させる → readLockHolder は ENOENT = `absent` を観測する。
    hooks.onLockContended = () => {
      if (!armedContended) return;
      armedContended = false;
      put("a-may-release");
      waitFor("a-released");
    };
    // 観測 → 奪取判断の間に C を入れる (旧実装はここで C の生きた lock を unlink した)。
    hooks.onHolderObserved = (kind) => {
      if (!armedObserved) return;
      armedObserved = false;
      put("b-observed", kind);
      put("c-go");
      waitFor("c-inside");
    };
  }

  withFileLock(
    target,
    () => {
      put("b-enter", String(Date.now()));
      if (has("c-inside") && !has("c-exit")) {
        put("violation", "B entered the critical section while C still held the lock");
      }
      // C が「B が入った」ことに気付いて抜けるより先に、二重保持を確実に観測できる幅を取る。
      napMs(40);
      put("b-inside");
      if (has("c-inside") && !has("c-exit")) {
        put("violation", "B held the lock while C was still inside the critical section");
      }
      put("b-exit", String(Date.now()));
    },
    { testHooks: hooks },
  );
}

try {
  if (role === "holder") runHolder();
  else if (role === "taker") runTaker();
  else if (role === "contender") runContender();
  else {
    process.stderr.write(`file-lock-race-worker: unknown ROLE ${role}\n`);
    process.exit(2);
  }
} catch (err) {
  put(`${role}-error`, err instanceof Error ? err.message : String(err));
  process.stderr.write(`file-lock-race-worker(${role}): ${String(err)}\n`);
  process.exit(3);
}
process.exit(0);
