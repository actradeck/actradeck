import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // event-model は source を直に解決 (dist 鮮度に依存させない)。backend は dist 経由
      // (buildIngestionServer は実プロセス起動コードを含むため source alias しない)。
      "@actradeck/event-model": fileURLToPath(
        new URL("../../packages/event-model/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.{ts,tsx}", "test/**/*.{test,spec}.{ts,tsx}"],
    setupFiles: ["./test/setup-env.ts"],
    coverage: {
      provider: "v8",
      // QA-3/TDA-4: testing.md コア相当の純ロジック (transport + 表示派生) のみ gate 化。
      //   React 層 (*.tsx / use-realtime.ts) は別途 component test を Phase4 sweep で整備するまで
      //   対象外 (現状 0% を閾値に含めると意味のない失敗になるため明示除外)。contract.ts は型のみ。
      include: [
        "src/realtime/**",
        "src/ui/liveness-display.ts",
        "src/ui/approval-display.ts",
        "src/ui/wall-display.ts",
        "src/server/**",
      ],
      exclude: ["src/**/*.{test,spec}.{ts,tsx}", "src/realtime/contract.ts"],
      reporter: ["text", "json-summary"],
      // 実測 (2026-06-04): realtime core parse/list-reducer/client/backoff/bff + liveness-display。
      //   branches は testing.md 契約 70 を必ず超える値に実測直下で張る。
      thresholds: {
        statements: 88,
        branches: 75,
        functions: 85,
        lines: 88,
      },
    },
  },
});
