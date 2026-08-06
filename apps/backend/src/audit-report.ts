/**
 * Audit report HTML / Markdown export (P2・ADR 019f2326).
 *
 * JSON/CSV に続く HTML / Markdown export。**INV-AUDIT-EXPORT-NO-RAW を html/md へ拡張**する:
 * 本モジュールの formatter は **既存の redacted-at-rest DTO のみ**を入力に取り、生 payload・
 * 未 redact stdout (`commandOutput`)・新規 raw 列を SELECT/参照しない (no-raw を構造継承)。
 *  - 入力 = `AuditRangeReport` / `AuditSessionSummary` / `ReplayEventDTO` / `RedactionOccurrences`
 *    由来の allow-list フィールドのみ。これらは replay / 承認エントリと同一の at-rest redacted 列で、
 *    backend は再 redaction しない (sidecar choke が唯一の権威)。
 *  - redaction は **kind 名 (closed-enum) + 非負整数件数**のみ。原文・値は載せない。
 *  - diff は sidecar が redaction 済みの本文を on-demand で返したもの (backend は再 redaction も
 *    永続もしない)。
 *
 * ## HTML escape (XSS / injection 防御)
 * CSV の formula-injection 中和 (`csvCell`) と同じ思想を **HTML escape** へ持ち込む。redacted 値
 * (command / path / reason / error / repo / branch / agent_id 等) は redaction 後も `<` `>` `"` `'` `&`
 * を含みうる (redaction は secret を消すだけで HTML メタ文字は残す)。全出力値を `htmlEscape` に
 * 通し、`<script>` / 属性 injection が redacted 文字列経由でも起きないようにする。生成 HTML は
 * self-contained (外部 JS / CDN 非依存・inline `<style>` のみ)。
 */

import { SYNTHETIC_RETIRE_ORIGIN } from "@actradeck/event-model";

import type { AuditRangeReport, AuditSessionSummary } from "./audit-contract.js";
import { foldByKind } from "./audit-contract.js";
import type { ReplayEventDTO } from "./replay-contract.js";
import {
  encodeManifestBase64,
  fingerprintOfPublicKey,
  AUDIT_MANIFEST_MARKER,
  type AuditManifest,
} from "./audit-integrity.js";

// ---------------------------------------------------------------------------
// Escaping primitives.
// ---------------------------------------------------------------------------

/**
 * HTML テキスト / 属性値 escape (XSS 防御・SEC)。`&` を最初に置換 (二重 escape を避ける)。
 * `<`/`>` でタグ注入を、`"`/`'` で属性境界脱出を封じる。undefined は空文字。
 * 件数 (number) / boolean も文字列化して escape (型に依存せず一様に無害化)。
 */
