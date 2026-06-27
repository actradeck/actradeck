/**
 * 監査ビューの純ロジック (強み(a) audit view・bundled・server token 非依存).
 *
 * BFF (`/realtime/audit/...`) が返す **allow-list DTO** (集計値 + decision enum + メタのみ・原文非載せ)
 * を defensive parse し、表示用ヘルパと export URL 構築を提供する。token はここに現れない
 * (same-origin path のみ・BFF が server-side で付与する)。
 */
import { gateRedactionCountByKind } from "@actradeck/event-model";

export type AuditDecision = "allow" | "allow_for_session" | "deny" | "cancel";

export interface AuditApprovalSummary {
  readonly total: number;
  readonly by_decision: Record<AuditDecision, number>;
  readonly pending: number;
}

export interface AuditApprovalEntry {
  readonly event_id: string;
  readonly timestamp: string;
  readonly tool_name?: string;
  readonly risk_level?: string;
  /** 承認対象コマンド (redaction 済み・backend allow-list 投影)。 */
  readonly command?: string;
  /** 承認対象パス (redaction 済み)。 */
  readonly path?: string;
  readonly decision?: AuditDecision;
  readonly auto_allowed?: boolean;
}

export interface AuditSessionSummary {
  readonly session_id: string;
  readonly provider: string;
  readonly source: string;
  readonly agent_id?: string;
  readonly repo?: string;
  readonly branch?: string;
  readonly cwd?: string;
  readonly capture_mode?: string;
  readonly permission_mode?: string;
  readonly state?: string;
  readonly started_at?: string;
  readonly ended_at?: string;
  readonly last_event_at?: string;
  readonly secret_detected: boolean;
  readonly secret_redaction_count: number;
  readonly secret_redaction_count_by_kind: Record<string, number>;
  readonly approvals: AuditApprovalSummary;
  readonly high_risk_op_count: number;
  readonly entries?: readonly AuditApprovalEntry[];
}

export interface AuditRangeTotals {
  readonly secret_redaction_count: number;
  readonly secret_redaction_count_by_kind: Record<string, number>;
  readonly approvals_by_decision: Record<AuditDecision, number>;
  readonly approval_total: number;
  readonly high_risk_op_count: number;
  readonly sessions_with_secret: number;
}

export interface AuditRangeReport {
  readonly from?: string;
  readonly to?: string;
  readonly generated_at: string;
  readonly session_count: number;
  readonly totals: AuditRangeTotals;
  readonly sessions: readonly AuditSessionSummary[];
  readonly limit: number;
  readonly has_more: boolean;
}

const AUDIT_BASE = "/realtime/audit/sessions";
const DECISIONS: readonly AuditDecision[] = ["allow", "allow_for_session", "deny", "cancel"];

/**
 * 監査集約 endpoint の same-origin URL を組む。from/to は ISO8601 (空は付けない)。
 * format=csv|json は export 用。token は付けない (BFF が server-side で付与)。
 */
export function buildAuditUrl(opts: {
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
  readonly format?: "json" | "csv";
}): string {
  const q = new URLSearchParams();
  if (opts.from) q.set("from", opts.from);
  if (opts.to) q.set("to", opts.to);
  if (typeof opts.limit === "number" && Number.isInteger(opts.limit) && opts.limit > 0) {
    q.set("limit", String(opts.limit));
  }
  if (opts.format) q.set("format", opts.format);
  const s = q.toString();
  return s.length > 0 ? `${AUDIT_BASE}?${s}` : AUDIT_BASE;
}

/** 件数・limit を非負整数として受ける (負/小数/NaN/Infinity は 0)。DTO 契約: 件数は非負整数 (QA-1)。 */
function nonNegInt(v: unknown): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function decisionTally(v: unknown): Record<AuditDecision, number> {
  const out: Record<AuditDecision, number> = {
    allow: 0,
    allow_for_session: 0,
    deny: 0,
    cancel: 0,
  };
  if (typeof v === "object" && v !== null) {
    const rec = v as Record<string, unknown>;
    for (const d of DECISIONS) out[d] = nonNegInt(rec[d]);
  }
  return out;
}

/** kind 別件数を closed-enum + 正整数で受ける (表示は kind 名 + 件数のみ・原文非依存)。
 *  SEC-1: read/carry 対称化の最終 hop。backend (parse/DTO/audit/merge) と同一 helper で key を
 *  gate し、phantom/語彙外 kind 名を画面ラベルに描画しない (上流二重 gate の最終防御層)。 */
