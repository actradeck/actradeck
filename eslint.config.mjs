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
