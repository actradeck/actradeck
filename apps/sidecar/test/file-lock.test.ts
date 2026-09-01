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
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { withFileLock } from "../src/file-lock.js";
import { cleanupTempDirs, makeTempDir } from "./helpers/lock-test-support.js";

let dir: string;
let target: string;
let lockPath: string;
let swapSeq = 0;

/**
 * `lockPath` を **必ず別 inode** の同内容/別内容ファイルへ差し替える。
 *
 * `unlinkSync` → `writeFileSync` だと解放直後の inode 番号がそのまま再利用されることがあり
 * (ext4 で実測)、「別 inode」を作ったつもりが同一 inode になる。元のファイルを link したまま
 * 別名で作ってから `renameSync` で被せると、新旧が同時に存在する瞬間があるので inode は必ず異なる。
 */
function swapLockFile(content: string): number {
  const staging = `${lockPath}.swap-${swapSeq++}`;
  writeFileSync(staging, content);
  const ino = statSync(staging).ino;
  renameSync(staging, lockPath);
  return ino;
}

beforeEach(() => {
  // FL-L9: 失敗した run でも残骸を残さないよう、作った temp dir は共有ハーネスが追跡する。
  dir = makeTempDir("actradeck-filelock-");
  target = join(dir, "target.json");
  lockPath = `${target}.actradeck-lock`; // SEC-1: 本番既定の lock 名
});
afterEach(cleanupTempDirs);

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
          testHooks: { isAlive: () => true, sleep: () => {} },
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
      { testHooks: { isAlive: () => false } }, // 保持者は死亡 → 奪取
    );
    expect(ran).toBe(true);
    expect(ret).toBe("ok");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("takes over a corrupt (non-numeric) lockfile", () => {
    writeFileSync(lockPath, "not-a-pid\n");
    const ret = withFileLock(target, () => "ok", { testHooks: { isAlive: () => true } });
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
    withFileLock(target, () => "ok", { testHooks: { isAlive: () => false } });
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
      testHooks: {
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
      testHooks: {
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
      testHooks: {
        isAlive: () => false,
        sleep: (ms) => sleeps.push(ms),
        onHolderObserved: () => {
          if (seen === 0) unlinkSync(lockPath); // 他者が先に取り外した
          seen += 1;
        },
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
        testHooks: {
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
        },
      }),
    ).toThrow(/kept flapping/);
    // QA-FL-4: 上限の実値を pin する (`toBeGreaterThan(1000)` だと上限を上げても検査されない)。
    // spins は onHolderObserved (= 各周回の判定直後) で数えるため、実装が spins > 1000 で throw する
    // 周回とちょうど同数になる。
    expect(spins).toBe(1001);
  });

  it("内容を読めない lock (ディレクトリ) は奪取せず fail-loud にする", () => {
    // 読めない lock は同一性を再検証できない。旧実装は全 read 失敗を stale 扱いして奪取していた。
    mkdirSync(lockPath);
    expect(() => withFileLock(target, () => "never")).toThrow(/EISDIR/);
  });

  it("同一 pid・別バイトの lock へ差し替わったら復元して backoff する (比較は生バイト列)", () => {
    // FL-B / QA-FL-3: 同一性の比較は parseInt 後の pid ではなく**生バイト列**。同じ pid を持つが
    // バイト列の違う lock を判定→取り外しの窓に差すと、復元されて backoff する
    // (pid 比較へ緩めると取り外して破棄してしまう = このテストが赤くなる)。
    writeFileSync(lockPath, `${DEAD}\n`);
    const observed: string[] = [];
    const sleeps: number[] = [];
    const restored: string[] = [];
    let round = 0;
    const ret = withFileLock(target, () => "ok", {
      testHooks: {
        isAlive: (pid) => pid !== DEAD, // DEAD だけ死亡扱い
        sleep: (ms) => sleeps.push(ms),
        onHolderObserved: (kind) => {
          observed.push(kind);
          if (round === 0) {
            // 判定直後・取り外し前に「同じ pid を書き直した別 lock」へ差し替える。
            // parseInt すると同値 (DEAD) だが逐語バイト列は別物。
            writeFileSync(lockPath, `${DEAD} x\n`);
          } else if (round === 1) {
            // 復元されており、かつ**差し替えた側の内容が保存されている**こと。
            restored.push(readFileSync(lockPath, "utf8"));
          }
          round += 1;
        },
      },
    });
    expect(ret).toBe("ok");
    expect(observed).toEqual(["pid", "pid"]);
    expect(restored).toEqual([`${DEAD} x\n`]);
    // 復元後は「生存保持者あり」扱い = backoff を挟む (即再試行しない)。
    expect(sleeps.length).toBeGreaterThanOrEqual(1);
    expect(readdirSync(dir).filter((n) => n.includes(".stale-"))).toEqual([]);
  });
});

