/**
 * INV-TOKEN-RESOLVE / INV-THEME-COMPLETENESS + CSS 生成形状の不変条件。
 *
 * 設計裁定 019ea263 (D2/D5)。トークンの整合（alias dangling/cycle 無し・テーマ override が base に存在・
 * 必須 semantic キー網羅）を赤テスト化し、DTCG ファイルのドリフトを CI で止める。
 */
import { describe, expect, it } from "vitest";

import {
  defaultTokensDir,
  generateCss,
  loadSources,
  mergedMap,
  resolveLiteral,
  type FlatToken,
} from "./index.js";

const sources = loadSources(defaultTokensDir());

/** UI が依存する必須 semantic キー（欠落すると kit が壊れる）。 */
const REQUIRED_SEMANTIC = [
  "bg.canvas",
  "bg.surface",
  "bg.layer",
  "bg.selected",
  "fg.primary",
  "fg.muted",
  "fg.on-action",
  "border.subtle",
  "border.strong",
  "focus",
  "action.primary.bg",
  "action.primary.bg-hover",
  "action.danger.bg",
  "status.success.fg",
  "status.success.bg",
  "status.warn.fg",
  "status.warn.bg",
  "status.danger.fg",
  "status.danger.bg",
  "status.info.fg",
  "status.info.bg",
];

function basePaths(): Set<string> {
  return new Set(sources.base.map((t) => t.path));
}

describe("INV-TOKEN-RESOLVE: 全 alias がリテラルまで解決し dangling/cycle 無し", () => {
  it("base (light) の全トークンが解決する", () => {
    const map = mergedMap(sources.base);
    for (const t of sources.base) {
      expect(() => resolveLiteral(t.path, map), `light: ${t.path}`).not.toThrow();
    }
  });

  it("各テーマ override を重ねても全トークンが解決する", () => {
    for (const theme of sources.themes) {
      const map = mergedMap(sources.base, theme.tokens);
      for (const path of map.keys()) {
        expect(() => resolveLiteral(path, map), `${theme.name}: ${path}`).not.toThrow();
      }
    }
  });

  it("色トークンは解決後に #hex リテラルになる", () => {
    const map = mergedMap(sources.base);
    const colorTokens = sources.base.filter((t) => t.type === "color");
    expect(colorTokens.length).toBeGreaterThan(0);
    for (const t of colorTokens) {
      expect(resolveLiteral(t.path, map), t.path).toMatch(/^#[0-9a-f]{3,6}$/i);
    }
  });
});

describe("INV-THEME-COMPLETENESS: base が必須キーを網羅・テーマ override は base に存在", () => {
  it("base が全必須 semantic キーを定義", () => {
    const paths = basePaths();
    for (const key of REQUIRED_SEMANTIC) {
      expect(paths.has(key), `missing required semantic: ${key}`).toBe(true);
    }
  });

  it("各テーマ override の全パスが base に存在（orphan override = タイポ検出）", () => {
    const paths = basePaths();
    for (const theme of sources.themes) {
      for (const t of theme.tokens) {
        expect(paths.has(t.path), `${theme.name} orphan override: ${t.path}`).toBe(true);
      }
    }
  });
});

describe("generateCss: テーマ別ブロックを emit", () => {
  const css = generateCss(sources);

  it(":root と各 data-theme セレクタ・system media を含む", () => {
    expect(css).toContain(":root {");
    expect(css).toContain('[data-theme="dark"]');
    expect(css).toContain('[data-theme="hc"]');
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain("@media (prefers-contrast: more)");
    expect(css).toContain(":root:not([data-theme])");
  });

  it("alias は var(--ad-*) として emit、リテラルはそのまま", () => {
    // semantic の alias は var() 参照（fg.primary は color.neutral.900 を指す）。
    expect(css).toContain("--ad-fg-primary: var(--ad-color-neutral-900);");
    // primitive のリテラルはそのまま。
    expect(css).toContain("--ad-color-neutral-0: #ffffff;");
  });

  it("Reduced Motion で motion duration を 0ms に落とす", () => {
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("--ad-motion-duration-fast: 0ms;");
  });

  it("全 --ad-* 宣言が空値でない", () => {
    const decls = css.match(/--ad-[a-z0-9-]+:\s*([^;]+);/gi) ?? [];
    expect(decls.length).toBeGreaterThan(20);
    for (const d of decls) {
      const value = d.split(":")[1]!.replace(";", "").trim();
      expect(value.length, d).toBeGreaterThan(0);
    }
  });
});

describe("flatten: DTCG ネストを FlatToken[] へ", () => {
  it("$description などグループメタを leaf にしない", () => {
    const all: FlatToken[] = [...sources.base];
    expect(all.some((t) => t.path.includes("$description"))).toBe(false);
    expect(all.every((t) => t.value.length > 0)).toBe(true);
  });
});
