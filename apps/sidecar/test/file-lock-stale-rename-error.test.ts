/**
 * INV-ATTACH-WIRE-LOCK: 奪取の `renameSync` が **ENOENT 以外**で失敗したら rethrow する
 * (QA-FL-2 / TDA-FL-3(1)・file-lock.ts:199 の被覆)。
 *
 * `ENOENT` だけが「他者が先に取り外した = 何も壊していない」であり即再試行してよい。それ以外の
 * error を `gone` 扱いに緩めると、取り外せていないのに取り外せたつもりで retry を回すことになる。
 *
 * 決定的に踏む方法: 奪取の退避名 `<lockPath>.stale-<pid>-<seq>` を先回りで**非空ディレクトリ**として
 * 占有しておくと `renameSync(file, dir)` が `EISDIR` になる。
 *
 * FL-L7 (QA-FL-R2-1): `staleSeq` は module 単位のカウンタなので、単一の seq を決め打ちすると
 * 「同ファイルに奪取を伴うテストをもう 1 本足しただけで RED」になる。よって seq を 1 つに賭けず
 * **先頭 {@link OCCUPIED_SEQ_COUNT} 個をまとめて占有**し、どの seq が使われても EISDIR になるようにする
 * (この本数を超える奪取が先行したときだけ決め打ちが外れる = その場合も loud に落ちる)。
 *
 * mutation: 非 ENOENT を `gone` として返すよう緩めると、2 回目の奪取が `.stale-<pid>-1` へ成功して
 * lock を取得してしまい throw しない = 本テストが赤くなる。
 *
 * 🔴 すべて os.tmpdir() 配下。実設定不可侵。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { withFileLock } from "../src/file-lock.js";
import { cleanupTempDirs, makeTempDir } from "./helpers/lock-test-support.js";

let dir: string;
let target: string;
let lockPath: string;

beforeEach(() => {
  // FL-L9: 失敗した run でも残骸を残さないよう、作った temp dir は共有ハーネスが追跡する。
  dir = makeTempDir("actradeck-filelock-rename-");
  target = join(dir, "target.json");
  lockPath = `${target}.actradeck-lock`; // 本番既定の lock 名
});
afterEach(cleanupTempDirs);

/** 先回り占有する `staleSeq` の個数 (seq 決め打ちをやめるための余裕・FL-L7)。 */
const OCCUPIED_SEQ_COUNT = 10;

describe("INV-ATTACH-WIRE-LOCK: stale 取り外しの rename 失敗", () => {
  it("rename が ENOENT 以外 (EISDIR) で失敗したら rethrow し、lock を壊さない", () => {
    const DEAD = 999999;
    writeFileSync(lockPath, `${DEAD}\n`);

    // 奪取が使いうる退避名を先頭からまとめて非空ディレクトリで占有する (どの seq でも EISDIR)。
    const occupied: string[] = [];
    for (let seq = 0; seq < OCCUPIED_SEQ_COUNT; seq++) {
      const stalePath = `${lockPath}.stale-${process.pid}-${seq}`;
      mkdirSync(stalePath);
      writeFileSync(join(stalePath, "occupied"), "x");
      occupied.push(basename(stalePath));
    }

    expect(() =>
      withFileLock(target, () => "never", {
        testHooks: {
          isAlive: () => false, // DEAD を死亡扱い = 奪取経路へ入る
          sleep: () => {},
        },
      }),
    ).toThrow(/EISDIR/);

    // 取り外せていない = seed した lock は逐語で残る (誤って消していない)。
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, "utf8")).toBe(`${DEAD}\n`);
    // tmp (`.acquire`) 残骸なし・新しい `.stale-*` も作られていない (占有した分だけ)。
    const names = readdirSync(dir);
    expect(names.filter((n) => n.endsWith(".acquire"))).toEqual([]);
    expect(names.filter((n) => n.includes(".stale-")).sort()).toEqual([...occupied].sort());
  });
});