/**
 * SEC-FL-1: 内容を読めない lock (EACCES) の扱いを pin する。
 *
 * **取得側**は「読めない lock は他者のものかもしれず、同一性を再検証できない」ので奪取せず即
 * fail-loud する (旧実装は全 read 失敗を stale 扱いして盲目的に奪取していた)。これは維持する軸。
 *
 * **解放側**は identity v2 で `(dev, ino)` から自 lock を判定するようになった (`statSync` は読み権限を
 * 要さない)。よって「保持中に自分の lock が読めなくなる」ケースは解放で外れ、次の取得が通る
 * = 恒久 wedge から回復する (旧: 解放も `readLockHolder` を通り EACCES で unlink できず、
 * 当該 lock file を手で除去するまで承認 allowlist の add/revoke/clear と policy 永続が失敗し続けた)。
 * 詳細は CHANGELOG / docs/adr/0012 の Concurrency 節。
 *
 * root では chmod が権限判定に効かない (CAP_DAC_OVERRIDE) ため skip する。
 */
const runningAsRoot = process.getuid?.() === 0;

describe("INV-ATTACH-WIRE-LOCK: 読めない lock (EACCES) の縮退", () => {
  it.skipIf(runningAsRoot)(
    "他プロセスの読めない lock は奪取せず即 throw する (backoff もしない・root では skip)",
    () => {
      writeFileSync(lockPath, "12345\n"); // 別 pid の lock
      chmodSync(lockPath, 0o000);
      const sleeps: number[] = [];
      expect(() =>
        withFileLock(target, () => "never", {
          testHooks: {
            sleep: (ms) => sleeps.push(ms),
            isAlive: () => false, // 死亡扱いにしても読めない以上は奪取しない
          },
        }),
      ).toThrow(/EACCES/);
      expect(sleeps).toEqual([]); // retry せず即 fail-loud (timeout を消費しない)
      expect(existsSync(lockPath)).toBe(true); // 読めない lock は消さない
      chmodSync(lockPath, 0o600); // afterEach の掃除用
    },
    5_000,
  );

  it.skipIf(runningAsRoot)(
    "保持中に自分の lock が読めなくなっても (dev,ino) 同一性で解放できる (回復する・root では skip)",
    () => {
      const ret = withFileLock(target, () => {
        chmodSync(lockPath, 0o000); // critical section 中に読めなくなる
        return "ok";
      });
      expect(ret).toBe("ok");
      // 解放は statSync ベースの identity 判定なので読み権限を要さない → 外れる。
      expect(existsSync(lockPath)).toBe(false);
      // 回復の直接証拠: 次の取得が (手動除去なしで) 通る。
      expect(withFileLock(target, () => "again")).toBe("again");
      expect(existsSync(lockPath)).toBe(false);
      // 退避名の残骸も残さない。
      expect(readdirSync(dir).filter((n) => n.includes(".stale-"))).toEqual([]);
    },
    5_000,
  );

  it.skipIf(runningAsRoot)(
    "読めない lock でも他者の inode は解放で消さない (identity 不一致・root では skip)",
    () => {
      // 自分の lock を保持中に、他者の lock へ**別 inode で**差し替えたうえで読めなくする。
      withFileLock(target, () => {
        swapLockFile(`${process.pid}\n`); // 別 inode・自分の pid を騙る他者の lock
        chmodSync(lockPath, 0o000);
      });
      // 内容 (自 pid) だけを見る旧実装はここで消していた。identity が違うので触らない。
      expect(existsSync(lockPath)).toBe(true);
      chmodSync(lockPath, 0o600); // afterEach の掃除用
    },
    5_000,
  );
});

