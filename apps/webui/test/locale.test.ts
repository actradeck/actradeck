/**
 * Locale Platform Adapter 純ロジック検証 (設計裁定 019eb745)。
 *
 * DOM 非依存 (ElementLike / StorageLike / NavigatorLike) で resolveInitialLocale / persistLocale /
 * applyLocale / noFlashLocaleScript を node 環境で固定する。既定は ja、navigator が ja 系でなければ en。
 */
import { describe, expect, it } from "vitest";

import {
  applyLocale,
  detectNavigatorLocale,
  isLocale,
  LOCALE_STORAGE_KEY,
  noFlashLocaleScript,
  persistLocale,
  readStoredLocale,
  resolveInitialLocale,
  type ElementLike,
  type StorageLike,
} from "../src/ui/locale.js";

function fakeEl(): ElementLike & { attrs: Map<string, string> } {
  const attrs = new Map<string, string>();
  return { attrs, setAttribute: (k, v) => void attrs.set(k, v) };
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

describe("isLocale", () => {
  it("accepts ja/en only", () => {
    expect(isLocale("ja")).toBe(true);
    expect(isLocale("en")).toBe(true);
    expect(isLocale("de")).toBe(false);
    expect(isLocale(42)).toBe(false);
  });
});

describe("detectNavigatorLocale", () => {
  it("ja-family → ja", () => {
    expect(detectNavigatorLocale({ language: "ja" })).toBe("ja");
    expect(detectNavigatorLocale({ language: "ja-JP" })).toBe("ja");
  });
  it("non-ja → en", () => {
    expect(detectNavigatorLocale({ language: "en-US" })).toBe("en");
    expect(detectNavigatorLocale({ language: "fr" })).toBe("en");
  });
  it("missing navigator → ja (product default)", () => {
    expect(detectNavigatorLocale(null)).toBe("ja");
    expect(detectNavigatorLocale({})).toBe("ja");
  });
});

describe("resolveInitialLocale: stored ?? navigator", () => {
  it("valid stored value wins", () => {
    expect(
      resolveInitialLocale(fakeStorage({ [LOCALE_STORAGE_KEY]: "en" }), { language: "ja" }),
    ).toBe("en");
  });
  it("invalid/missing stored → navigator detection", () => {
    expect(resolveInitialLocale(fakeStorage(), { language: "en-US" })).toBe("en");
    expect(
      resolveInitialLocale(fakeStorage({ [LOCALE_STORAGE_KEY]: "zz" }), { language: "ja" }),
    ).toBe("ja");
  });
  it("throwing storage falls back to navigator", () => {
    const hostile: StorageLike = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {},
    };
    expect(resolveInitialLocale(hostile, { language: "ja" })).toBe("ja");
    expect(resolveInitialLocale(hostile, { language: "en" })).toBe("en");
  });
});

describe("readStoredLocale / persistLocale", () => {
  it("reads valid value, falls back to ja otherwise", () => {
    expect(readStoredLocale(fakeStorage({ [LOCALE_STORAGE_KEY]: "en" }))).toBe("en");
    expect(readStoredLocale(fakeStorage())).toBe("ja");
    expect(readStoredLocale(null)).toBe("ja");
  });
  it("persists and swallows failures", () => {
    const s = fakeStorage();
    persistLocale(s, "en");
    expect(s.data.get(LOCALE_STORAGE_KEY)).toBe("en");
    expect(() =>
      persistLocale(
        {
          getItem: () => null,
          setItem: () => {
            throw new Error("quota");
          },
        },
        "en",
      ),
    ).not.toThrow();
  });
});

describe("applyLocale / noFlashLocaleScript", () => {
  it("applyLocale sets <html lang>", () => {
    const el = fakeEl();
    applyLocale(el, "en");
    expect(el.attrs.get("lang")).toBe("en");
  });
  it("no-flash script reads storage key, sets lang, swallows errors", () => {
    const s = noFlashLocaleScript();
    expect(s).toContain(JSON.stringify(LOCALE_STORAGE_KEY));
    expect(s).toContain("setAttribute('lang'");
    expect(s).toContain("catch");
  });
});
