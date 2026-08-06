/**
 * INV-AUDIT-EXPORT-NO-RAW (html/md 拡張) + HTML escape teeth (PG 非依存の純ロジック).
 *
 * audit-report の formatter (`auditReportToHtml`/`auditReportToMarkdown`/`sessionReportToHtml`/
 * `sessionReportToMarkdown`) は redacted-at-rest DTO → HTML/Markdown を生成する。ここでは PostgreSQL を
 * 使わず以下を固定する:
 *  - **INV-AUDIT-EXPORT-NO-RAW を html/md へ拡張**: 入力に生 secret を紛れ込ませても (DTO の非
 *    allow-list キーへ cast 注入 / commandOutput 相当) export に生 secret が現れず、`[REDACTED:kind]`
 *    マーカーのみが残る。formatter は allow-list フィールドしか読まない (構造継承)。
 *  - **HTML escape (XSS/injection 防御)**: redacted 値経由の `<`/`>`/`"`/`&`/`'` は escape され、
 *    `<script>` 様や属性脱出が起きない。escape を外すと赤 (falsifiability)。
 *  - **Markdown table injection 中和**: redacted 値の `|`/改行がテーブル構造を壊さない。
 */
import { describe, expect, it } from "vitest";

import type { AuditRangeReport, AuditSessionSummary } from "../src/audit-contract.js";
import { auditReportToCsv, foldByKind } from "../src/audit-contract.js";
import {
  auditReportToHtml,
  auditReportToMarkdown,
  htmlEscape,
  mdCell,
  sessionReportToHtml,
  sessionReportToMarkdown,
  type AuditSessionReport,
} from "../src/audit-report.js";
import type { ReplayEventDTO } from "../src/replay-contract.js";

// 生 secret sentinel (redaction 済み DTO には決して現れてはならない・現れたら no-raw 破れ)。
const RAW_AWS = "AKIAIOSFODNN7EXAMPLE";
const RAW_GH = "ghp_ABCDEFabcdef0123456789ABCDEFabcdef01";

function sampleSummary(overrides: Partial<AuditSessionSummary> = {}): AuditSessionSummary {
  return {
    session_id: "sess_report",
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
      synthetic_retired: 0,
      pending: 0,
    },
    high_risk_op_count: 1,
    auto_allowed_count: 0,
    entries: [],
    ...overrides,
  };
}

function makeEvent(overrides: Partial<ReplayEventDTO> = {}): ReplayEventDTO {
  return {
    event_id: "ev1",
    provider: "claude_code",
    source: "hooks",
    session_id: "sess_report",
    event_type: "command.started",
    kind: "command",
    timestamp: "2099-06-15T12:01:00.000Z",
    state: undefined,
    cwd: "/home/u/proj",
    summary: undefined,
    display_text: "",
    subject: undefined,
    request_id: undefined,
    tool_name: "Bash",
    command: "aws s3 cp [REDACTED:aws-access-key-id] s3://bucket",
    path: undefined,
    risk_level: "high",
    decision: "deny",
    auto_allowed: false,
    exit_code: 1,
    elapsed_ms: 42,
    ...overrides,
  };
}

function sessionReport(overrides: Partial<AuditSessionReport> = {}): AuditSessionReport {
  return {
    generated_at: "2099-06-16T00:00:00.000Z",
    summary: sampleSummary(),
    events: [makeEvent()],
    events_truncated: false,
    ...overrides,
  };
}

function rangeReport(sessions: readonly AuditSessionSummary[]): AuditRangeReport {
  return {
    from: undefined,
    to: undefined,
    generated_at: "2099-06-16T00:00:00.000Z",
    session_count: sessions.length,
    totals: {
      secret_redaction_count: 3,
      secret_redaction_count_by_kind: { "github-token": 2, "aws-access-key-id": 1 },
      approvals_by_decision: { allow: 2, allow_for_session: 1, deny: 1, cancel: 0 },
      synthetic_retired: 0,
      approval_total: 4,
      high_risk_op_count: 1,
      auto_allowed_count: 2,
      sessions_with_secret: 1,
    },
    sessions,
    limit: 100,
    has_more: false,
  };
}

describe("htmlEscape (XSS/injection 防御)", () => {
  it("&/</>/\"/' を実体参照へ escape する (順序: & が先)", () => {
    expect(htmlEscape(`<script>alert("x")</script>`)).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
    expect(htmlEscape("a & b")).toBe("a &amp; b");
    expect(htmlEscape("it's")).toBe("it&#39;s");
    // 二重 escape しない (& を最初に処理するので &lt; が &amp;lt; にならない)。
    expect(htmlEscape("<")).toBe("&lt;");
    expect(htmlEscape(undefined)).toBe("");
    expect(htmlEscape(3)).toBe("3");
    expect(htmlEscape(false)).toBe("false");
  });
});

