/**
 * Adaptive Clarity kit — Select（Carbon Select/SelectItem 置換）。
 *
 * ネイティブ `<select>`/`<option>`（INV-A11Y-SELECT-NATIVE）。combobox 自作はしない
 * （キーボード操作・SR・モバイルをネイティブで無償に満たす）。label を必須化し、視覚非表示も可。
 */
import type { ReactNode, SelectHTMLAttributes } from "react";

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  readonly id: string;
  readonly label: string;
  /** ラベルを視覚的に隠す（SR には読ませる）。 */
  readonly hideLabel?: boolean;
  readonly children: ReactNode;
}

export function Select({ id, label, hideLabel, className, children, ...rest }: SelectProps) {
  return (
    <span className="ad-select">
      <label htmlFor={id} className={hideLabel ? "ad-visually-hidden" : "ad-select__label"}>
        {label}
      </label>
      <select
        id={id}
        className={["ad-select__control", className].filter(Boolean).join(" ")}
        {...rest}
      >
        {children}
      </select>
    </span>
  );
}