function kindCounts(v: unknown): Record<string, number> {
  return gateRedactionCountByKind(v);
}

function parseApprovals(v: unknown): AuditApprovalSummary {
  const rec = (typeof v === "object" && v !== null ? v : {}) as Record<string, unknown>;
  return {
    total: nonNegInt(rec.total),
    by_decision: decisionTally(rec.by_decision),
    pending: nonNegInt(rec.pending),
  };
}

function parseEntry(v: unknown): AuditApprovalEntry | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const rec = v as Record<string, unknown>;
  const eventId = str(rec.event_id);
  const timestamp = str(rec.timestamp);
  if (eventId === undefined || timestamp === undefined) return undefined;
  const decision = str(rec.decision);
  return {
    event_id: eventId,
    timestamp,
    ...(str(rec.tool_name) !== undefined ? { tool_name: str(rec.tool_name) } : {}),
    ...(str(rec.risk_level) !== undefined ? { risk_level: str(rec.risk_level) } : {}),
    ...(str(rec.command) !== undefined ? { command: str(rec.command) } : {}),
    ...(str(rec.path) !== undefined ? { path: str(rec.path) } : {}),
    ...(decision !== undefined && (DECISIONS as readonly string[]).includes(decision)
      ? { decision: decision as AuditDecision }
      : {}),
    ...(typeof rec.auto_allowed === "boolean" ? { auto_allowed: rec.auto_allowed } : {}),
  };
}

export function parseAuditSession(v: unknown): AuditSessionSummary | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const rec = v as Record<string, unknown>;
  const sessionId = str(rec.session_id);
  if (sessionId === undefined) return undefined;
  const entriesRaw = Array.isArray(rec.entries) ? rec.entries : undefined;
  const entries = entriesRaw
    ?.map(parseEntry)
    .filter((e): e is AuditApprovalEntry => e !== undefined);
  return {
    session_id: sessionId,
    provider: str(rec.provider) ?? "",
    source: str(rec.source) ?? "",
    ...(str(rec.agent_id) !== undefined ? { agent_id: str(rec.agent_id) } : {}),
    ...(str(rec.repo) !== undefined ? { repo: str(rec.repo) } : {}),
    ...(str(rec.branch) !== undefined ? { branch: str(rec.branch) } : {}),
    ...(str(rec.cwd) !== undefined ? { cwd: str(rec.cwd) } : {}),
    ...(str(rec.capture_mode) !== undefined ? { capture_mode: str(rec.capture_mode) } : {}),
    ...(str(rec.permission_mode) !== undefined
      ? { permission_mode: str(rec.permission_mode) }
      : {}),
    ...(str(rec.state) !== undefined ? { state: str(rec.state) } : {}),
    ...(str(rec.started_at) !== undefined ? { started_at: str(rec.started_at) } : {}),
    ...(str(rec.ended_at) !== undefined ? { ended_at: str(rec.ended_at) } : {}),
    ...(str(rec.last_event_at) !== undefined ? { last_event_at: str(rec.last_event_at) } : {}),
    secret_detected: rec.secret_detected === true,
    secret_redaction_count: nonNegInt(rec.secret_redaction_count),
    secret_redaction_count_by_kind: kindCounts(rec.secret_redaction_count_by_kind),
    approvals: parseApprovals(rec.approvals),
    high_risk_op_count: nonNegInt(rec.high_risk_op_count),
    ...(entries !== undefined ? { entries } : {}),
  };
}

/** BFF JSON を AuditRangeReport へ defensive parse (欠落は安全側 default)。 */
export function parseAuditReport(raw: unknown): AuditRangeReport {
  const rec = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const totalsRec = (
    typeof rec.totals === "object" && rec.totals !== null ? rec.totals : {}
  ) as Record<string, unknown>;
  const sessions = (Array.isArray(rec.sessions) ? rec.sessions : [])
    .map(parseAuditSession)
    .filter((s): s is AuditSessionSummary => s !== undefined);
  return {
    ...(str(rec.from) !== undefined ? { from: str(rec.from) } : {}),
    ...(str(rec.to) !== undefined ? { to: str(rec.to) } : {}),
    generated_at: str(rec.generated_at) ?? "",
    session_count: nonNegInt(rec.session_count),
    totals: {
      secret_redaction_count: nonNegInt(totalsRec.secret_redaction_count),
      secret_redaction_count_by_kind: kindCounts(totalsRec.secret_redaction_count_by_kind),
      approvals_by_decision: decisionTally(totalsRec.approvals_by_decision),
      approval_total: nonNegInt(totalsRec.approval_total),
      high_risk_op_count: nonNegInt(totalsRec.high_risk_op_count),
      sessions_with_secret: nonNegInt(totalsRec.sessions_with_secret),
    },
    sessions,
    limit: nonNegInt(rec.limit),
    has_more: rec.has_more === true,
  };
}