/**
 * identity v2 (FL-B・SEC-FL-4 ≡ TDA-FL-1 ≡ QA-FL-3): 同一性の粒度が
 * **バイト = pid 粒度**から **`(dev, ino)` = lock インスタンス粒度**へ上がったことを pin する。
 *
 * 逐語バイト比較だけでは「同じバイト列を持つ別 inode」(前保持者が解放して即再取得した /
 * pid が再利用された) を同一とみなして破棄してしまう。ここは *バイトは同じ・inode は別* を
 * 決定的に作って、奪取側 (復元する) と解放側 (触らない) の双方を固定する。
 */
describe("INV-FILELOCK-STALE-TAKEOVER-IDENTITY: (dev,ino) 粒度", () => {
  const DEAD = 999999;

  it("同じバイト列の別 inode へ差し替わったら奪取せず復元して backoff する", () => {
    writeFileSync(lockPath, `${DEAD}\n`);
    const inodes: number[] = [];
    const sleeps: number[] = [];
    let round = 0;
    const ret = withFileLock(target, () => "ok", {
      testHooks: {
        isAlive: (pid) => pid !== DEAD,
        sleep: (ms) => sleeps.push(ms),
        onHolderObserved: () => {
          if (round === 0) {
            // 判定直後・取り外し前に「**逐語バイトは同じだが別 inode**」の lock へ差し替える。
            inodes.push(statSync(lockPath).ino);
            inodes.push(swapLockFile(`${DEAD}\n`)); // 同じバイト列・新しい inode
          } else if (round === 1) {
            // 復元されている = 差し替わった側の inode がそのまま残っている。
            inodes.push(statSync(lockPath).ino);
            unlinkSync(lockPath); // その holder が解放したことにして先へ進ませる
          }
          round += 1;
        },
      },
    });
    expect(ret).toBe("ok");
    // vacuity guard: 差し替えで inode が本当に変わっていた (バイト列は同一)。
    expect(inodes[0]).not.toBe(inodes[1]);
    // 差し替え後の inode が復元されている (バイト比較だけの実装はここで破棄していた)。
    expect(inodes[2]).toBe(inodes[1]);
    expect(sleeps.length).toBeGreaterThanOrEqual(1); // 復元後は backoff
    expect(readdirSync(dir).filter((n) => n.includes(".stale-"))).toEqual([]);
  });

  it("解放時、同じバイト列の別 inode に差し替わっていたら消さない (取り外しにも進まない)", () => {
    // 自分の lock を外し、**自分の pid を持つ別 inode** を置く (= 他者が偶然自 pid を書いた/pid 再利用)。
    let ownIno = 0;
    let foreignIno = 0;
    const detachedPhases: string[] = [];
    withFileLock(
      target,
      () => {
        ownIno = statSync(lockPath).ino;
        foreignIno = swapLockFile(`${process.pid}\n`); // 内容は自分と同一・inode は別
      },
      { testHooks: { onDetached: (phase) => detachedPhases.push(phase) } },
    );
    // identity 判定は **取り外す前** に効く。ここが無いと rename→再検証→復元で結果的に元へ戻るため
    // 「消さない」だけでは一層目が無検証になる (他者の lock を一瞬 lockPath から消す窓も開く)。
    expect(detachedPhases, "release detached a lock that was not ours").toEqual([]);
    expect(ownIno).not.toBe(foreignIno); // vacuity guard
    // 内容 (自 pid) だけを見る旧実装はこれを消していた。identity 不一致なので残る。
    expect(existsSync(lockPath)).toBe(true);
    expect(statSync(lockPath).ino).toBe(foreignIno);
    expect(readFileSync(lockPath, "utf8")).toBe(`${process.pid}\n`);
  });
});

/**
 * SEC-FL-2 (復元失敗 = fail-loud・退避 inode の保全): `renameSync` で取り外してから復元 `linkSync`
 * までの窓を第三者が奪うと復元が EEXIST で失敗する。このとき **critical section へ入らずに throw** し、
 * 取り外した inode は退避名のまま**残す** (victim の lock を破棄しない)。
 *
 * `onDetached` seam が無いとこの分岐は決定的に踏めず、throw を握り潰す変異が SURVIVE していた。
 */
