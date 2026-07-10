/**
 * INV-REPLAY-SUBJECT — replay DTO の言語非依存 subject (pure unit, no DB)。
 *
 * 表示時ローカライズ (ADR 019eeac6 D6/P2): replay timeline の表示文字列を **kind + subject** の
 * 構造へ分解し、webui が表示 locale で組み立てられるようにする。`rowToReplayEvent` は
 * `@actradeck/projection` の `deriveActionSubject` を **共有** し、projection の
 * current_action_subject と同一写像で subject を引く (二重実装によるドリフトを断つ・TDA)。
 *
 * 本テストは EventRow → ReplayEventDTO の純変換を検証する:
 *  - INV-REPLAY-SUBJECT: kind 別に **正しい redacted 列** から subject を引く
 *    (mutation: 出所を summary に変えると日本語が出て赤化する)。
 *  - QA-3: kindOf("error") === "error" の override を pin (override を消すと "tool" へ退行し赤化)。
 *  - INV-REPLAY-SUBJECT-NO-LEAK (unit): redacted marker を含む列はそのまま subject になり
 *    raw secret が現れない (e2e の at-rest no-leak は real-PG 側 inv-replay-history で別途)。
 */
import { describe, expect, it } from "vitest";

import { rowToReplayEvent } from "../src/replay-store.js";

import type { ReplayEventDTO } from "../src/replay-contract.js";

/** rowToReplayEvent が受ける EventRow と同形 (型は同パッケージ private なので構造で満たす)。 */
function makeRow(over: {
  event_type: string;
  summary?: string | null;
  command?: string | null;
  path?: string | null;
  server?: string | null;
  tool?: string | null;
  query?: string | null;
  reason?: string | null;
  error?: string | null;
  tool_name?: string | null;
  prompt_summary?: string | null;
  response_summary?: string | null;
}): Parameters<typeof rowToReplayEvent>[0] {
  return {
    event_id: "ev-1",
    provider: "claude_code",
    source: "hooks",
    session_id: "sess-1",
    event_type: over.event_type,
    state: null,
    timestamp: new Date("2026-06-06T00:00:00.000Z"),
    cwd: null,
    summary: over.summary ?? null,
    request_id: null,
    tool_name: over.tool_name ?? null,
    command: over.command ?? null,
    path: over.path ?? null,
    server: over.server ?? null,
    tool: over.tool ?? null,
    query: over.query ?? null,
    reason: over.reason ?? null,
    error: over.error ?? null,
    prompt_summary: over.prompt_summary ?? null,
    response_summary: over.response_summary ?? null,
    risk_level: null,
    decision: null,
    auto_allowed: null,
    exit_code: null,
    elapsed_ms: null,
  };
}

function subjectFor(over: Parameters<typeof makeRow>[0]): ReplayEventDTO["subject"] {
  return rowToReplayEvent(makeRow(over)).subject;
}

describe("INV-REPLAY-SUBJECT: replay DTO subject is derived from redacted allowlist columns", () => {
  it("command.* / tool.failed → command 列", () => {
    expect(subjectFor({ event_type: "command.started", command: "npm test" })).toBe("npm test");
    expect(subjectFor({ event_type: "command.completed", command: "npm run build" })).toBe(
      "npm run build",
    );
    expect(subjectFor({ event_type: "tool.failed", command: "rm x" })).toBe("rm x");
  });

  it("file.change.* → path 列", () => {
    expect(subjectFor({ event_type: "file.change.proposed", path: "src/a.ts" })).toBe("src/a.ts");
    expect(subjectFor({ event_type: "file.change.applied", path: "src/b.ts" })).toBe("src/b.ts");
  });

  it("tool.permission.requested → command を優先し無ければ path", () => {
    expect(
      subjectFor({ event_type: "tool.permission.requested", command: "rm -rf x", path: "p" }),
    ).toBe("rm -rf x");
    expect(subjectFor({ event_type: "tool.permission.requested", path: "secrets.txt" })).toBe(
      "secrets.txt",
    );
  });

  it("mcp.call.* → server/tool を結合", () => {
    expect(
      subjectFor({ event_type: "mcp.call.started", server: "memorymcp", tool: "decision.add" }),
    ).toBe("memorymcp/decision.add");
    expect(subjectFor({ event_type: "mcp.call.completed", server: "only-server" })).toBe(
      "only-server",
    );
  });

  it("web.search.started → query 列", () => {
    expect(subjectFor({ event_type: "web.search.started", query: "OTLP GenAI spec" })).toBe(
      "OTLP GenAI spec",
    );
  });

  it("tool.started / tool.completed → tool_name 列", () => {
    expect(subjectFor({ event_type: "tool.started", tool_name: "Read" })).toBe("Read");
  });

  it("session.ended → reason / turn.failed → error 優先・reason fallback", () => {
    expect(subjectFor({ event_type: "session.ended", reason: "user_exit" })).toBe("user_exit");
    expect(subjectFor({ event_type: "turn.failed", error: "boom" })).toBe("boom");
    // codex rollout turn_aborted は error と reason 両載せ → error を優先する (T1 正典)。
    expect(subjectFor({ event_type: "turn.failed", error: "aborted", reason: "user" })).toBe(
      "aborted",
    );
    // error 欠落時のみ reason へ後方互換 fallback。
    expect(subjectFor({ event_type: "turn.failed", reason: "only-reason" })).toBe("only-reason");
  });

  it("構造的 subject が無い event_type は undefined (diff.updated / heartbeat / turn.completed)", () => {
    for (const event_type of ["diff.updated", "heartbeat", "turn.completed"]) {
      expect(subjectFor({ event_type })).toBeUndefined();
    }
  });

  it("turn.started → prompt_summary / turn.completed → response_summary 列 (ADR 019f47c2)", () => {
    expect(subjectFor({ event_type: "turn.started", prompt_summary: "依頼: run tests" })).toBe(
      "依頼: run tests",
    );
    expect(subjectFor({ event_type: "turn.completed", response_summary: "応答: 完了" })).toBe(
      "応答: 完了",
    );
  });

  it("subject の出所は redacted 構造列のみ・summary (日本語焼付け) は決して使わない", () => {
    // summary に対象らしき日本語があっても subject は構造列からしか引かない。
    const dto = rowToReplayEvent(
      makeRow({
        event_type: "command.started",
        command: "npm test",
        summary: "コマンド実行: npm test",
      }),
    );
    expect(dto.subject).toBe("npm test");
    // mutation 反証用の load-bearing assertion: 出所を summary に変えると日本語が混入し赤化する。
    expect(dto.subject).not.toContain("コマンド実行");
    // 構造列が無い event は summary があっても subject 無し (summary 由来でない証左)。
    expect(subjectFor({ event_type: "turn.completed", summary: "完了" })).toBeUndefined();
  });
});

