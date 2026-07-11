/**
 * audit-coverage — per-provider 監査カバレッジ (「最終受信からの経過 = 監査できていない時間」) を
 * 導出する DTO + 正準述語の **単一出所** (T1・ADR 019f4cdb Phase 1・decision 019f4cc0 #2).
 *
 * 背景: external adapter は at-most-once / silent-drop ゆえ「欠落を検知できない audit」は弱い。
 * per-provider の「最終受信サーバ時刻」を可視化し「監査できていない時間 (gap)」を正直に出す。
 *
 * ## 2 つの正準判断 (ここに集約し backend SQL / route / webui parse が共有する)
 *
 *  1. **ingested_at 権威 (ADR §6-5)**: gap は **サーバ受信 clock (`events.ingested_at`) の MAX** を
 *     基準に計る。adapter 申告 `timestamp` (session_state.last_event_at 由来) は clock skew で gap を
 *     隠すため**監査 gap の権威にしない** (表示補助 `last_event_timestamp` に留める)。
 *     `computeProviderCoverage` は `last_received_at` を **maxIngestedAtMs からのみ**導く。
 *
 *  2. **非稼働 ≠ gap (ADR §6-6・accepted-risk)**: 非 terminal (稼働中) session が 1 つも無い provider の
 *     「無受信」は gap ではなく「非稼働」— gap として誤警報しない。`gap_candidate_ms` は
 *     `active_session_count > 0` かつ受信実績 (last_received) がある場合のみ算出し、それ以外は **null**。
 *
 * ## NO-RAW 契約 (security.md・INV-AUDIT-COVERAGE-NO-RAW)
 * wire/endpoint には **provider slug (公開スラグ) + 時刻 (ISO) + 非負整数 + gap ms (null 可) +
 * seq-drop 下限 (非負 safe-integer・null 可) + seq 追跡/抑制 session 数**のみを載せる。seq 系は**件数のみ**
 * (原文非依存) で生 seq 値の列すら載せない。生 cwd / パス / secret / session 内容 / 生コマンドは決して載せない。
 * `projectProviderCoverageRow` は **既知フィールドのみ抽出し余剰 field を構造的に落とす**うえ、provider は
 * `PROVIDER_SLUG_RE` で再ゲートして非 slug 文字列 (万一の生パス混入等) を **row ごと drop** する
 * (NO-RAW by construction — agent-visibility-wire の parse 境界と同じパターン)。
 *
 * 純粋・依存ゼロ (provider slug regex のみ)・fs/net 非アクセス ＝ browser/edge でも安全。
 */
import { PROVIDER_SLUG_RE } from "./provider.js";

/**
 * per-provider の生集約入力 (backend の 1 クエリ由来・trusted だが NO-RAW のため射影で防御する)。
 * ms は epoch ミリ秒。受信/セッション実績が無ければ null。
 */
export interface ProviderCoverageInput {
  readonly provider: string;
  /** MAX(events.ingested_at) の epoch ms (= 最終受信サーバ時刻・gap の権威)。無受信は null。 */
  readonly maxIngestedAtMs: number | null;
  /** MAX(events.timestamp) の epoch ms (adapter 申告・表示補助・gap 非権威)。無受信は null。 */
  readonly maxEventTimestampMs: number | null;
  /** 非 terminal (稼働中) session 数。 */
  readonly activeSessionCount: number;
  /** provider の全 session 数。 */
  readonly totalSessionCount: number;
  /**
   * seq-drop 下限の provider 集約 (ADR 019f4cdb Phase2)。当該 provider の **seq-bearing session ごとに
   * `evaluateSeqMissing().missing` (密性抑制込み) を算出した総和** (backend SQL が同式で集約)。密性違反で
   * 抑制された session は寄与 0。seq-bearing session が皆無なら **null** (= 検知対象なし)。0 は「区間内に
   * 穴が無い or 全 session 抑制 (欠落を検知しない)」を意味する。抑制で `≤ Σdistinct ≤ 総イベント数` に有界。
   */
  readonly seqMissingLowerBoundSum: number | null;
  /** seq-bearing なイベントを 1 件以上持つ session 数 (非負整数・seq 追跡の裾野・抑制 session も含む)。 */
  readonly seqTrackedSessionCount: number;
  /** 密性前提違反で欠落信号を抑制した session 数 (非負整数・SEC-1≡QA-4 の可観測性)。 */
  readonly seqSuppressedSessionCount: number;
}

