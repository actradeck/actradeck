"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";

import { applyTheme, persistTheme, readStoredTheme, type ThemePref } from "./theme";

interface ThemeContextValue {
  readonly pref: ThemePref;
  readonly setPref: (pref: ThemePref) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * テーマ状態を提供。初期 data-theme は layout の no-flash スクリプトが paint 前に確定済みのため、
 * ここでは mount 後に保存値を state へ同期し、変更時に DOM 反映 + 永続化する。
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>("system");

  useEffect(() => {
    setPrefState(readStoredTheme(globalThis.localStorage));
  }, []);

  const setPref = useCallback((next: ThemePref) => {
    setPrefState(next);
    applyTheme(document.documentElement, next);
    persistTheme(globalThis.localStorage, next);
  }, []);

  return <ThemeContext.Provider value={{ pref, setPref }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
