/**
 * SessionList の描画契約（Adaptive Clarity PR-C1: Carbon→kit 移行の回帰防衛）。
 *
 * react-dom/server で静的描画し、KPI（1 行で動/詰まり/介入要否）の data-testid 契約と
 * liveness suspected 表記・介入強調・table semantics を固定する（REAL DATA: SessionListItem の wire 形）。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SessionList } from "../src/ui/SessionList.js";

import type { SessionListItem } from "../src/realtime/contract.js";

function item(o: Partial<SessionListItem> = {}): SessionListItem {
  return {
    session_id: "sess-abcdef123456",
    provider: "claude_code",
    source: "hooks",
    agent_id: "agent-1",
    repo: "acme/app",
    branch: "main",
    cwd: "/repo",
    state: "running.command_executing",
    current_action: "npm test",
    last_event_at: "2026-06-07T00:00:00.000Z",
    needs_attention: false,
    liveness_state: "live",
    stalled_suspected: false,
    connected: true,
    ...o,
  };
}

describe("SessionList", () => {
  it("空なら empty-list を出す", () => {
    const html = renderToStaticMarkup(
      <SessionList sessions={[]} selectedId={null} nowMs={0} onSelect={() => {}} />,
    );
    expect(html).toContain('data-testid="empty-list"');
  });

  it("emptyAction 指定で空状態にアクションボタンを出す (履歴ゲート緩和: 履歴も含めて検索)", () => {
    const html = renderToStaticMarkup(
      <SessionList
        sessions={[]}
        selectedId={null}
        nowMs={0}
        onSelect={() => {}}
        emptyLabel="一致なし"
        emptyAction={{ label: "履歴も含めて検索", onClick: () => {} }}
      />,
    );
    expect(html).toContain('data-testid="empty-action"');
    expect(html).toContain("履歴も含めて検索");
    expect(html).toContain("一致なし");
  });

  it("emptyAction 未指定なら空状態にボタンを出さない", () => {
    const html = renderToStaticMarkup(
      <SessionList sessions={[]} selectedId={null} nowMs={0} onSelect={() => {}} />,
    );
    expect(html).not.toContain('data-testid="empty-action"');
  });

  it("ネイティブ table + caption + 行ごとの KPI セルを描画", () => {
    const html = renderToStaticMarkup(
      <SessionList
        sessions={[item()]}
        selectedId={null}
        nowMs={Date.parse("2026-06-07T00:00:05.000Z")}
        onSelect={() => {}}
      />,
    );
    expect(html).toContain("<table");
    expect(html).toContain("<caption");
    expect(html).toContain('data-testid="session-row"');
    for (const id of ["liveness", "action", "attention", "repo", "last-event", "provider"]) {
      expect(html).toContain(`data-testid="${id}"`);
    }
    // liveness は live→success tone + LIVE ラベル。
    expect(html).toContain("LIVE");
    expect(html).toContain('data-tone="ok"');
    // repo@branch / provider。
    expect(html).toContain("acme/app@main");
    expect(html).toContain("claude_code");
    // age（5s）。
    expect(html).toContain("5s");
  });

  it("stalled は suspected 表記（断定しない）・選択行は aria-selected", () => {
    const html = renderToStaticMarkup(
      <SessionList
        sessions={[item({ liveness_state: "stalled", stalled_suspected: true })]}
        selectedId="sess-abcdef123456"
        nowMs={0}
        onSelect={() => {}}
      />,
    );
    expect(html).toContain("STALLED?");
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('data-selected="true"');
  });

  it("承認待ちは介入強調（waiting kind を表示・data-attention）", () => {
    const html = renderToStaticMarkup(
      <SessionList
        sessions={[item({ state: "waiting.approval", needs_attention: true })]}
        selectedId={null}
        nowMs={0}
        onSelect={() => {}}
      />,
    );
    expect(html).toContain('data-attention="true"');
    expect(html).toContain("approval");
  });
});
