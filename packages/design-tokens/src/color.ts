/**
 * WCAG 2.2 コントラスト計算（純関数）。
 *
 * 出所: WCAG 2.2 1.4.3 / 1.4.11 / 2.4.13。sRGB hex から相対輝度 (relative luminance) を求め、
 * 2 色のコントラスト比 (L1+0.05)/(L2+0.05) を返す。INV-A11Y-CONTRAST（packages/design-tokens の
 * トークン値ペアが AA を満たすことの赤テスト）が axe/jsdom では検出不能なコントラストを赤線化する。
 */

/** `#rgb` / `#rrggbb` を [r,g,b]（0..255）へ。不正は例外（トークン値の打鍵ミスを早期検出）。 */
export function parseHex(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`invalid hex color: ${JSON.stringify(hex)}`);
  const h = m[1]!;
  const full = h.length === 3 ? h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]! : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

/** sRGB チャンネル (0..255) → 線形値 (0..1)。WCAG の定義式。 */
function channelToLinear(c8: number): number {
  const c = c8 / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** 相対輝度 (0..1)。WCAG: 0.2126 R + 0.7152 G + 0.0722 B（線形化後）。 */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * channelToLinear(r) + 0.7152 * channelToLinear(g) + 0.0722 * channelToLinear(b);
}

/** 2 色のコントラスト比（1..21）。順序非依存。 */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}
