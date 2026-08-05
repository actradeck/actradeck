/**
 * INV: CockpitBoard の「隠れ履歴」件数は **真の表示集合 (sessions=toDisplayList 出力)** から
 * 導出する (ADR 019f474e / TDA-2). external-recent を既定表示へ拡張したため、真 presence
 * (connectedCount) 基準で hidden を出すと external-recent 分を過大計上する
 * (external が 1 つ active でも「履歴 (1)」・トグルで新規ゼロ) — これを falsifiable に固定する。
 *
 * mutation で赤: 「履歴 (N)」導出を `totalCount - sessions.length` から `totalCount - connectedCount`
 * へ戻すと、hidden=0 のはずが「履歴 (1)」を表示し本テストが赤化する。
 *
 * 手法: useRealtime を含む周辺フックを mock し renderToStaticMarkup で静的描画 (REAL DATA: 実 wire 型
 * SessionListItem)。真の隠れ履歴 0 + external-recent 1 のシナリオで toggle-history 文言を検証する。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionListItem } from "../src/realtime/contract.js";

// 既定表示集合 (connected + external-recent)。真の隠れ履歴は 0。
const CONNECTED: SessionListItem = {
  session_id: "sess-connected01",
  provider: "claude_code",
  source: "hooks",
  agent_id: "agent-c",
  repo: "acme/app",
  branch: "main",
  cwd: "/repo",
  state: "running.command_executing",
  current_action: "pnpm test",
  last_event_at: "2026-07-09T00:00:00.000Z",
  needs_attention: false,
  liveness_state: "live",
  stalled_suspected: false,
  connected: true,
};
const EXTERNAL_RECENT: SessionListItem = {
  ...CONNECTED,
  session_id: "sess-external01",
  provider: "gemini_cli",
  source: "external",
  agent_id: "agent-x",
  // recency proxy で既定表示に含まれるが presence (connected) は持たない。
  connected: false,
};

// 表示集合 = [connected, external-recent] (toDisplayList 出力相当・showHistory=false)。
// connectedCount = 1 (真 presence・external を含めない=正直)。totalCount = 2 (隠れ履歴 0)。
const useRealtimeMock = vi.fn(() => ({
  status: "open",
  sessions: [CONNECTED, EXTERNAL_RECENT] as readonly SessionListItem[],
  selectedId: null,
  detail: undefined,
  select: () => {},
  clearSelection: () => {},
  approve: () => {},
  interrupt: () => {},
  lastAck: null,
  showHistory: false,
  setShowHistory: () => {},
  connectedCount: 1,
  // presence 母集合(connected!==false)の running.* = CONNECTED のみ (EXTERNAL_RECENT は connected:false)。
  runningCount: 1,
  totalCount: 2,
}));

vi.mock("../src/ui/use-realtime", () => ({ useRealtime: () => useRealtimeMock() }));
// 周辺 hook の中立 mock は _support/cockpit-hook-mocks の単一出所 (cockpit sweep TDA-2)。
vi.mock("../src/ui/use-notifications", async () => ({
  useNotifications: (await import("./_support/cockpit-hook-mocks.js")).notificationsHookMock,
}));
vi.mock("../src/ui/use-daemons", async () => ({
  useDaemons: (await import("./_support/cockpit-hook-mocks.js")).daemonsHookMock,
}));
vi.mock("../src/ui/use-readiness", async () => ({
  useReadiness: (await import("./_support/cockpit-hook-mocks.js")).readinessHookMock,
}));
vi.mock("../src/ui/use-safety-demo", async (importOriginal) =>
  (await import("./_support/cockpit-hook-mocks.js")).safetyDemoModuleMock(importOriginal),
);
vi.mock("../src/ui/use-session-events", async () => ({
  useSessionEvents: (await import("./_support/cockpit-hook-mocks.js")).sessionEventsHookMock,
}));
vi.mock("../src/ui/use-session-body", async () => ({
  useSessionBody: (await import("./_support/cockpit-hook-mocks.js")).sessionBodyHookMock,
}));

let CockpitBoard: typeof import("../src/ui/CockpitBoard.js").CockpitBoard;
let FixedLocaleProvider: typeof import("../src/ui/LocaleProvider.js").FixedLocaleProvider;
let ThemeProvider: typeof import("../src/ui/ThemeProvider.js").ThemeProvider;

beforeEach(async () => {
  ({ CockpitBoard } = await import("../src/ui/CockpitBoard.js"));
  ({ FixedLocaleProvider } = await import("../src/ui/LocaleProvider.js"));
  ({ ThemeProvider } = await import("../src/ui/ThemeProvider.js"));
});

describe("CockpitBoard hidden-history count (ADR 019f474e / TDA-2)", () => {
  it("external-recent が 1 つでも真の隠れ履歴 0 なら toggle-history は「履歴 (0)」を表示する", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <FixedLocaleProvider locale="ja">
          <CockpitBoard wsUrl="ws://localhost/realtime/ws" />
        </FixedLocaleProvider>
      </ThemeProvider>,
    );
    // toggle-history ボタンが存在し、隠れ件数 0 を表示する。
    expect(html).toContain('data-testid="toggle-history"');
    expect(html).toContain("履歴 (0)");
    // 過大計上バグ (connectedCount 基準 = 2-1 = 1) の兆候を明示的に排除する。
    expect(html).not.toContain("履歴 (1)");
  });

  // QA-1: 「Running 94」バグは CockpitBoard の描画配線 (表示集合 sessions の running.* を inline 再計算)
  // に居た。この描画層の pin が無いと、純ヘルパ presenceCounts は正しくても CockpitBoard が inline 再計算へ
  // 戻る回帰を無検証で通してしまう。モックは sessions=[CONNECTED, EXTERNAL_RECENT] (両方 running.*=表示集合
  // 再計算なら 2) だが hook の runningCount=1 (presence 母集合) と **故意に食い違わせ**、描画される Running が
  // hook 値 (1) であって表示集合再計算 (2) でないことを固定する。inline 再導入すると 2 になり RED。
  it("Running メトリクスは hook の runningCount(presence) を描画し、表示集合 sessions を再計算しない", () => {
    const html = renderToStaticMarkup(
      <ThemeProvider>
        <FixedLocaleProvider locale="ja">
          <CockpitBoard wsUrl="ws://localhost/realtime/ws" />
        </FixedLocaleProvider>
      </ThemeProvider>,
    );
    const running = html.match(/data-testid="running-count"[^>]*>(\d+)</)?.[1];
    expect(running).toBe("1"); // hook.runningCount (presence)
    expect(running).not.toBe("2"); // sessions.filter(running.*) の表示集合再計算 (旧バグ)
  });
});
