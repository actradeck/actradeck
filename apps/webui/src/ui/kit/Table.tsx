/**
 * Adaptive Clarity kit — Table プリミティブ（Carbon Table* 置換）。
 *
 * ネイティブ `<table>` セマンティクスを保つ（スクリーンリーダの行/列ナビ自動）。`<th scope>` と
 * 視覚非表示 `<caption>` を必須化（INV-A11Y-TABLE-SEMANTICS）。行選択は呼び出し側が
 * `tr tabIndex/aria-selected/onKeyDown` を付与する（既存パターン維持）。
 */
import type {
  HTMLAttributes,
  ReactNode,
  TableHTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from "react";

export interface TableProps extends TableHTMLAttributes<HTMLTableElement> {
  /** スクリーンリーダ向けの表の説明（視覚非表示の caption として描画）。 */
  readonly caption: string;
  readonly children: ReactNode;
}

export function Table({ caption, className, children, ...rest }: TableProps) {
  return (
    <table className={["ad-table", className].filter(Boolean).join(" ")} {...rest}>
      <caption className="ad-visually-hidden">{caption}</caption>
      {children}
    </table>
  );
}

export function THead(props: HTMLAttributes<HTMLTableSectionElement>) {
  return <thead {...props} />;
}

export function TBody(props: HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody {...props} />;
}

export function Tr({ className, ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={["ad-table__row", className].filter(Boolean).join(" ")} {...rest} />;
}

export function Th({ scope = "col", className, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th scope={scope} className={["ad-table__th", className].filter(Boolean).join(" ")} {...rest} />
  );
}

export function Td({ className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={["ad-table__td", className].filter(Boolean).join(" ")} {...rest} />;
}