describe("QA-3: kindOf('error') override is pinned (error stays an independent kind)", () => {
  it("event_type='error' は kind='error' (eventTypeToActionKind の tool 畳みを上書き)", () => {
    // override を消すと ActionKind の error→tool 畳みが露出し "tool" へ退行 (mutation で赤化)。
    expect(rowToReplayEvent(makeRow({ event_type: "error" })).kind).toBe("error");
  });

  it("error 以外の kind は eventTypeToActionKind の写像そのまま", () => {
    expect(rowToReplayEvent(makeRow({ event_type: "command.started" })).kind).toBe("command");
    expect(rowToReplayEvent(makeRow({ event_type: "mcp.call.started" })).kind).toBe("mcp");
  });
});

describe("turn DTO summary/display_text bound (gemini-obs SEC-3=TDA-3, DB-free)", () => {
  // gemini adapter は uncapped (≤512KiB) 送出ゆえ turn.started/completed の at-rest summary は
  // redacted だが有界でない。DTO 搬送 (summary / display_text) は projection 正典 boundTurnSummary
  // (200+…) で post-floor 有界化される (unbounded 値を webui へ運ばない・防御的 bound)。
  it("turn.started の unbounded summary は DTO summary/display_text で 200+… へ有界化される", () => {
    const long = "依頼: " + "x".repeat(1000);
    const dto = rowToReplayEvent(makeRow({ event_type: "turn.started", summary: long }));
    expect(dto.summary!.length).toBe(201); // 200 + ellipsis
    expect(dto.summary!.endsWith("…")).toBe(true);
    expect(dto.summary!.startsWith("依頼: ")).toBe(true);
    expect(dto.display_text.length).toBe(201); // display_text は summary fallback → 同じ bound 値
  });

  it("turn.completed も同様に有界化・cap 以下の turn summary は不変", () => {
    const long = "応答: " + "y".repeat(1000);
    const dtoLong = rowToReplayEvent(makeRow({ event_type: "turn.completed", summary: long }));
    expect(dtoLong.summary!.length).toBe(201);
    const short = "応答: done";
    const dtoShort = rowToReplayEvent(makeRow({ event_type: "turn.completed", summary: short }));
    expect(dtoShort.summary).toBe(short);
    expect(dtoShort.display_text).toBe(short);
  });

  it("非 turn event の summary は据え置き (既存挙動不変・bound は turn 経路限定)", () => {
    const long = "コマンド実行: " + "z".repeat(1000);
    const dto = rowToReplayEvent(
      makeRow({ event_type: "command.started", summary: long, command: "npm test" }),
    );
    expect(dto.summary).toBe(long);
    expect(dto.display_text).toBe(long);
  });
});

describe("INV-REPLAY-SUBJECT-NO-LEAK (unit): redacted marker passes through, raw secret never appears", () => {
  it("at-rest redacted な command (marker 含む) はそのまま subject になる (再 redaction しない)", () => {
    const redacted = "echo [REDACTED:github-token]";
    const dto = rowToReplayEvent(makeRow({ event_type: "command.started", command: redacted }));
    expect(dto.subject).toBe(redacted);
    // raw github token のパターンが subject へ漏れていないことを pin。
    expect(dto.subject).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
  });
});