export function htmlEscape(value: string | number | boolean | undefined): string {
  if (value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Markdown テーブルセル escape。redacted 値でも次の構造/注入リスクが残るため中和する:
 *  - `|` は列区切りを壊し、CR/LF は行を割る → backslash escape / 空白畳み。
 *  - `<`/`>` は **raw-HTML を許可する非 sanitize renderer** で inline-HTML/タグ注入を許す (SEC-1) →
 *    `&lt;`/`&gt;` へ中和。CommonMark は実体参照を literal 表示 (tag 化不能) するため可読性は維持。
 * `\` は他の escape で導入する backslash を二重化しないよう最初に処理する。undefined は空セル。
 * 原文非依存 (redacted 値の構造保全のみ)。
 * 注: markdown link 構文 (`[x](javascript:…)` / `[x](data:…)`) 残余は escape しない (ubiquitous な
 * `[REDACTED:kind]` マーカーの可読性優先で `[`/`]` を残す)。多くの主要 renderer (GitHub/GitLab/
 * VSCode/markdown-it) は link protocol を sanitize するが、一部 (marked 既定) は sanitize せず href
 * を出す。ただし残余は click 必須で `<`/`>` 中和済ゆえ auto-exec な `<img onerror>` 系より厳密に弱く、
 * `data:` は近代ブラウザが top-level nav を block する。副次リスクとして P2 sweep で追跡
 * (SEC-1-followup・decision 019f235a/019f236d)。
 */
export function mdCell(value: string | number | boolean | undefined): string {
  if (value === undefined) return "";
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r\n|\r|\n/g, " ");
}

// ---------------------------------------------------------------------------
// Single-session detail report DTO (route が合成し formatter が描画する純データ)。
// ---------------------------------------------------------------------------

/** on-demand diff の描画用データ (live 接続時のみ本文が付く・切断時は unavailable)。 */
export interface AuditSessionReportDiff {
  readonly available: boolean;
  /** redaction 済み diff 本文 (available=true のときのみ)。生 diff は決して載らない。 */
  readonly body?: string;
  readonly truncated?: boolean;
  readonly secret_detected?: boolean;
  readonly redaction_count?: number;
  /** available=false のときの理由 (session 切断など・原文非依存の固定文)。 */
  readonly unavailable_reason?: string;
}

/**
 * 単一セッション詳細レポート (時系列)。route が `AuditStore.sessionSummary`(detail) +
 * `ReplayStore.eventsPage`(時系列全件・上限内) を合成する。formatter はこの redacted DTO のみ描画する。
 */
export interface AuditSessionReport {
  readonly generated_at: string;
  readonly summary: AuditSessionSummary;
  /** 時系列 (timestamp ASC, event_id ASC) の allow-list 投影イベント。 */
  readonly events: readonly ReplayEventDTO[];
  /** 上限に達して時系列を打ち切ったか (true = 全件でない)。 */
  readonly events_truncated: boolean;
  /** ?diff=1 のときのみ付く on-demand diff。 */
  readonly diff?: AuditSessionReportDiff;
}

// ---------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------

/** 空/undefined を表示用 `"-"` に落とす cosmetic フォールバック (manifest は `""` を binding・非対称は TDA-2)。 */
export function dash(value: string | number | undefined): string {
  return value === undefined || value === "" ? "-" : String(value);
}

// ---------------------------------------------------------------------------
// HTML rendering.
// ---------------------------------------------------------------------------

const HTML_STYLE = `
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; margin: 1.5rem; line-height: 1.4; }
  h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 1.5rem; }
  table { border-collapse: collapse; width: 100%; font-size: 0.85rem; margin: 0.5rem 0; }
  th, td { border: 1px solid #8884; padding: 0.25rem 0.5rem; text-align: left; vertical-align: top; }
  th { background: #8882; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  pre { background: #8881; padding: 0.75rem; overflow-x: auto; white-space: pre-wrap; word-break: break-all; }
  .meta { color: #8889; } .mono { font-family: ui-monospace, monospace; }
  .flag-yes { color: #b00; font-weight: 600; }
`;

/** self-contained HTML ドキュメント wrapper (共有 style・外部参照なし)。packet render も再利用する。 */
export function htmlDoc(title: string, bodyInner: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEscape(title)}</title>
<style>${HTML_STYLE}</style>
</head>
<body>
${bodyInner}
</body>
</html>`;
}

function summaryMetaTableHtml(s: AuditSessionSummary): string {
  const rows: readonly [string, string | undefined][] = [
    ["session_id", s.session_id],
    ["provider", s.provider],
    ["source", s.source],
    ["agent_id", s.agent_id],
    ["repo", s.repo],
    ["branch", s.branch],
    ["cwd", s.cwd],
    ["capture_mode", s.capture_mode],
    ["permission_mode", s.permission_mode],
    ["state", s.state],
    ["started_at", s.started_at],
    ["ended_at", s.ended_at],
    ["last_event_at", s.last_event_at],
  ];
  const body = rows
    .map(
      ([k, v]) => `<tr><th>${htmlEscape(k)}</th><td class="mono">${htmlEscape(v ?? "-")}</td></tr>`,
    )
    .join("\n");
  return `<table>${body}</table>`;
}

function redactionTableHtml(count: number, byKind: Record<string, number>): string {
  const kindRows = Object.entries(byKind);
  const rows =
    kindRows.length === 0
      ? `<tr><td class="meta" colspan="2">(none)</td></tr>`
      : kindRows
          .map(
            ([k, v]) => `<tr><td class="mono">${htmlEscape(k)}</td><td>${htmlEscape(v)}</td></tr>`,
          )
          .join("\n");
  return `<p>secret_redaction_count: <strong>${htmlEscape(count)}</strong></p>
<table><thead><tr><th>kind</th><th>count</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function approvalsTableHtml(s: AuditSessionSummary): string {
  const a = s.approvals;
  return `<table>
<tr><th>total</th><td>${htmlEscape(a.total)}</td></tr>
<tr><th>allow</th><td>${htmlEscape(a.by_decision.allow)}</td></tr>
<tr><th>allow_for_session</th><td>${htmlEscape(a.by_decision.allow_for_session)}</td></tr>
<tr><th>deny</th><td>${htmlEscape(a.by_decision.deny)}</td></tr>
<tr><th>cancel</th><td>${htmlEscape(a.by_decision.cancel)}</td></tr>
<tr><th>synthetic_retired (${SYNTHETIC_RETIRE_ORIGIN})</th><td>${htmlEscape(a.synthetic_retired)}</td></tr>
<tr><th>pending</th><td>${htmlEscape(a.pending)}</td></tr>
<tr><th>high_risk_op_count</th><td>${htmlEscape(s.high_risk_op_count)}</td></tr>
</table>`;
}

function timelineTableHtml(events: readonly ReplayEventDTO[]): string {
  const header = `<thead><tr>
<th>#</th><th>timestamp</th><th>kind</th><th>event_type</th><th>risk</th>
<th>decision</th><th>exit</th><th>ms</th><th>command / path</th></tr></thead>`;
  const rows = events
    .map((e, i) => {
      const subject = e.command ?? e.path ?? e.subject;
      return `<tr>
<td>${i + 1}</td>
<td class="mono">${htmlEscape(e.timestamp)}</td>
<td>${htmlEscape(e.kind)}</td>
<td>${htmlEscape(e.event_type)}</td>
<td>${htmlEscape(dash(e.risk_level))}</td>
<td>${htmlEscape(dash(e.decision))}</td>
<td>${htmlEscape(e.exit_code === undefined ? "-" : e.exit_code)}</td>
<td>${htmlEscape(e.elapsed_ms === undefined ? "-" : e.elapsed_ms)}</td>
<td class="mono">${htmlEscape(subject ?? "-")}</td>
</tr>`;
    })
    .join("\n");
  return `<table>${header}<tbody>${rows}</tbody></table>`;
}

function diffSectionHtml(diff: AuditSessionReportDiff, h: "h2" | "h3" = "h2"): string {
  if (!diff.available) {
    return `<${h}>Diff</${h}><p class="meta">${htmlEscape(
      diff.unavailable_reason ?? "diff 取得不可 (session 切断)",
    )}</p>`;
  }
  const meta = `<p class="meta">truncated: ${htmlEscape(diff.truncated ?? false)} / secret_detected: ${htmlEscape(
    diff.secret_detected ?? false,
  )} / redaction_count: ${htmlEscape(diff.redaction_count ?? 0)}</p>`;
  return `<${h}>Diff (redacted)</${h}>${meta}<pre>${htmlEscape(diff.body ?? "")}</pre>`;
}

/**
 * 単一セッションレポートの本体セクション (Session/Redaction/Approvals/Timeline/Diff) を返す。
 * doc wrapper / h1 / generated_at / integrity は含まない。`h` で見出しタグを可変にし、packet render が
 * セッション見出し (h2) の配下に h3 として埋め込めるようにする (単一 report は既定 h2 で出力不変)。
 */
export function sessionReportBodyHtml(report: AuditSessionReport, h: "h2" | "h3" = "h2"): string {
  const s = report.summary;
  const parts = [
    `<${h}>Session</${h}>`,
    summaryMetaTableHtml(s),
    `<${h}>Redaction</${h}>`,
    redactionTableHtml(s.secret_redaction_count, s.secret_redaction_count_by_kind),
    `<${h}>Approvals</${h}>`,
    approvalsTableHtml(s),
    `<${h}>Timeline (${htmlEscape(report.events.length)} events${
      report.events_truncated ? ", truncated" : ""
    })</${h}>`,
    timelineTableHtml(report.events),
  ];
  if (report.diff !== undefined) parts.push(diffSectionHtml(report.diff, h));
  return parts.join("\n");
}

/**
 * 単一セッション詳細レポートを HTML 化する。`manifest` を渡すと **改竄検知 (tamper-evidence)** の
 * Integrity 章 (人間可読サマリ + base64 埋込 manifest) を末尾に足す (ADR 6点強化 #1)。
 */
export function sessionReportToHtml(report: AuditSessionReport, manifest?: AuditManifest): string {
  const s = report.summary;
  const parts = [
    `<h1>Audit Session Report</h1>`,
    `<p class="meta">generated_at: ${htmlEscape(report.generated_at)}</p>`,
    sessionReportBodyHtml(report, "h2"),
  ];
  if (manifest !== undefined) parts.push(integritySectionHtml(manifest));
  return htmlDoc(`Audit Session Report ${s.session_id}`, parts.join("\n"));
}

/**
 * 改竄検知 (Integrity) 章の HTML。人間可読サマリ (root / 署名 / fingerprint / 検証手順) +
 * verifier が抽出する base64 manifest を **HTML コメント** `<!-- marker+base64:… -->` に埋める。
 * レポート HTML は self-contained (no `<script>`・外部参照なし=XSS 面ゼロ) を不変条件とするため、
 * script タグは使わない。base64 は `-->` を含まないのでコメントを壊さず verbatim 保持=verify 可能。
 */
export function integritySectionHtml(m: AuditManifest): string {
  const sig = m.signature;
  const b64 = encodeManifestBase64(m);
  const rows = [
    ["algorithm", `${htmlEscape(m.algorithm)}${sig ? " + ed25519" : ""}`],
    ["event_count", htmlEscape(m.event_count)],
    ["root (sha256 chain)", `<span class="mono">${htmlEscape(m.root)}</span>`],
    ["signed", sig ? `<span class="flag-yes">yes</span>` : "no (chain only)"],
  ];
  if (sig) {
    rows.push([
      "key fingerprint (sha256)",
      `<span class="mono">${htmlEscape(fingerprintOfPublicKey(sig.public_key))}</span>`,
    ]);
  }
  const note = sig
    ? "この署名は「配布後の改竄」を検知します。受け手は上記 fingerprint を既知の operator 公開鍵と照合してください (埋込鍵の盲信不可)。at-rest (export 前の DB 改竄) は本モデルの対象外です。"
    : "未署名: 内部整合 (chain) のみ。配布後改竄の暗号学的検知には ACTRADECK_AUDIT_SIGNING_KEY で署名を有効化してください。";
  // base64 manifest は **HTML コメント**へ埋める: レポート HTML は self-contained (no <script>・
  // 外部参照なし) を不変条件とするため (XSS 面ゼロ)。base64 は `-->` を含まないのでコメントを壊さず
  // verbatim 保持 (verifier が marker で抽出)。可読サマリ (root/署名/fingerprint) は table に出す。
  return [
    `<h2>Integrity (tamper-evidence)</h2>`,
    `<table>${rows.map(([k, v]) => `<tr><th>${htmlEscape(k)}</th><td>${v}</td></tr>`).join("")}</table>`,
    `<p class="meta">${htmlEscape(note)}</p>`,
    `<p class="meta">検証: 埋込 manifest を <code>POST /realtime/audit/verify</code> へ渡すと ok/改竄が判定されます。</p>`,
    `<!-- ${AUDIT_MANIFEST_MARKER}+base64:${b64}:end-${AUDIT_MANIFEST_MARKER} -->`,
  ].join("\n");
}

/** 期間集計レポートを self-contained HTML へ描画する。 */
export function auditReportToHtml(report: AuditRangeReport): string {
  const header = `<thead><tr>
<th>session_id</th><th>provider</th><th>agent_id</th><th>repo</th><th>branch</th><th>state</th>
<th>started_at</th><th>ended_at</th><th>secret?</th><th>redactions</th><th>by_kind</th>
<th>appr.</th><th>allow</th><th>afs</th><th>deny</th><th>cancel</th><th>retired</th><th>pending</th><th>high_risk</th><th>auto_allowed</th>
</tr></thead>`;
  const rows = report.sessions
    .map(
      (s) => `<tr>
<td class="mono">${htmlEscape(s.session_id)}</td>
<td>${htmlEscape(s.provider)}</td>
<td>${htmlEscape(dash(s.agent_id))}</td>
<td>${htmlEscape(dash(s.repo))}</td>
<td>${htmlEscape(dash(s.branch))}</td>
<td>${htmlEscape(dash(s.state))}</td>
<td class="mono">${htmlEscape(dash(s.started_at))}</td>
<td class="mono">${htmlEscape(dash(s.ended_at))}</td>
<td class="${s.secret_detected ? "flag-yes" : ""}">${htmlEscape(s.secret_detected)}</td>
<td>${htmlEscape(s.secret_redaction_count)}</td>
<td class="mono">${htmlEscape(foldByKind(s.secret_redaction_count_by_kind))}</td>
<td>${htmlEscape(s.approvals.total)}</td>
<td>${htmlEscape(s.approvals.by_decision.allow)}</td>
<td>${htmlEscape(s.approvals.by_decision.allow_for_session)}</td>
<td>${htmlEscape(s.approvals.by_decision.deny)}</td>
<td>${htmlEscape(s.approvals.by_decision.cancel)}</td>
<td>${htmlEscape(s.approvals.synthetic_retired)}</td>
<td>${htmlEscape(s.approvals.pending)}</td>
<td>${htmlEscape(s.high_risk_op_count)}</td>
<td>${htmlEscape(s.auto_allowed_count)}</td>
</tr>`,
    )
    .join("\n");
  const t = report.totals;
  const inner = [
    `<h1>Audit Range Report</h1>`,
    `<p class="meta">generated_at: ${htmlEscape(report.generated_at)} / from: ${htmlEscape(
      dash(report.from),
    )} / to: ${htmlEscape(dash(report.to))} / sessions: ${htmlEscape(report.session_count)}${
      report.has_more ? " (truncated)" : ""
    }</p>`,
    `<h2>Totals</h2>`,
    `<table>
<tr><th>secret_redaction_count</th><td>${htmlEscape(t.secret_redaction_count)}</td></tr>
<tr><th>by_kind</th><td class="mono">${htmlEscape(foldByKind(t.secret_redaction_count_by_kind))}</td></tr>
<tr><th>approval_total</th><td>${htmlEscape(t.approval_total)}</td></tr>
<tr><th>allow / afs / deny / cancel</th><td>${htmlEscape(t.approvals_by_decision.allow)} / ${htmlEscape(
      t.approvals_by_decision.allow_for_session,
    )} / ${htmlEscape(t.approvals_by_decision.deny)} / ${htmlEscape(t.approvals_by_decision.cancel)}</td></tr>
<tr><th>synthetic_retired</th><td>${htmlEscape(t.synthetic_retired)}</td></tr>
<tr><th>high_risk_op_count</th><td>${htmlEscape(t.high_risk_op_count)}</td></tr>
<tr><th>auto_allowed_count</th><td>${htmlEscape(t.auto_allowed_count)}</td></tr>
<tr><th>sessions_with_secret</th><td>${htmlEscape(t.sessions_with_secret)}</td></tr>
</table>`,
    `<h2>Sessions</h2>`,
    `<table>${header}<tbody>${rows}</tbody></table>`,
  ].join("\n");
  return htmlDoc("Audit Range Report", inner);
}

// ---------------------------------------------------------------------------
// Markdown rendering.
// ---------------------------------------------------------------------------

/**
 * 単一セッションレポートの本体セクション (Session/Redaction/Approvals/Timeline/Diff) の Markdown 行を返す。
 * `hp` で見出しレベルを可変にし (単一 report は既定 `##` で出力不変・packet は `###`)、packet render が
 * セッション見出し配下に埋め込めるようにする。h1 / generated_at / integrity は含まない。
 */
export function sessionReportBodyMarkdown(
  report: AuditSessionReport,
  hp: "##" | "###" = "##",
): string[] {
  const s = report.summary;
  const lines: string[] = [];
  lines.push(`${hp} Session`, ``, `| field | value |`, `| --- | --- |`);
  const meta: readonly [string, string | undefined][] = [
    ["session_id", s.session_id],
    ["provider", s.provider],
    ["source", s.source],
    ["agent_id", s.agent_id],
    ["repo", s.repo],
    ["branch", s.branch],
    ["cwd", s.cwd],
    ["capture_mode", s.capture_mode],
    ["permission_mode", s.permission_mode],
    ["state", s.state],
    ["started_at", s.started_at],
    ["ended_at", s.ended_at],
    ["last_event_at", s.last_event_at],
  ];
  for (const [k, v] of meta) lines.push(`| ${mdCell(k)} | ${mdCell(v ?? "-")} |`);
  lines.push(``);

  lines.push(`${hp} Redaction`, ``, `secret_redaction_count: **${s.secret_redaction_count}**`, ``);
  lines.push(`| kind | count |`, `| --- | --- |`);
  const kindRows = Object.entries(s.secret_redaction_count_by_kind);
  if (kindRows.length === 0) lines.push(`| (none) | 0 |`);
  else for (const [k, v] of kindRows) lines.push(`| ${mdCell(k)} | ${v} |`);
  lines.push(``);

  const a = s.approvals;
  lines.push(
    `${hp} Approvals`,
    ``,
    `| metric | value |`,
    `| --- | --- |`,
    `| total | ${a.total} |`,
    `| allow | ${a.by_decision.allow} |`,
    `| allow_for_session | ${a.by_decision.allow_for_session} |`,
    `| deny | ${a.by_decision.deny} |`,
    `| cancel | ${a.by_decision.cancel} |`,
    `| synthetic_retired (${SYNTHETIC_RETIRE_ORIGIN}) | ${a.synthetic_retired} |`,
    `| pending | ${a.pending} |`,
    `| high_risk_op_count | ${s.high_risk_op_count} |`,
    ``,
  );

  lines.push(
    `${hp} Timeline (${report.events.length} events${report.events_truncated ? ", truncated" : ""})`,
    ``,
    `| # | timestamp | kind | event_type | risk | decision | exit | ms | command / path |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- | --- |`,
  );
  report.events.forEach((e, i) => {
    const subject = e.command ?? e.path ?? e.subject;
    lines.push(
      `| ${i + 1} | ${mdCell(e.timestamp)} | ${mdCell(e.kind)} | ${mdCell(e.event_type)} | ${mdCell(
        dash(e.risk_level),
      )} | ${mdCell(dash(e.decision))} | ${mdCell(e.exit_code === undefined ? "-" : e.exit_code)} | ${mdCell(
        e.elapsed_ms === undefined ? "-" : e.elapsed_ms,
      )} | ${mdCell(subject ?? "-")} |`,
    );
  });
  lines.push(``);

  if (report.diff !== undefined) {
    lines.push(`${hp} Diff`, ``);
    if (!report.diff.available) {
      lines.push(
        `_${mdCell(report.diff.unavailable_reason ?? "diff 取得不可 (session 切断)")}_`,
        ``,
      );
    } else {
      lines.push(
        `_truncated: ${report.diff.truncated ?? false} / secret_detected: ${
          report.diff.secret_detected ?? false
        } / redaction_count: ${report.diff.redaction_count ?? 0}_`,
        ``,
        "```diff",
        // fenced code block: 本文はそのまま (redacted 済)。閉じ fence 混入を防ぐため行頭 ``` を退避。
        (report.diff.body ?? "").replace(/```/g, "ˋˋˋ"),
        "```",
        ``,
      );
    }
  }
  return lines;
}

/** 単一セッション詳細レポートを Markdown へ描画する (テーブルセルは mdCell escape 済)。 */
export function sessionReportToMarkdown(
  report: AuditSessionReport,
  manifest?: AuditManifest,
): string {
  const lines: string[] = [];
  lines.push(`# Audit Session Report`, ``, `_generated_at: ${mdCell(report.generated_at)}_`, ``);
  lines.push(...sessionReportBodyMarkdown(report, "##"));
  if (manifest !== undefined) lines.push(...integritySectionMarkdown(manifest));
  return lines.join("\n");
}

/**
 * 改竄検知 (Integrity) 章の Markdown。人間可読サマリ + verifier 抽出用の base64 manifest を
 * ` ```<marker> ` fenced block に置く (base64 は backtick を含まないので fence を壊さず verbatim)。
 */
export function integritySectionMarkdown(m: AuditManifest): string[] {
  const sig = m.signature;
  const lines = [
    `## Integrity (tamper-evidence)`,
    ``,
    `| field | value |`,
    `| --- | --- |`,
    `| algorithm | ${mdCell(m.algorithm)}${sig ? " + ed25519" : ""} |`,
    `| event_count | ${mdCell(m.event_count)} |`,
    `| root (sha256 chain) | \`${mdCell(m.root)}\` |`,
    `| signed | ${sig ? "**yes**" : "no (chain only)"} |`,
  ];
  if (sig)
    lines.push(
      `| key fingerprint (sha256) | \`${mdCell(fingerprintOfPublicKey(sig.public_key))}\` |`,
    );
  lines.push(
    ``,
    sig
      ? `_この署名は「配布後の改竄」を検知します。受け手は上記 fingerprint を既知の operator 公開鍵と照合してください (埋込鍵の盲信不可)。at-rest (export 前の DB 改竄) は本モデルの対象外。_`
      : `_未署名: 内部整合 (chain) のみ。配布後改竄の暗号学的検知には ACTRADECK_AUDIT_SIGNING_KEY で署名を有効化してください。_`,
    ``,
    `_検証: 下記 manifest を \`POST /realtime/audit/verify\` へ渡すと ok/改竄が判定されます。_`,
    ``,
    `\`\`\`${AUDIT_MANIFEST_MARKER}`,
    encodeManifestBase64(m),
    `\`\`\``,
    ``,
  );
  return lines;
}

/** 期間集計レポートを Markdown へ描画する。 */
export function auditReportToMarkdown(report: AuditRangeReport): string {
  const t = report.totals;
  const lines: string[] = [];
  lines.push(
    `# Audit Range Report`,
    ``,
    `_generated_at: ${mdCell(report.generated_at)} / from: ${mdCell(dash(report.from))} / to: ${mdCell(
      dash(report.to),
    )} / sessions: ${report.session_count}${report.has_more ? " (truncated)" : ""}_`,
    ``,
    `## Totals`,
    ``,
    `| metric | value |`,
    `| --- | --- |`,
    `| secret_redaction_count | ${t.secret_redaction_count} |`,
    `| by_kind | ${mdCell(foldByKind(t.secret_redaction_count_by_kind))} |`,
    `| approval_total | ${t.approval_total} |`,
    `| allow / afs / deny / cancel | ${t.approvals_by_decision.allow} / ${t.approvals_by_decision.allow_for_session} / ${t.approvals_by_decision.deny} / ${t.approvals_by_decision.cancel} |`,
    `| synthetic_retired | ${t.synthetic_retired} |`,
    `| high_risk_op_count | ${t.high_risk_op_count} |`,
    `| auto_allowed_count | ${t.auto_allowed_count} |`,
    `| sessions_with_secret | ${t.sessions_with_secret} |`,
    ``,
    `## Sessions`,
    ``,
    `| session_id | provider | agent_id | repo | branch | state | started_at | ended_at | secret? | redactions | by_kind | appr. | allow | afs | deny | cancel | retired | pending | high_risk | auto_allowed |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`,
  );
  for (const s of report.sessions) {
    lines.push(
      `| ${mdCell(s.session_id)} | ${mdCell(s.provider)} | ${mdCell(dash(s.agent_id))} | ${mdCell(
        dash(s.repo),
      )} | ${mdCell(dash(s.branch))} | ${mdCell(dash(s.state))} | ${mdCell(dash(s.started_at))} | ${mdCell(
        dash(s.ended_at),
      )} | ${s.secret_detected} | ${s.secret_redaction_count} | ${mdCell(
        foldByKind(s.secret_redaction_count_by_kind),
      )} | ${s.approvals.total} | ${s.approvals.by_decision.allow} | ${s.approvals.by_decision.allow_for_session} | ${s.approvals.by_decision.deny} | ${s.approvals.by_decision.cancel} | ${s.approvals.synthetic_retired} | ${s.approvals.pending} | ${s.high_risk_op_count} | ${s.auto_allowed_count} |`,
    );
  }
  lines.push(``);
  return lines.join("\n");
}
