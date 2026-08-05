/**
 * QA-1 (監査 2026-08-05 / decision 019fcdaf): CockpitBoard の post-demo 配線 pin。
 *
 * post-demo-next-steps.test.tsx は SessionList 単体の描画契約を固定するが、機能の唯一のユーザー到達
 * 経路は CockpitBoard 側の glue (postDemoOnly 導出 → postDemo prop 受け渡し + useReadiness/useDaemons の
 * enabled 拡張) であり、ここが退行してもスイートが緑のままだった (mutation probe (e) で実証)。本テストは
 * その glue を board レベルで固定する:
 *  - 表示集合が「全 demo-safety-* かつ ≥1 terminal」なら post-demo-next が描画される (配線切断で RED)。
 *  - そのとき useReadiness / useDaemons が enabled: true で呼ばれる (enabled 拡張の退行で RED)。
 *  - 実 session が混ざれば描画されず、readiness pull も enabled: false (過剰 pull しない)。
 *
 * 手法: cockpit-hidden-history.test.tsx と同型 (useRealtime を含む周辺フックを mock し
 * renderToStaticMarkup で静的描画・REAL DATA: 実 wire 型 SessionListItem)。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionListItem } from "../src/realtime/contract.js";

const BASE: SessionListItem = {
  session_id: "demo-safety-abcd1234",
  provider: "claude_code",
  source: "hooks",
  agent_id: undefined,
  repo: undefined,
  branch: undefined,
  cwd: "/tmp/actradeck-demo",
  state: "completed",
  current_action: undefined,
  last_event_at: "2026-08-05T00:00:00.000Z",
  needs_attention: false,
  liveness_state: "unknown",
  stalled_suspected: false,
  connected: false,
};
const DEMO_TERMINAL = BASE;
const REAL_SESSION: SessionListItem = {
  ...BASE,
  session_id: "sess-real0001",
  state: "running.command_executing",
  connected: true,
};

// シナリオ切替: 各テストが sessions を差し替える (showHistory ON で terminal demo が表示集合に残る形)。
let scenarioSessions: readonly SessionListItem[] = [DEMO_TERMINAL];

const useRealtimeMock = vi.fn(() => ({
  status: "open",
  sessions: scenarioSessions,
  selectedId: null,
  detail: undefined,
  select: () => {},
  clearSelection: () => {},
  approve: () => {},
  interrupt: () => {},
  lastAck: null,
  showHistory: true,
  setShowHistory: () => {},
  connectedCount: 0,
  runningCount: 0,
  totalCount: scenarioSessions.length,
}));

// enabled 引数を捕捉する spy mock (QA-1 の核心: enabled 拡張の退行を可視化する)。
const useDaemonsMock = vi.fn((_opts: { enabled: boolean; refreshKey: number }) => ({
  daemonIds: [] as readonly string[],
  spawnDaemonIds: [] as readonly string[],
  refresh: () => {},
}));
const useReadinessMock = vi.fn((_opts: { enabled: boolean; refreshKey: number }) => ({
  readiness: { daemonCount: 0 },
  refresh: () => {},
}));

vi.mock("../src/ui/use-realtime", () => ({ useRealtime: () => useRealtimeMock() }));
// 周辺 hook の中立 mock は _support/cockpit-hook-mocks の単一出所 (cockpit sweep TDA-2)。
// use-daemons / use-readiness は本テストの検証対象 (呼び出し opts を assert する vi.fn ラッパ)
// のためファイル固有のまま。
vi.mock("../src/ui/use-notifications", async () => ({
  useNotifications: (await import("./_support/cockpit-hook-mocks.js")).notificationsHookMock,
}));
vi.mock("../src/ui/use-daemons", () => ({
  useDaemons: (opts: { enabled: boolean; refreshKey: number }) => useDaemonsMock(opts),
}));
vi.mock("../src/ui/use-readiness", () => ({
  useReadiness: (opts: { enabled: boolean; refreshKey: number }) => useReadinessMock(opts),
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
  vi.clearAllMocks();
  ({ CockpitBoard } = await import("../src/ui/CockpitBoard.js"));
  ({ FixedLocaleProvider } = await import("../src/ui/LocaleProvider.js"));
  ({ ThemeProvider } = await import("../src/ui/ThemeProvider.js"));
});

function renderBoard(): string {
  return renderToStaticMarkup(
    <ThemeProvider>
      <FixedLocaleProvider locale="ja">
        <CockpitBoard wsUrl="ws://localhost/realtime/ws" />
      </FixedLocaleProvider>
    </ThemeProvider>,
  );
}

describe("CockpitBoard post-demo wiring (QA-1)", () => {
  it("全 demo-safety-* + ≥1 terminal: post-demo-next を描画し readiness/daemons を enabled で pull する", () => {
    scenarioSessions = [DEMO_TERMINAL];
    const html = renderBoard();
    expect(html).toContain('data-testid="post-demo-next"');
    // readiness mock は daemonCount:0 を返す → disconnected 変種 + Docker hint (段階案内の実配線)。
    expect(html).toContain('data-connected="false"');
    expect(html).toContain('data-testid="post-demo-docker-hint"');
    // demo session 行は残る (パネルはテーブルを置換しない)。
    expect(html).toContain('data-testid="session-list"');
    // enabled 拡張の pin: post-demo 状態 (board 非空) でも両フックが enabled: true で呼ばれる。
    expect(useReadinessMock).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
    expect(useDaemonsMock).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
  });

  it("実 session 混在: post-demo-next を出さず readiness pull も enabled: false (過剰 pull しない)", () => {
    scenarioSessions = [DEMO_TERMINAL, REAL_SESSION];
    const html = renderBoard();
    expect(html).not.toContain('data-testid="post-demo-next"');
    expect(useReadinessMock).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
    expect(useDaemonsMock).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });
});
