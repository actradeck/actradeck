// @vitest-environment jsdom
/**
 * Action Rail の描画 + interaction (decision 019f69ef)。
 *
 * board 最上段の要対応レーンが: (a) 0 件で穏やかな All clear、(b) 非承認シグナルを出し click で
 * onOpenSession へ deep-link、(c) pending 承認を共有 ApprovalCard で出し inline deny が
 * onApprove(session_id, request_id, 'deny') を呼ぶ、ことを DOM で固定する。
 *
 * REAL DATA: backend の SessionListItem / SessionApprovals / PendingApproval wire 形をそのまま食わせる。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ActionRail } from "../src/ui/ActionRail.js";
import { LocaleProvider } from "../src/ui/LocaleProvider.js";

import type { AckState } from "../src/ui/approval-display.js";
import type {
  PendingApproval,
  SessionApprovals,
  SessionListItem,
} from "../src/realtime/contract.js";

const NOW_MS = Date.parse("2026-07-16T00:00:01.000Z");

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

function approval(o: Partial<PendingApproval> = {}): PendingApproval {
  return {
    request_id: "req-1",
    tool_name: "Bash",
    command: "rm -rf build",
    path: undefined,
    risk_level: "high",
    requested_at: "2026-07-16T00:00:00.000Z",
    session_id: "s1",
    trigger: undefined,
    secret_kinds: undefined,
    persistable: undefined,
    ...o,
  };
}

function group(sessionId: string, pending: readonly PendingApproval[]): SessionApprovals {
  return {
    session_id: sessionId,
    provider: "claude_code",
    cwd: undefined,
    pending_approvals: pending,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mount(props: {
  sessions: readonly SessionListItem[];
  approvals: readonly SessionApprovals[];
  onApprove?: (...a: unknown[]) => void;
  onOpenSession?: (id: string) => void;
}): void {
  act(() => {
    root.render(
      <LocaleProvider>
        <ActionRail
          sessions={props.sessions}
          approvals={props.approvals}
          nowMs={NOW_MS}
          lastAck={new Map<string, AckState>()}
          onApprove={(props.onApprove ?? (() => {})) as never}
          onOpenSession={props.onOpenSession ?? (() => {})}
        />
      </LocaleProvider>,
    );
  });
}

function q(id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

describe("ActionRail", () => {
  it("要対応 0 件 → All clear を出し count 0・data-clear=true", () => {
    mount({ sessions: [session()], approvals: [] });
    expect(q("action-rail-clear")).not.toBeNull();
    expect(q("action-rail-count")?.textContent).toContain("0");
    expect(q("action-rail")?.getAttribute("data-clear")).toBe("true");
    expect(q("action-rail-signals")).toBeNull();
  });

  it("非承認シグナルを出し、click で onOpenSession(session_id) を呼ぶ", () => {
    const onOpenSession = vi.fn();
    mount({
      sessions: [
        session({ session_id: "stall1", stalled_suspected: true, repo: "o/r", branch: "main" }),
      ],
      approvals: [],
      onOpenSession,
    });
    expect(q("action-rail-signals")).not.toBeNull();
    const btn = q("action-rail-signal-stall1");
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute("data-kind")).toBe("stalled");
    // repo@branch を主ラベルに出す (生 session_id より優先)。
    expect(btn?.textContent).toContain("o/r@main");
    act(() => (btn as HTMLButtonElement).click());
    expect(onOpenSession).toHaveBeenCalledWith("stall1");
    expect(q("action-rail")?.getAttribute("data-clear")).toBe("false");
  });

  it("pending 承認を共有 ApprovalCard で出し、inline deny が onApprove(session_id, req, 'deny')", () => {
    const onApprove = vi.fn();
    mount({
      sessions: [session({ session_id: "s1", repo: "o/r", branch: "main" })],
      approvals: [group("s1", [approval({ request_id: "r1" })])],
      onApprove,
    });
    expect(q("rail-group-s1")).not.toBeNull();
    expect(q("action-rail-count")?.textContent).toContain("1");
    const deny = q("approval-deny");
    expect(deny).not.toBeNull();
    act(() => (deny as HTMLButtonElement).click());
    expect(onApprove).toHaveBeenCalledWith("s1", "r1", "deny", undefined, undefined);
  });

  it("承認 session はシグナルに二重表示しない (approval を持てば signals から除外)", () => {
    mount({
      sessions: [session({ session_id: "s1", stalled_suspected: true })],
      approvals: [group("s1", [approval()])],
    });
    expect(q("action-rail-signals")).toBeNull();
    expect(q("rail-group-s1")).not.toBeNull();
  });
});
