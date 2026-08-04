/**
 * Wall claimed-unverified count バッジ (ADR 0015 §D4/§D8).
 *
 * 「自己申告完了だが未検証」件数は **needs_attention とは別カウント・別バッジ** で出す (§D4:
 * approvals + liveness の警報疲れと結合しない)。以下を pin する:
 *  - claimed_unverified_count>0 かつ needs_attention=false → claimed-unverified バッジのみ出て
 *    attention バッジは出ない (分離の核)。
 *  - needs_attention=true かつ claimed_unverified_count 欠落 → attention のみ (逆方向)。
 *  - 0 / 欠落 は claimed-unverified バッジ非表示。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WallLaneRow } from "../src/ui/LiveWall.js";
import { FixedLocaleProvider } from "../src/ui/LocaleProvider.js";

import type { SessionListItem, WallLane } from "../src/realtime/contract.js";

const NOW = Date.parse("2026-08-04T00:00:10.000Z");

function laneWith(session: Partial<SessionListItem>): WallLane {
  return {
    session: {
      session_id: "sess-abcdef123456",
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
      ...session,
    },
    events: [],
  };
}

function render(lane: WallLane): string {
  return renderToStaticMarkup(
    <FixedLocaleProvider locale="ja">
      <WallLaneRow lane={lane} nowMs={NOW} windowMs={120_000} />
    </FixedLocaleProvider>,
  );
}

describe("Wall claimed-unverified count は needs_attention と分離", () => {
  it("count>0 かつ needs_attention=false → claimed-unverified のみ (attention 非表示)", () => {
    const html = render(laneWith({ needs_attention: false, claimed_unverified_count: 3 }));
    expect(html).toContain('data-testid="wall-lane-claimed-unverified"');
    expect(html).toContain('data-count="3"');
    // 分離の核: 未検証件数は要対応バッジを出さない。
    expect(html).not.toContain('data-testid="wall-lane-attention"');
  });

  it("needs_attention=true かつ claimed 欠落 → attention のみ (逆方向)", () => {
    const html = render(laneWith({ needs_attention: true }));
    expect(html).toContain('data-testid="wall-lane-attention"');
    expect(html).not.toContain('data-testid="wall-lane-claimed-unverified"');
  });

  it("両方立つ場合は両バッジが独立に出る (別カウント・別扱い)", () => {
    const html = render(laneWith({ needs_attention: true, claimed_unverified_count: 2 }));
    expect(html).toContain('data-testid="wall-lane-attention"');
    expect(html).toContain('data-testid="wall-lane-claimed-unverified"');
  });

  it("count=0 / 欠落は claimed-unverified バッジ非表示", () => {
    expect(render(laneWith({ claimed_unverified_count: 0 }))).not.toContain(
      'data-testid="wall-lane-claimed-unverified"',
    );
    expect(render(laneWith({}))).not.toContain('data-testid="wall-lane-claimed-unverified"');
  });
});
