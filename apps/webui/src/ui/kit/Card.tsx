/**
 * Adaptive Clarity kit — Card（`.ad-approval-card` 等の構造化）。
 *
 * dumb component: DTO のどのフィールドを出すかは呼び出し側＋純ロジックに限定し、Card は children を
 * 表示するのみ（payload 形を知らない＝redaction 表示契約・token-isolation を壊さない）。
 */
import type { ElementType, HTMLAttributes, ReactNode } from "react";

import type { Tone } from "./Tag";

export interface CardProps extends HTMLAttributes<HTMLElement> {
  /** 描画する要素（承認カードは "li"）。既定 "section"。 */
  readonly as?: Extract<ElementType, "section" | "li" | "div" | "article">;
  readonly tone?: Tone;
  readonly children: ReactNode;
}

export function Card({ as, tone, className, children, ...rest }: CardProps) {
  const El = (as ?? "section") as ElementType;
  const cls = ["ad-card", tone ? `ad-card--${tone}` : null, className].filter(Boolean).join(" ");
  return (
    <El className={cls} {...rest}>
      {children}
    </El>
  );
}
