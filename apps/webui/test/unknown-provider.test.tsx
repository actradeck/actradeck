/**
 * 回帰: 未知 provider slug を cockpit が graceful に描画する (ADR 019f2d2c D1/D6)。
 *
 * provider は slug 開放 (WHO)。第三者アダプタが `provider: "my_tool"` 等の未知 slug で
 * /ingest すると、UI は既知 2 値 (claude_code/codex) 以外も **crash せず・空白にせず**、
 * slug をそのまま opaque label として描画しなければならない (webui に provider 値分岐は無く
 * neutral Tag に string を流すだけ = by construction graceful だが、将来の分岐混入を回帰で固定)。
 *
 * REAL DATA: SessionListItem / WallLane の wire 形をそのまま与える (モック無し)。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WallLaneRow } from "../src/ui/LiveWall.js";
import { SessionList } from "../src/ui/SessionList.js";

import type { SessionListItem, WallLane } from "../src/realtime/contract.js";

const NOW = Date.parse("2026-07-04T00:00:10.000Z");
const UNKNOWN_SLUG = "my_tool";

function item(o: Partial<SessionListItem> = {}): SessionListItem {
  return {
    session_id: "sess-external-01",
    provider: UNKNOWN_SLUG,
    source: "external",
    agent_id: "agent-x",
    repo: "acme/app",
    branch: "main",
    cwd: "/repo",
    state: "running.command_executing",
    current_action: "build",
    last_event_at: "2026-07-04T00:00:00.000Z",
    needs_attention: false,
    liveness_state: "live",
    stalled_suspected: false,
    connected: true,
    ...o,
  };
}

function lane(o: Partial<SessionListItem> = {}): WallLane {
  return {
    session: item(o),
    events: [],
  };
}

describe("未知 provider slug の graceful 描画 (D1/D6 回帰)", () => {
  it("SessionList: 未知 slug が provider Tag にそのまま出る (crash/空白なし)", () => {
    const html = renderToStaticMarkup(
      <SessionList sessions={[item()]} selectedId={null} nowMs={NOW} onSelect={() => {}} />,
    );
    // provider セルが存在し、未知 slug をラベルとして含む。
    expect(html).toContain('data-testid="provider"');
    expect(html).toContain(UNKNOWN_SLUG);
    // 行自体が描画された (未知 provider で早期 return / 例外にならない)。
    expect(html).toContain('data-testid="session-row"');
  });

  it("Wall lane: 未知 slug がレーン provider Tag にそのまま出る", () => {
    const html = renderToStaticMarkup(<WallLaneRow lane={lane()} nowMs={NOW} windowMs={120_000} />);
    expect(html).toContain('data-testid="wall-lane-provider"');
    expect(html).toContain(UNKNOWN_SLUG);
  });

  it("known / unknown slug が同じ neutral Tag 経路で描画される (分岐なし=graceful by construction)", () => {
    const known = renderToStaticMarkup(
      <SessionList
        sessions={[item({ provider: "claude_code", session_id: "sess-known" })]}
        selectedId={null}
        nowMs={NOW}
        onSelect={() => {}}
      />,
    );
    const unknown = renderToStaticMarkup(
      <SessionList
        sessions={[item({ provider: "aider", session_id: "sess-unknown" })]}
        selectedId={null}
        nowMs={NOW}
        onSelect={() => {}}
      />,
    );
    // 既知は claude_code を、未知は aider を出す。どちらも provider Tag を持つ。
    expect(known).toContain("claude_code");
    expect(known).toContain('data-testid="provider"');
    expect(unknown).toContain("aider");
    expect(unknown).toContain('data-testid="provider"');
  });
});
