import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      reporter: ["text", "json-summary"],
      // QA-7 (2026-08-13 監査): NO-RAW closed schema の唯一の出所ゆえ erosion tripwire を張る
      // (閾値なしの test:coverage は「あるのに効かない」dormant gate だった)。
      // 実測 (2026-08-13 local): 100/100/100/100。floor は worst-observed の 5pt 下。
      thresholds: { statements: 95, branches: 95, functions: 95, lines: 95 },
    },
  },
});
