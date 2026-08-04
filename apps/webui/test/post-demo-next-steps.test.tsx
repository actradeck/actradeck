/**
 * task 019f41ec / decision 019fcdaf: デモ完走後の「実エージェント接続」段階案内。
 *
 * - isPostDemoBoardState: 表示 session が **すべて** demo-safety-* かつ ≥1 terminal のときのみ true
 *   (実データ駆動の純関数・実 session が 1 件でも混ざれば false = 案内は自然消滅)。
 * - PostDemoNextSteps (SessionList 経由): daemon 未接続なら host sidecar 接続手順 + Docker 橋渡し、
 *   接続済みなら「リポジトリでエージェント起動」+ per-agent ✓/✗ 行 (既存 readiness 資産の再利用)。
 * - 空状態 readiness パネルの disconnected 枝にも Docker 橋渡し hint が出る (cockpit-only 経路)。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FixedLocaleProvider } from "../src/ui/LocaleProvider.js";
import { SessionList } from "../src/ui/SessionList.js";
import { isPostDemoBoardState, SAFETY_DEMO_SESSION_PREFIX } from "../src/ui/use-safety-demo.js";

import type { ReadinessData } from "../src/ui/SessionList.js";
import type { SessionListItem } from "../src/realtime/contract.js";

function item(overrides: Partial<SessionListItem> & { session_id: string }): SessionListItem {
  return {
    provider: "claude_code",
    source: "hooks",
    agent_id: undefined,
    repo: undefined,
    branch: undefined,
    cwd: undefined,
    state: "running.command_executing",
    current_action: undefined,
    last_event_at: "2026-08-04T00:00:00.000Z",
    needs_attention: false,
    liveness_state: "unknown",
    stalled_suspected: false,
    connected: false,
    ...overrides,
  };
}

const DEMO_TERMINAL = item({
  session_id: `${SAFETY_DEMO_SESSION_PREFIX}abcd1234`,
  state: "completed",
});
const DEMO_RUNNING = item({
  session_id: `${SAFETY_DEMO_SESSION_PREFIX}ff001122`,
  state: "running.command_executing",
  connected: true,
});
const REAL_SESSION = item({ session_id: "sess-real0001", state: "completed" });

const AGENTS: Pick<ReadinessData, "claude" | "codex"> = {
  claude: { binaryOnPath: true, anyHook: true },
  codex: { binaryOnPath: true, rolloutDirResolved: true },
};

function render(
  sessions: readonly SessionListItem[],
  props: { readiness?: ReadinessData; postDemo?: { readiness: ReadinessData } },
): string {
  return renderToStaticMarkup(
    <FixedLocaleProvider locale="ja">
      <SessionList sessions={sessions} selectedId={null} nowMs={0} onSelect={() => {}} {...props} />
    </FixedLocaleProvider>,
  );
}

describe("isPostDemoBoardState (実データ駆動の表示条件)", () => {
  it("全 session が demo-safety-* かつ ≥1 terminal なら true", () => {
    expect(isPostDemoBoardState([DEMO_TERMINAL])).toBe(true);
    expect(isPostDemoBoardState([DEMO_TERMINAL, DEMO_RUNNING])).toBe(true);
  });

  it("空一覧は false (空状態は既存 readiness パネルの領分)", () => {
    expect(isPostDemoBoardState([])).toBe(false);
  });

  it("demo が terminal に達していなければ false (実行中に被せない)", () => {
    expect(isPostDemoBoardState([DEMO_RUNNING])).toBe(false);
  });

  it("実 session が 1 件でも混ざれば false (案内は自然消滅)", () => {
    expect(isPostDemoBoardState([DEMO_TERMINAL, REAL_SESSION])).toBe(false);
    expect(isPostDemoBoardState([REAL_SESSION])).toBe(false);
  });
});

describe("PostDemoNextSteps (テーブル上部の段階案内)", () => {
  it("daemon 未接続: 接続手順 + Docker 橋渡しを出す (テーブルも描画される)", () => {
    const html = render([DEMO_TERMINAL], { postDemo: { readiness: { daemonCount: 0 } } });
    expect(html).toContain('data-testid="post-demo-next"');
    expect(html).toContain('data-connected="false"');
    expect(html).toContain('data-testid="post-demo-disconnected"');
    expect(html).toContain('data-testid="post-demo-docker-hint"');
    expect(html).toContain("docs/docker.md");
    // 案内はテーブルを置き換えない (完走 demo session の行は残る)。
    expect(html).toContain('data-testid="session-list"');
  });

  it("daemon 接続済み: 接続済み文言 + per-agent ✓/✗ 行 (readiness 資産再利用)", () => {
    const html = render([DEMO_TERMINAL], {
      postDemo: { readiness: { daemonCount: 2, ...AGENTS } },
    });
    expect(html).toContain('data-connected="true"');
    expect(html).toContain('data-testid="post-demo-connected"');
    expect(html).toContain('data-testid="readiness-agents"');
    expect(html).toContain('data-testid="readiness-agent-claude"');
    expect(html).toContain('data-state="wired"');
    expect(html).not.toContain('data-testid="post-demo-docker-hint"');
  });

  it("per-agent 欠落 (2a coarse) は接続済み文言のみ (架空状態を出さない)", () => {
    const html = render([DEMO_TERMINAL], { postDemo: { readiness: { daemonCount: 1 } } });
    expect(html).toContain('data-testid="post-demo-connected"');
    expect(html).not.toContain('data-testid="readiness-agents"');
  });

  it("postDemo 未指定なら案内は出ない", () => {
    const html = render([DEMO_TERMINAL], {});
    expect(html).not.toContain('data-testid="post-demo-next"');
    expect(html).toContain('data-testid="session-list"');
  });
});

describe("空状態 readiness パネルの Docker 橋渡し (task 019f41ec)", () => {
  it("daemon 未接続の空状態に docs/docker.md への橋渡し hint が出る", () => {
    const html = render([], { readiness: { daemonCount: 0 } });
    expect(html).toContain('data-testid="readiness-disconnected"');
    expect(html).toContain('data-testid="readiness-docker-hint"');
    expect(html).toContain("docs/docker.md");
  });

  it("接続済みの空状態には Docker hint を出さない", () => {
    const html = render([], { readiness: { daemonCount: 1 } });
    expect(html).not.toContain('data-testid="readiness-docker-hint"');
  });
});