describe("INV-FILELOCK-STALE-TAKEOVER-IDENTITY: 復元失敗は fail-loud + 退避 inode を残す", () => {
  const DEAD = 999999;

  it("奪取: 復元できなければ throw し、取り外した lock を退避名で残す", () => {
    writeFileSync(lockPath, `${DEAD}\n`);
    let ran = false;
    const phases: string[] = [];
    expect(() =>
      withFileLock(
        target,
        () => {
          ran = true;
          return "never";
        },
        {
          testHooks: {
            isAlive: () => false,
            sleep: () => {},
            onHolderObserved: () => {
              // 判定した lock を **in-place で書き換える** (同 inode・別バイト)
              // → 取り外したものが「判定した当の lock」ではなくなる = 復元経路へ入る。
              writeFileSync(lockPath, "1\n");
            },
            onDetached: (phase) => {
              phases.push(phase);
              // 取り外し済みで lockPath は空いている。第三者がここで lock を立てる。
              writeFileSync(lockPath, "2\n");
            },
          },
        },
      ),
    ).toThrow(/restoring the live holder failed \(EEXIST\)/);
    expect(ran).toBe(false); // critical section へは入っていない
    expect(phases).toEqual(["takeover"]);
    // 第三者の lock は無傷。
    expect(readFileSync(lockPath, "utf8")).toBe("2\n");
    // 取り外した inode は退避名で残る (破棄しない)。
    const debris = readdirSync(dir).filter((n) => n.includes(".stale-"));
    expect(debris).toHaveLength(1);
    expect(readFileSync(join(dir, debris[0]!), "utf8")).toBe("1\n");
  });

  it("解放: 取り外したのが他者の lock で復元もできなければ throw する", () => {
    let ownIno = 0;
    expect(() =>
      withFileLock(target, () => "ok", {
        testHooks: {
          onReleaseChecked: () => {
            // 自 lock と判定した直後・取り外す前に、第三者の lock へ差し替える (別 inode)。
            ownIno = statSync(lockPath).ino;
            swapLockFile("1\n");
          },
          onDetached: (phase) => {
            // 取り外した後 (= 他者の lock を外してしまった後) に lockPath を再び埋める
            // → 復元 linkSync が EEXIST で失敗する。
            if (phase === "release") writeFileSync(lockPath, "2\n");
          },
        },
      }),
    ).toThrow(/released .* but the file detached was a different lock/);
    expect(ownIno).toBeGreaterThan(0); // vacuity guard: 自 lock を保持していた
    expect(readFileSync(lockPath, "utf8")).toBe("2\n"); // 後から立った lock は無傷
    const debris = readdirSync(dir).filter((n) => n.includes(".stale-rel-"));
    expect(debris).toHaveLength(1); // 外した他者の inode は残す
    expect(readFileSync(join(dir, debris[0]!), "utf8")).toBe("1\n");
  });

  it("同一プロセスで 2 回復元失敗しても退避パスは distinct で 1 本目が生き残る", () => {
    // QA-FLV2-1: 退避名 `.stale-<pid>-<seq>` の seq が進まないと、2 回目の `renameSync` が
    // 1 本目の退避 (= 生きた holder の inode) を**黙って置換**して破棄する。
    // seq の実値は同一モジュール内の先行テストに依存するので決め打ちせず、
    // 「2 本あり・名前が distinct・中身が両方残っている」で固定する。
    const DEAD_LOCAL = 999999;
    const markers = ["round-1\n", "round-2\n"];
    for (const marker of markers) {
      writeFileSync(lockPath, `${DEAD_LOCAL}\n`);
      expect(() =>
        withFileLock(target, () => "never", {
          testHooks: {
            isAlive: () => false,
            sleep: () => {},
            // 判定した lock を in-place で書き換える (同 inode・別バイト) → 復元経路へ入る。
            onHolderObserved: () => writeFileSync(lockPath, marker),
            // 取り外し済みの窓を第三者が埋める → 復元 linkSync が EEXIST で失敗する。
            onDetached: (phase) => {
              if (phase === "takeover") writeFileSync(lockPath, "occupied\n");
            },
          },
        }),
      ).toThrow(/restoring the live holder failed \(EEXIST\)/);
    }
    const debris = readdirSync(dir)
      .filter((n) => n.includes(".stale-"))
      .sort();
    expect(debris, `debris: ${JSON.stringify(debris)}`).toHaveLength(2);
    expect(new Set(debris).size, "the two detached locks reused one path").toBe(2);
    // 1 本目が 2 本目に潰されていない (両方の中身が残っている)。
    const bodies = debris.map((n) => readFileSync(join(dir, n), "utf8")).sort();
    expect(bodies).toEqual([...markers].sort());
    // inode も distinct (同じ inode を 2 つの名前で数えていない)。
    const inos = debris.map((n) => statSync(join(dir, n)).ino);
    expect(new Set(inos).size).toBe(2);
  });

  it("解放: 取り外したのが他者の lock でも復元できれば throw しない (相手を消さない)", () => {
    // `onReleaseChecked` の窓で他者の lock へ差し替える → 解放の rename が他者の lock を外す。
    // ただし lockPath は空いたままなので復元 linkSync は成功する = 静かに元へ戻す。
    let ownIno = 0;
    let foreignIno = 0;
    const ret = withFileLock(target, () => "ok", {
      testHooks: {
        onReleaseChecked: () => {
          ownIno = statSync(lockPath).ino;
          foreignIno = swapLockFile("1\n");
        },
      },
    });
    expect(ret).toBe("ok");
    expect(ownIno).not.toBe(foreignIno); // vacuity guard
    // 他者の lock は逐語で・同じ inode のまま復元されている。
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toBe("1\n");
    expect(statSync(lockPath).ino).toBe(foreignIno);
    // 退避名の残骸は残さない (復元経路の掃除)。
    expect(readdirSync(dir).filter((n) => n.includes(".stale-"))).toEqual([]);
  });

  it("fn が throw した場合は解放の失敗より fn のエラーを優先する", () => {
    expect(() =>
      withFileLock(
        target,
        () => {
          throw new Error("boom");
        },
        {
          testHooks: {
            onReleaseChecked: () => {
              swapLockFile("1\n");
            },
            onDetached: (phase) => {
              if (phase === "release") writeFileSync(lockPath, "2\n");
            },
          },
        },
      ),
    ).toThrow("boom"); // 解放側の fail-loud で覆い隠さない
    // POSITIVE 対 (TDA-FLV2-6): 「fn のエラーが出た」だけでは、解放が**そもそも走らなかった**
    // 場合と区別できない。解放が実際に取り外し → 復元失敗まで進んだ痕跡を固定する。
    expect(readFileSync(lockPath, "utf8"), "the third party lock was not left in place").toBe(
      "2\n",
    );
    expect(
      readdirSync(dir).filter((n) => n.includes(".stale-rel-")),
      "release never detached anything: the swallowed failure was not exercised",
    ).toHaveLength(1);
  });
});

