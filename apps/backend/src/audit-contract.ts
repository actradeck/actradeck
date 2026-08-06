/**
 * Audit view DTO contract (強み(a) ガバナンス監査ビュー).
 *
 * 監査ビューは「保存前 redaction + 承認 + 正規化が効いた証跡」を集約表示・export するための
 * **read-only allow-list DTO** である。replay-contract と同じく raw NormalizedEvent を出さず、
 * UI 表示・監査に必要な集計値 (redaction kind 別件数 / 承認 decision 別件数 / 高リスク件数 / メタ) と、
 * per-session 詳細では承認エントリの allow-list フィールドのみを載せる。
 *
 * ## INV-AUDIT-EXPORT-NO-RAW
 * 本 DTO / CSV export には原文秘匿 (RAW) が一切出ない:
 *  - redaction は **kind 名 (公開 enum) + 非負整数件数** のみ (原文・値は載せない)。
 *  - **range 一覧 / CSV export** は承認を **decision (closed-enum) + risk_level + tool_name + 時刻 +
 *    件数集計**のみへ畳む (承認エントリ列 entries 自体を載せない = 監査台帳は最小)。
 *  - **per-session 詳細 (/:id) の entries のみ** 例外的に、何を承認したかを示すため
 *    `command` / `path` を載せる。これらは **sidecar redaction 済み at-rest** な events.payload の
 *    allow-list 投影 (replay の display 用フィールドと同一の redacted 列・backend は再 redaction
 *    しない)。RAW 秘匿は出ない (redaction 済み = RAW ではない)。生 payload・非 allow-list キーは
 *    投影しない (SELECT が固定 allow-list)。
 *  - すべて redacted-at-rest な session_state / sessions / events の allow-list 投影由来で、
 *    backend は再 redaction しない (sidecar choke を唯一の権威として維持する)。
 */

import {
  isKnownRedactionKind,
  type RedactionKind,
  ResolutionOrigin,
  type ResolutionOrigin as ResolutionOriginT,
} from "@actradeck/event-model";

/**
 * TDA-1 (Phase 4 監査 R2): resolved payload の resolution_origin を監査層へ投影する closed gate。
 * 未知値 / 欠落は undefined (ingress parseEvent は looseObject 素通しゆえ、監査 read 層で
 * closed-enum に落とすのが本 gate の役割)。
 */
