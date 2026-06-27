"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";

import { t, type Locale, type MessageKey } from "./i18n/messages";
import { applyLocale, persistLocale, resolveInitialLocale } from "./locale";

interface LocaleContextValue {
  readonly locale: Locale;
  readonly setLocale: (locale: Locale) => void;
  /** 現在 locale で束縛済みの翻訳関数 (コンポーネントは `const { t } = useLocale()` で使う)。 */
  readonly t: (key: MessageKey, params?: Record<string, string | number>) => string;
}

/**
 * **Context の default は "ja"** (設計裁定 019eb745)。Provider 無しで renderToStaticMarkup される
 * 既存テストが無改変で通ることが必須なので、ThemeProvider と違い throw せず ja で機能する default を
 * 提供する。setLocale は Provider 外では no-op。
 */
const LocaleContext = createContext<LocaleContextValue>({
  locale: "ja",
  setLocale: () => {},
  t: (key, params) => t("ja", key, params),
});

/**
 * テスト用に固定 locale を供給する軽量プロバイダ (SSR/静的描画で en を描くため)。
 * 本番 UI は LocaleProvider を使う (この helper は localStorage/effect を持たない)。
 */
export function FixedLocaleProvider({
  locale,
  children,
}: {
  readonly locale: Locale;
  readonly children: ReactNode;
}) {
  const value: LocaleContextValue = {
    locale,
    setLocale: () => {},
    t: (key, params) => t(locale, key, params),
  };
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

/**
 * 言語状態を提供。初期 lang は layout の no-flash スクリプトが paint 前に確定済みのため、ここでは
 * mount 後に保存値/navigator 推定を state へ同期し、変更時に `<html lang>` 反映 + 永続化する。
 * 既定 locale は "ja" (SSR / 初回 paint の文字列を ja で固定し、ハイドレーション不一致を避ける)。
 */
export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>("ja");

  useEffect(() => {
    setLocaleState(resolveInitialLocale(globalThis.localStorage, globalThis.navigator));
  }, []);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    applyLocale(document.documentElement, next);
    persistLocale(globalThis.localStorage, next);
  }, []);

  const value: LocaleContextValue = {
    locale,
    setLocale,
    t: (key, params) => t(locale, key, params),
  };

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext);
}
