import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // index.ts は event-model と異なり **barrel ではなく** state reducer 本体 (applyEvent 等) ゆえ
      //   coverage 対象に含める。テストのみ除外。
      exclude: ["src/**/*.{test,spec}.ts"],
      reporter: ["text", "json-summary"],
      // QA-2 (ADR 0015・decision 019fc622): `pnpm run test` (= vitest run) は coverage を計算しない
      //   ため、work-items fold (ADR 0015) の網羅性 floor が dormant になる。専用 `test:coverage` gate で
      //   このブロックを実効化する (閾値割れ→exit≠0)。projection の src は同期純関数で決定的
      //   (increment==reduce parity・環境間の振れは v8/node 差の小)。
      thresholds: {
        // global (All files 集約) floor = 全 include ファイルの erosion tripwire。
        //   worst-observed 92.63/89.17/95.74/98.63 の下 4-5pt (per-file-coverage-floor-below-worst-not-best・
        //   CI regime のブレを見込む erosion tripwire であって target ではない)。
        statements: 88,
        branches: 83,
        functions: 90,
        lines: 93,
        // work-items.ts (ADR 0015 work-items 純 fold・コア領域) = 小ファイル tripwire。純同期 fold で決定的・
        //   INV-WORKITEMS-FOLD (受入 5-15 + TDA-1/QA-1) が worst-observed 93.05/87.21/96.42/98.37 まで網羅。
        //   floor は worst の下 4-5pt (per-file-coverage-floor-below-worst-not-best)。claim/verification/stale/
        //   run_dirty/freeze/reconcile の何かが未到達になると trip する。
        "src/work-items.ts": { statements: 88, branches: 82, functions: 91, lines: 93 },
      },
    },
  },
});
