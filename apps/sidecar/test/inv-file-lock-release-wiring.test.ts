/**
 * INV-FILELOCK-IDENTITY-V2: 解放路の所有判定の**結線** (SEC-FLD-1 ≡ TDA-FLD-1・task 01a05a63)。
 *
 * `file-lock.test.ts` の表駆動 describe は純関数 `isOwnLockForRelease` の**中身**を固定するが、
 * 解放路 (`ownsLockForRelease`) が「実際に読取りで起きた errno をそのまま判定へ渡す」ことは固定しない。
 * call site で errno を写し替える / 条件を 1 つ足す変異 (例: EISDIR を EACCES へ写してから判定する) は
 * 表駆動 describe を素通りし、inode 番号の再利用に依存する実 fs の EISDIR it が走った run でしか
 * 落ちなかった (tmpfs では常に skip・ext4 でも run ごとに skip しうる: 監査 R1 実測)。
 *
 * ここでは `node:fs` の `openSync` を **lockPath に対してだけ**差し替える。`statSync` は本物のままなので
 * `(dev, ino)` は実際に自 inode と一致し、解放は「identity 一致 + 読めない」枝へ**決定的に**入る。
 * 本番コードに seam は足さない。差し替えは 2 形:
 *
 * 1. **open 段への合成 errno** (`code` のみを持つ Error): EISDIR / 一過性 (EMFILE / ENFILE / EIO) →
 *    **触らない**、EACCES / EPERM → identity を信じて**解放する** (POSITIVE 対)。
 * 2. **実ディレクトリを開かせる** (SEC-FLD-R2-1): Linux ではディレクトリの `open(O_RDONLY)` は成功し、
 *    EISDIR は `read` 段で kernel が返す (`syscall: "read"`)。本物のディレクトリ fd を返して、この実形の
 *    EISDIR で**触らない**ことを見る。1 だけでは「read 段の EISDIR だけを写し替える」変異が素通りした
 *    (監査 R2 実測・tmpfs)。
 *
 * **被覆の範囲 (本 file header が正・他の docstring / CHANGELOG はここを参照する)**: 上の 7 形について、
 * 解放路の call site が読取り失敗の errno を写し替えずに判定へ渡すことを、inode 番号の再利用に依存せず
 * 固定する。**固定しないもの**: この 7 形以外の errno を写し替える変異 (例: read 段の ENOMEM を EACCES へ・
 * 監査 R2 X3 は両 fs で SURVIVED)、および実 fs で第三者のディレクトリが lockPath に居座る形そのもの
 * (`file-lock.test.ts` の実 fs EISDIR it が前提の揃った run でだけ見る・gate 対象外)。
 *
 * 🔴 すべて os.tmpdir() 配下。実設定不可侵。
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const inject = vi.hoisted(() => ({
  path: null as string | null,
  code: null as string | null,
  // 非 null なら lockPath の open をこの実ディレクトリの open へ差し替える (read 段で実 EISDIR)。
  dir: null as string | null,
  hits: 0,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const openSync = ((p: unknown, ...rest: unknown[]) => {
    // 差し替えるのは「何に差し替えるか」(errno か実ディレクトリ) が指定されているときだけ。指定の無い
    // 注入は本物の open へ素通しし hits も数えない (errno 欠落の合成エラーが「触らない」と判定されて
    // 検査が空振りするのを防ぐ・R2 main ループ変異 W8)。
    if (
      inject.path !== null &&
      p === inject.path &&
      (inject.dir !== null || inject.code !== null)
    ) {
      inject.hits += 1;
      if (inject.dir !== null) {
        return (actual.openSync as (...a: unknown[]) => number)(inject.dir, ...rest);
      }
      const e = new Error(`${String(inject.code)}: injected open failure`) as NodeJS.ErrnoException;
      if (inject.code !== null) e.code = inject.code;
      throw e;
    }
    return (actual.openSync as (...a: unknown[]) => number)(p, ...rest);
  }) as typeof actual.openSync;
  return { ...actual, default: { ...actual, openSync }, openSync };
});

import { withFileLock } from "../src/file-lock.js";
import { cleanupTempDirs, makeTempDir } from "./helpers/lock-test-support.js";

let dir: string;
let target: string;
let lockPath: string;

beforeEach(() => {
  dir = makeTempDir("actradeck-filelock-wiring-");
  target = join(dir, "target.json");
  lockPath = `${target}.actradeck-lock`; // 本番既定の lock 名
  inject.path = null;
  inject.code = null;
  inject.dir = null;
  inject.hits = 0;
});
afterEach(() => {
  inject.path = null;
  cleanupTempDirs();
});

describe("INV-FILELOCK-IDENTITY-V2: 解放路の所有判定の結線 (自 inode の読取り errno を実 call site へ注入)", () => {
  // [errno, 解放するか]。EISDIR は SEC-FLV2-R2-1 の指名ベクタ。
  const CASES: readonly (readonly [string, boolean])[] = [
    ["EISDIR", false],
    ["EMFILE", false],
    ["ENFILE", false],
    ["EIO", false],
    ["EACCES", true],
    ["EPERM", true],
  ];
  let casesExecuted = 0;
  afterAll(() => {
    // 各 case が計測 callback の末尾まで到達したこと (skip / 早期 return を loud にする)。
    expect(casesExecuted).toBe(CASES.length + 1); // + 実ディレクトリ (read 段 EISDIR) の it
  });

  it("表の構成: 触らない側と解放する側の両方を含み、EISDIR を含む", () => {
    expect(CASES.map(([c]) => c)).toContain("EISDIR");
    expect(CASES.some(([, released]) => released)).toBe(true);
    expect(CASES.some(([, released]) => !released)).toBe(true);
    expect(new Set(CASES.map(([c]) => c)).size).toBe(CASES.length);
  });

  for (const [code, released] of CASES) {
    it(`自 inode の読取りが ${code} で失敗 → ${released ? "identity を信じて解放する" : "触らない"}`, () => {
      const phases: string[] = [];
      const ret = withFileLock(
        target,
        () => {
          // critical section の中で注入を仕掛ける (取得側の読取りには効かせない)。
          inject.path = lockPath;
          inject.code = code;
          return "ok";
        },
        { testHooks: { onDetached: (phase) => phases.push(phase) } },
      );
      inject.path = null;

      expect(ret).toBe("ok");
      // 注入が解放の読取りに 1 回だけ当たった (当たっていなければこの it は何も検査していない)。
      expect(inject.hits, "the release never read the lock").toBe(1);
      expect(existsSync(lockPath)).toBe(!released);
      expect(phases).toEqual(released ? ["release"] : []);
      if (!released) expect(readFileSync(lockPath, "utf8")).toBe(`${process.pid}\n`);
      casesExecuted += 1;
    });
  }

  it("自 inode の中身が実ディレクトリとして読める (read 段で kernel が返す EISDIR) → 触らない", () => {
    const realDir = join(dir, "real-directory");
    mkdirSync(realDir);
    writeFileSync(join(realDir, "occupied"), "x");
    let seen: NodeJS.ErrnoException | undefined;
    // 前提の実測: ディレクトリの open は成功し、read が EISDIR を返す (open 段の合成形とは別物)。
    const fd = openSync(realDir, "r");
    try {
      readFileSync(fd, "utf8");
    } catch (err) {
      seen = err as NodeJS.ErrnoException;
    } finally {
      closeSync(fd);
    }
    expect(seen?.code).toBe("EISDIR");
    expect(seen?.syscall).toBe("read");

    const phases: string[] = [];
    const ret = withFileLock(
      target,
      () => {
        inject.path = lockPath;
        inject.dir = realDir;
        return "ok";
      },
      { testHooks: { onDetached: (phase) => phases.push(phase) } },
    );
    inject.path = null;
    inject.dir = null;

    expect(ret).toBe("ok");
    expect(inject.hits, "the release never read the lock").toBe(1);
    expect(existsSync(lockPath), "release took a lock it could only read as a directory").toBe(
      true,
    );
    expect(phases).toEqual([]);
    expect(readFileSync(lockPath, "utf8")).toBe(`${process.pid}\n`);
    casesExecuted += 1;
  });
});
