/**
 * INV-AUDIT-VIEW (webui 純ロジック): 監査ビューの URL 構築 / defensive parse / 表示ヘルパ。
 * BFF 由来の集計値のみを扱い、原文秘匿に触れない (token も含まない same-origin path)。
 */
import { describe, expect, it } from "vitest";

import {
  aggregateSessions,
  buildAuditUrl,
  buildSessionAuditUrl,
  decidedTotal,
  distinctProjects,
  entryPrimaryText,
  filterSessions,
  formatKindCounts,
  formatStamp,
  parseAuditReport,
  parseAuditSession,
  projectLabel,
  shortenPath,
  type AuditSessionSummary,
} from "../src/ui/audit-view";

/** テスト用 session ファクトリ (必須フィールドを埋める)。 */
function mkSession(
  over: Partial<AuditSessionSummary> & { session_id: string },
): AuditSessionSummary {
  return {
    provider: "claude_code",
    source: "hooks",
    secret_detected: false,
    secret_redaction_count: 0,
    secret_redaction_count_by_kind: {},
    approvals: {
      total: 0,
      by_decision: { allow: 0, allow_for_session: 0, deny: 0, cancel: 0 },
      pending: 0,
    },
    high_risk_op_count: 0,
    ...over,
  };
}

describe("buildAuditUrl", () => {
  it("空指定は base path・from/to/limit/format を query へ (token なし)", () => {
    expect(buildAuditUrl({})).toBe("/realtime/audit/sessions");
    const u = buildAuditUrl({
      from: "2099-01-01T00:00:00.000Z",
      to: "2099-12-31T00:00:00.000Z",
      limit: 50,
      format: "csv",
    });
    expect(u.startsWith("/realtime/audit/sessions?")).toBe(true);
    expect(u).toContain("format=csv");
    expect(u).toContain("limit=50");
    expect(u).not.toContain("token");
  });

  it("不正 limit (0/負/非整数) は付けない", () => {
    expect(buildAuditUrl({ limit: 0 })).toBe("/realtime/audit/sessions");
    expect(buildAuditUrl({ limit: -3 })).toBe("/realtime/audit/sessions");
    expect(buildAuditUrl({ limit: 2.5 })).toBe("/realtime/audit/sessions");
  });
});

describe("parseAuditReport (defensive)", () => {
  it("正常な report を型安全に取り込み decision/kind を保持", () => {
    const r = parseAuditReport({
      from: "2099-01-01T00:00:00.000Z",
      generated_at: "2099-06-16T00:00:00.000Z",
      session_count: 1,
      totals: {
        secret_redaction_count: 3,
        secret_redaction_count_by_kind: { "github-token": 2, "aws-access-key-id": 1 },
        approvals_by_decision: { allow: 1, allow_for_session: 0, deny: 1, cancel: 0 },
        approval_total: 3,
        high_risk_op_count: 2,
        sessions_with_secret: 1,
      },
      sessions: [
        {
          session_id: "sess_a",
          provider: "claude_code",
          source: "hooks",
          secret_detected: true,
          secret_redaction_count: 2,
          secret_redaction_count_by_kind: { "github-token": 2 },
          approvals: {
            total: 2,
            by_decision: { allow: 1, allow_for_session: 0, deny: 0, cancel: 0 },
            pending: 1,
          },
          high_risk_op_count: 1,
          entries: [
            {
              event_id: "e1",
              timestamp: "2099-01-01T00:00:01.000Z",
              tool_name: "Bash",
              decision: "allow",
            },
          ],
        },
      ],
      limit: 100,
      has_more: false,
    });
    expect(r.session_count).toBe(1);
    expect(r.totals.approvals_by_decision.deny).toBe(1);
    expect(r.sessions[0]!.secret_redaction_count_by_kind["github-token"]).toBe(2);
    expect(r.sessions[0]!.entries?.[0]?.decision).toBe("allow");
  });

  it("欠落/不正は安全側 default (空 sessions・0 件・空 by_kind)", () => {
    const r = parseAuditReport({});
    expect(r.session_count).toBe(0);
    expect(r.sessions).toEqual([]);
    expect(r.totals.secret_redaction_count).toBe(0);
    expect(r.totals.approvals_by_decision).toEqual({
      allow: 0,
      allow_for_session: 0,
      deny: 0,
      cancel: 0,
    });
    expect(parseAuditReport(null).sessions).toEqual([]);
    expect(parseAuditReport("nope").sessions).toEqual([]);
  });

  it("kind 別件数は非負整数のみ採用 (小数/負/非数/0 は捨てる)", () => {
    const r = parseAuditReport({
      sessions: [
        {
          session_id: "s",
          secret_redaction_count_by_kind: {
            "github-token": 2,
            bad1: 1.5,
            bad2: -1,
            bad3: "x",
            bad4: 0,
          },
          approvals: {},
        },
      ],
    });
    const byKind = r.sessions[0]!.secret_redaction_count_by_kind;
    expect(byKind["github-token"]).toBe(2);
    expect(Object.keys(byKind)).toEqual(["github-token"]);
  });

  it("負/非整数のスカラ件数は 0 に clamp (kindCounts と対称・DTO 非負整数契約・QA-1)", () => {
    const r = parseAuditReport({
      session_count: -5,
      limit: 2.5,
      totals: {
        secret_redaction_count: -99,
        approval_total: 3.7,
        high_risk_op_count: -1,
        sessions_with_secret: 1.5,
        approvals_by_decision: { allow: -2, deny: 1.5, allow_for_session: 3, cancel: 0 },
      },
      sessions: [
        {
          session_id: "s",
          secret_redaction_count: -10,
          high_risk_op_count: 2.5,
          approvals: { total: -2, pending: -3, by_decision: { allow: 1.1, deny: -1 } },
        },
      ],
    });
    expect(r.session_count).toBe(0);
    expect(r.limit).toBe(0);
    expect(r.totals.secret_redaction_count).toBe(0);
    expect(r.totals.approval_total).toBe(0);
    expect(r.totals.high_risk_op_count).toBe(0);
    expect(r.totals.sessions_with_secret).toBe(0);
    expect(r.totals.approvals_by_decision).toEqual({
      allow: 0,
      allow_for_session: 3,
      deny: 0,
      cancel: 0,
    });
    const s = r.sessions[0]!;
    expect(s.secret_redaction_count).toBe(0);
    expect(s.high_risk_op_count).toBe(0);
    expect(s.approvals.total).toBe(0);
    expect(s.approvals.pending).toBe(0);
    expect(s.approvals.by_decision).toEqual({
      allow: 0,
      allow_for_session: 0,
      deny: 0,
      cancel: 0,
    });
  });

  it("不正な decision 値や session_id 欠落エントリは落とす", () => {
    const r = parseAuditReport({
      sessions: [
        {
          session_id: "s",
          approvals: { by_decision: { allow: 1, deny: 1 } },
          entries: [
            { event_id: "e1", timestamp: "t", decision: "ALLOW_INVALID" }, // 不正 decision → undefined
            { timestamp: "t" }, // event_id 欠落 → drop
            { event_id: "e2", timestamp: "t2", decision: "deny" },
          ],
        },
        { provider: "x" }, // session_id 欠落 → drop
      ],
    });
    expect(r.sessions.length).toBe(1);
    const entries = r.sessions[0]!.entries!;
    expect(entries.length).toBe(2); // event_id 欠落 1 件 drop
    expect(entries[0]!.decision).toBeUndefined(); // 不正 decision は付かない
    expect(entries[1]!.decision).toBe("deny");
  });
});

