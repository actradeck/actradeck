/**
 * Adaptive Clarity kit — Tag（Carbon Tag 置換）。tone 駆動の小ラベル。
 *
 * 色のみで意味を伝えない（WCAG 1.4.1）: tone と同時に必ずテキスト/アイコンを持つ。
 * data-* 属性は透過（既存テストの data-tone/data-phase 契約を保つため）。
 */
import type { HTMLAttributes, ReactNode } from "react";

import { Icon, type IconName } from "./Icon";

export type Tone = "neutral" | "info" | "success" | "warn" | "danger" | "muted";

export interface TagProps extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  readonly tone?: Tone;
  readonly size?: "sm" | "md";
  readonly iconStart?: IconName;
  readonly children: ReactNode;
}

export function Tag({
  tone = "neutral",
  size = "md",
  iconStart,
  className,
  children,
  ...rest
}: TagProps) {
  const cls = ["ad-tag", `ad-tag--${tone}`, `ad-tag--${size}`, className].filter(Boolean).join(" ");
  return (
    <span className={cls} {...rest}>
      {iconStart ? <Icon name={iconStart} className="ad-tag__icon" /> : null}
      <span className="ad-tag__label">{children}</span>
    </span>
  );
}