/**
 * TDA-FL-2 ≡ SEC-FL-7 (注入 seam の本番到達性): `testHooks` は **test モードでしか受理しない**。
 * 本番モードで渡すと throw する = 「本番が誤って seam を渡すと CI 信号ゼロで stale 判定・backoff が
 * 無言で無効化される」を、綴り走査ではなく**実行可能なゲート**で塞ぐ。
 *
 * POSITIVE / NEGATIVE の対で置く (片側だけだと恒真化に気づけない)。
 */
describe("INV-ATTACH-WIRE-LOCK: testHooks は test モード限定 (本番では throw)", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = { NODE_ENV: process.env.NODE_ENV, VITEST: process.env.VITEST };
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("POSITIVE: 本番モードで testHooks を渡すと throw し、lock も作らない", () => {
    process.env.NODE_ENV = "production";
    delete process.env.VITEST;
    let ran = false;
    expect(() =>
      withFileLock(
        target,
        () => {
          ran = true;
          return "never";
        },
        { testHooks: { isAlive: () => false, sleep: () => {} } },
      ),
    ).toThrow(/testHooks were passed outside of a test run/);
    expect(ran).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
  });

  it("NEGATIVE(対): 本番モードでも testHooks 無しなら通常どおり動く", () => {
    process.env.NODE_ENV = "production";
    delete process.env.VITEST;
    expect(withFileLock(target, () => "ok")).toBe("ok");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("NEGATIVE(対): test モードでは testHooks を honor する", () => {
    process.env.NODE_ENV = "test";
    delete process.env.VITEST;
    const sleeps: number[] = [];
    writeFileSync(lockPath, "999999\n");
    expect(
      withFileLock(target, () => "ok", {
        testHooks: { isAlive: () => false, sleep: (ms) => sleeps.push(ms) },
      }),
    ).toBe("ok");
    expect(sleeps).toEqual([]); // 奪取したので backoff なし = seam が効いている
  });
});

describe("INV-ATTACH-WIRE-LOCK: fail-loud", () => {
  it("throws when a live holder never releases within maxRetries", () => {
    writeFileSync(lockPath, "12345\n"); // 別の生存 pid が保持
    let slept = 0;
    expect(() =>
      withFileLock(target, () => "never", {
        maxRetries: 3,
        testHooks: {
          isAlive: () => true,
          sleep: () => {
            slept += 1;
          },
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
    const detachedPhases: string[] = [];
    withFileLock(
      target,
      () => {
        writeFileSync(lockPath, `${otherLivePid}\n`);
      },
      { testHooks: { onDetached: (phase) => detachedPhases.push(phase) } },
    );
    // 自 inode でも「内容が他者」なら取り外しへ進まない (rename の窓を開けない)。
    expect(detachedPhases, "release detached a lock whose content was not ours").toEqual([]);
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

  it("NODE_ENV=production では env の取得遅延を無視する (実経過時間で観測)", () => {
    // 本番モードでは testHooks 自体が拒否される (別 describe で pin) ので、sleep spy ではなく
    // **実経過時間**で観測する。env が honor されると既定 sleep (Atomics.wait) で 30s ブロックし、
    // このテストの timeout でも RED になる。
    process.env[ENV_KEY] = "30000";
    process.env.NODE_ENV = "production";
    delete process.env.VITEST; // test-mode シグナルを外す
    const t0 = performance.now();
    expect(withFileLock(target, () => "ok")).toBe("ok");
    expect(performance.now() - t0).toBeLessThan(3_000); // 本番では取得遅延を注入しない
  }, 10_000);

  it("NODE_ENV=test では env の取得遅延を honor する (sleep 呼出)", () => {
    process.env[ENV_KEY] = "7";
    process.env.NODE_ENV = "test";
    delete process.env.VITEST;
    const sleeps: number[] = [];
    withFileLock(target, () => "ok", { testHooks: { sleep: (ms) => sleeps.push(ms) } });
    expect(sleeps).toContain(7); // test モードでは注入される
  });

  it("VITEST シグナルだけでも honor する (NODE_ENV 非 test でも)", () => {
    process.env[ENV_KEY] = "9";
    process.env.NODE_ENV = "production";
    process.env.VITEST = "true";
    const sleeps: number[] = [];
    withFileLock(target, () => "ok", { testHooks: { sleep: (ms) => sleeps.push(ms) } });
    expect(sleeps).toContain(9);
  });

  it("env 値は 60s に clamp される (暴走遅延防止)", () => {
    process.env[ENV_KEY] = "999999999";
    process.env.NODE_ENV = "test";
    delete process.env.VITEST;
    const sleeps: number[] = [];
    withFileLock(target, () => "ok", { testHooks: { sleep: (ms) => sleeps.push(ms) } });
    expect(sleeps).toContain(60_000); // 上限で頭打ち
    expect(Math.max(...sleeps, 0)).toBeLessThanOrEqual(60_000);
  });

  it("非有限な env 値は 0 扱い (遅延なし)", () => {
    process.env[ENV_KEY] = "not-a-number";
    process.env.NODE_ENV = "test";
    delete process.env.VITEST;
    const sleeps: number[] = [];
    withFileLock(target, () => "ok", { testHooks: { sleep: (ms) => sleeps.push(ms) } });
    expect(sleeps).toEqual([]);
  });
});
