/**
 * Adaptive Clarity kit — InlineAlert（Carbon InlineNotification 置換）。
 *
 * error/warning は role="alert"（assertive）、info/success は role="status"（polite）を既定にする
 * （INV-A11Y-ROLE）。role は呼び出し側が上書き可能（既存 DOM の role 配置を保つため）。
 * 色のみで意味を伝えない（アイコン+テキスト同伴）。
 */
import type { HTMLAttributes, ReactNode } from "react";

import { Icon, type IconName } from "./Icon";

export type AlertKind = "info" | "success" | "warning" | "error";

const ICON: Record<AlertKind, IconName> = {
  info: "warning-alt",
  success: "check",
  warning: "warning",
  error: "warning",
};

export interface InlineAlertProps extends Omit<HTMLAttributes<HTMLDivElement>, "title"> {
  readonly kind: AlertKind;
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
}

export function InlineAlert({ kind, title, subtitle, role, className, ...rest }: InlineAlertProps) {
  const resolvedRole = role ?? (kind === "error" || kind === "warning" ? "alert" : "status");
  const cls = ["ad-alert", `ad-alert--${kind}`, className].filter(Boolean).join(" ");
  return (
    <div className={cls} role={resolvedRole} {...rest}>
      <Icon name={ICON[kind]} className="ad-alert__icon" />
      <div className="ad-alert__body">
        <span className="ad-alert__title">{title}</span>
        {subtitle ? <span className="ad-alert__subtitle">{subtitle}</span> : null}
      </div>
    </div>
  );
}
