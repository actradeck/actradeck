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
      "@actradeck/redaction": fileURLToPath(
        new URL("../../packages/redaction/src/index.ts", import.meta.url),
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
        // コア領域 (sink / store / approval-bridge) は高め。redactor.ts は
        //   @actradeck/redaction (packages/redaction) へ移設済で、当該 package の vitest が
        //   per-file floor (redactor.ts 89/85/95/94・redact-for-persist.ts 95/90/90/95 + global
        //   89/85/95/94) を強制する (ADR 019f2d2c D3・R1 recalibrated)。CI では専用
        //   `pnpm --filter @actradeck/redaction run test:coverage` step が実効化する (R1 QA-1)。
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
        // P4#QA-2 (ADR 019f2421): codex-runner.ts は R1/R2/R4/R5 の transport/lifecycle hardening を
        //   担う一次表面 (handshake timeout / stream-error 封じ込め / exit-drain / stop-state)。ここに
        //   per-file 閾値が無いと lifecycle ロジックの被覆が silent に erode しうる。
        // FLAKE 修正 (fix/codex-coverage-floor・2026-07-03): 旧 floor { stmts82 / br70 / fn80 / lines83 } は
        //   BEST 実測直下に置かれており CI で flaky に割れた (CI fn=74.5% < 80 で verify RED)。原因は
        //   function coverage が環境間で大きく振れること: uncovered な 9〜13 関数はすべて runCodexSession
        //   closure 内の **timing/flow 依存コールバック** (ProcessMonitor 間隔タイマ発火の heartbeat 群
        //   onSample→emitHeartbeat→emitMonitoring 匿名 = 3 fn ≈ 6pt / fault handler onParseError・onWriteError /
        //   approval Response 送出時のみ通る sendResponse / stderr on-data / 置換前 resolveExit 初期値)。
        //   real-bin e2e 専用ではなく (SKIP=1 でも到達可)、aggregate 実行のタイミングでどれが踏まれるかが
        //   揺れる (monitor 間隔 vs test 終了・approval flow 順序)。
        //   観測レンジ (CI regime = ACTRADECK_SKIP_REAL_BIN_E2E=1・全 metric): stmts 82.07〜85.84 /
        //   branch 71.77〜73.68 / func 74.5〜88.23 (~13.7pt swing) / lines 83.51〜87.23。real-bin e2e を
        //   走らせると (SKIP 無し) さらに上振れる (audit 実測 func 88.23)。
        //   よって WORST-observed (CI 値・stmts 82.07 / br 71.77 / fn 74.5 / lines 83.51) の 3〜5pt 下に
        //   conservative に固定し測定分散を吸収する。floor は依然 meaningful (lifecycle 被覆の実 erosion は
        //   ここを大きく下回る) だが flaky ではない。never-lower discipline は「BEST でなく WORST の下」に
        //   置いてこそ成立する (今回の教訓)。
        "src/codex-runner.ts": { statements: 78, branches: 68, functions: 70, lines: 79 },
        // QA-1 (file-lock 空ファイル窓修正・R1): withFileLock は approval allowlist / policy 永続 /
        //   attach settings の直列化を担う security-adjacent primitive。per-file floor が無いと取得
        //   ロジックの被覆が silent に erode しうる。file-lock.ts は完全同期・非決定 async 無しゆえ
        //   coverage は環境間で安定 (実測 3/3 run 同値 92.45/93.47/100/97.95)。floor は監査時 worst
        //   90.19/87.5/100/97.87 の下 3-5pt (per-file-coverage-floor-below-worst-not-best・funcs は
        //   100 観測の小ファイルゆえ 95・erosion tripwire であって target ではない)。
        "src/file-lock.ts": { statements: 86, branches: 83, functions: 95, lines: 93 },
        // QA-3 / TDA-7 (ADR 019f4206 A段・裁定 019f4244 unblock): codex-spawn-manager.ts は cockpit-relayed
        //   Codex spawn の cap / cwd 二段封じ込め / 値ベース deny / lifecycle を担う security-adjacent 一次表面。
        //   per-file floor が無いと deny/封じ込め分岐の被覆が silent に erode しうる。coverage は fake-seam
        //   ロジックで完全決定論 (4/4 run・SKIP=1/no-SKIP 両 regime で同値 stmts 89.09 / br 84.37 / fn 87.5 /
        //   lines 88.23・分散 0)。floor は WORST 実測の 3〜5pt 下に固定 (erosion tripwire であって target でない・
        //   per-file-coverage-floor-below-worst-not-best)。fn は少関数ゆえ coarse (1 関数脱落で ~12pt 降下)
        //   だが margin 内で実 erosion を捕捉する。
        "src/codex-spawn-manager.ts": { statements: 85, branches: 80, functions: 82, lines: 84 },
      },
    },
  },
});
