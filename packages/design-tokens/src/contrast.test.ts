/**
 * INV-A11Y-CONTRAST: トークン値ペアが WCAG 2.2 を満たすことの赤テスト。
 *
 * 設計裁定 019ea263 (D5)。axe/jsdom は実レンダリング色を持たずコントラストを検出できないため、
 * DTCG 値ペアの比率をここで計算して赤線化する。
 * - 通常テキスト 4.5:1 / 非テキスト UI 部品（border/focus）3:1（WCAG 1.4.3 / 1.4.11）。
 * - High Contrast テーマはテキスト 7:1 超を要求（AA 超え目標）。
 */
import { describe, expect, it } from "vitest";

import {
  contrastRatio,
  defaultTokensDir,
  loadSources,
  mergedMap,
  resolveLiteral,
  type ThemeName,
} from "./index.js";

const sources = loadSources(defaultTokensDir());

interface Pair {
  readonly fg: string;
  readonly bg: string;
  readonly kind: "text" | "nontext";
}

/** 各テーマで検査するセマンティックペア（fg をその bg / surface 上で読む）。 */
const PAIRS: readonly Pair[] = [
  { fg: "fg.primary", bg: "bg.canvas", kind: "text" },
  { fg: "fg.primary", bg: "bg.surface", kind: "text" },
  { fg: "fg.muted", bg: "bg.canvas", kind: "text" },
  { fg: "fg.muted", bg: "bg.surface", kind: "text" },
  { fg: "fg.on-action", bg: "action.primary.bg", kind: "text" },
  { fg: "fg.on-action", bg: "action.danger.bg", kind: "text" },
  { fg: "status.success.fg", bg: "status.success.bg", kind: "text" },
  { fg: "status.success.fg", bg: "bg.surface", kind: "text" },
  { fg: "status.warn.fg", bg: "status.warn.bg", kind: "text" },
  { fg: "status.warn.fg", bg: "bg.surface", kind: "text" },
  { fg: "status.danger.fg", bg: "status.danger.bg", kind: "text" },
  { fg: "status.danger.fg", bg: "bg.surface", kind: "text" },
  { fg: "status.info.fg", bg: "status.info.bg", kind: "text" },
  { fg: "status.info.fg", bg: "bg.surface", kind: "text" },
  { fg: "border.strong", bg: "bg.surface", kind: "nontext" },
  { fg: "focus", bg: "bg.surface", kind: "nontext" },
];

/** テーマ別の閾値。 */
function threshold(theme: ThemeName, kind: Pair["kind"]): number {
  if (kind === "nontext") return 3;
  return theme === "hc" ? 7 : 4.5;
}

/** theme 名 → 解決済みリテラル取得関数。 */
function resolverFor(theme: ThemeName): (path: string) => string {
  const override =
    theme === "light" ? [] : (sources.themes.find((t) => t.name === theme)?.tokens ?? []);
  const map = mergedMap(sources.base, override);
  return (path) => resolveLiteral(path, map);
}

const THEMES: readonly ThemeName[] = ["light", "dark", "hc"];

describe("INV-A11Y-CONTRAST: 全テーマの semantic ペアが WCAG 2.2 を満たす", () => {
  for (const theme of THEMES) {
    const resolve = resolverFor(theme);
    for (const pair of PAIRS) {
      const min = threshold(theme, pair.kind);
      it(`[${theme}] ${pair.fg} on ${pair.bg} ≥ ${min}:1`, () => {
        const fg = resolve(pair.fg);
        const bg = resolve(pair.bg);
        const ratio = contrastRatio(fg, bg);
        expect(
          ratio,
          `${theme}: ${pair.fg}(${fg}) on ${pair.bg}(${bg}) = ${ratio.toFixed(2)}:1 < ${min}:1`,
        ).toBeGreaterThanOrEqual(min);
      });
    }
  }
});
