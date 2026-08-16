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
    files: ["apps/sidecar/src/normalize.ts"],
    rules: {
      // 閾値は**実測 worst の直上**に置く。「今より育ったら赤」であって「今すぐ直せ」ではない
      //   — リファクタ自体は v0.8 の統合 ADR の仕事。以後 ratchet down する。
      //
      // 実測 (eslint 自身のルールを閾値 1 で走らせて採取・R9 時点):
      //   complexity              worst 112 (normalizeHook)   次点 62 (splitSegments)
      //   max-lines-per-function  worst 434 (normalizeHook)   次点 254 (splitSegments)
      //   max-depth               worst 7                     ← R9 で 9→8 へ ratchet
      //   max-lines (file)        worst 1839 (skipComments + skipBlankLines)
      //   TDA-CQ9-7 (R9 監査 L) の訂正: 以前ここに書いていた「splitSegments が cyclo 95 / nest 8」は
      //   再現しない値だった (eslint の complexity は入れ子アロー関数を別関数として数えるため)。
      //   記録は実測コマンドで再現できる値だけにする。
      complexity: ["error", 113],
      "max-depth": ["error", 8],
      "max-lines-per-function": ["error", { max: 435, skipComments: true, skipBlankLines: true }],
      // ファイル総量も ratchet する (TDA-CQ9-7)。1 ブランチで 2086 → 3104 行 (実行行 1839) まで
      //   育った。統合 ADR で下げる前提の天井。
      "max-lines": ["error", { max: 1900, skipComments: true, skipBlankLines: true }],
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
