// @vitest-environment jsdom
/**
 * CockpitBoard の adapter 配線 + showHistory 遷移不変性 (cockpit sweep QA-5 / QA-3)。
 *
 * QA-5: ActionRail → CockpitBoard の薄い adapter (CockpitBoard.tsx の onOpenSession=select+
 * setTopView("board") / onOpenReplay=openSessionReplay) を board 統合レベルで固定する。
 * ActionRail 自身の click 配線は action-rail.test.tsx が pin 済みだが、board 側の受けは未 assert
 * だった (特に承認グループからの onOpenReplay deep-link)。
 *
 * QA-3 (Running KPI 019f6bf2): cockpit-hidden-history.test.tsx の静的 pin に対し、本テストは
 * showHistory を OFF→ON→OFF と **遷移** させ、描画される Running/Live が hook の presence 値の
 * まま不変であることを固定する (表示集合 sessions の再計算へ戻す回帰は ON 遷移で 3 になり RED)。
 *
 * 手法: hook 群を mock し createRoot + act で interactive 描画 (REAL DATA: 実 wire 型
 * SessionListItem / SessionApprovals)。QA-3 の遷移は toggle click を起点に因果駆動する —
 * `setShowHistory` mock が実 hook 同様に state へ書き戻し (showHistory 反転 + 表示集合の
 * 拡張/縮小)、再 render で反映する (監査 QA-1: 手動 state 差し替えでは click→反転の因果が
 * 張られない)。再 render の手動呼び出しは残る (mock hook は subscription を持たないため)。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  PendingApproval,
  SessionApprovals,
  SessionListItem,
} from "../src/realtime/contract.js";

function session(o: Partial<SessionListItem> & { session_id: string }): SessionListItem {
  return {
    provider: "claude_code",
    source: "hooks",
    agent_id: undefined,
    repo: "acme/app",
    branch: "main",
    cwd: "/repo",
    state: "running.command_executing",
    current_action: "pnpm test",
    last_event_at: "2026-08-05T00:00:00.000Z",
    needs_attention: false,
    liveness_state: "live",
    stalled_suspected: false,
    connected: true,
    ...o,
  };
}

const CONNECTED = session({ session_id: "sess-connected01" });
const STALLED = session({ session_id: "sess-stalled0001", stalled_suspected: true });
const APPROVING = session({ session_id: "sess-approval001" });
// showHistory=ON でだけ表示集合に加わる固着履歴 (state は running.* のまま = 表示集合再計算なら
// Running を過大計上する discriminator)。
const HISTORY_STALE = session({
  session_id: "sess-history0001",
  connected: false,
  liveness_state: "unknown",
});

const PENDING: PendingApproval = {
  request_id: "req-1",
  tool_name: "Bash",
  command: "rm -rf build",
  path: undefined,
  risk_level: "high",
  requested_at: "2026-08-05T00:00:00.000Z",
  session_id: "sess-approval001",
  trigger: undefined,
  secret_kinds: undefined,
  persistable: undefined,
};
const APPROVAL_GROUP: SessionApprovals = {
  session_id: "sess-approval001",
  provider: "claude_code",
  cwd: undefined,
  pending_approvals: [PENDING],
};

// ─── mutable hook state (テストごとに再構成し、遷移は差し替え + 再 render で駆動) ───
const select = vi.fn();
const setShowHistory = vi.fn();
interface RealtimeState {
  sessions: readonly SessionListItem[];
  showHistory: boolean;
  connectedCount: number;
  runningCount: number;
  totalCount: number;
}
let realtimeState: RealtimeState;
let boardApprovals: readonly SessionApprovals[];

vi.mock("../src/ui/use-realtime", () => ({
  useRealtime: () => ({
    status: "open",
    sessions: realtimeState.sessions,
    selectedId: null,
    detail: undefined,
    select,
    clearSelection: () => {},
    approve: () => {},
    interrupt: () => {},
    lastAck: new Map(),
    showHistory: realtimeState.showHistory,
    setShowHistory,
    connectedCount: realtimeState.connectedCount,
    runningCount: realtimeState.runningCount,
    totalCount: realtimeState.totalCount,
  }),
}));
vi.mock("../src/ui/use-approval-inbox", () => ({
  useApprovalInbox: () => ({
    approvals: boardApprovals,
    loading: false,
    error: undefined,
    refresh: () => {},
  }),
}));
vi.mock("../src/ui/use-notifications", () => ({
  useNotifications: () => ({
    settings: { enabled: false, categories: {} },
    permission: "default",
    notify: () => {},
    requestEnable: () => {},
    disable: () => {},
    setCategory: () => {},
  }),
}));
vi.mock("../src/ui/use-daemons", () => ({
  useDaemons: () => ({ daemonIds: [], spawnDaemonIds: [], refresh: () => {} }),
}));
vi.mock("../src/ui/use-readiness", () => ({
  useReadiness: () => ({ readiness: null, refresh: () => {} }),
}));
vi.mock("../src/ui/use-audit-coverage", () => ({
  useAuditCoverage: () => ({
    coverage: null,
    staleForMs: null,
    isStale: false,
    unreachable: false,
  }),
}));
vi.mock("../src/ui/use-safety-demo", async (importOriginal) => ({
  // isPostDemoBoardState / SAFETY_DEMO_SESSION_PREFIX は純関数/定数なので実物を使う (hook のみ差し替え)。
  ...(await importOriginal<typeof import("../src/ui/use-safety-demo.js")>()),
  useSafetyDemo: () => ({ phase: "idle", sessionId: null, launch: () => {} }),
}));
vi.mock("../src/ui/use-session-events", () => ({
  useSessionEvents: () => ({ events: [], loading: false, error: null, reload: () => {} }),
}));
vi.mock("../src/ui/use-session-body", () => ({
  useSessionBody: () => ({
    diff: null,
    diffLoading: false,
    diffError: null,
    loadDiff: () => {},
    output: null,
    outputLoading: false,
    outputError: null,
    loadOutput: () => {},
    clear: () => {},
  }),
}));

let CockpitBoard: typeof import("../src/ui/CockpitBoard.js").CockpitBoard;
let FixedLocaleProvider: typeof import("../src/ui/LocaleProvider.js").FixedLocaleProvider;
let ThemeProvider: typeof import("../src/ui/ThemeProvider.js").ThemeProvider;

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  ({ CockpitBoard } = await import("../src/ui/CockpitBoard.js"));
  ({ FixedLocaleProvider } = await import("../src/ui/LocaleProvider.js"));
  ({ ThemeProvider } = await import("../src/ui/ThemeProvider.js"));
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  select.mockClear();
  setShowHistory.mockClear();
  realtimeState = {
    sessions: [CONNECTED, STALLED, APPROVING],
    showHistory: false,
    connectedCount: 3,
    runningCount: 3,
    totalCount: 3,
  };
  boardApprovals = [APPROVAL_GROUP];
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(): void {
  act(() => {
    root.render(
      <ThemeProvider>
        <FixedLocaleProvider locale="ja">
          <CockpitBoard wsUrl="ws://localhost/realtime/ws" />
        </FixedLocaleProvider>
      </ThemeProvider>,
    );
  });
}

function q(id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

describe("CockpitBoard adapter 配線 (QA-5)", () => {
  it("シグナル click → onOpenSession adapter が select(session_id) を呼び board に留まる", () => {
    render();
    const btn = q("action-rail-signal-sess-stalled0001");
    expect(btn).not.toBeNull();
    act(() => (btn as HTMLButtonElement).click());
    expect(select).toHaveBeenLastCalledWith("sess-stalled0001");
    // setTopView("board") 側: board 最上段の rail が残っている (inbox/wall へ遷移していない)。
    expect(q("action-rail")).not.toBeNull();
  });

  it("承認グループの replay click → openSessionReplay が setShowHistory(true) + select を呼ぶ", () => {
    render();
    const replay = q("rail-replay-sess-approval001");
    expect(replay).not.toBeNull();
    act(() => (replay as HTMLButtonElement).click());
    // deep-link 経路 (未選択 session): 履歴を出して選択ハイライトを成立させ、対象を選択する。
    expect(setShowHistory).toHaveBeenCalledWith(true);
    expect(select).toHaveBeenLastCalledWith("sess-approval001");
  });

  it("承認グループの open click → onOpenSession adapter が select(session_id) を呼ぶ", () => {
    render();
    const open = q("rail-open-sess-approval001");
    expect(open).not.toBeNull();
    act(() => (open as HTMLButtonElement).click());
    expect(select).toHaveBeenLastCalledWith("sess-approval001");
  });
});

describe("CockpitBoard showHistory 遷移不変性 (QA-3 / Running KPI 019f6bf2)", () => {
  it("toggle click 起点の OFF→ON→OFF 遷移で Running/Live は hook の presence 値のまま不変 (表示集合を再計算しない)", () => {
    boardApprovals = [];
    // 実 hook の意味論を mock に写す: showHistory ON で表示集合に固着履歴 (running.* のまま) が
    // 2 件加わるが、presence 由来の counts は不変。setShowHistory は state へ書き戻す (実 feedback)。
    const displaySets: Record<"off" | "on", readonly SessionListItem[]> = {
      off: [CONNECTED, HISTORY_STALE],
      on: [CONNECTED, HISTORY_STALE, { ...HISTORY_STALE, session_id: "sess-history0002" }],
    };
    const stateFor = (show: boolean): RealtimeState => ({
      sessions: displaySets[show ? "on" : "off"],
      showHistory: show,
      connectedCount: 1,
      runningCount: 1,
      totalCount: 3,
    });
    setShowHistory.mockImplementation((v: boolean) => {
      realtimeState = stateFor(v);
    });
    realtimeState = stateFor(false);
    render();
    expect(q("running-count")?.textContent).toBe("1");
    expect(q("connected-count")?.textContent).toBe("1");

    // トグル ON: click → setShowHistory(true) → mock feedback が state を反転・表示集合を拡張。
    // 再 render の手動呼び出しのみ残る (mock hook は subscription を持たない)。
    const toggle = q("toggle-history");
    expect(toggle).not.toBeNull();
    act(() => (toggle as HTMLButtonElement).click());
    expect(setShowHistory).toHaveBeenLastCalledWith(true);
    render();
    // 表示集合再計算 (旧バグ) なら Running=3。hook の presence 値 1 を描画し続けることを固定。
    expect(q("toggle-history")?.getAttribute("aria-pressed")).toBe("true");
    expect(q("running-count")?.textContent).toBe("1");
    expect(q("connected-count")?.textContent).toBe("1");

    // トグル OFF: click 起点で表示集合が戻っても値は 1 のまま (トグル非依存)。
    act(() => (q("toggle-history") as HTMLButtonElement).click());
    expect(setShowHistory).toHaveBeenLastCalledWith(false);
    render();
    expect(q("toggle-history")?.getAttribute("aria-pressed")).toBe("false");
    expect(q("running-count")?.textContent).toBe("1");
    expect(q("connected-count")?.textContent).toBe("1");
  });
});
