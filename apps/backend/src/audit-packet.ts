/**
 * Review Packet — 改竄検知レビュー・パケット (ADR 6点強化 #2).
 *
 * 多セッションを **1 つの共有可能・独立検証可能なレビュー成果物** に束ねる。受け手は成果物を受け取る
 * だけで検証でき、operator マシンへの live アクセスを要さない (単一オペレータ信頼境界を壊さない・ADR
 * 019e92ae)。#1 の per-session tamper-evident manifest を要素とし、packet manifest がそれら root を
 * 束ねて全体の改竄を検知する (audit-integrity.ts の chain を合成再利用・新規暗号ゼロ)。
 *
 * ## ガバナンス集計 (EU AI Act Art.12 hook)
 * 各承認介入を hard/soft/auto の 3 分類で集約する:
 *  - **hard gate (denied/blocked)** = `approvals.by_decision.deny + cancel` (timeout→deny 含む。
 *    SEC-R4-7 開示: child_exit/shutdown 由来の deny も含む — agent へは not_sent だが安全側 deny の
 *    発動として計上する。除外は origin=relay_lost の単一値のみ)。
 *    TDA-1 (Phase 4 R2): backend 合成の relay_lost retire は by_decision に**含まれない**
 *    (audit-store foldApprovals が origin で分離・summary.approvals.synthetic_retired に別立て) —
 *    誰も決定していない取消を「実施した gate」と数えない。what-to-review では reason=relay_lost
 *    で itemize される。
 *  - **soft gate (allowed-after-prompt)** = `approvals.by_decision.allow + allow_for_session`
 *    (各 resolved = プロンプトが出て operator が明示選択した)。
 *  - **auto-allowed (無プロンプト)** = `summary.auto_allowed_count` (audit-store の **full-session SQL
 *    集計**・events の auto_allowed マーカー由来だが by_decision / high_risk と同じ full 集計で
 *    report route の 10000-event 打ち切りに非依存・TDA-1)。auto-allow は承認イベントを一切生成しない
 *    (start イベントの payload にのみ auto_allowed マーカーが付く) ため by_decision には混入せず
 *    operator 明示 allow と構造分離される。**注意**: `AuditApprovalEntry.auto_allowed` はデッド
 *    フィールドゆえ使わない (要求イベントは auto_allowed を載せない)。
 *
 * ## INV-AUDIT-EXPORT-NO-RAW を継承
 * packet も集計値 (非負整数) + closed-enum (decision/reason) + redacted 表示列 (flagged の subject =
 * entries.command??path・at-rest redacted) のみを載せ、生 secret / 生 payload を再導入しない。
 * per-session の描画は audit-report.ts の body renderer を再利用し (全値 htmlEscape/mdCell 済)、
 * 新 redaction 面をゼロに保つ。
 */

import { isSyntheticRetireOrigin, SYNTHETIC_RETIRE_ORIGIN } from "@actradeck/event-model";

import type { AuditSessionSummary } from "./audit-contract.js";
import { foldByKind } from "./audit-contract.js";
import type { AuditSessionReport } from "./audit-report.js";
import {
  dash,
  htmlDoc,
  htmlEscape,
  integritySectionHtml,
  integritySectionMarkdown,
  mdCell,
  sessionReportBodyHtml,
  sessionReportBodyMarkdown,
} from "./audit-report.js";
import {
  AUDIT_PACKET_MANIFEST_MARKER,
  buildPacketManifest,
  encodePacketManifestBase64,
  fingerprintOfPublicKey,
  type AuditManifest,
  type AuditSigner,
  type PacketManifest,
  type PacketManifestGovernance,
} from "./audit-integrity.js";

/** high-risk とみなす risk_level (audit-store の HIGH_RISK_LEVELS と同義)。 */
const HIGH_RISK_LEVELS = new Set(["high", "critical"]);

