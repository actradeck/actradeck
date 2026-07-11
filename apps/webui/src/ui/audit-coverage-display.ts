/**
 * audit-coverage-display — cockpit の「Audit coverage」パネルが使う **純表示派生**
 * (ADR 019f4cdb 後続 UI スライス). React/DOM 非依存の純関数のみゆえ coverage gate 対象
 * (liveness-display.ts / wall-display.ts と同カテゴリ)。
 *
 * 二つの派生:
 *  1. gap 閾値の severity 分類 — 「監査できていない時間」を視覚的な警告レベルへ写像する。
 *  2. 最終受信の相対経過 — **server の generated_at 基準**で計り client clock skew に依存しない。
 *
 * NO-RAW: provider slug / 時刻は event-model の正準 parse で既に検証済み。ここは数値/文字列 →
 * 表示派生のみで、生パス/secret を新たに導入しない。
 */

/**
 * gap 警告閾値 (ms・**単一定義**)。
 *
 * - `GAP_WARN_MS = 60_000` (60s): 稼働 provider が 60s 受信ゼロ = 監査がその時間 blind ＝注意喚起 (amber)。
 * - `GAP_CRITICAL_MS = 300_000` (5 分): 一過性の gap (再接続/バックオフ/短い idle) では説明しにくい
 *   継続的無受信。実 ingestion outage (adapter 停止 / drop) を疑うべき水準 (red)。
 *
 * gap は `active_session_count > 0` かつ受信実績ありのときだけ non-null (event-model 導出)。
 * 非稼働/無受信は null = idle であり **警告しない** (誤警報しない・ADR §6-6)。
 */
// TDA-2: 60s は INV-STALLED の 60s とは**独立**（値一致は偶然）。stalled = セッション状態判定 /
//   gap = provider 受信の途絶で別概念ゆえ**単一出所化しない**（片方の閾値変更が他方を巻き込まない）。
export const GAP_WARN_MS = 60_000;
export const GAP_CRITICAL_MS = 300_000;

/** gap の視覚 severity。`idle` は「稼働していない/無受信 ＝ gap でない」= 非警告 (色を付けない)。 */
export type GapSeverity = "ok" | "warn" | "critical" | "idle";

/**
 * `gap_candidate_ms` を severity へ写像する。
 *  - null → `idle` (非稼働 or 無受信・**警告しない**)。
 *  - >= CRITICAL → `critical` (red)。>= WARN → `warn` (amber)。それ未満 → `ok`。
 */
export function gapSeverity(gapMs: number | null): GapSeverity {
  if (gapMs === null) return "idle";
  if (gapMs >= GAP_CRITICAL_MS) return "critical";
  if (gapMs >= GAP_WARN_MS) return "warn";
  return "ok";
}

/**
 * 最終受信 (`last_received_at`・ISO) を **server の `generated_at` (ISO) 基準**で計った compact 相対
 * 経過へ整形する (`"12s"` / `"3m"` / `"2h"`)。両端が server 由来ゆえ client clock skew に依存しない。
 *
 *  - `last_received_at === null` (無受信) → null (呼び出し側が i18n の "no events" を出す)。
 *  - パース不能 (万一) → null (誤った経過を出さない fail-safe)。
 *  - 単位付与 (`ago` / `前`) は i18n に委ねる (ここは language-neutral な数値+単位・SessionList の
 *    `relativeAge` 流儀と同じ)。
 */
export function relativeReceivedAge(
  lastReceivedIso: string | null,
  generatedAtIso: string,
): string | null {
  if (lastReceivedIso === null) return null;
  const recv = Date.parse(lastReceivedIso);
  const gen = Date.parse(generatedAtIso);
  if (!Number.isFinite(recv) || !Number.isFinite(gen)) return null;
  const s = Math.max(0, Math.round((gen - recv) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}
