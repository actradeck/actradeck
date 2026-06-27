/**
 * INV-ATTACH-WIRE-LOCK (汎用 file lock コア)。
 *
 * withFileLock の不変条件を固定する:
 * - 相互排他: lock 保持中 (`fn` 実行中) は lockfile が存在し、別の取得は素通ししない。
 * - fail-loud: 生存保持者がいて maxRetries を超えたら throw (無言継続しない)。
 * - stale 奪取: 死亡 pid の lock は奪取して取得できる。
 * - 自己 unlink: 正常終了・例外時とも finally で lockfile を消す。
 *
 * mutation: withFileLock を「素通し (lock 取らず fn 実行)」に変えると、
 * 「保持中は二重取得が fail-loud」「保持中 lockfile 存在」テストが赤化する。
 *
 * 🔴 すべて os.tmpdir() 配下。実設定不可侵。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { withFileLock } from "../src/file-lock.js";

let dir: string;
let target: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "actradeck-filelock-"));
  target = join(dir, "target.json");
  lockPath = `${target}.actradeck-lock`; // SEC-1: 本番既定の lock 名
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("INV-ATTACH-WIRE-LOCK: mutual exclusion", () => {
  it("holds the lock during fn: lockfile exists while inside, removed after", () => {
    let insideExists = false;
    const ret = withFileLock(target, () => {
      insideExists = existsSync(lockPath);
      return 42;
    });
    expect(ret).toBe(42);
    expect(insideExists).toBe(true); // 保持中は lockfile が存在する
    expect(existsSync(lockPath)).toBe(false); // 終了後は消える (自己 unlink)
  });

  it("re-entrant acquisition while held fails loud (does not silently pass through)", () => {
    // 外側 lock 保持中に、別 holder pid を装った live lock 取得を試みる。
    // 内側は「自分とは別の生存 pid」が保持しているように見せ、maxRetries=0 で即 fail-loud。
    expect(() =>
      withFileLock(target, () => {
        // ここで lockfile を「別の生存プロセス」が持っているように上書きする。
        const otherLivePid = process.pid === 1 ? 2 : 1; // init は常に生存 (奪取されない)
        writeFileSync(lockPath, `${otherLivePid}\n`);
        // 同一 path を別 holder として再取得 → 生存保持者ありで retry 上限 0 → throw。
        withFileLock(target, () => "should-not-run", {
          maxRetries: 0,
          isAlive: () => true,
          sleep: () => {},
        });
      }),
    ).toThrow(/failed to acquire/);
  });

  it("serializes: a second acquire waits then succeeds after the first releases", () => {
    // 同一プロセス内では同期実行なので、ネスト無しの sequential 取得が両方成功することを確認
    // (lockfile が前回終了で確実に解放されている = リーク無し)。
    const a = withFileLock(target, () => "a");
    const b = withFileLock(target, () => "b");
    expect([a, b]).toEqual(["a", "b"]);
    expect(existsSync(lockPath)).toBe(false);
  });
});

describe("INV-ATTACH-WIRE-LOCK: creates the lock dir if missing", () => {
  // QA-2: lock file の親 dir が未作成でも openSync('wx') が ENOENT で落ちないことを pin。
  // mutation: file-lock.ts の mkdirSync(dirname(lockPath),{recursive:true}) を削除すると、
  //           未作成の入れ子 dir 配下で ENOENT throw して赤化する。
  it("runs fn under a target inside an uncreated nested directory", () => {
    const nestedTarget = join(dir, "a/b/c/.claude/settings.json");
    let ran = false;
    const ret = withFileLock(nestedTarget, () => {
      ran = true;
      return "ok";
    });
    expect(ran).toBe(true);
    expect(ret).toBe("ok");
  });
});

describe("INV-ATTACH-WIRE-LOCK: stale takeover", () => {
  it("takes over a lock held by a dead pid", () => {
    // 死んだ pid の lock を残す。
    writeFileSync(lockPath, "999999\n");
    let ran = false;
    const ret = withFileLock(
      target,
      () => {
        ran = true;
        return "ok";
      },
      { isAlive: () => false }, // 保持者は死亡 → 奪取
    );
    expect(ran).toBe(true);
    expect(ret).toBe("ok");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("takes over a corrupt (non-numeric) lockfile", () => {
    writeFileSync(lockPath, "not-a-pid\n");
    const ret = withFileLock(target, () => "ok", { isAlive: () => true });
    expect(ret).toBe("ok");
  });
});

describe("INV-ATTACH-WIRE-LOCK: fail-loud", () => {
  it("throws when a live holder never releases within maxRetries", () => {
    writeFileSync(lockPath, "12345\n"); // 別の生存 pid が保持
    let slept = 0;
    expect(() =>
      withFileLock(target, () => "never", {
        maxRetries: 3,
        isAlive: () => true,
        sleep: () => {
          slept += 1;
        },
      }),
    ).toThrow(/failed to acquire .* after 3 retries/);
    expect(slept).toBe(3); // 上限まで backoff してから throw
  });
});

describe("INV-ATTACH-WIRE-LOCK: self-unlink on throw", () => {
  it("releases the lock even when fn throws", () => {
    expect(() =>
      withFileLock(target, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(existsSync(lockPath)).toBe(false); // 例外でも finally で解放
  });

  it("does not delete a lock that was taken over by someone else", () => {
    // fn 内で lockfile を別 live pid に書き換えたら、finally は自分のものでないので消さない。
    const otherLivePid = process.pid === 1 ? 2 : 1;
    withFileLock(target, () => {
      writeFileSync(lockPath, `${otherLivePid}\n`);
    });
    // finally は holder !== self を検出して unlink しない → 他者の lock を尊重。
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf8").trim()).toBe(String(otherLivePid));
  });
});
