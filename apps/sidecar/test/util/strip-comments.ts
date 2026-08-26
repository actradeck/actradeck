/**
 * 走査正規化 (単一出所・TDA-CQ14-4 → TDA-CQ15-4): ソースからブロックコメントと行頭の行コメントを落とし、
 * 識別子・source pin の出現をコメント文言の増減から独立させる。exclusivity metatest (inv-approval) と
 * source-coupling pin (inv-check-classifier) の両方がこれを使う — 片側だけ強化される複製を作らない。
 *
 * 正直な限界: 行末コメント (`code // note`) は落とさない (行頭限定)。文字列リテラル内の `/*` は
 * 誤って切る可能性がある。tripwire 用途 (逐語コピー・改名の検出) には十分で、証明ではない。
 */
export function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}
