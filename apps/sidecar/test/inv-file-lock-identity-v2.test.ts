/**
 * INV-FILELOCK-IDENTITY-V2: `withFileLock` の同一性は **`(dev, ino)` = lock インスタンス粒度**で
 * あって、逐語バイト = pid 粒度ではない。
 *
 * 根因 (v1): 奪取の再検証は「取り外したファイルの**逐語バイト**が判定時に読んだものと一致するか」
 * だった。lock の内容は常に `${pid}\n` なので、これは実質 **pid 粒度**であり、
 * 「同じ pid が鋳造した別の lock」を区別できない (SEC-FL-4 ≡ TDA-FL-1 ≡ QA-FL-3)。
 * 前保持者が **解放して即座に再取得**すると、判定した lock (旧 inode) と取り外した lock
 * (新 inode) はバイト列が同一なので、v1 は**生きた lock を破棄**して二重保持になる。
 *
 * 修正 (v2): 取得時に自分の inode の `(dev, ino)` を保持し、奪取の再検証を
 * 「`(dev, ino)` 一致 **かつ** 逐語バイト一致」の連言にした (バイト比較は軸として残す)。
 * 別 inode なら復元して backoff する。
 *
 * さらに SEC-FL-2: 取り外し (`rename`) から復元 (`linkSync`) までの窓を第三者に奪われると復元が
 * EEXIST で失敗する。このとき奪取側は critical section へ入らず **fail-loud** し、取り外した
 * **victim の inode は退避名のまま残す** (v1 は finally で unlink して破棄していた)。
 *
 * 残余 (開示・本テストでは assert しない): 復元に失敗した場合、evicted された生きた holder (victim)
 * と第三者 (sniper) は重なりうる。奪取側が二重保持者にならないことと、victim の inode を破棄しない
 * ことがここで保証する範囲。ADR 0012 Concurrency 節を参照。
 *
 * 検証方法: **実プロセス (distinct pid) 4 役** (victim / taker / sniper / observer)。
 * 順序は sleep でなくファイル sentinel + `testHooks` seam で決定的に作る。スレッドでは検証できない
 * (stale 判定が `holder === process.pid` を「自分の残骸」として奪うため同一 pid では偽陽性)。
 *
 * 🔴 すべて os.tmpdir() 配下。実 ~/.actradeck / 実 settings 不可侵。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  cleanupTempDirs,
  makeTempDir,
  spawnWorker,
  spawnWorkerWithFdLimit,
  waitForFile,
  workerScript,
} from "./helpers/lock-test-support.js";

const workerPath = workerScript("file-lock-identity-worker.mts");

afterEach(cleanupTempDirs);

const SENTINELS = [
  "v-pid",
  "v1-ino",
  "v1-enter",
  "v1-exit",
  "v2-ino",
  "v2-enter",
  "v2-inside",
  "v2-exit",
  "v-done",
  "b-observed",
  "b-observed-ino",
  "b-enter",
  "b-inside",
  "b-exit",
  "b-done",
  "s-ino",
  "s-enter",
  "s-inside",
  "s-exit",
  "s-done",
  "o-enter",
  "o-exit",
  "o-done",
  "violation",
  "u-held-ino",
  "u-foreign-ino",
  "u-reused",
  "u-open-error",
  "u-fds-burned",
  "u-victim-survived",
  "u-victim-body",
  "u-victim-ino",
  "u-done",
  "unreadable-error",
  "victim-error",
  "taker-error",
  "sniper-error",
  "observer-error",
] as const;

type Sentinels = Readonly<Record<string, string | undefined>>;

interface RaceOutcome {
  /** 役名 → exit code。 */
  readonly codes: Readonly<Record<string, number>>;
  readonly sentinels: Sentinels;
  /** lock file の退避残骸 (`.stale-*`) の [名前, 内容, inode]。 */
  readonly debris: readonly (readonly [string, string, number])[];
  readonly lockLeftBehind: boolean;
}

