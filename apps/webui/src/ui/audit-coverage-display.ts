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
 *   （back-reference: opencode example adapter の `HEARTBEAT_INTERVAL_MS`(20s) がこの値を下回る前提に
 *   依存する — docs/examples/opencode-adapter/adapter.js。20s⊂60s の結合は import せず docs/コメントの
 *   双方向 mirror で保つ・dep 逆流回避。この値を変えるなら adapter の 20s 前提を再確認すること。）
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
  return compactDuration(gen - recv);
}

/** compactDuration のオプション (GFI #19: 出力保存のための呼び元別差分を明示引数化)。 */
export interface CompactDurationOptions {
  /**
   * 最大単位 (既定 "h")。"m" は h へ畳まず分で出し続ける — SessionDetail の heartbeat 行が
   * 従来この形 (`"72m"`) で描画していたため、出力保存のためのオプション。
   */
  readonly maxUnit?: "m" | "h";
  /**
   * 負値 (未来 skew) を 0 へ clamp するか (既定 true)。false は符号付き秒 (`"-3s"`) で
   * 従来出力を保存する (SessionDetail heartbeat 行)。
   */
  readonly clampNegative?: boolean;
}

/**
 * ミリ秒差を compact な相対経過 (`"12s"` / `"3m"` / `"2h"`) へ整形する純関数。
 *  - 負値は既定で 0 へ clamp (未来 skew を負表示しない)。
 *  - 単位付与 (`ago` / `前`) は i18n に委ねる (language-neutral な数値+単位)。
 *
 * **webui の相対経過表示の単一出所** (GFI #19): staleness バナー / relativeReceivedAge に加え、
 * SessionList の last-event 列 (`relativeAge`) と SessionDetail の heartbeat 行 (`ageLabel`) も
 * 本関数へ委譲する (private コピーの並存はドリフト源・consolidation-invariant-sweep)。呼び元の
 * 従来出力差 (m-cap / 符号付き skew) は options で明示し、描画出力を変えない。
 * ※ PersistedApprovalsPanel の `formatRemaining` (m/h/d・期限切れ null) は「残り時間」の別意味論で
 *   本関数のコピーではない (対象外・当該ファイルのコメント参照)。action-units-display の小数秒
 * (`1.4s`) も別書式で対象外。
 */
export function compactDuration(deltaMs: number, opts?: CompactDurationOptions): string {
  const rounded = Math.round(deltaMs / 1000);
  const s = opts?.clampNegative === false ? rounded : Math.max(0, rounded);
  if (s < 60) return `${s}s`;
  if (opts?.maxUnit === "m" || s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

/**
 * seq-drop chip の表示上限 (SEC-1・UI cap)。密性抑制で集計は有界だが、表示は防御的に cap し、
 * 万一の巨大値でも桁溢れ表示にしない (`≥9999+ dropped?`)。
 */
export const SEQ_DROP_DISPLAY_CAP = 9999;

/**
 * `seq_missing_lower_bound` を chip 表示用に整形する純関数。
 *  - null (seq-bearing 無し / 信号不能) or 0 以下 (穴なし) → **null** (chip を出さない・誤警報しない)。
 *  - `> SEQ_DROP_DISPLAY_CAP` → `{ count: CAP, capped: true }` (i18n が `≥N+ dropped?` を出す)。
 *  - それ以外 → `{ count, capped: false }` (i18n が `≥N dropped?` を出す)。
 * 数値のみを返し (原文非依存)、hedged 文言の付与は i18n に委ねる。
 */
export function formatSeqDrop(missing: number | null): { count: number; capped: boolean } | null {
  if (missing === null || !Number.isFinite(missing) || missing <= 0) return null;
  const m = Math.trunc(missing);
  return m > SEQ_DROP_DISPLAY_CAP
    ? { count: SEQ_DROP_DISPLAY_CAP, capped: true }
    : { count: m, capped: false };
}
