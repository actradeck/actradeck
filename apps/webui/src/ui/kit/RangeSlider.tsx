/**
 * Adaptive Clarity kit — RangeSlider（replay scrubber）。
 *
 * ネイティブ `<input type="range">`（矢印キー操作・aria-value* 自動）。aria-label を必須化し、
 * 文脈ラベルとして aria-valuetext を渡せる。つまみは 24px 以上（globals の ::-*-thumb）。
 */
import type { InputHTMLAttributes } from "react";

export interface RangeSliderProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  /** 必須（数値だけでない文脈ラベル。INV: range の aria-label 欠落を型で防ぐ）。 */
  readonly "aria-label": string;
}

export function RangeSlider({ className, ...rest }: RangeSliderProps) {
  return (
    <input type="range" className={["ad-range", className].filter(Boolean).join(" ")} {...rest} />
  );
}