/**
 * 単一セッションの監査詳細 endpoint URL (same-origin)。entries 付き (backend detail=true)。
 * session_id は encodeURIComponent でエスケープ (path injection 防止)。token は付けない。
 */
export function buildSessionAuditUrl(sessionId: string, format?: "json" | "csv"): string {
  const base = `${AUDIT_BASE}/${encodeURIComponent(sessionId)}`;
  return format ? `${base}?format=${format}` : base;
}

/**
 * ISO8601 を `YYYY-MM-DD HH:MM` (UTC) の人間可読スタンプへ。non-ISO は素通し (壊さない)。
 * formatClock (時刻のみ) と異なり監査は日跨ぎを扱うため日付込み。
 */
export function formatStamp(iso: string | undefined): string {
  if (iso === undefined || iso.length < 16 || iso[10] !== "T") return iso ?? "";
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

/** ホームディレクトリ前置を `~` へ畳む (例 /home/u/Files/X → ~/Files/X)。表示専用・決定論。 */
export function shortenPath(path: string): string {
  return path.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, "~");
}

/**
 * 「どのプロジェクトか」を一目で示すラベル。repo 優先 → cwd の basename → session_id 短縮。
 * 監査行の見出しに使う (cwd フルパスは別途併記・memory: wall-show-working-directory)。
 */
export function projectLabel(s: {
  readonly repo?: string;
  readonly cwd?: string;
  readonly session_id: string;
}): string {
  if (s.repo !== undefined && s.repo.length > 0) return s.repo;
  if (s.cwd !== undefined && s.cwd.length > 0) {
    const parts = s.cwd.replace(/\/+$/, "").split("/");
    const base = parts[parts.length - 1];
    if (base !== undefined && base.length > 0) return base;
  }
  return s.session_id.slice(0, 12);
}

/** kind 別件数を {kind, count} の配列へ (件数降順)。drill-down のクリック対象用に kind を保持。 */
export function sortedKindCounts(
  byKind: Record<string, number>,
): ReadonlyArray<{ readonly kind: string; readonly count: number }> {
  return Object.entries(byKind)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => ({ kind, count }));
}

/**
 * kind 別件数を `kind ×n` の表示文字列配列へ (件数降順)。原文は含まない。
 * 並び順は sortedKindCounts と単一ソース (TDA-2: 件数降順ロジックの重複を排除)。
 */
export function formatKindCounts(byKind: Record<string, number>): string[] {
  return sortedKindCounts(byKind).map(({ kind, count }) => `${kind} ×${count}`);
}

// ---------------------------------------------------------------------------
// Redaction drill-down (ガバナンス証跡の集計→個別イベント展開・decision 019f03cc).
//
// kind 別件数タグから「どのイベントで・いつ」その redaction が起きたかを辿る。BFF
// (`/realtime/audit/sessions/:id/redactions?kind=`) が返す **allow-list DTO** を defensive parse する。
// 原文秘匿は出ない (kind enum + 件数 + redacted command/path のみ)。token はここに現れない。
// ---------------------------------------------------------------------------

/** 当該 kind の redaction が発生した 1 イベント (redacted・原文非載せ)。 */
export interface RedactionOccurrence {
  readonly event_id: string;
  readonly timestamp: string;
  readonly event_type: string;
  /** この event 内の当該 kind の redaction マーカー件数 (>=1)。 */
  readonly count: number;
  /** 文脈用の redaction 済み command。 */
  readonly command?: string;
  /** 文脈用の redaction 済み path。 */
  readonly path?: string;
}

export interface RedactionOccurrences {
  readonly session_id: string;
  readonly kind: string;
  readonly total: number;
  readonly occurrences: readonly RedactionOccurrence[];
  readonly limit: number;
  readonly has_more: boolean;
}

/**
 * drill-down endpoint の same-origin URL。session_id / kind は encodeURIComponent でエスケープ。
 * token は付けない (BFF が server-side で付与)。
 */