describe("mdCell (Markdown table injection 中和)", () => {
  it("| と改行を中和し列/行構造を壊さない", () => {
    expect(mdCell("a|b")).toBe("a\\|b");
    expect(mdCell("a\nb")).toBe("a b");
    expect(mdCell("a\r\nb")).toBe("a b");
    expect(mdCell("a\\b")).toBe("a\\\\b");
    expect(mdCell(undefined)).toBe("");
  });

  it("SEC-1: <>/タグ文字を &lt;/&gt; へ中和し inline-HTML 注入を封じる (falsifiability)", () => {
    // 生タグは残らず実体参照へ (mdCell の <>/中和を外すと赤)。
    expect(mdCell("<script>")).toBe("&lt;script&gt;");
    expect(mdCell("<img src=x onerror=alert(1)>")).toBe("&lt;img src=x onerror=alert(1)&gt;");
    // | との併用でも両方中和 (\| escape と <>/中和が共存)。
    expect(mdCell("a|<b>")).toBe("a\\|&lt;b&gt;");
    // [REDACTED:kind] マーカーは可読性維持のため素通し ([/]/は escape しない・decision 019f235a)。
    expect(mdCell("[REDACTED:aws-access-key-id]")).toBe("[REDACTED:aws-access-key-id]");
  });
});