async function runRace(mode: "reacquire" | "restore-fail"): Promise<RaceOutcome> {
  const dir = makeTempDir("actradeck-filelock-identity-");
  const sigDir = join(dir, "sig");
  mkdirSync(sigDir);
  const target = join(dir, "target.json");
  const lockPath = `${target}.actradeck-lock`;
  const base = { SIG_DIR: sigDir, TARGET: target, WAIT_MS: "15000", HOLD_MS: "600" };

  const victim = spawnWorker(workerPath, { ...base, ROLE: "victim" });
  // victim が critical section に入り自 pid を公示するまで待つ (taker がそれを読む)。
  const ready =
    (await waitForFile(join(sigDir, "v1-inside"), 15_000)) &&
    (await waitForFile(join(sigDir, "v-pid"), 15_000));
  expect(ready, "victim never entered the critical section").toBe(true);

  const roles: Record<string, Promise<number>> = {
    victim,
    taker: spawnWorker(workerPath, { ...base, ROLE: "taker", MODE: mode }),
    observer: spawnWorker(workerPath, { ...base, ROLE: "observer" }),
  };
  if (mode === "restore-fail") {
    roles.sniper = spawnWorker(workerPath, { ...base, ROLE: "sniper" });
  }
  const names = Object.keys(roles);
  const settled = await Promise.all(names.map((n) => roles[n]!));
  const codes: Record<string, number> = {};
  names.forEach((n, i) => (codes[n] = settled[i]!));

  const sentinels: Record<string, string | undefined> = {};
  for (const name of SENTINELS) {
    const p = join(sigDir, name);
    sentinels[name] = existsSync(p) ? readFileSync(p, "utf8") : undefined;
  }
  const debris = readdirSync(dir)
    .filter((n) => n.includes(".stale-"))
    .map((n) => [n, readFileSync(join(dir, n), "utf8"), statSync(join(dir, n)).ino] as const);
  return { codes, sentinels, debris, lockLeftBehind: existsSync(lockPath) };
}

/** [enter, exit] 区間が重なっていないこと (= 同時に 2 プロセスが保持していない)。 */
function overlaps(a: readonly [number, number], b: readonly [number, number]): boolean {
  return !(a[1] <= b[0] || b[1] <= a[0]);
}

function interval(s: Sentinels, role: string): [number, number] {
  const enter = s[`${role}-enter`];
  const exit = s[`${role}-exit`];
  expect(enter, `${role}: never entered the critical section`).toBeDefined();
  expect(exit, `${role}: never left the critical section`).toBeDefined();
  return [Number(enter), Number(exit)];
}