describe("display helpers", () => {
  it("formatKindCounts は件数降順で `kind ×n`", () => {
    expect(formatKindCounts({ "github-token": 1, "aws-access-key-id": 3 })).toEqual([
      "aws-access-key-id ×3",
      "github-token ×1",
    ]);
    expect(formatKindCounts({})).toEqual([]);
  });

  it("decidedTotal は全 decision の合計", () => {
    expect(
      decidedTotal({
        total: 5,
        by_decision: { allow: 2, allow_for_session: 1, deny: 1, cancel: 0 },
        pending: 1,
      }),
    ).toBe(4);
  });
});

describe("buildSessionAuditUrl", () => {
  it("session_id を encode した per-session path (token なし)", () => {
    expect(buildSessionAuditUrl("abc-123")).toBe("/realtime/audit/sessions/abc-123");
    expect(buildSessionAuditUrl("a/b?x")).toBe("/realtime/audit/sessions/a%2Fb%3Fx");
    expect(buildSessionAuditUrl("abc", "csv")).toBe("/realtime/audit/sessions/abc?format=csv");
  });
});

describe("formatStamp", () => {
  it("ISO を YYYY-MM-DD HH:MM へ・non-ISO/空は素通し", () => {
    expect(formatStamp("2026-06-20T02:41:06.462Z")).toBe("2026-06-20 02:41");
    expect(formatStamp(undefined)).toBe("");
    expect(formatStamp("nope")).toBe("nope");
  });
});

describe("shortenPath", () => {
  it("ホーム前置を ~ へ畳む (それ以外は素通し)", () => {
    expect(shortenPath("/home/user/Files/ActraDeck")).toBe("~/Files/ActraDeck");
    expect(shortenPath("/Users/me/x")).toBe("~/x");
    expect(shortenPath("/var/lib/x")).toBe("/var/lib/x");
    expect(shortenPath("/home/user")).toBe("~");
  });
});

describe("projectLabel", () => {
  it("repo 優先 → cwd basename → session_id 短縮", () => {
    expect(projectLabel({ session_id: "s", repo: "org/app", cwd: "/home/u/x" })).toBe("org/app");
    expect(projectLabel({ session_id: "s", cwd: "/home/user/Files/ActraDeck" })).toBe("ActraDeck");
    expect(projectLabel({ session_id: "0123456789abcdef" })).toBe("0123456789ab");
  });
});

