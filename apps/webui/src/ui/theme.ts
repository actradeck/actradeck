/**
 * Adaptive Clarity 2030 — テーマ Platform Adapter（純ロジック）。
 *
 * 設計裁定 019ea263 (D3)。`<html data-theme>` を状態源に、`@actradeck/design-tokens` の
 * `--ad-*` をテーマ別へ切替える。"system" は data-theme を外し prefers-color-scheme /
 * prefers-contrast の自動追従に委ねる。Reduced Motion はトークン側 media で自動適用。
 *
 * DOM 依存を最小化し、要素ライク（setAttribute/removeAttribute）と storage ライク
 * （getItem/setItem）のインターフェイスで受けることで node 環境テストを可能にする。
 */
import { t, type Locale } from "./i18n/messages";

export const THEME_PREFS = ["system", "light", "dark", "hc"] as const;
export type ThemePref = (typeof THEME_PREFS)[number];

const THEME_LABEL_KEYS = {
  system: "header.theme.system",
  light: "header.theme.light",
  dark: "header.theme.dark",
  hc: "header.theme.hc",
} as const;

/** テーマ pref の表示ラベルをカタログから引く (既定 locale は ja)。 */
export function themeLabel(pref: ThemePref, locale: Locale = "ja"): string {
  return t(locale, THEME_LABEL_KEYS[pref]);
}

export const THEME_STORAGE_KEY = "ad-theme";

export function isThemePref(value: unknown): value is ThemePref {
  return typeof value === "string" && (THEME_PREFS as readonly string[]).includes(value);
}

/** 要素ライク（テスト用に DOM 非依存）。 */
export interface ElementLike {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/** ストレージライク（テスト用に DOM 非依存）。 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * テーマ設定を要素へ反映。
 * - "system": data-theme を外す（media query が自動追従）。
 * - "light"/"dark"/"hc": data-theme を設定（"light" は :root 既定を使うが、明示することで
 *   system の自動 dark/hc 追従を抑止する）。
 */
export function applyTheme(el: ElementLike, pref: ThemePref): void {
  if (pref === "system") {
    el.removeAttribute("data-theme");
  } else {
    el.setAttribute("data-theme", pref);
  }
}

/** 保存済みテーマを読む（不正/未設定は "system"）。 */
export function readStoredTheme(storage: StorageLike | null | undefined): ThemePref {
  try {
    const raw = storage?.getItem(THEME_STORAGE_KEY);
    return isThemePref(raw) ? raw : "system";
  } catch {
    return "system";
  }
}

/** テーマを保存（失敗は黙殺＝プライベートモード等で落ちない）。 */
export function persistTheme(storage: StorageLike | null | undefined, pref: ThemePref): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    // ignore: storage 不可でも UI は動く
  }
}

/**
 * SSR フラッシュ回避用の同期スクリプト本文。<head> 先頭で paint 前に data-theme を確定する。
 * localStorage を読み、"system" 以外なら即 data-theme を立てる。例外は握りつぶす。
 */
export function noFlashScript(): string {
  return (
    `(function(){try{var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});` +
    `if(t&&t!=='system'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`
  );
}