describe("INV-FILELOCK-IDENTITY-V2: 奪取の同一性は (dev,ino) 粒度", () => {
  it("解放直後に同一 pid が再取得した lock (同じバイト列・別 inode) を奪取しない", async () => {
    const o = await runRace("reacquire");
    const s = o.sentinels;

    // vacuity guard 1: taker は victim の **一度目の** lock を観測していた。
    expect(s["b-observed"]?.trim(), "taker did not observe the victim's pid").toBe(
      s["v-pid"]?.trim(),
    );
    expect(s["b-observed-ino"]?.trim(), "taker observed a different inode than lock #1").toBe(
      s["v1-ino"]?.trim(),
    );
    // vacuity guard 2: 再取得で inode が実際に変わった (バイト列は同一のまま)。
    expect(s["v2-ino"], "victim never re-acquired").toBeDefined();
    expect(
      s["v2-ino"]?.trim(),
      "re-acquire reused the same inode: the race does not exercise (dev,ino)",
    ).not.toBe(s["v1-ino"]?.trim());

    // 全員 正常終了 (fail-loud も含めて 0 で揃う)。
    expect(o.codes, `errors: ${JSON.stringify(s)}`).toEqual({
      victim: 0,
      taker: 0,
      observer: 0,
    });

    // 保持区間が pairwise に重ならない (= 二重保持ゼロ)。v1 は「B が観測した後に解放」なので
    // v2 と B、v2 と O、B と O を見る。
    const v2 = interval(s, "v2");
    const b = interval(s, "b");
    const o2 = interval(s, "o");
    expect(overlaps(v2, b), `victim(#2) and taker overlapped: ${v2} / ${b}`).toBe(false);
    expect(overlaps(v2, o2), `victim(#2) and observer overlapped: ${v2} / ${o2}`).toBe(false);
    expect(overlaps(b, o2), `taker and observer overlapped: ${b} / ${o2}`).toBe(false);
    // taker は victim が解放した後にしか入れない。
    expect(b[0], "taker entered before the victim released").toBeGreaterThanOrEqual(v2[1]);

    // taker 自身が critical section 内で観測した二重保持 (直接証拠)。
    expect(s["violation"], "taker observed a double hold").toBeUndefined();
    // 解放漏れ・退避残骸なし。
    expect(o.lockLeftBehind).toBe(false);
    expect(o.debris).toEqual([]);
  }, 180_000);

  it("取り外し窓を奪われて復元できないときは fail-loud し、取り外した inode を残す", async () => {
    const o = await runRace("restore-fail");
    const s = o.sentinels;

    // vacuity guard: レースが実際に組めていた。
    expect(s["b-observed-ino"]?.trim()).toBe(s["v1-ino"]?.trim());
    expect(s["v2-ino"]?.trim()).not.toBe(s["v1-ino"]?.trim());
    expect(s["s-inside"], "sniper never took the lock in the detach window").toBeDefined();

    // taker は復元できず fail-loud (exit 3)。critical section へは入っていない。
    expect(o.codes.taker, "taker did not fail loud").toBe(3);
    expect(s["taker-error"], "taker error message").toMatch(
      /restoring the live holder failed \(EEXIST\)/,
    );
    expect(s["taker-error"]).toMatch(/the detached lock is kept at /);
    expect(
      s["b-enter"],
      "taker entered the critical section despite failing to restore",
    ).toBeUndefined();
    expect(s["violation"]).toBeUndefined();

    // 取り外した victim の inode は退避名のまま残る (破棄しない)。
    expect(o.debris, `debris: ${JSON.stringify(o.debris)}`).toHaveLength(1);
    const [, body, ino] = o.debris[0]!;
    expect(body.trim(), "the kept remnant is not the victim's lock").toBe(s["v-pid"]?.trim());
    expect(String(ino), "the kept remnant is a different inode than lock #2").toBe(
      s["v2-ino"]?.trim(),
    );

    // sniper / observer / victim は正常終了し、sniper と observer は重ならない。
    expect(o.codes.victim).toBe(0);
    expect(o.codes.sniper).toBe(0);
    expect(o.codes.observer).toBe(0);
    const sn = interval(s, "s");
    const ob = interval(s, "o");
    expect(overlaps(sn, ob), `sniper and observer overlapped: ${sn} / ${ob}`).toBe(false);
    // victim の解放は他者 (sniper) の lock を消さない → observer が正当に取得できた。
    expect(o.lockLeftBehind).toBe(false);
  }, 180_000);
});