describe("parseAuditSession (単一セッション詳細)", () => {
  it("session_id 欠落は undefined・entries は defensive parse", () => {
    expect(parseAuditSession({})).toBeUndefined();
    const s = parseAuditSession({
      session_id: "abc",
      provider: "claude_code",
      source: "hooks",
      cwd: "/home/user/Files/ActraDeck",
      last_event_at: "2026-06-20T02:41:06.462Z",
      secret_redaction_count: 3,
      entries: [
        {
          event_id: "e1",
          timestamp: "2026-06-20T02:00:00.000Z",
          tool_name: "Bash",
          command: "git stash pop",
          decision: "deny",
        },
        { bogus: true },
      ],
    });
    expect(s?.session_id).toBe("abc");
    expect(s?.entries).toHaveLength(1);
    expect(s?.entries?.[0]?.decision).toBe("deny");
    expect(s?.entries?.[0]?.command).toBe("git stash pop");
  });

  it("entries の path を投影し、非文字列 command は str() ガードで落とす (QA-2)", () => {
    const s = parseAuditSession({
      session_id: "s",
      entries: [
        // command が非文字列 (数値) → str() が undefined を返し command キーは付かない。path は投影。
        { event_id: "e1", timestamp: "t1", tool_name: "Edit", command: 123, path: "src/x.ts" },
        // 空文字 command も str() で落ちる (length>0 のみ採用)。
        { event_id: "e2", timestamp: "t2", command: "" },
      ],
    });
    expect(s?.entries).toHaveLength(2);
    const e1 = s?.entries?.find((e) => e.event_id === "e1");
    expect(e1?.command).toBeUndefined(); // 非文字列は落とす
    expect(e1?.path).toBe("src/x.ts"); // path は投影
    const e2 = s?.entries?.find((e) => e.event_id === "e2");
    expect(e2?.command).toBeUndefined(); // 空文字も落とす
  });
});

describe("client-side filters (project / text / aggregate)", () => {
  const sessions = [
    mkSession({
      session_id: "s1",
      cwd: "/home/user/Files/ActraDeck",
      branch: "main",
      secret_redaction_count: 5,
      high_risk_op_count: 1,
      approvals: {
        total: 3,
        by_decision: { allow: 1, allow_for_session: 1, deny: 1, cancel: 0 },
        pending: 0,
      },
    }),
    mkSession({
      session_id: "s2",
      cwd: "/home/user/Files/Memorymcp",
      secret_redaction_count: 2,
    }),
    mkSession({ session_id: "s3", repo: "ActraDeck", cwd: "/x/ActraDeck" }),
  ];

  it("distinctProjects は projectLabel の重複排除を昇順で返す", () => {
    // s1=ActraDeck(cwd basename) / s2=Memorymcp / s3=ActraDeck(repo) → 重複排除で 2 件。
    expect(distinctProjects(sessions)).toEqual(["ActraDeck", "Memorymcp"]);
  });

  it("filterSessions: project で絞る", () => {
    const r = filterSessions(sessions, "Memorymcp", "");
    expect(r.map((s) => s.session_id)).toEqual(["s2"]);
  });

  it("filterSessions: テキストは cwd/branch/session_id 横断・大小無視", () => {
    expect(filterSessions(sessions, "", "memorymcp").map((s) => s.session_id)).toEqual(["s2"]);
    expect(filterSessions(sessions, "", "MAIN").map((s) => s.session_id)).toEqual(["s1"]);
    expect(filterSessions(sessions, "", "s3").map((s) => s.session_id)).toEqual(["s3"]);
    expect(filterSessions(sessions, "", "  ").length).toBe(3); // 空白のみは全件
  });

  it("filterSessions: project と text の AND", () => {
    expect(filterSessions(sessions, "ActraDeck", "main").map((s) => s.session_id)).toEqual(["s1"]);
    expect(filterSessions(sessions, "Memorymcp", "main").length).toBe(0);
  });

  it("aggregateSessions: 表示中セッションの KPI を合算", () => {
    expect(aggregateSessions(sessions)).toEqual({
      sessions: 3,
      redactions: 7,
      deny: 1,
      approvals: 3,
      highRisk: 1,
    });
    expect(aggregateSessions(filterSessions(sessions, "Memorymcp", ""))).toEqual({
      sessions: 1,
      redactions: 2,
      deny: 0,
      approvals: 0,
      highRisk: 0,
    });
    expect(aggregateSessions([])).toEqual({
      sessions: 0,
      redactions: 0,
      deny: 0,
      approvals: 0,
      highRisk: 0,
    });
  });
});

describe("entryPrimaryText (何を承認したか)", () => {
  it("command 優先 → path → tool_name → event_id", () => {
    expect(
      entryPrimaryText({
        event_id: "e",
        timestamp: "t",
        command: "ls",
        path: "/x",
        tool_name: "Bash",
      }),
    ).toBe("ls");
    expect(entryPrimaryText({ event_id: "e", timestamp: "t", path: "/x", tool_name: "Edit" })).toBe(
      "/x",
    );
    expect(entryPrimaryText({ event_id: "e", timestamp: "t", tool_name: "Edit" })).toBe("Edit");
    expect(entryPrimaryText({ event_id: "e9", timestamp: "t" })).toBe("e9");
  });
});
