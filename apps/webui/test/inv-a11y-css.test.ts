/**
 * INV-A11Y-FOCUS-VISIBLE / INV-A11Y-TARGET-SIZE（設計裁定 019ea263 D5）。
 *
 * globals.scss のソースを静的検査し、フォーカス可視（2px・--ad-focus）と最小ターゲット 24px
 * （--ad-size-target-min）が宣言されていることを赤線化する。outline を無条件 none で潰す退行も禁止。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const globals = readFileSync(
  fileURLToPath(new URL("../app/globals.scss", import.meta.url)),
  "utf8",
);

describe("INV-A11Y-FOCUS-VISIBLE", () => {
  it(":focus-visible で 2px・--ad-focus の outline を宣言する", () => {
    expect(globals).toContain(":focus-visible");
    expect(globals).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--ad-focus\)/);
  });

  it("outline を無条件 none で潰さない（focus 退行の禁止）", () => {
    // 単独の `outline: none;`（:focus-visible 等の代替提示なし）を禁止。
    expect(globals).not.toMatch(/outline:\s*none/);
  });
});

describe("INV-A11Y-TARGET-SIZE", () => {
  it(".ad-btn / .ad-icon-btn が min-height 24px(--ad-size-target-min) を宣言", () => {
    expect(globals).toMatch(/\.ad-btn\s*\{[^}]*min-height:\s*var\(--ad-size-target-min\)/);
    expect(globals).toMatch(/\.ad-icon-btn\s*\{[^}]*min-height:\s*var\(--ad-size-target-min\)/);
  });

  it(".ad-icon-btn は min-width も 24px（正方形ターゲット）", () => {
    expect(globals).toMatch(/\.ad-icon-btn\s*\{[^}]*min-width:\s*var\(--ad-size-target-min\)/);
  });

  it("range のつまみが 24px（操作可能サイズ）", () => {
    expect(globals).toMatch(/slider-thumb\s*\{[^}]*height:\s*var\(--ad-size-target-min\)/);
  });
});