export function buildRedactionOccurrencesUrl(
  sessionId: string,
  kind: string,
  limit?: number,
): string {
  const q = new URLSearchParams({ kind });
  if (typeof limit === "number" && Number.isInteger(limit) && limit > 0) {
    q.set("limit", String(limit));
  }
  return `${AUDIT_BASE}/${encodeURIComponent(sessionId)}/redactions?${q.toString()}`;
}

function parseOccurrence(v: unknown): RedactionOccurrence | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const rec = v as Record<string, unknown>;
  const eventId = str(rec.event_id);
  const timestamp = str(rec.timestamp);
  const eventType = str(rec.event_type);
  if (eventId === undefined || timestamp === undefined || eventType === undefined) return undefined;
  return {
    event_id: eventId,
    timestamp,
    event_type: eventType,
    count: nonNegInt(rec.count),
    ...(str(rec.command) !== undefined ? { command: str(rec.command) } : {}),
    ...(str(rec.path) !== undefined ? { path: str(rec.path) } : {}),
  };
}

/** BFF JSON を RedactionOccurrences へ defensive parse (欠落は安全側 default)。 */
export function parseRedactionOccurrences(raw: unknown): RedactionOccurrences | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const rec = raw as Record<string, unknown>;
  const sessionId = str(rec.session_id);
  const kind = str(rec.kind);
  if (sessionId === undefined || kind === undefined) return undefined;
  const occurrences = (Array.isArray(rec.occurrences) ? rec.occurrences : [])
    .map(parseOccurrence)
    .filter((o): o is RedactionOccurrence => o !== undefined);
  return {
    session_id: sessionId,
    kind,
    total: nonNegInt(rec.total),
    occurrences,
    limit: nonNegInt(rec.limit),
    has_more: rec.has_more === true,
  };
}

/** occurrence の「何が redaction されたか」文脈表示 (redacted command 優先 → path → event_type)。 */
export function occurrencePrimaryText(o: RedactionOccurrence): string {
  return o.command ?? o.path ?? o.event_type;
}

/** decision 別件数の合計 (resolved 総数)。 */
export function decidedTotal(summary: AuditApprovalSummary): number {
  return DECISIONS.reduce((acc, d) => acc + summary.by_decision[d], 0);
}

/** 読み込み済みセッションから distinct なプロジェクトラベルを昇順で返す (フィルタ選択肢用)。 */
export function distinctProjects(sessions: readonly AuditSessionSummary[]): string[] {
  return [...new Set(sessions.map((s) => projectLabel(s)))].sort((a, b) => a.localeCompare(b));
}

/**
 * クライアント側フィルタ。project (空=全) と自由文字列 query (project/cwd/branch/session_id/
 * provider/source を横断・大小無視) で絞る。原文には触れない (読み込み済み allow-list 値のみ)。
 */
export function filterSessions(
  sessions: readonly AuditSessionSummary[],
  project: string,
  query: string,
): AuditSessionSummary[] {
  const q = query.trim().toLowerCase();
  return sessions.filter((s) => {
    if (project.length > 0 && projectLabel(s) !== project) return false;
    if (q.length > 0) {
      const hay = [projectLabel(s), s.cwd ?? "", s.branch ?? "", s.session_id, s.provider, s.source]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** 表示中セッション群の KPI 集計 (フィルタ適用後の数値を KPI ストリップへ反映する)。 */
export interface AuditVisibleTotals {
  readonly sessions: number;
  readonly redactions: number;
  readonly deny: number;
  readonly approvals: number;
  readonly highRisk: number;
}

export function aggregateSessions(sessions: readonly AuditSessionSummary[]): AuditVisibleTotals {
  return sessions.reduce<AuditVisibleTotals>(
    (acc, s) => ({
      sessions: acc.sessions + 1,
      redactions: acc.redactions + s.secret_redaction_count,
      deny: acc.deny + s.approvals.by_decision.deny,
      approvals: acc.approvals + s.approvals.total,
      highRisk: acc.highRisk + s.high_risk_op_count,
    }),
    { sessions: 0, redactions: 0, deny: 0, approvals: 0, highRisk: 0 },
  );
}

/**
 * 承認エントリの「何を承認したか」主表示 (redaction 済み command 優先 → path → tool_name →
 * event_id)。approval-display.approvalPrimaryText と同規約。原文は含まない。
 */
export function entryPrimaryText(e: AuditApprovalEntry): string {
  return e.command ?? e.path ?? e.tool_name ?? e.event_id;
}
