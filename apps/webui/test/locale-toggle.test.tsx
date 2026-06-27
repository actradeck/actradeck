/**
 * LocaleToggle の a11y/ネイティブ契約 + LocaleProvider 既定 (設計裁定 019eb745)。
 *
 * 静的描画 (react-dom/server) で:
 *  - ネイティブ `<select>` (ThemeToggle と同型: combobox 自作への退行禁止)。
 *  - aria-label と非表示 `<label>` でラベル提供 (4.1.2)。
 *  - 日本語 / English の 2 option、既定 (Provider 無し = Context default) は ja。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LocaleProvider, useLocale } from "../src/ui/LocaleProvider.js";
import { LocaleToggle } from "../src/ui/LocaleToggle.js";

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(node);
}

describe("LocaleToggle", () => {
  it("renders a native select (no self-built combobox)", () => {
    const html = render(<LocaleToggle />);
    expect(html).toContain("<select");
    expect(html).not.toContain('role="combobox"');
  });

  it("has aria-label and visually-hidden label (default ja: 言語)", () => {
    const html = render(<LocaleToggle />);
    expect(html).toMatch(/aria-label="言語"/);
    expect(html).toContain("ad-visually-hidden");
  });

  it("offers 日本語 / English options, default ja selected", () => {
    const html = render(<LocaleToggle />);
    expect(html).toContain("日本語");
    expect(html).toContain("English");
    expect(html).toMatch(/value="ja"[^>]*selected|selected[^>]*value="ja"/);
  });

  it("inside a Provider still defaults to ja before effects run (SSR-safe)", () => {
    const html = render(
      <LocaleProvider>
        <LocaleToggle />
      </LocaleProvider>,
    );
    expect(html).toContain("日本語");
    expect(html).toMatch(/value="ja"[^>]*selected|selected[^>]*value="ja"/);
  });
});

/** Context default が ja で機能する (Provider 無しでも t() が ja を返す) ことを固定する。 */
function ProbeLabel() {
  const { locale, t } = useLocale();
  return (
    <span data-locale={locale}>
      {t("approval.allow")}|{t("risk.files", { count: 2 })}
    </span>
  );
}

describe("useLocale default (no Provider)", () => {
  it("returns ja and a working t()", () => {
    const html = render(<ProbeLabel />);
    expect(html).toContain('data-locale="ja"');
    expect(html).toContain("許可");
    expect(html).toContain("変更ファイル: 2");
  });
});
