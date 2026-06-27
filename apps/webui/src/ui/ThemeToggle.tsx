"use client";

import { useId } from "react";

import { useLocale } from "./LocaleProvider";
import { THEME_PREFS, themeLabel, type ThemePref } from "./theme";
import { useTheme } from "./ThemeProvider";

/**
 * テーマ切替（system/light/dark/hc）。ネイティブ `<select>` を使い、キーボード操作・
 * スクリーンリーダ・モバイルを無償で満たす（Adaptive Clarity: ネイティブ要素優先）。
 */
export function ThemeToggle() {
  const { pref, setPref } = useTheme();
  const { locale, t } = useLocale();
  const id = useId();
  const label = t("header.theme");
  return (
    <div className="ad-theme-toggle">
      <label htmlFor={id} className="ad-visually-hidden">
        {label}
      </label>
      <select
        id={id}
        className="ad-theme-select"
        value={pref}
        aria-label={label}
        onChange={(e) => setPref(e.target.value as ThemePref)}
      >
        {THEME_PREFS.map((p) => (
          <option key={p} value={p}>
            {themeLabel(p, locale)}
          </option>
        ))}
      </select>
    </div>
  );
}