/** per-provider 監査カバレッジ (NO-RAW・closed shape). */
export interface AuditProviderCoverage {
  /** provider 公開スラグ (`PROVIDER_SLUG_RE` 妥当・生パス/secret を含まない)。 */
  readonly provider: string;
  /** 最終受信サーバ時刻 (ISO8601・`ingested_at` 権威)。無受信/Date 域外は null (gap と対称・TDA-2)。 */
  readonly last_received_at: string | null;
  /** 最終イベント adapter 申告時刻 (ISO8601・表示補助・gap 非権威)。無受信/Date 域外は null (TDA-2)。 */
  readonly last_event_timestamp: string | null;
  /** 非 terminal (稼働中) session 数 (非負整数)。 */
  readonly active_session_count: number;
  /** provider の全 session 数 (非負整数)。 */
  readonly total_session_count: number;
  /**
   * 監査 gap 候補 (ms・`generated_at` − `last_received_at`)。
   * **非稼働 (active_session_count===0) or 無受信 (last_received なし) は null** (誤警報しない・ADR §6-6)。
   */
  readonly gap_candidate_ms: number | null;
  /**
   * client 申告 seq による中間 silent-drop の **下限** (ADR 019f4cdb Phase2)。seq-bearing session ごとの
   * `evaluateSeqMissing().missing` (密性抑制込み) を provider 全体で総和したもの。**「下限」ゆえ真の欠落数は
   * これ以上** (末尾/先頭 drop は原理的に検知不能・受信区間内の穴のみ)。密性前提違反の session は抑制され
   * 寄与しない (`seq_suppressed_session_count` で可観測)。gap severity とは独立の信号。
   *
   * **null の意味は producer / parser で非対称 (SEC-7・実挙動)**:
   *  - **producer** (`computeProviderCoverage`): `seq_tracked_session_count === 0` (seq-bearing 無し =
   *    検知対象外) のときのみ null。tracked>0 の集計が safe-integer 域外に振れた場合は **0 へ fail-safe**
   *    (精度落ちの巨大偽値を surface させない・null にはしない)。ゆえに producer 出力の null ⇔ 検知対象外。
   *  - **parser** (`parseProviderCoverageWire`): wire 値が欠落 / 非数 / safe-integer 域外なら null へ縮退
   *    (誤警報しない安全側)。よって受信側は「検知対象外」と「不正/域外 wire 値」を共に null で扱う。
   */
  readonly seq_missing_lower_bound: number | null;
  /**
   * seq-bearing なイベントを持つ session 数 (非負整数)。producer では 0 のとき
   * `seq_missing_lower_bound` は null (検知対象外)。
   */
  readonly seq_tracked_session_count: number;
  /**
   * 密性前提違反で欠落信号を抑制した session 数 (非負整数・SEC-1≡QA-4)。>0 は「非密な seq (global
   * カウンタ誤用等) を検出し偽警報を抑えた」ことを示す診断。`seq_tracked_session_count` の部分集合。
   */
  readonly seq_suppressed_session_count: number;
}

