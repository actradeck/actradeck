import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve the workspace event-model package to its TS source so tests do not
// require a prior build step (mirrors sidecar/backend test configs).
export default defineConfig({
  resolve: {
    alias: {
      "@actradeck/event-model": fileURLToPath(
        new URL("../event-model/src/index.ts", import.meta.url),
      ),
      // 自パッケージの barrel を src へ解決し、テストが built dist を要求しないようにする。
      "@actradeck/redaction": fileURLToPath(new URL("./src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.ts", "test/**/*.{test,spec}.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // index.ts は re-export barrel。redactor.ts / redact-for-persist.ts の網羅性をゲートする。
      exclude: ["src/index.ts", "src/**/*.{test,spec}.ts"],
      reporter: ["text", "json-summary"],
      thresholds: {
        // R1 QA-3: global (All files 集約) floor。全 include ファイルの erosion tripwire
        //   (redact-for-persist.ts 等の退行も集約で捕捉)。この閾値ブロックがあることで
        //   `test:coverage` が **実際に赤くなる** (QA-1: 旧 `test` は coverage 非計算で floor が dormant
        //   だった)。worst-observed All files 92.55/89.1/100/97.45 の下
        //   (per-file-coverage-floor-below-worst-not-best・erosion tripwire であり target でない)。
        statements: 89,
        branches: 85,
        functions: 95,
        lines: 94,
        // redactor.ts は最重要 secret 検出面。旧 sidecar 閾値 (90/80/95/90) は sink 統合テストと
        //   同一 coverage run で満たしていたが、emit 経由統合は sidecar へ分離した (ADR 019f2d2c D3)。
        //   R1 TDA-3 で cred-context 分岐 (redactor.ts:1085-1097) の pure package test を追加し worst が
        //   88.12/81.21/95.12/92.67 → 92.44/88.83/100/97.41 へ回復。floor は新 worst の下
        //   (redactor は同期純関数で決定的・環境間の振れは v8/node 差の小)。
        "src/redactor.ts": { statements: 89, branches: 85, functions: 95, lines: 94 },
        // redact-for-persist.ts (共有権威ヘルパ・小ファイル)。worst 100/100/100/100 (helper 単体で全被覆)。
        //   小 N (1 関数) の funcs は 100/0 の二値ゆえ floor 90 は「関数未到達」でのみ trip する tripwire。
        "src/redact-for-persist.ts": { statements: 95, branches: 90, functions: 90, lines: 95 },
      },
    },
  },
});
