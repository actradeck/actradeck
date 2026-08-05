/**
 * 型宣言: assert-inv-ran.mjs の export 面 (INV-TRIPWIRE-COVERAGE metatest が import する)。
 * 実体は同名 .mjs が単一出所 — ここは shape のみを写す (値の重複定義を置かない)。
 */
export declare const SUITES: Readonly<
  Record<"db" | "backend" | "sidecar-egress", { readonly label: string; readonly pattern: string }>
>;