export function asResolutionOrigin(raw: string | null | undefined): ResolutionOriginT | undefined {
  if (raw === null || raw === undefined) return undefined;
  const parsed = ResolutionOrigin.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** 承認 decision の closed-enum (event-model ApprovalDecision と同値・監査表示用に複製)。 */
export const AUDIT_DECISIONS = ["allow", "allow_for_session", "deny", "cancel"] as const;
export type AuditDecision = (typeof AUDIT_DECISIONS)[number];

/** decision 別件数 (全 decision キーを 0 埋めで持つ・集計の決定論化)。 */
export type AuditDecisionTally = Record<AuditDecision, number>;

export function emptyDecisionTally(): AuditDecisionTally {
  return { allow: 0, allow_for_session: 0, deny: 0, cancel: 0 };
}

/**
 * per-session 詳細でのみ返す承認エントリ (allow-list)。
 * command / path は **sidecar redaction 済み at-rest** な payload の投影で「何を承認したか」を示す
 * (RAW 秘匿ではない・range/CSV には載せない)。生 payload・非 allow-list キーは投影しない。
 */
export interface AuditApprovalEntry {
  readonly event_id: string;
  readonly timestamp: string;
  readonly tool_name: string | undefined;
  readonly risk_level: string | undefined;
  /** 承認対象コマンド (redaction 済み)。Bash 等で付く・無ければ undefined。 */
  readonly command: string | undefined;
  /** 承認対象パス (redaction 済み・file_path フォールバック)。Edit/Write 等で付く。 */
  readonly path: string | undefined;
  /** 解決済みの decision。requested のみで未解決なら undefined。 */
  readonly decision: AuditDecision | undefined;
  /**
   * TDA-1 (Phase 4 R2): 解決の出所 (closed enum・未知/欠落は undefined)。`relay_lost` は
   * backend 合成の retire (誰も決定していない・agent へ何も届いていない) であり、operator の
   * hard gate と区別して表示・集計する。
   */
  readonly resolution_origin: ResolutionOriginT | undefined;
  readonly auto_allowed: boolean | undefined;
}

export interface AuditApprovalSummary {
  /** 承認要求 (tool.permission.requested) の件数。 */
  readonly total: number;
  /**
   * decision 別の解決件数。TDA-1 (Phase 4 R2): backend 合成の relay_lost retire は**含めない**
   * (operator の決定でも agent へ届いた deny でもないため hard/soft gate へ計上しない)。
   */
  readonly by_decision: AuditDecisionTally;
  /**
   * TDA-1 (Phase 4 R2): backend 合成 (resolution_origin=relay_lost) で retire された件数。
   * 「daemon 再起動等で中継が失われ、operator が決定できないまま非 actionable 化された」観測で
   * あり、gate 実施と偽らないための別立て集計。
   *
   * 意味論の正直な開示 (TDA-R2-5/SEC-R2-6 R3):
   *  - 集計単位は **resolved イベント数** (by_decision と同じ)。同一 request_id に合成 cancel と
   *    実 resolved が両方残る既知エッジ (ADR 0014 開示) では両方が各々の枠に 1 ずつ数えられ、
   *    pending がその分過少 (clamp 0) になりうる — request 単位 dedup は entries 側のみ。
   *  - 判定は producer 申告の resolution_origin による。「backend が合成した」ことのサーバ権威
   *    marker は無く、INGEST_TOKEN 境界の内側では申告ベース (relay_lost を申告した resolved の
   *    件数) — 境界内で任意イベントを書ける前提は従来と同じで新たな権限昇格ではない。
   */
  readonly synthetic_retired: number;
  /** 要求されたが decision が記録されていない件数 (= total - Σby_decision - synthetic_retired, clamp ≥0)。 */
  readonly pending: number;
}

export interface AuditSessionSummary {
  readonly session_id: string;
  readonly provider: string;
  readonly source: string;
  readonly agent_id: string | undefined;
  readonly repo: string | undefined;
  readonly branch: string | undefined;
  readonly cwd: string | undefined;
  readonly capture_mode: string | undefined;
  readonly permission_mode: string | undefined;
  readonly state: string | undefined;
  readonly started_at: string | undefined;
  readonly ended_at: string | undefined;
  readonly last_event_at: string | undefined;
  readonly secret_detected: boolean;
  readonly secret_redaction_count: number;
  /** kind 別件数 (closed-enum gate 済 = 既知 kind のみ・原文非依存)。 */
  readonly secret_redaction_count_by_kind: Record<string, number>;
  readonly approvals: AuditApprovalSummary;
  /** risk_level が high/critical の承認要求件数。 */
  readonly high_risk_op_count: number;
  /**
   * 無プロンプト自動許可 (allowlist / session-grant) の **full-session** 件数。events の auto_allowed
   * マーカー由来だが by_decision / high_risk_op_count と同じく **SQL full 集計**で打ち切り非依存
   * (TDA-1: レビュー・パケットの governance がこれを走査する・truncated events を数える過少計上を排除)。
   */
  readonly auto_allowed_count: number;
  /** per-session 詳細 (/:id) でのみ付く承認エントリ列。一覧では undefined。 */
  readonly entries?: readonly AuditApprovalEntry[];
}

export interface AuditRangeTotals {
  readonly secret_redaction_count: number;
  readonly secret_redaction_count_by_kind: Record<string, number>;
  readonly approvals_by_decision: AuditDecisionTally;
  /** TDA-1 (Phase 4 R2): relay_lost 合成 retire の range 合計 (by_decision 非含・別立て)。 */
  readonly synthetic_retired: number;
  readonly approval_total: number;
  readonly high_risk_op_count: number;
  /** 無プロンプト自動許可 (auto_allowed=true) の range 合計。high_risk_op_count と対称 (QA-1)。 */
  readonly auto_allowed_count: number;
  readonly sessions_with_secret: number;
}

export interface AuditRangeReport {
  /** ISO8601 (指定なしは undefined = 全期間)。 */
  readonly from: string | undefined;
  readonly to: string | undefined;
  /** レポート生成時刻 (ISO8601)。 */
  readonly generated_at: string;
  readonly session_count: number;
  readonly totals: AuditRangeTotals;
  readonly sessions: readonly AuditSessionSummary[];
  readonly limit: number;
  readonly has_more: boolean;
}

export const DEFAULT_AUDIT_LIMIT = 100;
export const MAX_AUDIT_LIMIT = 500;

export function normalizeAuditLimit(raw: unknown): number {
  if (typeof raw !== "string" || raw.length === 0) return DEFAULT_AUDIT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_AUDIT_LIMIT;
  return Math.min(n, MAX_AUDIT_LIMIT);
}

/**
 * `from`/`to` クエリを ISO8601 へ正規化する。空/不正は undefined (= 無制限境界)。
 * from>to のような矛盾は呼び出し側で空結果に倒す (over-fetch しない)。
 */
export function normalizeAuditInstant(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return undefined;
  return new Date(t).toISOString();
}

// ---------------------------------------------------------------------------
// Redaction drill-down (ガバナンス証跡の集計→個別イベント展開).
//
// 監査詳細の kind 別件数 (例 `high-entropy-secret ×2672`) から「どのイベントで・いつ」その
// redaction が起きたかを個別に辿るための read-only DTO。**INV-AUDIT-EXPORT-NO-RAW を踏襲**し
// 原文秘匿は一切載せない:
//  - `kind` は closed-enum (event-model REDACTION_KINDS) で**検証済み**の公開 enum。
//  - `count` は当該イベント内の `[REDACTED:<kind>]` マーカー件数 (非負整数・原文非依存)。
//  - `command` / `path` は at-rest redacted な events.payload の allow-list 投影
//    (replay / 承認エントリと同一の redacted 列・backend は再 redaction しない)。生 payload・
//    非 allow-list キーは投影しない (SELECT が固定 allow-list)。
// ---------------------------------------------------------------------------

/** 当該 kind の redaction が発生した 1 イベント (allow-list・原文非載せ)。 */
export interface RedactionOccurrence {
  readonly event_id: string;
  readonly timestamp: string;
  readonly event_type: string;
  /** この event 内の当該 kind の redaction マーカー件数 (>=1)。 */
  readonly count: number;
  /** 文脈用の redaction 済み command (Bash 等)。無ければ undefined。 */
  readonly command: string | undefined;
  /** 文脈用の redaction 済み path (file_path フォールバック)。Edit/Write 等。 */
  readonly path: string | undefined;
}

export interface RedactionOccurrences {
  readonly session_id: string;
  /** 検証済み redaction kind (closed-enum)。 */
  readonly kind: string;
  /** この応答 (limit 内) に含まれる occurrence の count 合算。 */
  readonly total: number;
  readonly occurrences: readonly RedactionOccurrence[];
  readonly limit: number;
  readonly has_more: boolean;
}

export const DEFAULT_REDACTION_OCCURRENCE_LIMIT = 200;
export const MAX_REDACTION_OCCURRENCE_LIMIT = 1000;

export function normalizeRedactionOccurrenceLimit(raw: unknown): number {
  if (typeof raw !== "string" || raw.length === 0) return DEFAULT_REDACTION_OCCURRENCE_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_REDACTION_OCCURRENCE_LIMIT;
  return Math.min(n, MAX_REDACTION_OCCURRENCE_LIMIT);
}

/**
 * `kind` クエリを closed-enum (REDACTION_KINDS) で検証する。未知/不正は undefined を返し、
 * route が 400 にする (phantom kind をスキャン対象にしない = 構造的に語彙外を弾く)。
 */
export function normalizeRedactionKind(raw: unknown): RedactionKind | undefined {
  return typeof raw === "string" && isKnownRedactionKind(raw) ? (raw as RedactionKind) : undefined;
}

// ---------------------------------------------------------------------------
// CSV export (INV-AUDIT-EXPORT-NO-RAW: 集計値・enum・メタのみ。原文非載せ)。
// ---------------------------------------------------------------------------

/**
 * RFC4180 寄りの CSV セル escape。
 * - **CSV formula injection 防止 (SEC)**: 先頭が `=`/`+`/`-`/`@`/`|`/tab/CR/LF のセルは
 *   Excel/Sheets/LibreOffice が数式・DDE として実行しうる (repo/branch/agent_id 等 git/agent 由来の
 *   free-text が該当しうる。`|` は DDE ベクタ・LF も先頭中和対象に含める = CR/LF 対称)。先頭に `'` を
 *   付けてテキスト化し中和する。件数 (非負整数) は先頭が数字ゆえ影響しない。
 * - カンマ/改行/引用符を含むなら `"..."` で括り `"` を `""` にエスケープ。
 */
export function csvCell(value: string | number | boolean | undefined): string {
  if (value === undefined) return "";
  let s = String(value);
  if (/^[=+\-@\t\r\n|]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * kind 別件数を `kind:count;...` の 1 文字列へ畳む (原文非載せ・closed-enum kind + 非負整数のみ)。
 * CSV / HTML / Markdown の全 range formatter がこの単一ソースを共有し、区切りドリフトを防ぐ
 * (TDA-1・decision 019f235a: 以前 CSV が `;`・HTML/MD が `; ` と分岐していた)。区切りは機械 CSV の
 * セル内 split 安全側で `;` (空白なし) に統一する。
 */
export function foldByKind(byKind: Record<string, number>): string {
  return Object.entries(byKind)
    .map(([k, v]) => `${k}:${v}`)
    .join(";");
}

/**
 * range レポートを per-session 1 行の CSV へ整形する (監査台帳)。kind 別件数は
 * `kind:count;...` の 1 セルへ畳む (列数を固定し原文を載せない)。
 */
export function auditReportToCsv(report: AuditRangeReport): string {
  const header = [
    "session_id",
    "provider",
    "agent_id",
    "repo",
    "branch",
    "state",
    "started_at",
    "ended_at",
    "secret_detected",
    "secret_redaction_count",
    "redaction_by_kind",
    "approvals_total",
    "approve",
    "allow_for_session",
    "deny",
    "cancel",
    "synthetic_retired",
    "approvals_pending",
    "high_risk_op_count",
    "auto_allowed_count",
  ];
  const lines = [header.join(",")];
  for (const s of report.sessions) {
    const byKind = foldByKind(s.secret_redaction_count_by_kind);
    lines.push(
      [
        csvCell(s.session_id),
        csvCell(s.provider),
        csvCell(s.agent_id),
        csvCell(s.repo),
        csvCell(s.branch),
        csvCell(s.state),
        csvCell(s.started_at),
        csvCell(s.ended_at),
        csvCell(s.secret_detected),
        csvCell(s.secret_redaction_count),
        csvCell(byKind),
        csvCell(s.approvals.total),
        csvCell(s.approvals.by_decision.allow),
        csvCell(s.approvals.by_decision.allow_for_session),
        csvCell(s.approvals.by_decision.deny),
        csvCell(s.approvals.by_decision.cancel),
        csvCell(s.approvals.synthetic_retired),
        csvCell(s.approvals.pending),
        csvCell(s.high_risk_op_count),
        csvCell(s.auto_allowed_count),
      ].join(","),
    );
  }
  return lines.join("\r\n");
}
