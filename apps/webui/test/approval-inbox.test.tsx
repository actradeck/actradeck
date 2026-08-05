// @vitest-environment jsdom
/**
 * ApprovalInbox の最小 render + interaction (cockpit sweep QA-4)。
 *
 * 共有 ApprovalSessionGroup の chrome/deny 配線は action-rail.test.tsx (idPrefix="rail") が被覆
 * 済みのため、本テストは **Inbox 固有の glue** だけを固定する:
 *  (a) idPrefix="inbox" の testid 契約 (inbox-group-* / inbox-open-* / inbox-replay-*)、
 *  (b) onApprove の reason=undefined 挟み — グループの (sessionId, req, decision, persist) を
 *      親契約 (sessionId, req, decision, reason?, persist?) へ写像する、
 *  (c) secondaryLabel=cwd (Inbox は cwd・Action Rail は repo@branch という呼び分け)、
 *  (d) open/replay の deep-link spread が親コールバックへ届く、
 *  (e) pending 0 件の empty 表示。
 *
 * REAL DATA: fetch (外部境界) のみ stub し、backend `/realtime/approvals` の wire 形 JSON を
 * そのまま食わせる (useApprovalInbox → parseApprovalsResponse の実パースを通す)。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApprovalInbox } from "../src/ui/ApprovalInbox.js";
import { LocaleProvider } from "../src/ui/LocaleProvider.js";

import type { AckState } from "../src/ui/approval-display.js";

const NOW_MS = Date.parse("2026-08-05T00:00:01.000Z");

/** backend `/realtime/approvals` の wire 形 (redacted DTO・実応答と同形)。 */
const WIRE_RESPONSE = {
  approvals: [
    {
      session_id: "sess-inbox000001",
      provider: "claude_code",
      cwd: "/repo/checkout",
      pending_approvals: [
        {
          request_id: "req-1",
          tool_name: "Bash",
          command: "rm -rf build",
          risk_level: "high",
          requested_at: "2026-08-05T00:00:00.000Z",
          session_id: "sess-inbox000001",
        },
      ],
    },
  ],
};

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  fetchMock = vi.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve(WIRE_RESPONSE) }),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(props: {
  onApprove?: (...a: unknown[]) => void;
  onOpenSession?: (id: string) => void;
  onOpenReplay?: (id: string) => void;
}): Promise<void> {
  await act(async () => {
    root.render(
      <LocaleProvider>
        <ApprovalInbox
          active
          nowMs={NOW_MS}
          onApprove={(props.onApprove ?? (() => {})) as never}
          lastAck={new Map<string, AckState>()}
          {...(props.onOpenSession ? { onOpenSession: props.onOpenSession } : {})}
          {...(props.onOpenReplay ? { onOpenReplay: props.onOpenReplay } : {})}
        />
      </LocaleProvider>,
    );
  });
}

function q(id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

describe("ApprovalInbox (QA-4)", () => {
  it("実 wire 形応答からグループを idPrefix=inbox の testid で描画し cwd を副ラベルに出す", async () => {
    await mount({});
    expect(fetchMock).toHaveBeenCalledWith(
      "/realtime/approvals",
      expect.objectContaining({ headers: { accept: "application/json" } }),
    );
    const group = q("inbox-group-sess-inbox000001");
    expect(group).not.toBeNull();
    // session_id は正準 shortSessionId (12 桁) 短縮。
    expect(q("inbox-session-id")?.textContent).toBe("sess-inbox00");
    // Inbox の副ラベルは cwd (Action Rail の repo@branch と呼び分け・redacted DTO 由来)。
    expect(group?.textContent).toContain("/repo/checkout");
    expect(q("inbox-empty")).toBeNull();
  });

  it("inline deny が onApprove(sessionId, req, 'deny', undefined, persist) へ写像される", async () => {
    const onApprove = vi.fn();
    await mount({ onApprove });
    const deny = q("approval-deny");
    expect(deny).not.toBeNull();
    act(() => (deny as HTMLButtonElement).click());
    // Inbox glue は reason スロットへ undefined を挟む (グループ側は reason を持たない)。
    expect(onApprove).toHaveBeenCalledWith(
      "sess-inbox000001",
      "req-1",
      "deny",
      undefined,
      undefined,
    );
  });

  it("open/replay の deep-link spread が親コールバックへ session_id を届ける", async () => {
    const onOpenSession = vi.fn();
    const onOpenReplay = vi.fn();
    await mount({ onOpenSession, onOpenReplay });
    const open = q("inbox-open-sess-inbox000001");
    const replay = q("inbox-replay-sess-inbox000001");
    expect(open).not.toBeNull();
    expect(replay).not.toBeNull();
    act(() => (open as HTMLButtonElement).click());
    expect(onOpenSession).toHaveBeenCalledWith("sess-inbox000001");
    act(() => (replay as HTMLButtonElement).click());
    expect(onOpenReplay).toHaveBeenCalledWith("sess-inbox000001");
  });

  it("handler 未指定なら open/replay ボタンは描画しない (spread の条件付与)", async () => {
    await mount({});
    expect(q("inbox-open-sess-inbox000001")).toBeNull();
    expect(q("inbox-replay-sess-inbox000001")).toBeNull();
  });

  it("pending 0 件は empty を表示する", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ approvals: [] }) }),
    );
    await mount({});
    expect(q("inbox-empty")).not.toBeNull();
    expect(container.querySelector('[data-testid^="inbox-group-"]')).toBeNull();
  });
});
