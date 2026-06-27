/**
 * Locale Platform Adapter (純ロジック・設計裁定 019eb745)。
 *
 * ThemeProvider/theme.ts と **同型**: `<html lang>` を状態源に、localStorage 永続キー `ad-locale`
 * で言語選択を保持する。DOM 依存を最小化し、要素ライク (setAttribute) / storage ライク
 * (getItem/setItem) のインターフェイスで受けることで node 環境テストを可能にする。
 *
 * 純粋な表示層 — realtime/bff/backend を value-import しない (token-isolation)。
 */
import { LOCALES, type Locale } from "./i18n/messages";

export type { Locale };
export { LOCALES };

export const LOCALE_STORAGE_KEY = "ad-locale";

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** 要素ライク (テスト用に DOM 非依存)。 */
export interface ElementLike {
  setAttribute(name: string, value: string): void;
}

/** ストレージライク (テスト用に DOM 非依存)。 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** ナビゲータライク (テスト用に DOM 非依存)。 */
export interface NavigatorLike {
  readonly language?: string;
  readonly languages?: readonly string[];
}

/** 選択された locale を `<html lang>` へ反映する。 */
export function applyLocale(el: ElementLike, locale: Locale): void {
  el.setAttribute("lang", locale);
}

/**
 * navigator の言語設定から既定 locale を推定する。`ja` 系 (ja / ja-JP …) なら "ja"、それ以外は "en"。
 * navigator が無い/空なら "ja" (製品既定)。
 */
export function detectNavigatorLocale(nav: NavigatorLike | null | undefined): Locale {
  const raw = nav?.language ?? nav?.languages?.[0];
  if (typeof raw !== "string") return "ja";
  return raw.toLowerCase().startsWith("ja") ? "ja" : "en";
}

/**
 * 初期 locale を決める: 保存値 (有効なら) ?? navigator 推定。保存値が無効/未設定なら navigator へ。
 * storage アクセスが throw しても navigator 推定へフォールバック (プライベートモード等で落ちない)。
 */
export function resolveInitialLocale(
  storage: StorageLike | null | undefined,
  nav: NavigatorLike | null | undefined,
): Locale {
  try {
    const raw = storage?.getItem(LOCALE_STORAGE_KEY);
    if (isLocale(raw)) return raw;
  } catch {
    // ignore: storage 不可でも navigator 推定で続行
  }
  return detectNavigatorLocale(nav);
}

/** 保存済み locale を読む (無効/未設定/null は "ja")。 */
export function readStoredLocale(storage: StorageLike | null | undefined): Locale {
  try {
    const raw = storage?.getItem(LOCALE_STORAGE_KEY);
    return isLocale(raw) ? raw : "ja";
  } catch {
    return "ja";
  }
}

/** locale を保存 (失敗は黙殺 = プライベートモード等で落ちない)。 */
export function persistLocale(storage: StorageLike | null | undefined, locale: Locale): void {
  try {
    storage?.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // ignore: storage 不可でも UI は動く
  }
}

/**
 * SSR フラッシュ回避用の同期スクリプト本文。<head> 先頭で paint 前に `<html lang>` を確定する。
 * 保存値が有効な locale ならそれを、無ければ navigator 推定 (ja 系→ja, 他→en) を立てる。例外は握り潰す。
 */
export function noFlashLocaleScript(): string {
  return (
    `(function(){try{var l=localStorage.getItem(${JSON.stringify(LOCALE_STORAGE_KEY)});` +
    `if(l!=='ja'&&l!=='en'){var n=(navigator.language||'');l=n.toLowerCase().indexOf('ja')===0?'ja':'en';}` +
    `document.documentElement.setAttribute('lang',l);}catch(e){}})();`
  );
}
