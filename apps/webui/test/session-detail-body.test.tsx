/**
 * SessionDetailView 段階2 本文ペインのレンダリング契約 — ADR 019ea4ba D2/D3/D5.
 *
 * react-dom/server で静的描画し、diff/stdout 本文の on-demand pull コントローラ表示・
 * permission_mode (sandbox) バッジ・secret_detected フラグの描画を固定する。
 *
 * SEC: 本文は backend/sidecar で redaction 済み (UI は受け取った文字列を表示するのみ)。
 *  - secret_detected は **件数/bool のみ** (秘匿値そのものは出さない)。
 *  - body 未指定 (段階1 互換) では本文ボタン・本文表示を出さない。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createElement } from "react";

import { SessionDetailView, type SessionBodyController } from "../src/ui/SessionDetail.js";

import type { ReplayEventDTO, SessionDetail } from "../src/realtime/contract.js";

function repEvent(o: Partial<ReplayEventDTO> = {}): ReplayEventDTO {
  return {
    event_id: "e1",
    provider: "claude_code",
    source: "hooks",
    session_id: "s1",
    event_type: "command.started",
    kind: "command",
    timestamp: "2026-06-05T00:00:01.000Z",
    state: undefined,
    cwd: undefined,
    summary: undefined,
    display_text: "x",
    subject: undefined,
    request_id: undefined,
    tool_name: undefined,
    command: undefined,
    path: undefined,
    risk_level: undefined,
    decision: undefined,
    auto_allowed: undefined,
    exit_code: undefined,
    elapsed_ms: undefined,
    ...o,
  };
}

function detail(o: Partial<SessionDetail> = {}): SessionDetail {
  return {
    session_id: "s1",
    provider: "claude_code",
    source: "hooks",
    agent_id: undefined,
    repo: undefined,
    branch: undefined,
    cwd: undefined,
    state: "running.command_executing",
    current_action: "bash",
    last_event_at: "2026-06-05T00:00:00.000Z",
    needs_attention: false,
    liveness_state: "live",
    stalled_suspected: false,
    connected: true,
    last_event_id: "e1",
    liveness_evidence: {},
    liveness_reason: "",
    liveness_evaluated_at_ms: 1,
    invalid_transition_count: 0,
    pending_approvals: [],
    ...o,
  };
}

function bodyController(o: Partial<SessionBodyController> = {}): SessionBodyController {
  return {
    diff: undefined,
    diffLoading: false,
    diffError: undefined,
    loadDiff: () => {},
    output: undefined,
    outputLoading: false,
    outputError: undefined,
    loadOutput: () => {},
    ...o,
  };
}

describe("SessionDetailView stage-2 body panes", () => {
  it("body 未指定 (段階1 互換) では diff/output ボタンも本文も出さない", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, { detail: detail(), loading: false, events: [] }),
    );
    expect(html).not.toContain('data-testid="diff-load"');
    expect(html).not.toContain('data-testid="output-load"');
  });

  it("body 指定で diff/output の pull ボタンが出る (常時 push しない・明示操作)", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        detail: detail(),
        loading: false,
        events: [repEvent({ event_type: "command.started", kind: "command" })],
        body: bodyController(),
      }),
    );
    expect(html).toContain('data-testid="diff-load"');
    expect(html).toContain('data-testid="output-load"');
  });

  it("diff 本文 (redaction 済み) を表示し、切り詰めマーカーを添える", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        detail: detail(),
        loading: false,
        events: [],
        body: bodyController({
          diff: {
            body: "diff --git a/a b/a\n+GITHUB_TOKEN=[REDACTED:github-token]\n",
            truncated: true,
            secret_detected: true,
            redaction_count: 1,
          },
        }),
      }),
    );
    expect(html).toContain('data-testid="diff-pre"');
    expect(html).toContain("[REDACTED:github-token]");
    expect(html).not.toContain("ghp_");
    // secret_detected フラグ (件数のみ・秘匿値なし)。
    expect(html).toContain('data-testid="risk-secret-detected"');
    expect(html).toContain("1 件");
    // 切り詰めの明示。
    expect(html).toContain('data-truncated="true"');
  });

  it("stdout 本文 tail を command ビューで表示する", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        detail: detail({ state: "running.command_executing" }),
        loading: false,
        events: [repEvent({ event_type: "command.started", kind: "command" })],
        body: bodyController({
          output: {
            session_id: "s1",
            anchor_event_id: "e1",
            output_excerpt: "build ok\n",
            tail: 16384,
            truncated: false,
            not_found: false,
          },
        }),
      }),
    );
    expect(html).toContain('data-testid="output-pre"');
    expect(html).toContain("build ok");
  });

  it("permission_mode を右ペインに表示し、bypassPermissions は注意色 (danger)", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        detail: detail({ permission_mode: "bypassPermissions" }),
        loading: false,
        events: [],
        body: bodyController(),
      }),
    );
    expect(html).toContain('data-testid="risk-permission-mode"');
    expect(html).toContain('data-permission-mode="bypassPermissions"');
    expect(html).toContain("権限: bypassPermissions");
  });

  it("permission_mode 欠落では権限バッジを出さない (optional・後方互換)", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        detail: detail(),
        loading: false,
        events: [],
        body: bodyController(),
      }),
    );
    expect(html).not.toContain('data-testid="risk-permission-mode"');
  });

  // --- Plan Step5: session 単位 secret_detected (detail 由来・常時・diff pull 不要) ---

  it("detail.secret_detected=true で session 単位の secret バッジを出す (diff pull 不要・件数表示・原文は出さない)", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        detail: detail({ secret_detected: true, secret_redaction_count: 3 }),
        loading: false,
        events: [],
        // body 未指定 = diff pull していない。それでも session 単位は常時出る。
      }),
    );
    expect(html).toContain('data-testid="risk-secret-detected"');
    expect(html).toContain('data-secret-source="session"');
    expect(html).toContain('data-redaction-count="3"');
    // 件数 (検出の濃度) を表示。
    expect(html).toContain("3 件");
    // SEC: 秘匿値そのもの・REDACTED マーカーの原文は DOM に出ない (件数/bool のみ)。
    expect(html).not.toContain("ghp_");
    expect(html).not.toContain("[REDACTED");
  });

  it("detail.secret_detected=true で count 欠落でも session バッジを出す (件数なし文言)", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        detail: detail({ secret_detected: true }),
        loading: false,
        events: [],
      }),
    );
    expect(html).toContain('data-secret-source="session"');
    // 件数欠落時は count-less 文言にフォールバック (リテラル {count} を残さない)。
    expect(html).not.toContain("{count}");
    // QA-4: count 欠落時の data-redaction-count は **欠落 or 空** であり、文字列 "undefined" を
    //   描画しない (React は undefined 属性値を出力しないため属性ごと落ちる)。誤って "undefined"
    //   を載せる退行 (例 String(count) でラップ) を pin する。
    expect(html).not.toContain('data-redaction-count="undefined"');
  });

  it("detail.secret_detected が undefined (旧セッション) では session バッジを出さない (未観測を『無し』と誤表示しない)", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        detail: detail(),
        loading: false,
        events: [],
        body: bodyController(),
      }),
    );
    expect(html).not.toContain('data-secret-source="session"');
  });

  it("detail.secret_detected=false では session バッジを出さない", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        detail: detail({ secret_detected: false, secret_redaction_count: 0 }),
        loading: false,
        events: [],
      }),
    );
    expect(html).not.toContain('data-secret-source="session"');
    expect(html).not.toContain('data-testid="risk-secret-detected"');
  });

  it("session 単位が出ている時は diff-pull の補助バッジを重複表示しない (主表示は session)", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        detail: detail({ secret_detected: true, secret_redaction_count: 2 }),
        loading: false,
        events: [],
        body: bodyController({
          diff: {
            body: "diff --git a/a b/a\n+TOKEN=[REDACTED:token]\n",
            truncated: false,
            secret_detected: true,
            redaction_count: 5,
          },
        }),
      }),
    );
    // session 単位のみ・diff 由来は出さない。
    expect(html).toContain('data-secret-source="session"');
    expect(html).not.toContain('data-secret-source="diff"');
    // risk-secret-detected testid は 1 つだけ。
    expect(html.match(/data-testid="risk-secret-detected"/g)?.length).toBe(1);
  });

  it("session 未観測 (undefined) で diff pull が secret 検出した時は diff 由来の補助バッジを出す (旧セッション後方互換)", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        detail: detail(),
        loading: false,
        events: [],
        body: bodyController({
          diff: {
            body: "diff --git a/a b/a\n+TOKEN=[REDACTED:token]\n",
            truncated: false,
            secret_detected: true,
            redaction_count: 1,
          },
        }),
      }),
    );
    expect(html).toContain('data-secret-source="diff"');
    expect(html).toContain('data-testid="risk-secret-detected"');
  });

  it("secret_detected が false (または diff 未取得) では secret バッジを出さない", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        detail: detail(),
        loading: false,
        events: [],
        body: bodyController({
          diff: {
            body: "diff --git a/a b/a\n+plain\n",
            truncated: false,
            secret_detected: false,
            redaction_count: 0,
          },
        }),
      }),
    );
    expect(html).not.toContain('data-testid="risk-secret-detected"');
  });
});
