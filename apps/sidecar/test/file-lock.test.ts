/**
 * INV-ATTACH-WIRE-LOCK (汎用 file lock コア)。
 *
 * withFileLock の不変条件を固定する:
 * - 相互排他: lock 保持中 (`fn` 実行中) は lockfile が存在し、別の取得は素通ししない。
 * - fail-loud: 生存保持者がいて maxRetries を超えたら throw (無言継続しない)。
 * - stale 奪取: 死亡 pid の lock は奪取して取得できる。
 * - **奪取の同一性**: 判定した当の lock だけを消す (rename で取り外し → 内容再検証 → 不一致なら復元)。
 *   `absent` (ENOENT) は stale ではなく「解放直後」として unlink せず即再試行する。
 * - 自己 unlink: 正常終了・例外時とも finally で lockfile を消す。
 *
 * mutation: withFileLock を「素通し (lock 取らず fn 実行)」に変えると、
 * 「保持中は二重取得が fail-loud」「保持中 lockfile 存在」テストが赤化する。
 *
 * NOTE: 実 multi-process harness が必要な INV は別ファイルに同居/常駐する。
 *   - 「空ファイル窓 (create→pid 可視の TOCTOU) で二重取得しない」= 承認永続の並走テスト
 *     inv-approval-allowlist-store.test.ts の `INV-FILELOCK-NO-EMPTY-WINDOW`
 *     (実 spawn worker + acquireDelayMs 注入で falsifiable)。
 *   - 「stale 奪取が判定した当の lock だけを消す」= inv-file-lock-stale-takeover.test.ts の
 *     `INV-FILELOCK-STALE-TAKEOVER-IDENTITY` (実 spawn worker 3 本 + seam 注入で falsifiable)。
 *   本ファイルの以下の describe は同じ機構を **同期・単一プロセス**で分岐単位に pin する
 *   (実プロセス INV の代替ではなく補完)。
 *
 * 🔴 すべて os.tmpdir() 配下。実設定不可侵。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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

  it("takes over its own leftover lockfile (self remnant)", () => {
    // 前回の自分 (同一 pid) が残した lock は自分の残骸として奪取してよい。
    writeFileSync(lockPath, `${process.pid}\n`);
    let ran = false;
    const ret = withFileLock(target, () => {
      ran = true;
      return "ok";
    });
    expect(ran).toBe(true);
    expect(ret).toBe("ok");
  });

  it("leaves no .stale-* debris behind after a takeover", () => {
    writeFileSync(lockPath, "999999\n");
    withFileLock(target, () => "ok", { isAlive: () => false });
    expect(readdirSync(dir).filter((n) => n.includes(".stale-"))).toEqual([]);
  });
});

/**
 * INV-FILELOCK-STALE-TAKEOVER-IDENTITY (同期・単一プロセス側の分岐 pin)。
 *
 * 実プロセス版は inv-file-lock-stale-takeover.test.ts。ここでは `onLockContended`
 * (holder 読取り前) / `onHolderObserved` (奪取判断前) の seam を使って、判定と取り外しの間に
 * lock が入れ替わる各分岐を決定的に踏む。
 *
 * mutation: 「rename → 内容再検証 → 不一致なら復元」を無条件 unlink へ戻すと
 * 「復元して backoff する」テストが赤化する。「absent を stale 扱いして unlink」へ戻すと
 * 「解放直後に立った生きた lock を消さない」テストが赤化する。
 */
