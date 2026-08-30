/**
 * INV-ATTACH-WIRE-LOCK: 奪取の `renameSync` が **ENOENT 以外**で失敗したら rethrow する
 * (QA-FL-2 / TDA-FL-3(1)・file-lock.ts:199 の被覆)。
 *
 * `ENOENT` だけが「他者が先に取り外した = 何も壊していない」であり即再試行してよい。それ以外の
 * error を `gone` 扱いに緩めると、取り外せていないのに取り外せたつもりで retry を回すことになる。
 *
 * 決定的に踏む方法: 奪取の退避名 `<lockPath>.stale-<pid>-<seq>` を先回りで**非空ディレクトリ**として
 * 占有しておくと `renameSync(file, dir)` が `EISDIR` になる。`staleSeq` は **module 単位のカウンタで
 * 0 始まり**なので、退避名を決め打ちするには「このモジュールで最初に走る奪取」である必要がある。
 * よって本ファイルは奪取を 1 回だけ行うテストを 1 本だけ持つ (file-lock.test.ts に同居させると
 * 先行テストの奪取で seq が進み、決め打ちが外れる)。
 *
 * mutation: 非 ENOENT を `gone` として返すよう緩めると、2 回目の奪取が `.stale-<pid>-1` へ成功して
 * lock を取得してしまい throw しない = 本テストが赤くなる。
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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { withFileLock } from "../src/file-lock.js";

let dir: string;
let target: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "actradeck-filelock-rename-"));
  target = join(dir, "target.json");
  lockPath = `${target}.actradeck-lock`; // 本番既定の lock 名
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("INV-ATTACH-WIRE-LOCK: stale 取り外しの rename 失敗", () => {
  it("rename が ENOENT 以外 (EISDIR) で失敗したら rethrow し、lock を壊さない", () => {
    const DEAD = 999999;
    writeFileSync(lockPath, `${DEAD}\n`);

    // 最初の奪取が使う退避名 (staleSeq は本モジュールで 0 始まり) を非空ディレクトリで占有する。
    const stalePath = `${lockPath}.stale-${process.pid}-0`;
    mkdirSync(stalePath);
    writeFileSync(join(stalePath, "occupied"), "x");

    expect(() =>
      withFileLock(target, () => "never", {
        isAlive: () => false, // DEAD を死亡扱い = 奪取経路へ入る
        sleep: () => {},
      }),
    ).toThrow(/EISDIR/);

    // 取り外せていない = seed した lock は逐語で残る (誤って消していない)。
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toBe(`${DEAD}\n`);
    // tmp (`.acquire`) 残骸なし・新しい `.stale-*` も作られていない (占有した 1 個だけ)。
    const names = readdirSync(dir);
    expect(names.filter((n) => n.endsWith(".acquire"))).toEqual([]);
    expect(names.filter((n) => n.includes(".stale-"))).toEqual([basename(stalePath)]);
  });
});
