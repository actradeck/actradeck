/**
 * INV-TRIPWIRE-COVERAGE (3c TDA-1・構造 metatest・DB 不要):
 * backend の **全** real-DB suite (`describe.skipIf(!reachable)`) が CI silent-skip tripwire
 * (scripts/ci/assert-inv-ran.mjs の SUITES.backend.pattern) に被覆されていることを固定する。
 *
 * 再発クラスの根絶: 新しい real-PG INV suite を追加したのに tripwire へ登録し忘れると、その
 * suite だけ「DATABASE_URL 未到達で silent skip しても CI が緑」= 偽 green になる。この登録漏れは
 * 3a QA-3/TDA-4・3b-1 QA-1・3c TDA-1 と **4 度再発**した (毎フェーズの人手レビュー依存が原因)。
 * 本テストは登録を構造的に強制する: 未登録 suite の追加はこのテストを RED にする。
 *
 * 非空虚ガード: describe.skipIf の記法が変わって抽出が 0/激減した場合も RED にする
 * (抽出 regex の rot で「全被覆」が空虚に成立するのを防ぐ)。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// gate script の単一出所 SUITES を直接 import する (CLI 実行は entrypoint guard で走らない)。
import { SUITES } from "../../../scripts/ci/assert-inv-ran.mjs";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

/** backend test ディレクトリの全 *.test.ts から skipIf(!reachable) suite 名を抽出する。 */
function collectRealDbSuiteTitles(): { file: string; title: string }[] {
  const out: { file: string; title: string }[] = [];
  for (const name of fs.readdirSync(TEST_DIR)) {
    if (!name.endsWith(".test.ts")) continue;
    const src = fs.readFileSync(path.join(TEST_DIR, name), "utf8");
    // describe.skipIf(!reachable)( の直後の文字列リテラル (改行整形にも耐える)。
    const re = /describe\.skipIf\(!reachable\)\(\s*"([^"]+)"/gs;
    for (let m = re.exec(src); m !== null; m = re.exec(src)) {
      out.push({ file: name, title: m[1]! });
    }
  }
  return out;
}

describe("INV-TRIPWIRE-COVERAGE: real-DB suite は全て assert-inv-ran の backend pattern に被覆", () => {
  const suites = collectRealDbSuiteTitles();
  const pattern = new RegExp(SUITES.backend.pattern);

  it("抽出が非空虚 (記法変更で抽出 regex が腐ったら RED)", () => {
    // 2026-08 時点で 30 suite。下限は余裕を持たせつつ激減を検知する。
    expect(suites.length).toBeGreaterThanOrEqual(25);
    // 本ファイルが依存する代表 suite が実在する (sanity)。
    expect(suites.map((s) => s.title)).toContain("INV-LINEAGE-DTO (real Postgres)");
  });

  it("全 suite title が SUITES.backend.pattern にマッチする (未登録 suite の追加で RED)", () => {
    const uncovered = suites.filter((s) => !pattern.test(s.title));
    expect(
      uncovered,
      `tripwire 未登録の real-DB suite があります。scripts/ci/assert-inv-ran.mjs の ` +
        `SUITES.backend.pattern へ追加してください: ` +
        uncovered.map((s) => `[${s.file}] "${s.title}"`).join(" / "),
    ).toEqual([]);
  });
});
