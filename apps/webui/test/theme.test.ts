/**
 * テーマ Platform Adapter 純ロジック検証（設計裁定 019ea263 D3）。
 *
 * DOM 非依存（ElementLike / StorageLike）で applyTheme / readStoredTheme / persistTheme /
 * noFlashScript を node 環境で固定する。system は data-theme を外し、明示テーマは設定する。
 */
import { describe, expect, it } from "vitest";

import {
  applyTheme,
  isThemePref,
  noFlashScript,
  persistTheme,
  readStoredTheme,
  THEME_PREFS,
  THEME_STORAGE_KEY,
  type ElementLike,
  type StorageLike,
} from "../src/ui/theme.js";

function fakeEl(): ElementLike & { attrs: Map<string, string> } {
  const attrs = new Map<string, string>();
  return {
    attrs,
    setAttribute: (k, v) => void attrs.set(k, v),
    removeAttribute: (k) => void attrs.delete(k),
  };
}

function fakeStorage(
  init: Record<string, string> = {},
): StorageLike & { data: Map<string, string> } {
  const data = new Map(Object.entries(init));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
}

describe("applyTheme: data-theme の設定/除去", () => {
  it("system は data-theme を外す（media 追従に委ねる）", () => {
    const el = fakeEl();
    el.setAttribute("data-theme", "dark");
    applyTheme(el, "system");
    expect(el.attrs.has("data-theme")).toBe(false);
  });

  it.each(["light", "dark", "hc"] as const)("%s は data-theme=%s を設定", (pref) => {
    const el = fakeEl();
    applyTheme(el, pref);
    expect(el.attrs.get("data-theme")).toBe(pref);
  });
});

describe("readStoredTheme / persistTheme", () => {
  it("保存値が有効ならそれを返す", () => {
    expect(readStoredTheme(fakeStorage({ [THEME_STORAGE_KEY]: "dark" }))).toBe("dark");
  });

  it("未設定/不正/null storage は system にフォールバック", () => {
    expect(readStoredTheme(fakeStorage())).toBe("system");
    expect(readStoredTheme(fakeStorage({ [THEME_STORAGE_KEY]: "neon" }))).toBe("system");
    expect(readStoredTheme(null)).toBe("system");
  });

  it("getItem が throw しても system（プライベートモード等で落ちない）", () => {
    const hostile: StorageLike = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {},
    };
    expect(readStoredTheme(hostile)).toBe("system");
  });

  it("persistTheme は保存し、失敗は黙殺", () => {
    const s = fakeStorage();
    persistTheme(s, "hc");
    expect(s.data.get(THEME_STORAGE_KEY)).toBe("hc");
    expect(() =>
      persistTheme(
        {
          getItem: () => null,
          setItem: () => {
            throw new Error("quota");
          },
        },
        "dark",
      ),
    ).not.toThrow();
  });
});

describe("isThemePref / noFlashScript", () => {
  it("有効なテーマ名のみ true", () => {
    for (const p of THEME_PREFS) expect(isThemePref(p)).toBe(true);
    expect(isThemePref("system-dark")).toBe(false);
    expect(isThemePref(42)).toBe(false);
  });

  it("no-flash スクリプトは storage キーを読み data-theme を立てる", () => {
    const s = noFlashScript();
    expect(s).toContain(JSON.stringify(THEME_STORAGE_KEY));
    expect(s).toContain("setAttribute('data-theme'");
    // system は除外（明示テーマのみ立てる）。
    expect(s).toContain("t!=='system'");
    // 例外を握りつぶす（paint 前スクリプトが落ちない）。
    expect(s).toContain("catch");
  });
});
