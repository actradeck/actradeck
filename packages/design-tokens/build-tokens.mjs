/**
 * design-tokens ビルド: src/tokens/*.tokens.json → dist/tokens.css。
 *
 * `tsc -b` の後に実行（dist/generate.js を import）。純ロジック generateCss/loadSources を呼び、
 * テーマ別 CSS custom properties を書き出す。dist は gitignore のため CI は webui build 前に本ステップを通す。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { generateCss, loadSources } from "./dist/generate.js";

const root = dirname(fileURLToPath(import.meta.url));
const sources = loadSources(join(root, "src", "tokens"));
const css = generateCss(sources);

const outDir = join(root, "dist");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "tokens.css"), css, "utf8");

process.stdout.write(`design-tokens: wrote dist/tokens.css (${css.length} bytes)\n`);
