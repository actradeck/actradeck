/**
 * INV-AUDIT-EXPORT-NO-RAW / CSV formula injection (PG 非依存の純ロジック).
 *
 * audit-contract の `csvCell` / `auditReportToCsv` は DTO → 監査台帳 CSV を生成する。
 * ここでは PostgreSQL を使わず、CSV escape の正当性と INV-AUDIT-EXPORT-NO-RAW を固定する:
 *  - **CSV formula injection 中和**: 先頭 `=`/`+`/`-`/`@`/tab/CR のセルは Excel/Sheets が数式実行しうる。
 *    repo/branch/agent_id 等の git/agent 由来値が該当しうるため先頭 `'` でテキスト化する。
 *  - **RFC4180 quoting**: カンマ/改行/引用符を含むセルは `"..."` で括り `"` を `""` にする。
 *  - **原文非載せ**: CSV は allow-list 列のみ (kind enum + 非負整数件数 + decision enum + メタ)。
 *    生 payload/command/path 本文が混ざる列を後から足したら、このテストの sentinel 検査で落ちる。
 */
import { describe, expect, it } from "vitest";

import {
  type AuditRangeReport,
  type AuditSessionSummary,
  auditReportToCsv,
  csvCell,
  DEFAULT_AUDIT_LIMIT,
  MAX_AUDIT_LIMIT,
  normalizeAuditInstant,
  normalizeAuditLimit,
} from "../src/audit-contract.js";

describe("csvCell (formula injection + RFC4180 escape)", () => {
  it("undefined は空セル / 件数 (非負整数) は素通し", () => {
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(0)).toBe("0");
    expect(csvCell(3)).toBe("3");
    expect(csvCell(true)).toBe("true");
    expect(csvCell("claude_code")).toBe("claude_code");
  });

  it("先頭が =/+/-/@/|/tab/CR/LF のセルは先頭に ' を付けて数式・DDE 実行を中和する", () => {
    expect(csvCell("=SUM(A1:A9)")).toBe("'=SUM(A1:A9)");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell("-2+3")).toBe("'-2+3");
    expect(csvCell("|cmd")).toBe("'|cmd"); // SEC-2: pipe は DDE ベクタ (LibreOffice/legacy Excel)
    expect(csvCell("\tfoo")).toBe("'\tfoo"); // tab は quoting 対象外なので ' 付与のみ
    expect(csvCell("\rfoo")).toBe('"\'\rfoo"'); // CR は ' 付与 + quoting 両方が効く
    expect(csvCell("\n=1+1")).toBe('"\'\n=1+1"'); // SEC-2: 先頭 LF も中和 (LF は quoting も効く)
    // 数式実行を狙う典型 payload (DDE / HYPERLINK) も先頭 ' で無害化される。
    expect(csvCell('=HYPERLINK("http://evil","x")')).toContain("'=HYPERLINK");
  });

  it('カンマ/引用符/改行を含むセルは "..." で括り " を "" にする', () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('a"b')).toBe('"a""b"');
    expect(csvCell("a\nb")).toBe('"a\nb"');
    expect(csvCell("a\r\nb")).toBe('"a\r\nb"');
  });

  it("formula 先頭 + カンマ の合わせ技は ' 付与の後に quote される", () => {
    // "=a,b" → "'=a,b" (先頭中和) → カンマを含むので quote → "\"'=a,b\""
    expect(csvCell("=a,b")).toBe('"\'=a,b"');
  });
});

function sampleSession(overrides: Partial<AuditSessionSummary> = {}): AuditSessionSummary {
  return {
    session_id: "sess_a",
    provider: "claude_code",
    source: "hooks",
    agent_id: "agent_1",
    repo: "owner/repo",
    branch: "main",
    cwd: "/home/u/proj",
    capture_mode: "hooks",
    permission_mode: "default",
    state: "active",
    started_at: "2099-06-15T12:00:00.000Z",
    ended_at: undefined,
    last_event_at: "2099-06-15T12:05:00.000Z",
    secret_detected: true,
    secret_redaction_count: 3,
    secret_redaction_count_by_kind: { "github-token": 2, "aws-access-key-id": 1 },
    approvals: {
      total: 4,
      by_decision: { allow: 2, allow_for_session: 1, deny: 1, cancel: 0 },
      pending: 0,
    },
    high_risk_op_count: 1,
    ...overrides,
  };
}