/** per-provider カバレッジ集約レポート (read-only・NO-RAW). */
export interface AuditCoverageReport {
  /** レポート生成時刻 (ISO8601)。gap age の基準時刻 (サーバ now)。 */
  readonly generated_at: string;
  readonly providers: readonly AuditProviderCoverage[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * JS Date が表現できる epoch ms の絶対上限 (ECMAScript ±8,640,000,000,000,000)。これを超える ms は
 * `new Date(ms).toISOString()` が `RangeError: Invalid time value` を投げるため、射影境界で null へ
 * 縮退させる (SEC-1)。ingest 経路は year を 4 桁に cap するため到達不能だが、at-rest 破損や将来の
 * 直接書込に対し、層が謳う dirty-row robustness (provider 再ゲート) と同水準で timestamp も守る。
 */
const MAX_JS_DATE_MS = 8.64e15;

/** finite かつ JS Date 有効域内の number へ強制 (それ以外は null)。文字列 (pg numeric) も Number 経由で
 *  受ける。Date 域外 ms も null へ縮退させ後段 `msToIso` を throw させない (SEC-1・fail-safe)。 */
function asFiniteMsOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || Math.abs(n) > MAX_JS_DATE_MS) return null;
  return n;
}

/** 非負整数へ強制 (負/非有限/非数は 0)。 */
function asNonNegInt(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.trunc(n));
}

/**
 * 非負 **safe-integer** or null へ強制 (SEC-1・pg bigint SUM の safe-integer 保全)。
 * pg の bigint SUM は文字列で届く。`Number()` は 2^53-1 超で精度が落ちるため、`MAX_SAFE_INTEGER` を
 * 超える値は **精度落ちのまま通さず null** へ縮退させる (信号不能・巨大な偽値を surface させない)。
 * seq-drop 集約は密性抑制で `≤ Σdistinct ≤ 総イベント数` に有界ゆえこの経路は defense-in-depth。
 * null/非数は null (idle・誤警報しない安全側)。負値は 0 へ clamp。
 */
function asNonNegSafeIntOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const t = Math.max(0, Math.trunc(n));
  if (t > Number.MAX_SAFE_INTEGER) return null; // 精度落ちの巨大値を通さない
  return t;
}

/** epoch ms → ISO8601。null/非有限/JS Date 域外は null (無受信と対称・TDA-2/SEC-1・defense-in-depth)。 */
function msToIso(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || Math.abs(ms) > MAX_JS_DATE_MS) return null;
  return new Date(ms).toISOString();
}

/**
 * 生行 (untrusted 扱い) を `ProviderCoverageInput` へ検証射影する正準パーサ。
 * 既知フィールドのみ抽出し**余剰 field を構造的に落とす** (NO-RAW)。provider が `PROVIDER_SLUG_RE` に
 * 一致しなければ **row ごと undefined** (非 slug 文字列＝生パス/secret 様を surface させない・非 throw)。
 */
export function projectProviderCoverageRow(raw: unknown): ProviderCoverageInput | undefined {
  if (!isPlainObject(raw)) return undefined;
  const provider = raw.provider;
  if (typeof provider !== "string" || !PROVIDER_SLUG_RE.test(provider)) return undefined;
  return {
    provider,
    maxIngestedAtMs: asFiniteMsOrNull(raw.maxIngestedAtMs),
    maxEventTimestampMs: asFiniteMsOrNull(raw.maxEventTimestampMs),
    activeSessionCount: asNonNegInt(raw.activeSessionCount),
    totalSessionCount: asNonNegInt(raw.totalSessionCount),
    // seq-drop 集約 (pg bigint SUM は文字列で届くため Number 経由で受ける)。SEC-1: safe-integer 保全で
    // 2^53-1 超は精度落ちのまま通さず null (信号不能) へ縮退させる。
    seqMissingLowerBoundSum: asNonNegSafeIntOrNull(raw.seqMissingLowerBoundSum),
    seqTrackedSessionCount: asNonNegInt(raw.seqTrackedSessionCount),
    seqSuppressedSessionCount: asNonNegInt(raw.seqSuppressedSessionCount),
  };
}

