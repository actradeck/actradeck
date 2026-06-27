import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve the workspace event-model package to its TS source so tests do not
// require a prior build step (Phase 0). Phase 2 may revisit if build artifacts
// are needed.
export default defineConfig({
  resolve: {
    alias: {
      "@actradeck/event-model": fileURLToPath(
        new URL("../../packages/event-model/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.ts", "test/**/*.{test,spec}.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // cli.ts は exec エントリ (process.argv/exit/PTY 起動) で e2e 担保。index.ts は re-export。
      exclude: ["src/cli.ts", "src/index.ts", "src/**/*.{test,spec}.ts"],
      reporter: ["text", "json-summary"],
      // QA-3: testing.md 目標を CI 強制 (閾値割れで exit≠0)。コアは include 全体で底上げ。
      thresholds: {
        statements: 80,
        branches: 70,
        functions: 85,
        lines: 80,
        // コア領域 (redaction / sink / store / approval-bridge) は高め。
        "src/redactor.ts": { statements: 90, branches: 80, functions: 95, lines: 90 },
        // 4#QA-1: redaction choke point の branch ゲートは testing.md 契約 (branch>70) を
        //   下回らせない。実測 72.72% で 70 をクリア (3#QA-3 の 50 緩和を撤回)。
        "src/sink.ts": { statements: 95, branches: 70, functions: 100, lines: 95 },
        "src/store.ts": { statements: 90, branches: 70, functions: 95, lines: 90 },
        "src/approval-bridge.ts": { statements: 90, branches: 85, functions: 95, lines: 90 },
        // 再監査#4 QA-1: 承認ゲート HTTP 経路 (handleApprovalGate の defer/deny/allow 応答 +
        //   解決イベント発行) を貫通する round-trip テストで被覆する。handleApprovalGate の
        //   無検証退行 (特に 227-238 の defer 応答) を CI で赤にするため per-file branch>=70 を
        //   固定する (testing.md 契約 >70 を下限。実測 81.08% で十分なマージン)。
        "src/hook-receiver.ts": { statements: 80, branches: 70, functions: 85, lines: 80 },
        // 再#3 QA-4 / 再監査#4 QA-2: 承認分類器 (classifyCommandRisk) の本体。新規の破壊オプション
        //   分岐 / runner ラッパ / SEC-1 インラインコード判定が**無検証のまま増える**のを防ぐため
        //   per-file 閾値を実測直下でタイトに固定する。SEC-1 + QA-2 のテスト追加で branch 実測が
        //   72.94% → 76.31% へ上昇したため、新実測直下へ引き上げる (緩めすぎ禁止: 未検証
        //   destructive 分岐の追加で閾値割れ → CI exit≠0)。再監査#4 round2 の一般化ルール
        //   (D サブシェル/メタ文字 / E prefix ビルトイン / F source procsub) + 赤テストで branch
        //   実測が 76.88% → 79.26% へ上昇したため新実測直下の 79 へ。閾値は決して下げない。
        "src/normalize.ts": { statements: 85, branches: 79, functions: 95, lines: 90 },
      },
    },
  },
});