function report(sessions: readonly AuditSessionSummary[]): AuditRangeReport {
  return {
    from: undefined,
    to: undefined,
    generated_at: "2099-06-16T00:00:00.000Z",
    session_count: sessions.length,
    totals: {
      secret_redaction_count: 3,
      secret_redaction_count_by_kind: { "github-token": 2, "aws-access-key-id": 1 },
      approvals_by_decision: { allow: 2, allow_for_session: 1, deny: 1, cancel: 0 },
      approval_total: 4,
      high_risk_op_count: 1,
      sessions_with_secret: 1,
    },
    sessions,
    limit: 100,
    has_more: false,
  };
}

describe("auditReportToCsv", () => {
  it("ヘッダ + per-session 1 行を CRLF 区切りで出す / kind 別件数は kind:count; に畳む", () => {
    const csv = auditReportToCsv(report([sampleSession()]));
    const lines = csv.split("\r\n");
    expect(lines[0]).toContain("session_id");
    expect(lines[0]).toContain("redaction_by_kind");
    expect(lines.length).toBe(2);
    expect(lines[1]).toContain("sess_a");
    // kind 別件数は "github-token:2;aws-access-key-id:1" のような enum 名 + 件数のみ。
    expect(lines[1]).toContain("github-token:2");
    expect(lines[1]).toContain("aws-access-key-id:1");
  });

  it("repo/branch の formula injection payload を CSV 出力時に中和する", () => {
    const csv = auditReportToCsv(
      report([
        sampleSession({
          repo: "=cmd|'/c calc'!A1",
          branch: "@SUM(1)",
        }),
      ]),
    );
    // 先頭 = / @ のセルは ' でテキスト化される (生のまま行頭に出さない)。
    expect(csv).toContain("'=cmd");
    expect(csv).toContain("'@SUM(1)");
    // 中和前の生 payload が裸でセル先頭に出ていないこと。
    expect(csv).not.toMatch(/(^|,)=cmd/);
    expect(csv).not.toMatch(/(^|,)@SUM/);

    // SEC-2: 先頭 pipe (DDE ベクタ) の agent_id も中和される。
    const piped = auditReportToCsv(report([sampleSession({ agent_id: "|calc'!A1" })]));
    expect(piped).toContain("'|calc");
    expect(piped).not.toMatch(/(^|,)\|calc/);
  });

  it("INV-AUDIT-EXPORT-NO-RAW: allow-list 列以外の生 payload/command/path を CSV に載せない", () => {
    // 後から raw 列を足す回帰を捕捉するため、型に無い生フィールドを混ぜても出ないことを固定。
    const tainted = {
      ...sampleSession(),
      command: "rm -rf / --no-preserve-root",
      raw_payload: "AKIAIOSFODNN7EXAMPLE",
      path: "/home/u/.ssh/id_rsa",
    } as unknown as AuditSessionSummary;
    const csv = auditReportToCsv(report([tainted]));
    expect(csv).not.toContain("rm -rf");
    expect(csv).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(csv).not.toContain("id_rsa");
  });
});

describe("normalizeAuditLimit / normalizeAuditInstant (route 境界・QA-2)", () => {
  it("normalizeAuditLimit: 空/0/負/非整数/非数は DEFAULT・>MAX は MAX に clamp", () => {
    expect(normalizeAuditLimit(undefined)).toBe(DEFAULT_AUDIT_LIMIT);
    expect(normalizeAuditLimit("")).toBe(DEFAULT_AUDIT_LIMIT);
    expect(normalizeAuditLimit("0")).toBe(DEFAULT_AUDIT_LIMIT);
    expect(normalizeAuditLimit("-1")).toBe(DEFAULT_AUDIT_LIMIT);
    expect(normalizeAuditLimit("2.5")).toBe(DEFAULT_AUDIT_LIMIT);
    expect(normalizeAuditLimit("abc")).toBe(DEFAULT_AUDIT_LIMIT);
    expect(normalizeAuditLimit("50")).toBe(50);
    expect(normalizeAuditLimit(String(MAX_AUDIT_LIMIT))).toBe(MAX_AUDIT_LIMIT);
    expect(normalizeAuditLimit(String(MAX_AUDIT_LIMIT + 100))).toBe(MAX_AUDIT_LIMIT);
  });

  it("normalizeAuditInstant: 空/不正は undefined・有効 ISO は正規化", () => {
    expect(normalizeAuditInstant(undefined)).toBeUndefined();
    expect(normalizeAuditInstant("")).toBeUndefined();
    expect(normalizeAuditInstant("not-a-date")).toBeUndefined();
    expect(normalizeAuditInstant("2099-06-15T12:00:00.000Z")).toBe("2099-06-15T12:00:00.000Z");
    expect(normalizeAuditInstant("2099-06-15T12:00:00Z")).toBe("2099-06-15T12:00:00.000Z");
  });
});