/**
 * 集約入力 → per-provider カバレッジ DTO への **正準変換** (2 つの正準判断をここに閉じる)。
 *  - `last_received_at` は **maxIngestedAtMs からのみ**導く (ingested_at 権威・timestamp を使わない)。
 *  - `gap_candidate_ms` は `active_session_count > 0` かつ受信実績ありのときだけ算出し、
 *    それ以外 (非稼働 or 無受信) は **null** (誤警報しない)。負値は 0 へ clamp (未来 skew 安全側)。
 */
export function computeProviderCoverage(
  input: ProviderCoverageInput,
  generatedAtMs: number,
): AuditProviderCoverage {
  const active = asNonNegInt(input.activeSessionCount);
  // gap の権威は ingested_at (サーバ受信 clock)。adapter timestamp は表示補助のみ。
  // Date 有効域外 ms は null へ縮退させ last_received_at と gap を一貫させる (SEC-1・
  // projection 済入力なら既に null だが直呼びでも self-consistent に)。
  const lastIngestedMs = asFiniteMsOrNull(input.maxIngestedAtMs);
  const gap =
    active > 0 && lastIngestedMs !== null && Number.isFinite(generatedAtMs)
      ? Math.max(0, Math.trunc(generatedAtMs - lastIngestedMs))
      : null;
  // seq-drop: seq-bearing session が皆無 (tracked===0) なら null (検知対象なし)。それ以外は下限総和。
  //   safe-integer 域外 (asNonNegSafeIntOrNull→null) は精度落ちの巨大偽値を通さず 0 へ fail-safe
  //   (tracked>0 だが sum が null になる自己矛盾入力への安全側縮退と同一経路・偽警報を作らない)。
  const seqTracked = asNonNegInt(input.seqTrackedSessionCount);
  const seqMissing =
    seqTracked > 0 ? (asNonNegSafeIntOrNull(input.seqMissingLowerBoundSum) ?? 0) : null;
  return {
    provider: input.provider,
    last_received_at: msToIso(lastIngestedMs),
    last_event_timestamp: msToIso(input.maxEventTimestampMs),
    active_session_count: active,
    total_session_count: asNonNegInt(input.totalSessionCount),
    gap_candidate_ms: gap,
    seq_missing_lower_bound: seqMissing,
    seq_tracked_session_count: seqTracked,
    seq_suppressed_session_count: asNonNegInt(input.seqSuppressedSessionCount),
  };
}

/**
 * 生行群 → `AuditCoverageReport` の **単一エントリポイント** (backend route が使う)。
 * 各行を `projectProviderCoverageRow` (NO-RAW 射影 + slug 再ゲート) → `computeProviderCoverage`
 * (正準 gap 述語) に通し、drop された行 (非 slug) を除外して provider 昇順に並べる。
 */
export function buildCoverageReport(
  rows: readonly unknown[],
  generatedAt: Date,
): AuditCoverageReport {
  const generatedAtMs = generatedAt.getTime();
  const providers: AuditProviderCoverage[] = [];
  for (const row of rows) {
    const input = projectProviderCoverageRow(row);
    if (input === undefined) continue;
    providers.push(computeProviderCoverage(input, generatedAtMs));
  }
  providers.sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0));
  return { generated_at: generatedAt.toISOString(), providers };
}

/**
 * ISO8601 の形 (`toISOString()` 互換: `YYYY-MM-DDTHH:MM:SS[.fff](Z|±HH:MM)`)。lenient な `Date.parse`
 * 単独だと "2026" / "next friday" のような非 ISO 文字列も通り、万一の生パス/自由文字列を wire で
 * surface させうる。形の妥当性まで確認して非 ISO 文字列を **wire 受信境界で落とす** (NO-RAW 補強)。
 */
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** ISO 形かつ実在日時 (JS Date 有効域内) の文字列のみ通す。それ以外は null (無受信と対称・NO-RAW)。 */
function asIsoOrNull(v: unknown): string | null {
  if (typeof v !== "string" || !ISO_8601_RE.test(v)) return null;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_JS_DATE_MS) return null;
  return v;
}

