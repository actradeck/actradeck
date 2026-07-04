/**
 * INV-COVERAGE-CONFIG-KEYS (R2 QA-L1): vitest coverage の per-file threshold key が
 * **実在する src ファイルへ解決される**ことを構造的に固定する。
 *
 * 背景: coverage thresholds の per-file key (`"src/redactor.ts"` 等) は文字列であり、
 * redactor.ts の rename/分割で key が実ファイルを指さなくなると、その per-file floor は
 * **silent に dormant 化** する (vitest は存在しない key に対応する coverage が無いので trip しない)。
 * この meta-test は config を import して per-file key を列挙し、fs 上の実在を assert することで
 * floor の dead 化を回帰固定する。
 *
 * falsifiability: 架空 key (`src/__ghost__.ts`) を thresholds に足すと本テストが RED になる
 * (注入実証は R2 報告に添付)。
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

/** defineConfig の戻りから thresholds オブジェクトを取り出す (型は緩く辿る)。 */
function getThresholds(): Record<string, unknown> {
  const cfg = vitestConfig as unknown as {
    test?: { coverage?: { thresholds?: Record<string, unknown> } };
  };
  const thresholds = cfg.test?.coverage?.thresholds;
  if (!thresholds || typeof thresholds !== "object") {
    throw new Error("redaction vitest.config: test.coverage.thresholds が見つからない");
  }
  return thresholds;
}

describe("INV-COVERAGE-CONFIG-KEYS: redaction per-file coverage floor が実ファイルを指す", () => {
  it("thresholds ブロックが存在し per-file key を含む", () => {
    const thresholds = getThresholds();
    const fileKeys = Object.keys(thresholds).filter((k) => !GLOBAL_METRIC_KEYS.has(k));
    // redactor.ts / redact-for-persist.ts の 2 つの per-file floor が最低限ある。
    expect(fileKeys.length).toBeGreaterThanOrEqual(2);
  });

  it("すべての per-file threshold key が実在する src ファイルへ解決される (dead floor 検知)", () => {
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