/**
 * SEC-FLV2-1 (H): 解放側の「内容が読めないなら identity を信じる」枝は **permission クラス**
 * (`EACCES` / `EPERM`) の読取り不能に限る。`EISDIR` は自 lock を記述しえないため R2-1 で除いた。
 *
 * 根因: この枝が **すべての** 読取り失敗を受けていると、fd 枯渇 (`EMFILE`) や I/O 障害のような
 * **一過性**の失敗でも content 軸 (= 内容が別 pid なら触らない) を捨てることになる。inode 番号は
 * OS が再利用するため、「自分が保持していた inode 番号を他者の生きた lock が占めている」状態で
 * 内容が読めないと、identity だけを信じて **他者の生きた lock を消す**。
 *
 * 検証: 実プロセス (distinct pid) を `ulimit -n` を絞って起動し、critical section の中で
 * (a) 自分の lock を消して **同じ inode 番号**の「他者 (pid 1 = init・生存) の lock」を作り、
 * (b) 残りの fd を焼き尽くす。`stat` / `rename` / `link` / `unlink` は fd を要さず成功するので、
 * 解放側で失敗するのは `openSync` だけ = `EMFILE`。
 *
 * **fs 前提 (QA-FLV2-R2-1)**: (a) は「解放された inode 番号を直後の作成が再利用する」ことに依存する
 * (**ext4 で実測**・`os.tmpdir()` が既定の `/tmp` を指す前提)。**tmpfs は再利用しない**ため、
 * `TMPDIR=/dev/shm` で走らせるとレースが組めず、その場合は緑にならず
 * 「the inode number was not reused: the race is vacuous」で **loud に落ちる** (実測)。
 * 前提が崩れたことを緑で見逃さないための設計であって、tmpfs 対応の欠落ではない。
 *
 * POSITIVE 対 (クラス境界の反対側): 「保持中に自分の lock が読めなくなっても (dev,ino) 同一性で
 * 解放できる」(file-lock.test.ts の EACCES describe) が **permission クラスなら外す**ことを固定する。
 * 本テストは **permission クラスでなければ外さない**ことを固定し、2 本で errno クラス境界を挟む。
 *
 * 🔴 すべて os.tmpdir() 配下。実 ~/.actradeck / 実 settings 不可侵。
 */
describe("INV-FILELOCK-IDENTITY-V2: 一過性の読取り不能 (EMFILE) では他者の lock を消さない", () => {
  it("fd 枯渇で内容が読めなくても、inode 番号を再利用した他者の生きた lock を解放で消さない", async () => {
    const dir = makeTempDir("actradeck-filelock-unreadable-");
    const sigDir = join(dir, "sig");
    mkdirSync(sigDir);
    const target = join(dir, "target.json");
    const lockPath = `${target}.actradeck-lock`;
    const FOREIGN_PID = "1"; // init: 常に生存 = 「他者の生きた lock」

    const code = await spawnWorkerWithFdLimit(
      workerScript("file-lock-identity-worker.mts"),
      {
        SIG_DIR: sigDir,
        TARGET: target,
        WAIT_MS: "15000",
        ROLE: "unreadable",
        FOREIGN_PID,
      },
      256,
    );

    const s: Record<string, string | undefined> = {};
    for (const name of SENTINELS) {
      const p = join(sigDir, name);
      s[name] = existsSync(p) ? readFileSync(p, "utf8") : undefined;
    }
    expect(code, `worker aborted; error: ${s["unreadable-error"]}`).toBe(0);
    expect(s["u-done"], "worker never finished").toBeDefined();

    // vacuity guard 1: 解放側の読取りが本当に **permission でない** errno で失敗した。
    expect(s["u-open-error"]?.trim(), "fd exhaustion did not produce EMFILE").toBe("EMFILE");
    expect(Number(s["u-fds-burned"] ?? "0")).toBeGreaterThan(0);
    // vacuity guard 2: 他者の lock が本当に **自分が保持していた inode 番号** を占めた
    // (再利用できていなければ identity 一致の窓が無く、テストは何も検査していない)。
    expect(s["u-reused"]?.trim(), "the inode number was not reused: the race is vacuous").toBe(
      "true",
    );
    expect(s["u-foreign-ino"]?.trim()).toBe(s["u-held-ino"]?.trim());

    // 本題: 他者の生きた lock は消えていない (blanket catch だとここで消える)。
    expect(s["u-victim-survived"]?.trim(), "the foreign live lock was destroyed").toBe("true");
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf8").trim()).toBe(FOREIGN_PID);
    expect(s["u-victim-ino"]?.trim()).toBe(s["u-held-ino"]?.trim());
    // 取り外しにも進んでいない (退避残骸ゼロ)。
    expect(readdirSync(dir).filter((n) => n.includes(".stale"))).toEqual([]);
  }, 180_000);
});
