/**
 * INV-COVERAGE-CONFIG-KEYS (R2 QA-R2-1): event-model の vitest coverage config を構造的に固定する。
 * packages/redaction の同名 meta-test と対称 (QA targeted 再監査で非対称が指摘された)。
 *
 * QA 注入の 2 死角を回帰固定する:
 *  (A) per-file threshold key (`"src/provider.ts"`) は文字列であり、provider.ts の rename/分割で
 *      key が実ファイルを指さなくなると、その per-file floor は **silent に dormant 化** する
 *      (vitest は存在しない key に対応する coverage が無いので trip しない)。
 *  (B) `thresholds` ブロック自体を rename/削除すると `test:coverage` が **exit 0 で silent pass**
 *      になる (floor が丸ごと消える)。→ ブロック不在を fail-loud に throw して検出する。
 *
 * falsifiability (R2 報告に添付):
 *  - 幻 key (`src/__ghost__.ts`) を thresholds に足す → 本テスト RED。
 *  - `thresholds` ブロックを rename/削除 → getThresholds() throw で本テスト RED。
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import vitestConfig from "../vitest.config.js";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** グローバル metric key (per-file でない)。これらは file 解決の対象外。 */
const GLOBAL_METRIC_KEYS = new Set([
  "statements",
  "branches",
  "functions",
  "lines",
  "perFile",
  "autoUpdate",
  "100",
]);

/** defineConfig の戻りから thresholds オブジェクトを取り出す (型は緩く辿る)。
 *  ブロック不在 (rename/削除) は fail-loud に throw する — QA 注入 B の「silent pass」を固定。 */
function getThresholds(): Record<string, unknown> {
  const cfg = vitestConfig as unknown as {
    test?: { coverage?: { thresholds?: Record<string, unknown> } };
  };
  const thresholds = cfg.test?.coverage?.thresholds;
  if (!thresholds || typeof thresholds !== "object") {
    throw new Error(
      "event-model vitest.config: test.coverage.thresholds が見つからない " +
        "(ブロック rename/削除は coverage floor を silent に消す — QA-R2-1)",
    );
  }
  return thresholds;
}

describe("INV-COVERAGE-CONFIG-KEYS: event-model per-file coverage floor が実ファイルを指す", () => {
  it("thresholds ブロックが存在し per-file key を含む (不在なら throw=RED・注入 B)", () => {
    const thresholds = getThresholds();
    const fileKeys = Object.keys(thresholds).filter((k) => !GLOBAL_METRIC_KEYS.has(k));
    // provider.ts (D1 の本体) の per-file floor が最低限ある。
    expect(fileKeys.length).toBeGreaterThanOrEqual(1);
  });

  it("すべての per-file threshold key が実在する src ファイルへ解決される (dead floor 検知・注入 A)", () => {
    const thresholds = getThresholds();
    const fileKeys = Object.keys(thresholds).filter((k) => !GLOBAL_METRIC_KEYS.has(k));
    const missing = fileKeys.filter((k) => !existsSync(resolve(PKG_ROOT, k)));
    expect(missing, `実在しない per-file coverage key (dead floor): ${missing.join(", ")}`).toEqual(
      [],
    );
  });

  it("per-file key はファイル形 (src/ 配下・glob 展開でなく単一ファイル前提)", () => {
    const thresholds = getThresholds();
    const fileKeys = Object.keys(thresholds).filter((k) => !GLOBAL_METRIC_KEYS.has(k));
    for (const k of fileKeys) {
      expect(k.startsWith("src/"), `per-file key は src/ 配下であるべき: ${k}`).toBe(true);
      // glob (`*`) は fs 存在確認が効かないので、per-file floor は具体ファイルで張る契約。
      expect(k.includes("*"), `per-file key に glob を使わない (存在確認が効かない): ${k}`).toBe(
        false,
      );
    }
  });
});
