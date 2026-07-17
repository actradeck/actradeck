/**
 * Live Wall の project グルーピング描画 (decision 019f69ef)。
 *
 * use-wall-feed を mock して複数 project の lanes を注入し、既定 (groupByProject=ON) で project グループ
 * ヘッダが出て同一 project のレーンが束ねられること、repo NULL・cwd 有は cwd(shortenCwd) ラベルで束ね、
 * repo/cwd どちらも無いレーンが "場所不明" グループへ落ちること、toggle が出ることを固定する。
 * 純関数 groupLanesByProject の単体は wall-display.test.ts。
 *
 * REAL DATA: backend の WallLane (SessionListItem + events) wire 形をそのまま食わせる。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { SessionListItem, WallLane } from "../src/realtime/contract.js";

const NOW = Date.parse("2026-07-16T00:00:00.000Z");

function session(o: Partial<SessionListItem> = {}): SessionListItem {
  return {
    session_id: "s1",
    provider: "claude_code",
    source: "hooks",
    agent_id: undefined,
    repo: undefined,
    branch: undefined,
    cwd: undefined,
    state: undefined,
    current_action: undefined,
    last_event_at: undefined,
    needs_attention: false,
    liveness_state: "live",
    stalled_suspected: false,
    connected: true,
    ...o,
  };
}

function lane(sessionId: string, repo?: string, branch?: string, cwd?: string): WallLane {
  return { session: session({ session_id: sessionId, repo, branch, cwd }), events: [] };
}

const MOCK_LANES: WallLane[] = [
  lane("a1", "owner/A", "main"),
  lane("b1", "owner/B"),
  lane("a2", "owner/A", "dev"),
  lane("c1", undefined, undefined, "/home/u/proj-c"), // repo NULL・cwd で束ねる (実データ形)
  lane("x1"), // repo/cwd どちらも無し → 場所不明グループ
];

vi.mock("../src/ui/use-wall-feed", () => ({
  useWallFeed: () => ({ lanes: MOCK_LANES, loading: false, error: undefined, refresh: () => {} }),
}));

// LocaleProvider は value-import (mock 後に import して hoist 順の影響を避ける)。
const { LiveWall } = await import("../src/ui/LiveWall.js");
const { LocaleProvider } = await import("../src/ui/LocaleProvider.js");

function render(): string {
  return renderToStaticMarkup(
    <LocaleProvider>
      <LiveWall active nowMs={NOW} onOpenSession={() => {}} />
    </LocaleProvider>,
  );
}

/**
 * group **ヘッダ** の label span (`wall-group-label`) の中身だけを抽出する。
 * per-lane の cwd 表示 (`wall-lane-cwd`) と区別し、「cwd フォールバックが group 見出しに効いている」を
 * 検証するため (QA-2: `toContain(cwd)` は per-lane 表示で充足しうる偽ゲート)。
 */
function groupHeaderLabels(html: string): string[] {
  return [...html.matchAll(/data-testid="wall-group-label"[^>]*>([^<]*)</g)].map((m) => m[1] ?? "");
}

describe("LiveWall project グルーピング描画", () => {
  it("既定 (groupByProject ON) で repo ラベルのグループヘッダを出し、同一 repo を束ねる", () => {
    const html = render();
    // グループ枠は index 化 testid (raw cwd/repo を DOM 属性へ出さない)。
    expect(html).toContain('data-testid="wall-group-0"');
    expect(html).toContain('data-testid="wall-group-1"');
    // repo は group **ヘッダ** ラベルに出る (per-lane 表示でなく group 見出しで検証)。
    const labels = groupHeaderLabels(html);
    expect(labels).toContain("owner/A");
    expect(labels).toContain("owner/B");
    // 各レーンは対応グループ内に描かれる (lane testid は不変)。
    expect(html).toContain('data-testid="wall-lane-a1"');
    expect(html).toContain('data-testid="wall-lane-a2"');
    expect(html).toContain('data-testid="wall-lane-b1"');
  });

  it("repo NULL・cwd 有のレーンは cwd(shortenCwd) を GROUP ヘッダラベルに束ねる (実データ形・偽ゲート回避)", () => {
    const html = render();
    // QA-2: group **ヘッダ** の label 集合で検証する。cwd フォールバックが削除されると c1 の group
    // ラベルは "~/proj-c" でなく "場所不明" に落ちる → この assert が RED になる (per-lane cwd 表示に
    // 依存した偽ゲートでない)。
    const labels = groupHeaderLabels(html);
    expect(labels).toContain("~/proj-c"); // shortenCwd: /home/<user>/ → ~/
    expect(html).toContain('data-testid="wall-lane-c1"');
  });

  it("repo/cwd どちらも無いレーンは '場所不明' グループへ落ちる (既定 locale=ja)", () => {
    const html = render();
    expect(groupHeaderLabels(html)).toContain("場所不明");
    expect(html).toContain('data-testid="wall-lane-x1"');
  });

  it("project グルーピング toggle を出し既定 ON (pressed)", () => {
    const html = render();
    expect(html).toContain('data-testid="wall-group-toggle"');
    expect(html).toMatch(/data-testid="wall-group-toggle"[^>]*aria-pressed="true"/);
  });

  it("グループ ON では手動並べ替え UI (drag handle/move) を出さない (grouping が組織化を担う)", () => {
    const html = render();
    expect(html).not.toContain('data-testid="wall-drag-a1"');
    expect(html).not.toContain('data-testid="wall-move-up-a1"');
  });
});
