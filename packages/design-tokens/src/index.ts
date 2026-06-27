/**
 * @actradeck/design-tokens — Adaptive Clarity 2030 デザイントークン（DTCG 2025.10 形式）。
 *
 * - TS API: テーマ名・型・alias 解決・CSS 生成・コントラスト計算（ThemeProvider / テスト用）。
 * - CSS 出力: `@actradeck/design-tokens/tokens.css`（build-tokens.mjs が dist/tokens.css を生成）。
 *   `<html data-theme="light|dark|hc">` と prefers-* に応じて `--ad-*` を切替える。
 */
export {
  THEME_NAMES,
  type ThemeName,
  type FlatToken,
  type TokenSources,
  type ThemeLayer,
  flatten,
  isAlias,
  aliasTarget,
  pathToVar,
  resolveLiteral,
  mergedMap,
  generateCss,
  loadSources,
  defaultTokensDir,
} from "./generate.js";

export { parseHex, relativeLuminance, contrastRatio } from "./color.js";