describe("INV-FILELOCK-STALE-TAKEOVER-IDENTITY: 取り外す lock の同一性", () => {
  const DEAD = 999999;

  it("判定 → 取り外しの間に内容が変わったら復元して backoff する (消さない)", () => {
    writeFileSync(lockPath, `${DEAD}\n`);
    const observed: string[] = [];
    const sleeps: number[] = [];
    let round = 0;
    const ret = withFileLock(target, () => "ok", {
      isAlive: (pid) => pid !== DEAD, // DEAD だけ死亡扱い
      sleep: (ms) => sleeps.push(ms),
      onHolderObserved: (kind) => {
        observed.push(kind);
        if (round === 0) {
          // 判定直後・取り外し前に「別プロセスの生きた lock」へ差し替える。
          writeFileSync(lockPath, "1\n");
        } else {
          // 復元されていること = 生きた lock を消していないことの直接証拠。
          expect(readFileSync(lockPath, "utf8")).toBe("1\n");
          unlinkSync(lockPath); // その holder が解放したことにして先へ進ませる
        }
        round += 1;
      },
    });
    expect(ret).toBe("ok");
    expect(observed).toEqual(["pid", "pid"]);
    // 復元後は「生存保持者あり」扱い = backoff を挟む (即再試行しない)。
    expect(sleeps.length).toBeGreaterThanOrEqual(1);
    expect(readdirSync(dir).filter((n) => n.includes(".stale-"))).toEqual([]);
  });

  it("absent (解放直後) を stale 扱いせず、その窓で立った生きた lock を消さない", () => {
    writeFileSync(lockPath, `${DEAD}\n`);
    const observed: string[] = [];
    let contended = 0;
    let seen = 0;
    const ret = withFileLock(target, () => "ok", {
      isAlive: () => true, // 何も死んでいない = 奪取経路へ入らない
      sleep: () => {},
      onLockContended: () => {
        // 1 回目だけ: holder 読取りの直前に前保持者が解放したことにする。
        if (contended === 0) unlinkSync(lockPath);
        contended += 1;
      },
      onHolderObserved: (kind) => {
        observed.push(kind);
        if (seen === 0) {
          // absent 観測の直後に別プロセスが**生きた** lock を立てた。
          writeFileSync(lockPath, "1\n");
        } else {
          // 生きた lock が消されずに残っていること (旧実装はここで消していた)。
          expect(readFileSync(lockPath, "utf8")).toBe("1\n");
          unlinkSync(lockPath);
        }
        seen += 1;
      },
    });
    expect(ret).toBe("ok");
    expect(observed[0]).toBe("absent");
    expect(observed).toEqual(["absent", "pid"]);
  });

  it("取り外す前に他者が消していたら (rename ENOENT) backoff せず即再試行する", () => {
    writeFileSync(lockPath, `${DEAD}\n`);
    const sleeps: number[] = [];
    let seen = 0;
    const ret = withFileLock(target, () => "ok", {
      isAlive: () => false,
      sleep: (ms) => sleeps.push(ms),
      onHolderObserved: () => {
        if (seen === 0) unlinkSync(lockPath); // 他者が先に取り外した
        seen += 1;
      },
    });
    expect(ret).toBe("ok");
    expect(seen).toBe(1);
    expect(sleeps).toEqual([]); // 即再試行 (backoff を挟まない)
  });

  it("free ↔ held を無限に往復したら fail-loud で止まる (無言 busy-loop にしない)", () => {
    writeFileSync(lockPath, "1\n");
    let spins = 0;
    expect(() =>
      withFileLock(target, () => "never", {
        isAlive: () => true,
        sleep: () => {},
        onLockContended: () => {
          // 読取り直前に消す → absent 観測
          try {
            unlinkSync(lockPath);
          } catch {
            /* noop */
          }
        },
        onHolderObserved: () => {
          spins += 1;
          writeFileSync(lockPath, "1\n"); // 判定直後に立て直す → 永久 flapping
        },
      }),
    ).toThrow(/kept flapping/);
    expect(spins).toBeGreaterThan(1000);
  });

  it("内容を読めない lock (ディレクトリ) は奪取せず fail-loud にする", () => {
    // 読めない lock は同一性を再検証できない。旧実装は全 read 失敗を stale 扱いして奪取していた。
    mkdirSync(lockPath);
    expect(() => withFileLock(target, () => "never")).toThrow(/EISDIR/);
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

  it("releases a lock whose content got corrupted while held", () => {
    // 自分が立てた lock の内容が壊された残骸は掃除する (放置すると次回まで残る)。
    withFileLock(target, () => {
      writeFileSync(lockPath, "not-a-pid\n");
    });
    expect(existsSync(lockPath)).toBe(false);
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
