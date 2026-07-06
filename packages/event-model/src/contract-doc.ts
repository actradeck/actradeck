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
 * golden event を囲む marker と ```json フェンス (それぞれ**独立の線形 regex**)。
 *
 * ReDoS (js/polynomial-redos): 以前は `A([\s\S]*?)B` の単一 regex（開始 marker A・終了 marker B が
 *   共に `<!--` prefix を共有）で領域を捕捉していた。lazy 捕捉 `[\s\S]*?` を、prefix を共有する
 *   2 marker で挟む構造は、marker prefix の反復入力（例 `<!--GOLDEN-EVENT:START-->` の連打）に対し
 *   捕捉境界の再試行が起きる quadratic backtracking を残した (CodeQL #22/#23)。
 *   → **marker 間に lazy 捕捉を挟まない**。START/END/フェンスをそれぞれ「literal + \s* + literal」の
 *   単純（＝線形）regex or `indexOf` で**順に検出して slice** する方式へ置換し、`A([\s\S]*?)B` を
 *   一切作らない。marker の `\s*` 柔軟性 (`<!-- X -->` と `<!--X-->` 両対応) は各 marker regex 内で維持。
 */
const GOLDEN_START_RE = /<!--\s*GOLDEN-EVENT:START\s*-->/;
const GOLDEN_END_RE = /<!--\s*GOLDEN-EVENT:END\s*-->/;
const GOLDEN_FENCE_OPEN_RE = /```json/;
const GOLDEN_FENCE_CLOSE = "```";

/**
 * markdown 文字列から golden event JSON を抽出して parse する。
 * marker / フェンス / JSON のいずれかが欠けたら throw (fail-loud)。
 *
 * 非バックトラッキング抽出: START marker → ```json フェンス開始 → 閉じ ``` → END marker を
 *   単純 regex + `indexOf` で**この順に**検出し、フェンス間の JSON 本体を slice する。旧
 *   `A([\s\S]*?)B` の lazy 捕捉を廃したため各段は線形。フェンス内の先頭/末尾空白は slice に含まれるので
 *   `.trim()` して旧実装と **byte 等価**の JSON 文字列へ揃える (INV: JSON.parse 結果は不変)。
 *
 * @internal 契約テスト専用ヘルパ (docs↔schema 非ドリフト固定用)。runtime プロダクト API ではない。
 */
export function extractGoldenEvent(markdown: string): unknown {
  const notFound = () =>
    new Error("GOLDEN-EVENT marker or json fence not found in ingestion-contract.md");
  const s = GOLDEN_START_RE.exec(markdown);
  if (!s) throw notFound();
  const afterStart = markdown.slice(s.index + s[0].length);
  const fo = GOLDEN_FENCE_OPEN_RE.exec(afterStart);
  if (!fo) throw notFound();
  const afterFenceOpen = afterStart.slice(fo.index + fo[0].length);
  const closeIdx = afterFenceOpen.indexOf(GOLDEN_FENCE_CLOSE);
  if (closeIdx === -1) throw notFound();
  const json = afterFenceOpen.slice(0, closeIdx);
  // END marker が閉じフェンスの後に存在することを確認 (旧 regex の終端 marker 相当・fail-loud)。
  const afterClose = afterFenceOpen.slice(closeIdx + GOLDEN_FENCE_CLOSE.length);
  if (!GOLDEN_END_RE.exec(afterClose)) throw notFound();
  return JSON.parse(json.trim());
}

/**
 * docs §4.3 の event_type 一覧を囲む marker (それぞれ**独立の線形 regex**)。
 *
 * ReDoS (js/polynomial-redos): GOLDEN_RE と同型の `A([\s\S]*?)B`（prefix 共有 marker で lazy 捕捉を
 *   挟む）quadratic を除去。START/END を個別の単純 regex で検出し marker 間を slice するため、
 *   marker prefix の反復入力でも backtracking しない (線形)。slice 内容は backtick token matcher へ
 *   渡すため前後空白は無害 (抽出される backtick token 集合は不変)。
 */
const EVENT_TYPES_START_RE = /<!--\s*EVENT-TYPES:START\s*-->/;
const EVENT_TYPES_END_RE = /<!--\s*EVENT-TYPES:END\s*-->/;
const BACKTICK_TOKEN_RE = /`([^`]+)`/g;

/**
 * docs §4.3 の `<!-- EVENT-TYPES:START/END -->` に囲まれた event_type 一覧から、
 * backtick で囲まれた token を抽出する (TDA-3・ALL_EVENT_TYPES との集合一致 pin 用)。
 * marker が欠けたら throw (fail-loud)。
 *
 * 非バックトラッキング抽出: START marker を検出 → 残りから END marker を検出 → 両 marker 間を slice。
 *   marker 間に lazy 捕捉を挟まないため線形。slice は旧 regex の捕捉群 `m[1]` と byte 等価。
 *
 * @internal 契約テスト専用ヘルパ (docs↔schema 非ドリフト固定用)。runtime プロダクト API ではない。
 */
export function extractDocEventTypes(markdown: string): string[] {
  const notFound = () => new Error("EVENT-TYPES marker not found in ingestion-contract.md");
  const s = EVENT_TYPES_START_RE.exec(markdown);
  if (!s) throw notFound();
  const rest = markdown.slice(s.index + s[0].length);
  const e = EVENT_TYPES_END_RE.exec(rest);
  if (!e) throw notFound();
  const content = rest.slice(0, e.index);
  const tokens = content.match(BACKTICK_TOKEN_RE) ?? [];
  return tokens.map((t) => t.slice(1, -1));
}