// ---------------------------------------------------------------------------
// Governance derivation (per-session + cross-session).
// ---------------------------------------------------------------------------

/** 1 セッションのガバナンス分類 (hard/soft/auto + 高リスク + redaction 件数)。 */
export interface SessionGovernance {
  /** denied/blocked = deny + cancel (timeout-deny 含む・relay_lost 合成 retire は非含・TDA-1 R2)。 */
  readonly hard_gate: number;
  /** allowed-after-prompt = allow + allow_for_session (operator 明示)。 */
  readonly soft_gate: number;
  /** 無プロンプト自動許可 = events の auto_allowed===true 件数 (start イベント 1:1)。 */
  readonly auto_allowed: number;
  readonly high_risk_op_count: number;
  readonly secret_redaction_count: number;
}

/** what-to-review digest の 1 項目 (redacted 表示列のみ・NO-RAW)。 */
export interface FlaggedItem {
  readonly session_id: string;
  readonly reason: "denied" | "high_risk" | "relay_lost";
  readonly risk_level: string;
  readonly decision: string;
  /** 対象 (redacted command ?? path・生 secret 非載せ)。 */
  readonly subject: string;
}

/** cross-session のガバナンス集計 + what-to-review。 */
export interface PacketGovernanceSummary {
  readonly session_count: number;
  readonly hard_gate: number;
  readonly soft_gate: number;
  readonly auto_allowed: number;
  readonly high_risk_op_count: number;
  readonly secret_redaction_count: number;
  readonly redaction_by_kind: Record<string, number>;
  readonly flagged: readonly FlaggedItem[];
}

/**
 * 1 セッションの summary からガバナンス分類を導出する。全指標が summary の **full-session SQL 集計**
 * 由来で対称 (TDA-1): hard/soft は by_decision、auto は `auto_allowed_count`、high_risk/redaction も
 * summary。以前 auto を `report.events` (10000-event 打ち切り) 走査していたため 10000 超セッションで
 * auto のみ過少計上する非対称があった → summary の full 集計へ切替えて打ち切り依存を排除した。
 */
export function deriveSessionGovernance(summary: AuditSessionSummary): SessionGovernance {
  const d = summary.approvals.by_decision;
  return {
    hard_gate: d.deny + d.cancel,
    soft_gate: d.allow + d.allow_for_session,
    auto_allowed: summary.auto_allowed_count,
    high_risk_op_count: summary.high_risk_op_count,
    secret_redaction_count: summary.secret_redaction_count,
  };
}

/**
 * summary.entries から what-to-review 項目を導出する。denied/cancel を最優先 (hard gate)、それ以外の
 * high/critical を high_risk として拾う。entries は承認 **要求** (`tool.permission.requested`) の
 * allow-list 投影 (command/path は at-rest redacted) ゆえ NO-RAW。
 *
 * **既知の限界 (SEC-3/TDA-2)**: 無プロンプト自動許可 (auto-allowed) の操作は承認イベントを一切生成せず
 * entries に不在ゆえ、**auto-allowed の high-risk は本ダイジェストに itemize されない** (件数は
 * governance の `auto_allowed` に集計される・per-session timeline で辿れる)。ここが拾うのは
 * 「プロンプトが出て operator が明示決定した」承認ゲート操作のみ。itemize は後続 Phase/UI。
 */
