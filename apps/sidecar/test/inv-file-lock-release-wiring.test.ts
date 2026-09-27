/**
 * INV-FILELOCK-IDENTITY-V2: 解放路の所有判定の**結線** (SEC-FLD-1 ≡ TDA-FLD-1・task 01a05a63)。
 *
 * `file-lock.test.ts` の表駆動 describe は純関数 `isOwnLockForRelease` の**中身**を固定するが、
 * 解放路 (`ownsLockForRelease`) が「実際に読取りで起きた errno をそのまま判定へ渡す」ことは固定しない。
 * call site で errno を写し替える / 条件を 1 つ足す変異 (例: EISDIR を EACCES へ写してから判定する) は
 * 表駆動 describe を素通りし、inode 番号の再利用に依存する実 fs の EISDIR it が走った run でしか
 * 落ちなかった (tmpfs では常に skip・ext4 でも run ごとに skip しうる: 監査 R1 実測)。
 *
 * ここでは `node:fs` の `openSync` を **lockPath に対してだけ**指定 errno で失敗させる。`statSync` は
 * 本物のままなので `(dev, ino)` は実際に自 inode と一致し、解放は「identity 一致 + 読めない」枝へ
 * **決定的に**入る。本番コードに seam を足さずに、実 call site の結線をどの fs でも固定する。
 *
 * - EISDIR / 一過性 (EMFILE / ENFILE / EIO) → **触らない** (lock は自 pid のまま残り、取り外しにも進まない)。
 * - EACCES / EPERM → identity を信じて**解放する** (POSITIVE 対: 注入が効いていれば残る側と区別される)。
 *
 * 🔴 すべて os.tmpdir() 配下。実設定不可侵。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const inject = vi.hoisted(() => ({
  path: null as string | null,
  code: null as string | null,
  hits: 0,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const openSync = ((p: unknown, ...rest: unknown[]) => {
    if (inject.path !== null && p === inject.path) {
      inject.hits += 1;
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

let target: string;
let lockPath: string;

beforeEach(() => {
  const dir = makeTempDir("actradeck-filelock-wiring-");
  target = join(dir, "target.json");
  lockPath = `${target}.actradeck-lock`; // 本番既定の lock 名
  inject.path = null;
  inject.code = null;
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
    expect(casesExecuted).toBe(CASES.length);
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
});
