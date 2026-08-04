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
        // decision 019f69ef: Action Rail の attention 導出 (deriveAttention 優先度/dedup・repoBranchLabel の
        //   NO-RAW)。要対応サーフェスを司る純ロジックゆえ gate 対象 (liveness-display と同カテゴリ)。
        "src/ui/action-rail.ts",
        // ADR 019f4cdb 後続 UI: 監査カバレッジの純表示派生 (gap severity 分類 / 相対受信経過)。
        //   React 非依存の純ロジックゆえ gate 対象 (liveness-display と同カテゴリ)。
        "src/ui/audit-coverage-display.ts",
        // QA-1≡TDA-4: 監査カバレッジ pull フックの fail-safe 分岐 (unmount cleanup / !ok・parse=undefined
        //   の last-known 保持 / enabled トグル) を無検証化させないため gate に含める
        //   (use-audit-coverage.test.tsx が jsdom+act で駆動)。per-file floor は新設せず global のみ。
        "src/ui/use-audit-coverage.ts",
        // QA-1: セーフティデモ起動フックの runtime (二度押し抑止 / NO-RAW parse 統合 / error 縮退 /
        //   TDA-2 出現 watchdog) を無検証化させないため gate に含める (safety-demo-hook.test.tsx が駆動)。
        "src/ui/use-safety-demo.ts",
        // ADR 0015 B3 (QA-B3-2): work-items の差別化不変条件を司る純ロジックを floor 保護する。
        //   work-items-fold (client fold == projection reduce の locale 写像・badge 単一出所) /
        //   parse-replay (wire→DTO の NO-RAW carriage 検証) / replay-state (DTO→NormalizedEvent 復元・
        //   fold 入力の payload 再構成) は React 非依存の pure logic ゆえ liveness-display と同カテゴリ。
        "src/ui/work-items-fold.ts",
        "src/replay/parse-replay.ts",
        "src/replay/replay-state.ts",
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
