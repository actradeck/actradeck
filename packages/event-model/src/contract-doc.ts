/**
 * contract-doc — 公開取込コントラクト docs (`docs/ingestion-contract.md`) から
 * golden example / event_type 列挙を抽出する **契約 docs 用ヘルパ** (T1・ADR 019f2d2c D5)。
 *
 * これは runtime プロダクトロジックではなく「docs↔schema の非ドリフト」を固定する INV テストの
 * 共有基盤である。event-model 側 (schema pin) と backend 側 (real /ingest POST) の両契約テストが
 * **同一の抽出規則**を使うために public API へ載せる (PR-2 QA-3/TDA-1: 以前は event-model の
 * test-helper と backend test に GOLDEN_RE / extract 関数が verbatim 二重定義されていた → 単一出所化)。
 *
 * anti-drift by construction: doc の**実バイト列**を single source として parse する。marker で
 * 囲まれた領域が欠けたら fail-loud (throw) する — 「docs を黙って壊す」を CI で赤化させるため。
 *
 * **pure / node 非依存** (event-model src は browser/edge でも安全な isomorphic T1・`path-scope.ts`
 * と同じ規律)。fs read と絶対パス解決は node 型を持つ **呼び元 (test)** が行い、markdown 文字列だけを
 * 渡す。共有できるのは (a) doc の repo-root 相対パス文字列 `GOLDEN_DOC_RELPATH`、(b) 抽出規則の 2 関数。
 * import.meta.url によるパス解決はモジュール固有ゆえ各 test が自 dir に対して `GOLDEN_DOC_RELPATH` を
 * resolve する (packages/event-model/test も apps/backend/test も repo root から 3 階層下で対称)。
 */

/**
 * repo root から見た golden doc への相対パス (呼び元の import.meta.url dir に対して resolve する)。
 * doc が移動したらこの 1 箇所を直せば両契約テストが追従する (「どの doc か」の単一出所)。
 *
 * @internal 契約テスト専用ヘルパ (docs↔schema 非ドリフト固定用)。runtime プロダクト API ではない。
 */
export const GOLDEN_DOC_RELPATH = "../../../docs/ingestion-contract.md";

/**
 * golden event を囲む marker + ```json フェンス。
 *
 * ReDoS (js/polynomial-redos): 以前は `\s*([\s\S]*?)\s*` と書いていたが、`\s`(空白) が外側
 *   `\s*` と内側 `[\s\S]` の**両方**に一致するため、空白多数入力で捕捉群と隣接 `\s*` の間で
 *   空白の配分を再試行する polynomial backtracking が起きた。捕捉群に隣接する `\s*` を除去し、
 *   lazy `[\s\S]*?` を**固定リテラル (```json … ```) で直接挟む**ことで overlap を構造的に消す
 *   (lazy + literal 終端は per-anchor 線形)。捕捉前後の空白は抽出側で `.trim()` して**現行と
 *   byte 等価**の内容を維持する (INV: JSON.parse 結果は不変)。
 */
const GOLDEN_RE =
  /<!--\s*GOLDEN-EVENT:START\s*-->\s*```json([\s\S]*?)```\s*<!--\s*GOLDEN-EVENT:END\s*-->/;

/**
 * markdown 文字列から golden event JSON を抽出して parse する。
 * marker / フェンス / JSON のいずれかが欠けたら throw (fail-loud)。
 *
 * @internal 契約テスト専用ヘルパ (docs↔schema 非ドリフト固定用)。runtime プロダクト API ではない。
 */
export function extractGoldenEvent(markdown: string): unknown {
  const m = GOLDEN_RE.exec(markdown);
  if (!m || !m[1]) {
    throw new Error("GOLDEN-EVENT marker or json fence not found in ingestion-contract.md");
  }
  // ReDoS 対策で捕捉群前後の `\s*` を除いたため、フェンス内の先頭/末尾空白は捕捉に含まれる。
  //   trim して旧 `\s*(...)\s*` と byte 等価の JSON 文字列へ揃える (JSON.parse 結果は不変)。
  return JSON.parse(m[1].trim());
}

/**
 * docs §4.3 の event_type 一覧を囲む marker。
 *
 * ReDoS (js/polynomial-redos): GOLDEN_RE と同型の `\s*([\s\S]*?)\s*` overlap を除去。捕捉群を
 *   固定リテラル (`-->` … `<!--`) で直接挟み、捕捉内容は backtick token matcher へ渡すため
 *   前後空白は無害 (抽出される backtick token 集合は不変)。
 */
const EVENT_TYPES_RE = /<!--\s*EVENT-TYPES:START\s*-->([\s\S]*?)<!--\s*EVENT-TYPES:END\s*-->/;

/**
 * docs §4.3 の `<!-- EVENT-TYPES:START/END -->` に囲まれた event_type 一覧から、
 * backtick で囲まれた token を抽出する (TDA-3・ALL_EVENT_TYPES との集合一致 pin 用)。
 * marker が欠けたら throw (fail-loud)。
 *
 * @internal 契約テスト専用ヘルパ (docs↔schema 非ドリフト固定用)。runtime プロダクト API ではない。
 */
export function extractDocEventTypes(markdown: string): string[] {
  const m = EVENT_TYPES_RE.exec(markdown);
  if (!m || !m[1]) {
    throw new Error("EVENT-TYPES marker not found in ingestion-contract.md");
  }
  const tokens = m[1].match(/`([^`]+)`/g) ?? [];
  return tokens.map((t) => t.slice(1, -1));
}
