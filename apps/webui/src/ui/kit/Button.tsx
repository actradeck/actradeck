/**
 * Adaptive Clarity kit — Button / IconButton（Carbon Button 置換）。
 *
 * ネイティブ `<button>`（Enter/Space・フォーカスはブラウザ任せ）。`disabled` はネイティブ属性として
 * 透過（aria-disabled に変換しない＝既存テストの disabled カウント契約を保つ）。`title`/`aria-*` も透過。
 * WCAG 2.2: フォーカス可視 2px（globals の :focus-visible）、ターゲット 24px 以上（.ad-btn min-size）。
 */
import type { ButtonHTMLAttributes, ReactNode } from "react";

import { Icon, type IconName } from "./Icon";

export type ButtonKind = "primary" | "secondary" | "danger" | "ghost";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly kind?: ButtonKind;
  readonly size?: "sm" | "md";
  readonly iconStart?: IconName;
  readonly children: ReactNode;
}

export function Button({
  kind = "secondary",
  size = "md",
  iconStart,
  className,
  type = "button",
  children,
  ...rest
}: ButtonProps) {
  const cls = ["ad-btn", `ad-btn--${kind}`, `ad-btn--${size}`, className].filter(Boolean).join(" ");
  return (
    <button type={type} className={cls} {...rest}>
      {iconStart ? <Icon name={iconStart} className="ad-btn__icon" /> : null}
      {children}
    </button>
  );
}

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "aria-label"
> {
  readonly icon: IconName;
  /** 必須（INV-A11Y-ICONBUTTON-LABEL）。aria-label と既定 title に使う。 */
  readonly label: string;
  readonly kind?: ButtonKind;
}

export function IconButton({
  icon,
  label,
  kind = "ghost",
  className,
  type = "button",
  title,
  ...rest
}: IconButtonProps) {
  const cls = ["ad-icon-btn", `ad-btn--${kind}`, className].filter(Boolean).join(" ");
  return (
    <button type={type} className={cls} aria-label={label} title={title ?? label} {...rest}>
      <Icon name={icon} />
    </button>
  );
}
