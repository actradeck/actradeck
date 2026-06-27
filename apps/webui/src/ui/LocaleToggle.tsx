"use client";

import { useId } from "react";

import { LOCALE_LABELS } from "./i18n/messages";
import { LOCALES, type Locale } from "./locale";
import { useLocale } from "./LocaleProvider";

/**
 * 言語切替 (日本語 / English)。ThemeToggle と同型のネイティブ `<select>` でキーボード操作・
 * スクリーンリーダ・モバイルを無償で満たす (Adaptive Clarity: ネイティブ要素優先)。
 * ラベル文言は現在 locale で翻訳する (自己参照だが選択肢の言語名はネイティブ表記で固定)。
 */
export function LocaleToggle() {
  const { locale, setLocale, t } = useLocale();
  const id = useId();
  const label = t("header.locale");
  return (
    <div className="ad-locale-toggle">
      <label htmlFor={id} className="ad-visually-hidden">
        {label}
      </label>
      <select
        id={id}
        className="ad-locale-select"
        value={locale}
        aria-label={label}
        onChange={(e) => setLocale(e.target.value as Locale)}
      >
        {LOCALES.map((l) => (
          <option key={l} value={l}>
            {LOCALE_LABELS[l]}
          </option>
        ))}
      </select>
    </div>
  );
}
