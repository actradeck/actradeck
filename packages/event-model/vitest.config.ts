import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.ts", "test/**/*.{test,spec}.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // index.ts は re-export barrel。provider.ts (slug 開放・ADR 019f2d2c D1) 等の
      //   T1 契約ロジックの網羅性をゲートする。
      exclude: ["src/index.ts", "src/**/*.{test,spec}.ts"],
      reporter: ["text", "json-summary"],
      thresholds: {
        // R1 QA-1: `pnpm run test` (= vitest run) は coverage を計算しないため、D1 で足した
        //   provider slug 判定 (isKnownProvider / PROVIDER_SLUG_RE / Provider schema) の floor が
        //   dormant になる。専用 `test:coverage` gate でこのブロックを実効化する (閾値割れ→exit≠0)。
        //   event-model の src は同期純関数・zod schema で決定的 (環境間の振れは v8/node 差の小)。
        // global (All files 集約) floor = 全 include ファイルの erosion tripwire。
        //   worst-observed 96.88/95.17/93.61/98.61 の下 (per-file-coverage-floor-below-worst-not-best・
        //   erosion tripwire であって target ではない)。
        statements: 92,
        branches: 90,
        functions: 88,
        lines: 94,
        // provider.ts (D1 の本体・小ファイル) = worst 100/100/100/100 の「100-or-trip」tripwire
        //   (redact-for-persist.ts と同型)。小 N ゆえ 1 関数/分岐の脱落で大きく落ちる → floor 95/90/90/95
        //   は「slug 判定の何かが未到達になった」ときにのみ trip する。
        "src/provider.ts": { statements: 95, branches: 90, functions: 90, lines: 95 },
        // contract-doc.ts (契約 docs 抽出・PR-2 QA-3/TDA-1 で単一出所化) = 小ファイル tripwire。
        //   worst 100/90/100/100 (branch 90 は extractDocEventTypes の `?? []` fallback が未到達)。
        //   floor は worst の下 3-5pt (per-file-coverage-floor-below-worst-not-best・erosion tripwire)。
        "src/contract-doc.ts": { statements: 95, branches: 85, functions: 90, lines: 95 },
        // seq-drop.ts (silent-drop 下限導出 + 密性抑制・QA-2) = 小ファイル tripwire。純同期関数で決定的・
        //   INV-SEQ-DROP が全境界を網羅する worst 100/100/100/100 → floor 95/90/90/95 は worst の下
        //   (per-file-coverage-floor-below-worst-not-best・erosion tripwire であって target ではない)。
        "src/seq-drop.ts": { statements: 95, branches: 90, functions: 90, lines: 95 },
      },
    },
  },
});
