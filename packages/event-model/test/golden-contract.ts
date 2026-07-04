/**
 * docs/ingestion-contract.md の golden example を抽出するテストヘルパ (ADR 019f2d2c D5)。
 *
 * 抽出対象は doc 内の `<!-- GOLDEN-EVENT:START -->` 〜 `<!-- GOLDEN-EVENT:END -->` の
 * 間にある単一の ```json フェンスブロック。**doc の実バイト列**を single source として parse するため、
 * schema/example のドリフトを構造的に検出できる (backend の real-POST テストも同じ doc を読む)。
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** docs/ingestion-contract.md の絶対パス (packages/event-model/test → repo root)。 */
export const GOLDEN_DOC_PATH = resolve(HERE, "../../../docs/ingestion-contract.md");

const GOLDEN_RE =
  /<!--\s*GOLDEN-EVENT:START\s*-->\s*```json\s*([\s\S]*?)\s*```\s*<!--\s*GOLDEN-EVENT:END\s*-->/;

/**
 * markdown 文字列から golden event JSON を抽出して parse する。
 * marker / フェンス / JSON のいずれかが欠けたら throw (fail-loud)。
 */
export function extractGoldenEvent(markdown: string): unknown {
  const m = GOLDEN_RE.exec(markdown);
  if (!m || !m[1]) {
    throw new Error("GOLDEN-EVENT marker or json fence not found in ingestion-contract.md");
  }
  return JSON.parse(m[1]);
}

const EVENT_TYPES_RE = /<!--\s*EVENT-TYPES:START\s*-->\s*([\s\S]*?)\s*<!--\s*EVENT-TYPES:END\s*-->/;

/**
 * docs §4.3 の `<!-- EVENT-TYPES:START/END -->` に囲まれた event_type 一覧から、
 * backtick で囲まれた token を抽出する (TDA-3・ALL_EVENT_TYPES との集合一致 pin 用)。
 * marker が欠けたら throw (fail-loud)。
 */
export function extractDocEventTypes(markdown: string): string[] {
  const m = EVENT_TYPES_RE.exec(markdown);
  if (!m || !m[1]) {
    throw new Error("EVENT-TYPES marker not found in ingestion-contract.md");
  }
  const tokens = m[1].match(/`([^`]+)`/g) ?? [];
  return tokens.map((t) => t.slice(1, -1));
}
