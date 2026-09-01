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
        // test-db-guard.ts (production-DB 接続拒否の security gate・SEC-2/裁定 019fcd5f QA-2) =
        //   小ファイル tripwire。純同期関数で決定的・INV-TEST-DB-GUARD が worst 100/100/100/100 まで
        //   網羅 → floor 95/90/90/95 は worst の下 (per-file-coverage-floor-below-worst-not-best・
        //   erosion tripwire)。PGPORT/境界分岐のテスト削除が global 集約に吸収されるのを防ぐ。
        "src/test-db-guard.ts": { statements: 95, branches: 90, functions: 90, lines: 95 },
        // test-strip-comments.ts (tripwire 走査正規化の単一出所・task 01a059a7-173c) = 小ファイル
        //   tripwire。INV-STRIP-COMMENTS が被覆軸 / 残余 / corpus / 単一出所を挙動で網羅し
        //   3 regime の worst-observed は 96.55/97.77/100/97.27 (実装時 / QA レーン 97.41/98.88/100/97.27 /
        //   R2 後 98.03/98.29/100/97.90) → floor はその **3-5pt 下**
        //   (per-file-coverage-floor-below-worst-not-best・erosion tripwire であって target ではない。
        //   QA-CSX-4: 旧 92/92/95/92 は branch で 5.8pt 空いており規律より広かった)。regex skip /
        //   補間追跡 / 改行 resync / fail-closed 2 種 / 空白除去のどれかが未到達になると trip する。
        "src/test-strip-comments.ts": { statements: 93, branches: 93, functions: 95, lines: 93 },
        // state.ts (T1 状態機械 + ADR 0014 直交軸マップ/helper・コア領域) = 小ファイル tripwire。
        //   純同期関数/写像で決定的。inv-terminal-axes + inv-event-transition が worst 100/100/100/100
        //   まで網羅 → floor 95/90/90/95 は worst の下 (per-file-coverage-floor-below-worst-not-best・
        //   erosion tripwire)。continuation/terminal_evidence/failure 判定の何かが未到達になると trip
        //   (QA-2: 以前 floor 無しで func57%/branch66% の silent erosion を許していた回帰防止)。
        "src/state.ts": { statements: 95, branches: 90, functions: 90, lines: 95 },
        // work-item.ts (ADR 0015 work-item 契約 + deriveWorkItemId/treeFingerprint・T1 正典) = 小ファイル
        //   tripwire。純同期関数で決定的・INV-WORKITEM-ID が id 決定性/NO-RAW/fingerprint 縮退/enum
        //   closedness を worst 100/100/100/100 まで網羅 → floor 95/90/90/95 は worst の下 (QA-3・decision
        //   019fc622・per-file-coverage-floor-below-worst-not-best・erosion tripwire)。
        "src/work-item.ts": { statements: 95, branches: 90, functions: 90, lines: 95 },
        // hash.ts (ADR 0015 isomorphic 同期 SHA-256・自前実装) = 小ファイル tripwire。NIST 既知応答
        //   ベクタ + UTF-8 マルチバイト/surrogate/lone-surrogate 分岐を worst 100/100/100/100 まで固定
        //   → floor 95/90/90/95 (QA-3)。誤エンコード/未到達分岐が入ると trip する (id サイレント破壊防止)。
        "src/hash.ts": { statements: 95, branches: 90, functions: 90, lines: 95 },
        // approval-request-id.ts (redaction-stable 採番の T1 単一出所・TDA-R4-12) = 小ファイル
        //   tripwire。INV-APPROVAL-REQUEST-ID (shape/決定論) が worst 100/100/100/100 まで網羅
        //   → floor 95/90/90/95 (per-file-coverage-floor-below-worst-not-best・erosion tripwire)。
        "src/approval-request-id.ts": { statements: 95, branches: 90, functions: 90, lines: 95 },
        // approval-reconcile-wire.ts (hello 宣言の cap/検証・fail-safe 境界・TDA-R4-12) = 同上。
        //   INV-APPROVAL-RECONCILE-WIRE が worst 100/100/100/100 まで網羅 → floor 95/90/90/95。
        "src/approval-reconcile-wire.ts": {
          statements: 95,
          branches: 90,
          functions: 90,
          lines: 95,
        },
        // observability-counters-wire.ts (縮退カウンタの NO-RAW 射影 / 非負整数ゲート / sum fold・
        //   TDA-V9-7) = 同上。INV-OBSERVABILITY-COUNTERS-WIRE が worst 100/100/100/100 まで網羅
        //   → floor 95/90/90/95 (per-file-coverage-floor-below-worst-not-best・erosion tripwire)。
        //   負数/非整数ゲートの分岐が未到達になると trip する (endpoint を「負の観測」で汚す回帰の防止)。
        "src/observability-counters-wire.ts": {
          statements: 95,
          branches: 90,
          functions: 90,
          lines: 95,
        },
      },
    },
  },
});