/**
 * gap ms を「非負整数 or null」へ強制。null/非数は null (= idle・**誤警報しない**安全側へ縮退)。
 * 負値 (skew/破損) は 0 へ clamp (buildCoverageReport の未来 skew clamp と対称)。
 */
function asNonNegIntOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.trunc(n));
}

/**
 * wire の per-provider row (`AuditProviderCoverage` DTO・endpoint 応答由来・untrusted 扱い) を
 * **検証射影**する正準パーサ。`projectProviderCoverageRow` (SQL 生行→入力) と対をなす受信側で、
 * webui parse が共有する (T1 単一出所・security-gate-reuse-canonical-parser)。
 *
 *  - provider は `PROVIDER_SLUG_RE` 再ゲート、非 slug は **row ごと undefined** (生パス/secret 様を drop)。
 *  - 時刻は `asIsoOrNull` で **ISO 形のみ** 通す (非 ISO 文字列を落とす・NO-RAW)。
 *  - count は非負整数、gap は非負整数 or null へ強制。
 *  - 既知 field のみ抽出し **余剰 field を構造的に落とす** (NO-RAW by construction)。非 throw。
 */
export function parseProviderCoverageWire(raw: unknown): AuditProviderCoverage | undefined {
  if (!isPlainObject(raw)) return undefined;
  const provider = raw.provider;
  if (typeof provider !== "string" || !PROVIDER_SLUG_RE.test(provider)) return undefined;
  return {
    provider,
    last_received_at: asIsoOrNull(raw.last_received_at),
    last_event_timestamp: asIsoOrNull(raw.last_event_timestamp),
    active_session_count: asNonNegInt(raw.active_session_count),
    total_session_count: asNonNegInt(raw.total_session_count),
    gap_candidate_ms: asNonNegIntOrNull(raw.gap_candidate_ms),
    // seq-drop 下限は非負 safe-integer or null (null = seq-bearing 無し / safe-int 域外・誤警報しない安全側)。
    seq_missing_lower_bound: asNonNegSafeIntOrNull(raw.seq_missing_lower_bound),
    seq_tracked_session_count: asNonNegInt(raw.seq_tracked_session_count),
    seq_suppressed_session_count: asNonNegInt(raw.seq_suppressed_session_count),
  };
}

/**
 * endpoint 応答 (`GET /realtime/audit/coverage`・untrusted 扱い) → `AuditCoverageReport` の
 * **webui 側 単一エントリポイント**。agent-visibility の `parseAgentVisibilityWire` と同流儀:
 * 既知 field のみ抽出・余剰 field を構造的に落とし・非妥当 row を drop・**非 throw**。
 *
 *  - `generated_at` は gap age の基準時刻ゆえ **必須** (ISO 形でなければ report 全体 undefined =
 *    「未取得扱い」へ fail-safe。基準を欠いた相対時刻は誤描画になるため描画しない)。
 *  - `providers` が配列でなければ空配列扱い (report は返すが 0 行)。各 row は `parseProviderCoverageWire`
 *    に通し drop された非 slug row を除外、provider 昇順に整列 (endpoint と同順・決定的)。
 */
export function parseAuditCoverageReportWire(raw: unknown): AuditCoverageReport | undefined {
  if (!isPlainObject(raw)) return undefined;
  const generated_at = asIsoOrNull(raw.generated_at);
  if (generated_at === null) return undefined;
  const rawProviders = Array.isArray(raw.providers) ? raw.providers : [];
  const providers: AuditProviderCoverage[] = [];
  for (const row of rawProviders) {
    const p = parseProviderCoverageWire(row);
    if (p === undefined) continue;
    providers.push(p);
  }
  providers.sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0));
  return { generated_at, providers };
}