function deriveFlagged(summary: AuditSessionSummary): FlaggedItem[] {
  const out: FlaggedItem[] = [];
  for (const e of summary.entries ?? []) {
    const subject = e.command ?? e.path ?? "";
    if (e.decision === "deny" || e.decision === "cancel") {
      out.push({
        session_id: summary.session_id,
        // TDA-1 (Phase 4 R2): relay_lost 合成 retire は「誰も決定していない・agent へ何も届いて
        // いない」— operator の denied と偽らず別 reason で itemize する (hard_gate 計上は
        // by_decision 側で既に除外済み)。
        reason: isSyntheticRetireOrigin(e.resolution_origin) ? SYNTHETIC_RETIRE_ORIGIN : "denied",
        risk_level: e.risk_level ?? "",
        decision: e.decision,
        subject,
      });
    } else if (e.risk_level !== undefined && HIGH_RISK_LEVELS.has(e.risk_level)) {
      out.push({
        session_id: summary.session_id,
        reason: "high_risk",
        risk_level: e.risk_level,
        decision: e.decision ?? "",
        subject,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Packet assembly.
// ---------------------------------------------------------------------------

/** packet 内の 1 セッション (per-session report + per-session manifest + 導出ガバナンス)。 */
export interface ReviewPacketSessionEntry {
  readonly report: AuditSessionReport;
  /** per-session tamper-evident manifest (受け手は各セッションを個別検証もできる)。 */
  readonly manifest: AuditManifest;
  readonly governance: SessionGovernance;
}

export interface ReviewPacket {
  readonly generated_at: string;
  readonly sessions: readonly ReviewPacketSessionEntry[];
  readonly governance: PacketGovernanceSummary;
  /** packet 全体の tamper-evident manifest (session roots + governance を束ねる)。 */
  readonly manifest: PacketManifest;
}

/** cross-session の redaction 件数を kind 別に合算する (決定論・key 単純加算)。 */
function mergeRedactionByKind(
  entries: readonly ReviewPacketSessionEntry[],
): Record<string, number> {
  const byKind: Record<string, number> = {};
  for (const e of entries) {
    for (const [k, v] of Object.entries(e.report.summary.secret_redaction_count_by_kind)) {
      byKind[k] = (byKind[k] ?? 0) + v;
    }
  }
  return byKind;
}

/**
 * per-session report + manifest 群からレビュー・パケットを組み立てる。ガバナンスを集約し、packet
 * manifest を構築する (signer があれば署名)。入力の report/manifest は既に redacted-at-rest DTO から
 * 生成済み (本関数は新 redaction 面ゼロ)。
 */
export function buildReviewPacket(input: {
  readonly generated_at: string;
  readonly sessions: readonly {
    readonly report: AuditSessionReport;
    readonly manifest: AuditManifest;
  }[];
  readonly signer?: AuditSigner;
}): ReviewPacket {
  const entries: ReviewPacketSessionEntry[] = input.sessions.map(({ report, manifest }) => ({
    report,
    manifest,
    governance: deriveSessionGovernance(report.summary),
  }));

  const flagged = entries.flatMap((e) => deriveFlagged(e.report.summary));
  const redactionByKind = mergeRedactionByKind(entries);
  const gov: PacketGovernanceSummary = {
    session_count: entries.length,
    hard_gate: entries.reduce((n, e) => n + e.governance.hard_gate, 0),
    soft_gate: entries.reduce((n, e) => n + e.governance.soft_gate, 0),
    auto_allowed: entries.reduce((n, e) => n + e.governance.auto_allowed, 0),
    high_risk_op_count: entries.reduce((n, e) => n + e.governance.high_risk_op_count, 0),
    secret_redaction_count: entries.reduce((n, e) => n + e.governance.secret_redaction_count, 0),
    redaction_by_kind: redactionByKind,
    flagged,
  };

  // packet manifest governance canonical (全て文字列・by_kind は key 昇順・flagged はタプル)。
  const packetGov: PacketManifestGovernance = {
    session_count: String(gov.session_count),
    hard_gate: String(gov.hard_gate),
    soft_gate: String(gov.soft_gate),
    auto_allowed: String(gov.auto_allowed),
    high_risk_op_count: String(gov.high_risk_op_count),
    secret_redaction_count: String(gov.secret_redaction_count),
    redaction_by_kind: Object.entries(redactionByKind)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
      .map(([k, v]) => [k, String(v)] as const),
    flagged: flagged.map(
      (f) => [f.session_id, f.reason, f.risk_level, f.decision, f.subject] as const,
    ),
  };

  const manifest = buildPacketManifest(
    {
      generated_at: input.generated_at,
      sessions: entries.map((e) => ({
        session_id: e.report.summary.session_id,
        root: e.manifest.root,
        event_count: e.manifest.event_count,
        events_truncated: e.report.events_truncated,
        hard_gate: e.governance.hard_gate,
        soft_gate: e.governance.soft_gate,
        auto_allowed: e.governance.auto_allowed,
      })),
      governance: packetGov,
    },
    input.signer,
  );

  return { generated_at: input.generated_at, sessions: entries, governance: gov, manifest };
}

// ---------------------------------------------------------------------------
// HTML rendering (self-contained・全値 htmlEscape 済・NO-RAW を継承)。
// ---------------------------------------------------------------------------

function governanceSummaryHtml(g: PacketGovernanceSummary): string {
  return `<table>
<tr><th>sessions</th><td>${htmlEscape(g.session_count)}</td></tr>
<tr><th>hard gates (denied/blocked)</th><td class="flag-yes">${htmlEscape(g.hard_gate)}</td></tr>
<tr><th>soft gates (allowed-after-prompt)</th><td>${htmlEscape(g.soft_gate)}</td></tr>
<tr><th>auto-allowed (allowlist / session-grant)</th><td>${htmlEscape(g.auto_allowed)}</td></tr>
<tr><th>high-risk requests</th><td>${htmlEscape(g.high_risk_op_count)}</td></tr>
<tr><th>secrets redacted</th><td>${htmlEscape(g.secret_redaction_count)}</td></tr>
<tr><th>redacted by kind</th><td class="mono">${htmlEscape(foldByKind(g.redaction_by_kind))}</td></tr>
</table>`;
}

function whatToReviewHtml(flagged: readonly FlaggedItem[]): string {
  if (flagged.length === 0) {
    return `<p class="meta">(no denied or high-risk operations flagged)</p>`;
  }
  const header = `<thead><tr><th>#</th><th>session</th><th>reason</th><th>risk</th><th>decision</th><th>command / path</th></tr></thead>`;
  const rows = flagged
    .map(
      (f, i) => `<tr>
<td>${i + 1}</td>
<td class="mono">${htmlEscape(f.session_id)}</td>
<td class="${f.reason === "denied" ? "flag-yes" : ""}">${htmlEscape(f.reason)}</td>
<td>${htmlEscape(dash(f.risk_level))}</td>
<td>${htmlEscape(dash(f.decision))}</td>
<td class="mono">${htmlEscape(dash(f.subject))}</td>
</tr>`,
    )
    .join("\n");
  return `<table>${header}<tbody>${rows}</tbody></table>`;
}

/**
 * packet 全体の Integrity 章 (packet manifest を human-readable + base64 埋込)。
 *
 * TDA-5: #1 の `integritySectionHtml`(per-session 用に再利用済) と skeleton は似るが、**意図的に別物**:
 * packet manifest 型 (session_count / packet root)・別マーカー (`AUDIT_PACKET_MANIFEST_MARKER`)・別 verify
 * endpoint (`/packet/verify`) を持つ。共有 escape/base64 原始関数は既に再利用済で、残る差異は content ゆえ
 * 過度な helper 集約はせず両者を明示的に分ける (leak/契約リスクなし)。
 */
function packetIntegritySectionHtml(m: PacketManifest): string {
  const sig = m.signature;
  const b64 = encodePacketManifestBase64(m);
  const rows = [
    ["algorithm", `${htmlEscape(m.algorithm)}${sig ? " + ed25519" : ""}`],
    ["session_count", htmlEscape(m.session_count)],
    ["packet root (sha256 chain)", `<span class="mono">${htmlEscape(m.root)}</span>`],
    ["signed", sig ? `<span class="flag-yes">yes</span>` : "no (chain only)"],
  ];
  if (sig) {
    rows.push([
      "key fingerprint (sha256)",
      `<span class="mono">${htmlEscape(fingerprintOfPublicKey(sig.public_key))}</span>`,
    ]);
  }
  const note = sig
    ? "この署名は「配布後の改竄」を検知します。受け手は上記 fingerprint を既知の operator 公開鍵と照合してください (埋込鍵の盲信不可)。at-rest (export 前の DB 改竄) は本モデルの対象外です。各セッションは per-session manifest で個別にも検証できます。"
    : "未署名: 内部整合 (chain) のみ。配布後改竄の暗号学的検知には ACTRADECK_AUDIT_SIGNING_KEY で署名を有効化してください。";
  // base64 は HTML コメントへ verbatim 埋込 (self-contained・no <script>・base64 は `-->` を含まない)。
  return [
    `<h2>Integrity (tamper-evidence)</h2>`,
    `<table>${rows.map(([k, v]) => `<tr><th>${htmlEscape(k)}</th><td>${v}</td></tr>`).join("")}</table>`,
    `<p class="meta">${htmlEscape(note)}</p>`,
    `<p class="meta">検証: 埋込 packet manifest を <code>POST /realtime/audit/packet/verify</code> へ渡すと ok/改竄が判定されます。</p>`,
    `<!-- ${AUDIT_PACKET_MANIFEST_MARKER}+base64:${b64}:end-${AUDIT_PACKET_MANIFEST_MARKER} -->`,
  ].join("\n");
}

/** レビュー・パケットを self-contained HTML へ描画する (全値 htmlEscape 済・NO-RAW)。 */
export function renderReviewPacketHtml(packet: ReviewPacket): string {
  const parts = [
    `<h1>Agent Governance Review Packet</h1>`,
    `<p class="meta">generated_at: ${htmlEscape(packet.generated_at)} / sessions: ${htmlEscape(
      packet.governance.session_count,
    )}</p>`,
    `<h2>Governance summary</h2>`,
    governanceSummaryHtml(packet.governance),
    `<h2>What to review</h2>`,
    whatToReviewHtml(packet.governance.flagged),
    `<h2>Sessions (${htmlEscape(packet.sessions.length)})</h2>`,
  ];
  for (const e of packet.sessions) {
    parts.push(
      `<h2>Session <span class="mono">${htmlEscape(e.report.summary.session_id)}</span></h2>`,
      `<p class="meta">hard: ${htmlEscape(e.governance.hard_gate)} / soft: ${htmlEscape(
        e.governance.soft_gate,
      )} / auto: ${htmlEscape(e.governance.auto_allowed)} / high-risk: ${htmlEscape(
        e.governance.high_risk_op_count,
      )} / redactions: ${htmlEscape(e.governance.secret_redaction_count)}</p>`,
      sessionReportBodyHtml(e.report, "h3"),
      // SEC-2: 各セッション body (timeline / diff 本文) は per-session manifest を成果物へ埋込んで
      //   はじめて成果物単体から検証可能になる。#1 の integritySection を再利用し、per-session manifest
      //   (root == packet.sessions[i].root) を埋める (JSON だけでなく HTML/MD でも body 改竄が検知可能)。
      integritySectionHtml(e.manifest),
    );
  }
  parts.push(packetIntegritySectionHtml(packet.manifest));
  return htmlDoc("Agent Governance Review Packet", parts.join("\n"));
}

// ---------------------------------------------------------------------------
// Markdown rendering.
// ---------------------------------------------------------------------------

function packetIntegritySectionMarkdown(m: PacketManifest): string[] {
  const sig = m.signature;
  const lines = [
    `## Integrity (tamper-evidence)`,
    ``,
    `| field | value |`,
    `| --- | --- |`,
    `| algorithm | ${mdCell(m.algorithm)}${sig ? " + ed25519" : ""} |`,
    `| session_count | ${mdCell(m.session_count)} |`,
    `| packet root (sha256 chain) | \`${mdCell(m.root)}\` |`,
    `| signed | ${sig ? "**yes**" : "no (chain only)"} |`,
  ];
  if (sig)
    lines.push(
      `| key fingerprint (sha256) | \`${mdCell(fingerprintOfPublicKey(sig.public_key))}\` |`,
    );
  lines.push(
    ``,
    sig
      ? `_この署名は「配布後の改竄」を検知します。受け手は上記 fingerprint を既知の operator 公開鍵と照合してください (埋込鍵の盲信不可)。at-rest (export 前の DB 改竄) は本モデルの対象外。各セッションは per-session manifest で個別にも検証できます。_`
      : `_未署名: 内部整合 (chain) のみ。配布後改竄の暗号学的検知には ACTRADECK_AUDIT_SIGNING_KEY で署名を有効化してください。_`,
    ``,
    `_検証: 下記 packet manifest を \`POST /realtime/audit/packet/verify\` へ渡すと ok/改竄が判定されます。_`,
    ``,
    `\`\`\`${AUDIT_PACKET_MANIFEST_MARKER}`,
    encodePacketManifestBase64(m),
    `\`\`\``,
    ``,
  );
  return lines;
}

/** レビュー・パケットを Markdown へ描画する (テーブルセルは mdCell escape 済)。 */
export function renderReviewPacketMarkdown(packet: ReviewPacket): string {
  const g = packet.governance;
  const lines: string[] = [];
  lines.push(
    `# Agent Governance Review Packet`,
    ``,
    `_generated_at: ${mdCell(packet.generated_at)} / sessions: ${g.session_count}_`,
    ``,
    `## Governance summary`,
    ``,
    `| metric | value |`,
    `| --- | --- |`,
    `| sessions | ${g.session_count} |`,
    `| hard gates (denied/blocked) | ${g.hard_gate} |`,
    `| soft gates (allowed-after-prompt) | ${g.soft_gate} |`,
    `| auto-allowed (allowlist / session-grant) | ${g.auto_allowed} |`,
    `| high-risk requests | ${g.high_risk_op_count} |`,
    `| secrets redacted | ${g.secret_redaction_count} |`,
    `| redacted by kind | ${mdCell(foldByKind(g.redaction_by_kind))} |`,
    ``,
    `## What to review`,
    ``,
  );
  if (g.flagged.length === 0) {
    lines.push(`_(no denied or high-risk operations flagged)_`, ``);
  } else {
    lines.push(
      `| # | session | reason | risk | decision | command / path |`,
      `| --- | --- | --- | --- | --- | --- |`,
    );
    g.flagged.forEach((f, i) => {
      lines.push(
        `| ${i + 1} | ${mdCell(f.session_id)} | ${mdCell(f.reason)} | ${mdCell(
          dash(f.risk_level),
        )} | ${mdCell(dash(f.decision))} | ${mdCell(dash(f.subject))} |`,
      );
    });
    lines.push(``);
  }

  lines.push(`## Sessions (${packet.sessions.length})`, ``);
  for (const e of packet.sessions) {
    lines.push(
      `## Session ${mdCell(e.report.summary.session_id)}`,
      ``,
      `_hard: ${e.governance.hard_gate} / soft: ${e.governance.soft_gate} / auto: ${e.governance.auto_allowed} / high-risk: ${e.governance.high_risk_op_count} / redactions: ${e.governance.secret_redaction_count}_`,
      ``,
    );
    lines.push(...sessionReportBodyMarkdown(e.report, "###"));
    // SEC-2: per-session manifest を埋込み body (timeline/diff) を成果物単体から検証可能にする。
    lines.push(...integritySectionMarkdown(e.manifest));
  }
  lines.push(...packetIntegritySectionMarkdown(packet.manifest));
  return lines.join("\n");
}
