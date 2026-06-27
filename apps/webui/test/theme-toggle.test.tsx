/**
 * ThemeToggle の a11y/ネイティブ契約（設計裁定 019ea263 D3/D5）。
 *
 * 静的描画（react-dom/server）で:
 *  - ネイティブ `<select>`（INV-A11Y-SELECT-NATIVE: combobox 自作への退行禁止）。
 *  - aria-label と非表示 `<label>` でラベル提供（4.1.2）。
 *  - 4 テーマ option を列挙、既定は system。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ThemeProvider } from "../src/ui/ThemeProvider.js";
import { ThemeToggle } from "../src/ui/ThemeToggle.js";

function render(): string {
  return renderToStaticMarkup(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>,
  );
}

describe("ThemeToggle", () => {
  it("ネイティブ select で描画される（INV-A11Y-SELECT-NATIVE）", () => {
    const html = render();
    expect(html).toContain("<select");
    expect(html).not.toContain('role="combobox"');
  });

  it("aria-label と非表示 label でラベル付け", () => {
    const html = render();
    expect(html).toMatch(/aria-label="テーマ"/);
    expect(html).toContain("ad-visually-hidden");
    expect(html).toContain("テーマ");
  });

  it("system/light/dark/hc の 4 option を持ち、既定は system", () => {
    const html = render();
    for (const label of ["システム", "ライト", "ダーク", "ハイコントラスト"]) {
      expect(html).toContain(label);
    }
    // 既定選択は system。
    expect(html).toMatch(/value="system"[^>]*selected|selected[^>]*value="system"/);
  });
});
