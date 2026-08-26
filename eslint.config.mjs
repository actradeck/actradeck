// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    // 製品コードのみを lint 対象にする (.claude フック / docs は対象外)。
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/*.config.*",
      ".claude/**",
      "**/*.cjs",
      "**/*.mjs",
      // docs/examples scope (QA-R3-2): the shipped adapter **source** `docs/examples/**/adapter.js`
      //   IS lint-checked (it is a `.js` file · commit 7476ceb brought it under the standard glob),
      //   so its loader-safety / no-undef discipline is machine-enforced. The accompanying
      //   `README.md` and `.jsonl` fixtures are **docs artifacts** and are NOT covered by eslint
      //   (eslint targets `.js`/`.ts`) nor by the prettier/format glob — intentional, not an
      //   oversight. Do not add a new gate for them; the contract test + SEC-1 fixture regression
      //   guard the fixture instead.
      // oss/ は retire 済み旧 mirror pipeline の再生成成果物 (.gitignore 済・canonical cutover
      //   以後は生成されない)。dist/.next と同じ生成物カテゴリなので lint 対象外 (ignore は
      //   歴史的 checkout に残る生成物対策として無害なので残す)。
      "oss/**",
      // oss-landing/ は landing 公開物の再生成成果物 (.gitignore 済・overlay の prepare-landing
      //   が source の landing/ から再生成)。source の landing/ を直接 lint すれば足り、
      //   oss-landing/app.js の二重 lint (browser globals no-undef) は gate を不整合化する。
      "oss-landing/**",
      // .oss-sync/ は landing-sync が website repo を clone し ./oss-landing を rsync する
      //   作業ツリー (.gitignore 済)。oss-landing/ と同じ生成物カテゴリで、browser globals
      //   override (files: ["landing/**/*.js"]) の外にある .oss-sync/*/app.js を二重 lint
      //   すると no-undef で gate が不整合化する。source を直接 lint すれば足りる。
      ".oss-sync/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // TDA-CQ7-5 (CQ-R7 監査 M): 承認分類器の複雑度 erosion tripwire。
    //   `splitSegments` は 6 ラウンドで 6 行/cyclo 5 → 317 行/cyclo 95 まで育ち、シェル文法の
    //   手書き複製が 22 サイト → 82 サイトへ増えた。これが 6 ラウンド連続 H 再発の機構的原因と
    //   3 レーンが独立に診断している。単一出所化は v0.8 の統合 ADR で行うが、それまでの間
    //   **現天井を超えたら CI が赤くなる**状態にしておく (無いと次のラウンドでさらに育つ)。
    //   閾値は現状を通す値。統合 ADR の実施に合わせて段階的に下げること。
    // **sidecar の src 全体に掛ける (R10 M・v0.8 part 3)**: 以前は normalize.ts 単体だったため、
    //   関数やファイルを 2 つに割るだけで peak 天井を抜けられた。全ファイルに同じ天井を掛け、
    //   さらに「分類器モジュール集合の合計」は test 側の metatest
    //   (inv-approval.test.ts `INV-APPROVAL-R10-M` の total-size ceiling) が固定する — 分割先を
    //   集合へ足すには単一出所 map の更新が要り、合計の天井は残る。
    files: ["apps/sidecar/src/**/*.ts"],
    rules: {
      // 閾値は**実測 worst の直上**に置く。「今より育ったら赤」であって「今すぐ直せ」ではない。
      //   以後 ratchet down する。
      //
      // 実測 (eslint 自身のルールを閾値 1 で走らせて採取・v0.8 part 3 時点・src/** 全体):
      //   complexity              worst 112 (normalizeHook)   次点 52 (normalizeResponseItem)
      //   max-lines-per-function  worst 434 (normalizeHook)   次点 426 (startManagedCodex)
      //   max-depth               worst 6                     ← part 3 で 8→7 へ ratchet
      //   max-lines (file)        worst 1916 (normalize.ts)   次点 660 (normalize-codex-rollout.ts)
      //   TDA-CQ9-7 (R9 監査 L) の訂正: 以前ここに書いていた「splitSegments が cyclo 95 / nest 8」は
      //   再現しない値だった (eslint の complexity は入れ子アロー関数を別関数として数えるため)。
      //   記録は実測コマンドで再現できる値だけにする。
      complexity: ["error", 113],
      "max-depth": ["error", 7],
      "max-lines-per-function": ["error", { max: 435, skipComments: true, skipBlankLines: true }],
      // ファイル総量も ratchet する (TDA-CQ9-7)。**正直な記録**: R9 時点の実行行 1839 に対し、
      //   v0.8 統合 (part 1〜3) は 1916 へ**増えた** — 語の読み方を単一出所へ畳む代わりに
      //   literal の組み立て (quotedSpanLiteral / ANSI-C 表) と R10 の H/M 修正が乗ったため。
      //   統合の成果は「手書き複製の除去」であって行数削減ではない。天井は metatest の合計天井と
      //   同じ 1920 に置いた (part 3)。
      //   R11 unblock (decision 01a03b69) で 1916 → 1951: EOF 終端 heredoc (H1)・予約語 opt-out (H2)・
      //   正準導出鎖 `programTokens` (M6)・置換平坦化 (M1)・egress 長さガード (M2) の実修正分。
      //   この per-file 天井は `normalizeHook` (cyclo 112 / 434 行) に引きずられ分類器に対しては
      //   inert (TDA-CQ11-2) — 分類器の合計は test 側 metatest (import 閉包の合計天井) が固定し、
      //   `normalizeHook` の分離 + 分類器専用天井は v0.9 task。ここは実測直上に置き、以後は下げるだけ。
      "max-lines": ["error", { max: 1955, skipComments: true, skipBlankLines: true }],
    },
  },
  {
    // SEC-1 / TDA-2 / SEC-4: token-isolation 境界。ブラウザグラフ (webui の UI / app と
    //   realtime の **bff.ts を除く全モジュール**) は server 専用 bff.ts (REALTIME_TOKEN 保持) と
    //   backend value import を **禁止**する。
    //   SEC-4 (再監査 a547b9f2): client.ts だけでなく client.ts の transitive 依存
    //   (backoff / parse-frame / list-reducer / contract) も browser バンドルに載るため、
    //   realtime/** 全体を対象にする (将来これらが bff/backend を value-import しても CI 赤化)。
    //   bff.ts のみ server-only として除外 (token 保持・backend へ接続する正規の relay)。
    //   違反は build 前に CI lint で赤化する (散文コメントでなく機械強制)。
    //   型のみ import (contract.ts の re-export 等) は allowTypeImports で許可。
    files: [
      "apps/webui/src/ui/**/*.{ts,tsx}",
      "apps/webui/src/realtime/**/*.{ts,tsx}",
      "apps/webui/app/**/*.{ts,tsx}",
    ],
    ignores: ["apps/webui/src/realtime/bff.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@actradeck/backend",
              message:
                "browser graph must not value-import backend (server-side; pulls fastify/pg and risks token leak). Use src/realtime/contract.ts type-only re-exports.",
              allowTypeImports: true,
            },
          ],
          patterns: [
            {
              group: ["**/realtime/bff", "**/realtime/bff.js", "**/bff", "**/bff.js"],
              message:
                "bff.ts is server-only (holds REALTIME_TOKEN). Do not import it from the browser graph — wire it only in the custom server.",
              allowTypeImports: true,
            },
          ],
        },
      ],
    },
  },
  {
    // landing/ はマーケティングサイトの素のブラウザ JS (バンドラなし)。browser グローバルを
    //   宣言して no-undef を解消する (実行環境はコードでなく lint 設定でしか表現できない)。
    files: ["landing/**/*.js"],
    languageOptions: {
      globals: {
        window: "readonly",
        document: "readonly",
        localStorage: "readonly",
        navigator: "readonly",
        matchMedia: "readonly",
        requestAnimationFrame: "readonly",
        cancelAnimationFrame: "readonly",
        IntersectionObserver: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        console: "readonly",
        fetch: "readonly",
      },
    },
  },
  prettier,
);