describe("sessionReportToHtml: escape teeth + no-raw", () => {
  it("redacted 値経由の <script> は escape され生タグとして出ない (falsifiability)", () => {
    const html = sessionReportToHtml(
      sessionReport({
        events: [makeEvent({ command: `<script>alert(1)</script>[REDACTED:github-token]` })],
      }),
    );
    // escape 済みマーカーは出る。
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("[REDACTED:github-token]");
    // 生 <script> タグは出ない (escape を外すと この assert が赤: falsifiability)。
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it('属性境界脱出 (" onerror=) が redacted 値経由でも起きない', () => {
    const html = sessionReportToHtml(
      sessionReport({ summary: sampleSummary({ repo: `x"><img src=x onerror=alert(1)>` }) }),
    );
    expect(html).not.toContain(`onerror=alert(1)>`);
    expect(html).toContain("&quot;&gt;&lt;img");
  });

  it("INV-AUDIT-EXPORT-NO-RAW: 非 allow-list キーの生 secret は HTML に出ない (kind マーカーのみ)", () => {
    // ReplayEventDTO に無い raw 列 (commandOutput 相当) を cast で注入しても formatter は読まない。
    const taintedEvent = {
      ...makeEvent({ command: "curl [REDACTED:github-token]" }),
      commandOutput: `${RAW_AWS} ${RAW_GH}`,
      raw_payload: RAW_AWS,
    } as unknown as ReplayEventDTO;
    const taintedSummary = {
      ...sampleSummary(),
      raw_env: RAW_GH,
    } as unknown as AuditSessionSummary;
    const html = sessionReportToHtml(
      sessionReport({ summary: taintedSummary, events: [taintedEvent] }),
    );
    expect(html).toContain("[REDACTED:github-token]");
    expect(html).not.toContain(RAW_AWS);
    expect(html).not.toContain(RAW_GH);
  });

  it("?diff=1 相当: available=false は本文へ切断メッセージを明記 (500 でなく graceful)", () => {
    const html = sessionReportToHtml(
      sessionReport({
        diff: { available: false, unavailable_reason: "diff 取得不可 (session 切断)" },
      }),
    );
    expect(html).toContain("diff 取得不可 (session 切断)");
  });

  it("diff 本文 (redacted) は <pre> 内で escape される", () => {
    const html = sessionReportToHtml(
      sessionReport({
        diff: {
          available: true,
          body: `- old\n+ new <b>[REDACTED:github-token]</b>`,
          truncated: false,
          secret_detected: true,
          redaction_count: 1,
        },
      }),
    );
    expect(html).toContain("&lt;b&gt;[REDACTED:github-token]&lt;/b&gt;");
    expect(html).not.toContain("<b>[REDACTED:github-token]</b>");
  });
});

describe("sessionReportToMarkdown: no-raw + injection 中和", () => {
  it("timeline に command/exit/decision/risk/時刻が出て生 secret は出ない", () => {
    const md = sessionReportToMarkdown(
      sessionReport({
        events: [
          makeEvent({
            command: "aws s3 cp [REDACTED:aws-access-key-id] s3://b",
            exit_code: 1,
            decision: "deny",
            risk_level: "high",
          }),
        ],
      }),
    );
    expect(md).toContain("[REDACTED:aws-access-key-id]");
    expect(md).toContain("deny");
    expect(md).toContain("high");
    expect(md).toContain("2099-06-15T12:01:00.000Z");
    expect(md).not.toContain(RAW_AWS);
  });

  it("非 allow-list キーの生 secret は Markdown に出ない", () => {
    const taintedEvent = {
      ...makeEvent({ command: "echo [REDACTED:github-token]" }),
      commandOutput: RAW_GH,
    } as unknown as ReplayEventDTO;
    const md = sessionReportToMarkdown(sessionReport({ events: [taintedEvent] }));
    expect(md).toContain("[REDACTED:github-token]");
    expect(md).not.toContain(RAW_GH);
  });

  it("redacted 値の | はテーブル列を壊さない (escape)", () => {
    const md = sessionReportToMarkdown(
      sessionReport({ events: [makeEvent({ command: "a | b [REDACTED:github-token]" })] }),
    );
    expect(md).toContain("a \\| b");
  });

  it("SEC-1: redacted 値経由の <script>/<img onerror> は md に raw タグとして出ない (falsifiability)", () => {
    const md = sessionReportToMarkdown(
      sessionReport({
        summary: sampleSummary({ repo: `<img src=x onerror=alert(1)>` }),
        events: [makeEvent({ command: `<script>alert(1)</script>[REDACTED:github-token]` })],
      }),
    );
    expect(md).toContain("[REDACTED:github-token]");
    // 生タグは出ない (mdCell の <>/中和を外すと この2 assert が赤)。
    expect(md).not.toContain("<img src=x onerror=alert(1)>");
    expect(md).not.toContain("<script>alert(1)</script>");
    // 中和形は出る (table cell 経由で escape 済)。
    expect(md).toContain("&lt;script&gt;");
    expect(md).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("QA-1: diff available=true は fence 中和 + truncated/secret_detected/redaction_count メタを描画", () => {
    const md = sessionReportToMarkdown(
      sessionReport({
        diff: {
          available: true,
          // 本文に閉じ fence ``` を仕込む (guard が退避しないと code block を脱出する)。
          body: "```\n- old\n+ new <b>[REDACTED:github-token]</b>\n```",
          truncated: true,
          secret_detected: true,
          redaction_count: 2,
        },
      }),
    );
    // available=true 分岐のメタ行 (従来この分岐は Markdown で完全未テスト)。
    expect(md).toContain("truncated: true");
    expect(md).toContain("secret_detected: true");
    expect(md).toContain("redaction_count: 2");
    // redacted マーカーは残る (fenced code block 内は renderer が更に escape するため <b> は安全)。
    expect(md).toContain("[REDACTED:github-token]");
    // 本文の ``` は ˋˋˋ へ退避される (guard が効いている証跡)。
    expect(md).toContain("ˋˋˋ");
    // literal ``` はレポート自身の開始 ```diff + 終了 ``` の 2 個のみ。guard を外すと本文の
    // ``` ×2 が加わり 4 個になり赤化する (fence-injection guard の falsifiability)。
    const fenceCount = (md.match(/```/g) ?? []).length;
    expect(fenceCount).toBe(2);
  });
});

describe("auditReportToHtml / auditReportToMarkdown (range 集計)", () => {
  it("HTML: 集計 + per-session 行を出し kind 別件数は enum:count のみ (no-raw)", () => {
    const html = auditReportToHtml(rangeReport([sampleSummary()]));
    expect(html).toContain("Audit Range Report");
    expect(html).toContain("sess_report");
    expect(html).toContain("github-token:2");
    // formula-injection 相当の repo も escape される。
    const inj = auditReportToHtml(rangeReport([sampleSummary({ repo: `<img onerror=x>` })]));
    expect(inj).not.toContain("<img onerror=x>");
    expect(inj).toContain("&lt;img");
  });

  it("HTML: 非 allow-list キーの生 secret は出ない", () => {
    const tainted = {
      ...sampleSummary(),
      command: "rm -rf /",
      raw_payload: RAW_AWS,
    } as unknown as AuditSessionSummary;
    const html = auditReportToHtml(rangeReport([tainted]));
    expect(html).not.toContain("rm -rf /");
    expect(html).not.toContain(RAW_AWS);
  });

  it("Markdown: 集計 + per-session 行を出す", () => {
    const md = auditReportToMarkdown(rangeReport([sampleSummary()]));
    expect(md).toContain("# Audit Range Report");
    expect(md).toContain("sess_report");
    expect(md).toContain("github-token:2");
  });
});

describe("TDA-1: range formatter cross-format 列 parity (ドリフト防止)", () => {
  // CSV / HTML / Markdown は同一 per-session 投影の 3 手写しコピー。1 formatter だけ列を
  // 増減させると監査成果物が不一致になるため、列数の一致を構造的に固定する (decision 019f235a)。
  const cellCount = (mdRow: string) => mdRow.split("|").filter((c) => c.trim() !== "").length;

  it("CSV / HTML / Markdown の per-session 列数が一致し header==row (18 列)", () => {
    const report = rangeReport([sampleSummary(), sampleSummary({ session_id: "sess_b" })]);
    // CSV: header 行 / data 行のセル数 (sampleSummary はカンマ非含ゆえ split(',') が正確)。
    const csvLines = auditReportToCsv(report).split("\r\n");
    const csvHeaderCols = csvLines[0]!.split(",").length;
    const csvRowCols = csvLines[1]!.split(",").length;
    // HTML: <thead> の <th> 数 / tbody 先頭行の <td> 数。
    const html = auditReportToHtml(report);
    const thead = html.match(/<thead>[\s\S]*?<\/thead>/)?.[0] ?? "";
    const htmlHeaderCols = (thead.match(/<th>/g) ?? []).length;
    const firstRow = html.match(/<tbody>[\s\S]*?<tr>([\s\S]*?)<\/tr>/)?.[1] ?? "";
    const htmlRowCols = (firstRow.match(/<td/g) ?? []).length;
    // Markdown: "## Sessions" の header 行 / 先頭 data 行のセル数。
    const mdLines = auditReportToMarkdown(report).split("\n");
    const h = mdLines.findIndex((l) => l.startsWith("| session_id |"));
    const mdHeaderCols = cellCount(mdLines[h]!);
    const mdRowCols = cellCount(mdLines[h + 2]!); // header(+0), separator(+1), data(+2)

    expect(csvHeaderCols).toBe(19); // + auto_allowed_count (high_risk_op_count と対称・QA-1)
    // 6 計測 (3 formatter × header/row) がすべて 19 で一致 (1 formatter に列追加すると Set>1 で赤)。
    const counts = new Set([
      csvHeaderCols,
      csvRowCols,
      htmlHeaderCols,
      htmlRowCols,
      mdHeaderCols,
      mdRowCols,
    ]);
    expect(counts).toEqual(new Set([19]));
  });

  it("auto_allowed_count が range totals (HTML/MD) と CSV per-session に surface する (high_risk_op_count と対称・QA-1)", () => {
    // rangeReport の totals.auto_allowed_count = 2、session を distinct な 5 で override。
    const report = rangeReport([sampleSummary({ auto_allowed_count: 5 })]);

    // range totals: HTML/MD が auto_allowed_count を high_risk_op_count と並べて surface する。
    const html = auditReportToHtml(report);
    expect(html).toContain("<tr><th>auto_allowed_count</th><td>2</td></tr>");
    expect(auditReportToMarkdown(report)).toContain("| auto_allowed_count | 2 |");

    // CSV: header に auto_allowed_count 列、per-session 行に当該 session の値 (5)。
    const csvLines = auditReportToCsv(report).split("\r\n");
    expect(csvLines[0]!.split(",")).toContain("auto_allowed_count");
    const headerCols = csvLines[0]!.split(",");
    const rowCols = csvLines[1]!.split(",");
    expect(rowCols[headerCols.indexOf("auto_allowed_count")]).toBe("5");
    // high_risk_op_count と同数の列位置に隣接して存在する (対称)。
    expect(headerCols.indexOf("auto_allowed_count")).toBe(
      headerCols.indexOf("high_risk_op_count") + 1,
    );
  });

  it("by-kind fold は全 formatter で同一区切り `;` (以前の CSV `;` / HTML/MD `; ` ドリフトを固定)", () => {
    expect(foldByKind({ "github-token": 2, "aws-access-key-id": 1 })).toBe(
      "github-token:2;aws-access-key-id:1",
    );
    const report = rangeReport([sampleSummary()]);
    for (const out of [
      auditReportToCsv(report),
      auditReportToHtml(report),
      auditReportToMarkdown(report),
    ]) {
      // canonical `;` 形が出る。
      expect(out).toContain("github-token:2;aws-access-key-id:1");
      // TDA-1r-a: drift 形 `; ` (空白) が **どの by_kind cell にも** 出ない。HTML/MD は by_kind を
      //   session-row + totals の 2 cell で出すため、片方だけ `; ` へ再 inline した partial-drift も
      //   この negative assert が捕捉する (canonical `;` を残す他 cell が toContain を満たす masking を塞ぐ)。
      expect(out).not.toContain("github-token:2; aws-access-key-id:1");
    }
  });
});
