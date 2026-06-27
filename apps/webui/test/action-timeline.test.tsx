/**
 * ActionTimeline の行文法 DOM 契約 (設計裁定 019eb981).
 *
 * react-dom/server の静的描画で固定する (jsdom 不要・既定 locale=ja):
 *  - 解決済み承認行に「承認待ち」文言が出ない (resolved → 過去形)。
 *  - 対象全文 (command) が切詰めずに DOM に存在する。
 *  - 行は button 化 (キーボード到達)。role=log の一覧。
 *  - 既定はアクション単位ビュー (data-view=units)、raw トグルが存在する。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ActionTimeline } from "../src/ui/ActionTimeline.js";

import type { ReplayEventDTO } from "../src/realtime/contract.js";

let seq = 0;
function ev(o: Partial<ReplayEventDTO> = {}): ReplayEventDTO {
  seq += 1;
  return {
    event_id: `e${seq}`,
    provider: "claude_code",
    source: "hooks",
    session_id: "s1",
    event_type: "command.started",
    kind: "command",
    timestamp: "2026-06-12T01:02:03.000Z",
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

function render(events: ReplayEventDTO[]): string {
  return renderToStaticMarkup(
    <ActionTimeline sessionId="s1" events={events} ariaLabel="timeline" emptyLabel="empty" />,
  );
}

describe("ActionTimeline 行文法 DOM", () => {
  it("解決済み承認行に『承認待ち』文言を出さない・対象全文を含む", () => {
    const rid = "s1:apr-Q";
    const html = render([
      ev({
        event_type: "tool.permission.requested",
        kind: "approval",
        request_id: rid,
        command: "kubectl apply -f very/long/path/to/manifest.yaml",
        risk_level: "high",
      }),
      ev({
        event_type: "tool.permission.resolved",
        kind: "approval",
        request_id: rid,
        decision: "allow",
      }),
    ]);
    // 解決済み = 「承認待ち」と読ませない。
    expect(html).not.toContain("承認待ち");
    expect(html).toContain("許可");
    // 対象全文を切詰めずに含む。
    expect(html).toContain("kubectl apply -f very/long/path/to/manifest.yaml");
    // 1 行に畳まれている (承認は 1 ユニット)。
    expect(html).toContain(`data-testid="action-row-apr:${rid}"`);
  });

  it("未解決承認は『承認待ち』+ data-attention=true", () => {
    const html = render([
      ev({
        event_type: "tool.permission.requested",
        kind: "approval",
        request_id: "s1:apr-P",
        command: "rm -rf x",
      }),
    ]);
    expect(html).toContain("承認待ち");
    expect(html).toContain('data-attention="true"');
  });

  it("行は button 化されキーボード到達可能", () => {
    const html = render([ev({ event_type: "command.started", command: "ls -la" })]);
    expect(html).toContain('class="ad-action-row__btn"');
    expect(html).toContain("<button");
    expect(html).toContain("ls -la");
  });

  it("非ゼロ exit は danger 結果チップ", () => {
    const html = render([ev({ event_type: "command.completed", exit_code: 127 })]);
    expect(html).toContain("ad-tag--danger");
    expect(html).toContain("exit 127");
  });

  it("既定はアクション単位ビュー (data-view=units) + raw トグルあり", () => {
    const html = render([ev({ event_type: "command.started", command: "x" })]);
    expect(html).toContain('data-view="units"');
    expect(html).toContain('data-testid="action-toggle-units"');
    expect(html).toContain('data-testid="action-toggle-raw"');
    expect(html).toContain('role="log"');
  });

  it("空入力は emptyLabel を出す", () => {
    const html = render([]);
    expect(html).toContain('data-testid="action-timeline-empty"');
    expect(html).toContain("empty");
  });
});
