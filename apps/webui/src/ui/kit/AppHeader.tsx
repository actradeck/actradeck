/**
 * Adaptive Clarity kit — AppHeader（Carbon Header/HeaderName/Content 置換）。
 *
 * `<header>` ランドマーク + 製品見出し + スキップリンク（2.4.1: メイン領域へ）。右側に常設操作
 * （テーマ切替等）を children で受ける。スキップリンク先 `#main` は本体側で id="main" を付与する。
 */
import type { ReactNode } from "react";

import { t } from "../i18n/messages";

export interface AppHeaderProps {
  readonly productName: string;
  readonly tagline?: string;
  /** スキップリンク文言。呼び出し側 (locale 解決済み) が渡す。未指定は ja 既定。 */
  readonly skipLabel?: string;
  /** ブランドマーク画像 URL (例 /brand/icon.svg)。未指定は CSS のアクセントドットへ縮退。 */
  readonly markSrc?: string;
  /** 右寄せの常設操作（ThemeToggle 等）。 */
  readonly children?: ReactNode;
}

export function AppHeader({ productName, tagline, skipLabel, markSrc, children }: AppHeaderProps) {
  return (
    <header className="ad-appheader">
      <a href="#main" className="ad-skip-link">
        {skipLabel ?? t("ja", "common.skipToMain")}
      </a>
      <span className="ad-appheader__brand">
        {markSrc ? (
          // width/height を明示し CSS 適用前に SVG 本来寸法 (例 344px) で描画されて
          // ヘッダーが巨大化する FOUC レイアウトシフトを防ぐ (CSS は同値 1.5rem を維持)。
          <img
            className="ad-appheader__mark"
            src={markSrc}
            alt=""
            aria-hidden="true"
            width={24}
            height={24}
          />
        ) : (
          <span className="ad-appheader__mark" aria-hidden="true" />
        )}
        <span className="ad-appheader__product">{productName}</span>
        {tagline ? <span className="ad-appheader__tagline">{tagline}</span> : null}
      </span>
      {children ? <div className="ad-header__actions">{children}</div> : null}
    </header>
  );
}
