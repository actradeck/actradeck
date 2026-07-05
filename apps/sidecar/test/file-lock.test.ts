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
 * NOTE: 「空ファイル窓 (create→pid 可視の TOCTOU) で二重取得しない」INV は実 multi-process harness が
 *   必要なため、承認永続の並走テスト inv-approval-allowlist-store.test.ts の
 *   `INV-FILELOCK-NO-EMPTY-WINDOW` に同居する (実 spawn worker + acquireDelayMs 注入で falsifiable)。
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
  // QA-2: lock file の親 dir が未作成でも linkSync 取得が ENOENT で落ちないことを pin。
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

describe("INV-ATTACH-WIRE-LOCK: SEC-1 acquire-delay env は test モード時のみ honor", () => {
  // 取得遅延の env (ACTRADECK_TEST_LOCK_ACQUIRE_DELAY_MS) は本番デーモンで無視されねばならない
  // (万一漏れても取得遅延を注入できない)。free lock ゆえ backoff sleep は起きないため、注入した
  // sleep spy が呼ばれたら「acquire-delay が honor された」直接証拠になる。
  const ENV_KEY = "ACTRADECK_TEST_LOCK_ACQUIRE_DELAY_MS";
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {
      [ENV_KEY]: process.env[ENV_KEY],
      NODE_ENV: process.env.NODE_ENV,
      VITEST: process.env.VITEST,
    };
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("NODE_ENV=production では env の取得遅延を無視する (sleep 未呼出)", () => {
    process.env[ENV_KEY] = "5000";
    process.env.NODE_ENV = "production";
    delete process.env.VITEST; // test-mode シグナルを外す
    const sleeps: number[] = [];
    withFileLock(target, () => "ok", { sleep: (ms) => sleeps.push(ms) });
    expect(sleeps).toEqual([]); // 本番では取得遅延を注入しない
  });

  it("NODE_ENV=test では env の取得遅延を honor する (sleep 呼出)", () => {
    process.env[ENV_KEY] = "7";
    process.env.NODE_ENV = "test";
    delete process.env.VITEST;
    const sleeps: number[] = [];
    withFileLock(target, () => "ok", { sleep: (ms) => sleeps.push(ms) });
    expect(sleeps).toContain(7); // test モードでは注入される
  });

  it("VITEST シグナルだけでも honor する (NODE_ENV 非 test でも)", () => {
    process.env[ENV_KEY] = "9";
    process.env.NODE_ENV = "production";
    process.env.VITEST = "true";
    const sleeps: number[] = [];
    withFileLock(target, () => "ok", { sleep: (ms) => sleeps.push(ms) });
    expect(sleeps).toContain(9);
  });

  it("env 値は 60s に clamp される (暴走遅延防止)", () => {
    process.env[ENV_KEY] = "999999999";
    process.env.NODE_ENV = "test";
    delete process.env.VITEST;
    const sleeps: number[] = [];
    withFileLock(target, () => "ok", { sleep: (ms) => sleeps.push(ms) });
    expect(sleeps).toContain(60_000); // 上限で頭打ち
    expect(Math.max(...sleeps, 0)).toBeLessThanOrEqual(60_000);
  });

  it("非有限な env 値は 0 扱い (遅延なし)", () => {
    process.env[ENV_KEY] = "not-a-number";
    process.env.NODE_ENV = "test";
    delete process.env.VITEST;
    const sleeps: number[] = [];
    withFileLock(target, () => "ok", { sleep: (ms) => sleeps.push(ms) });
    expect(sleeps).toEqual([]);
  });
});
