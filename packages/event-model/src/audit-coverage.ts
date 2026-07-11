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
 * wire/endpoint には **provider slug (公開スラグ) + 時刻 (ISO) + 非負整数 + gap ms (null 可)** のみを
 * 載せる。生 cwd / パス / secret / session 内容 / 生コマンドは決して載せない。
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
  return {
    provider: input.provider,
    last_received_at: msToIso(lastIngestedMs),
    last_event_timestamp: msToIso(input.maxEventTimestampMs),
    active_session_count: active,
    total_session_count: asNonNegInt(input.totalSessionCount),
    gap_candidate_ms: gap,
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
