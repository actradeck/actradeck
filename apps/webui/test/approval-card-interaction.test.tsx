// @vitest-environment jsdom
/**
 * INV-PERSIST-CARD-CLICK (QA-4・ADR 019ee0c0): ApprovalCard の承認ボタンの **実クリック** が
 * onApprove を正しい (request_id, decision, persist?) で呼ぶ DOM interaction を pin する。
 *
 * 既存 approval-card.test.tsx は react-dom/server の静的 markup でボタンの提示/無効のみを検証する。
 * 本テストは jsdom + react-dom/client で実際にクリックし、「永続ボタン → allow_for_session +
 * persist=true」「allow → persist 引数なし」等の onClick 配線を検証する (buildApproveFrame 単体
 * テストと UI クリックの間の配線ギャップを埋める)。新規依存は足さない (jsdom は既存 devDep)。
 *
 * REAL DATA: backend reducer の PendingApproval wire 形をそのまま食わせる。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApprovalCard } from "../src/ui/ApprovalCard.js";
import { LocaleProvider } from "../src/ui/LocaleProvider.js";

import type { AckState } from "../src/ui/approval-display.js";
import type { PendingApproval } from "../src/realtime/contract.js";

function pending(o: Partial<PendingApproval> = {}): PendingApproval {
  return {
    request_id: "req-1",
    tool_name: "Bash",
    command: "pnpm test",
    path: undefined,
    risk_level: "medium",
    requested_at: "2026-06-05T00:00:00.000Z",
    session_id: "s1",
    trigger: undefined,
    secret_kinds: undefined,
    persistable: undefined,
    ...o,
  };
}

const NOW_MS = Date.parse("2026-06-05T00:00:01.000Z");

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

function mount(
  approval: PendingApproval,
  onApprove: (...a: unknown[]) => void,
  ack?: AckState,
): void {
  act(() => {
    root.render(
      <LocaleProvider>
        <ul>
          <ApprovalCard
            approval={approval}
            ack={ack}
            nowMs={NOW_MS}
            onApprove={onApprove as never}
          />
        </ul>
      </LocaleProvider>,
    );
  });
}

function button(id: string): HTMLButtonElement {
  const el = container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
  if (el === null) throw new Error(`button not found: ${id}`);
  return el;
}

describe("ApprovalCard INV-PERSIST-CARD-CLICK (QA-4): onClick → onApprove 配線", () => {
  it("永続ボタン click → onApprove(request_id, 'allow_for_session', true)", () => {
    const onApprove = vi.fn();
    mount(pending({ risk_level: "medium", persistable: true }), onApprove);
    act(() => button("approval-allow-persist").click());
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(onApprove).toHaveBeenCalledWith("req-1", "allow_for_session", true);
  });

  it("allow click → onApprove(request_id, 'allow') (persist 引数なし)", () => {
    const onApprove = vi.fn();
    mount(pending({ risk_level: "medium", persistable: true }), onApprove);
    act(() => button("approval-allow").click());
    expect(onApprove).toHaveBeenCalledWith("req-1", "allow");
  });

  it("allow_for_session (非永続) click → onApprove(request_id, 'allow_for_session') (persist なし)", () => {
    const onApprove = vi.fn();
    mount(pending({ risk_level: "medium", persistable: true }), onApprove);
    act(() => button("approval-allow-for-session").click());
    expect(onApprove).toHaveBeenCalledWith("req-1", "allow_for_session");
  });

  it("deny click → onApprove(request_id, 'deny')", () => {
    const onApprove = vi.fn();
    mount(pending({ risk_level: "medium", persistable: true }), onApprove);
    act(() => button("approval-deny").click());
    expect(onApprove).toHaveBeenCalledWith("req-1", "deny");
  });

  it("送信中 ack: 永続ボタンは disabled・click しても onApprove を呼ばない (二重承認抑止)", () => {
    const onApprove = vi.fn();
    const ack: AckState = { decision: "allow_for_session", ok: undefined, error: undefined };
    mount(pending({ risk_level: "medium", persistable: true }), onApprove, ack);
    const btn = button("approval-allow-persist");
    expect(btn.disabled).toBe(true);
    act(() => btn.click()); // disabled button への click は no-op (ネイティブ <button disabled>)
    expect(onApprove).not.toHaveBeenCalled();
  });
});
