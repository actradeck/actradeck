/**
 * useRealtime 通知配線の契約テスト (QA-1 / decision 019ecd53 unblock).
 *
 * 背景: 純関数 (computeNotifications) と engine は緑でも、handleFrame の list ブランチ配線
 * 「snapshot.list は onListDelta を呼ばない / delta.list は **反映前 prev** を渡しちょうど 1 回呼ぶ」
 * が無監視だった (= 偽ゲート)。use-realtime.handleFrame はこの配線を純経路 applyListFrame へ
 * 委譲しており (単一出所)、本ファイルはその実コードを直接駆動して赤化可能にする。
 *
 * INV-NOTIFY-SNAPSHOT-NOT-FIRED:
 *  (a) snapshot.list 受信で onListDelta が呼ばれない。
 *  (b) delta.list 受信で (反映前 prev, curr) でちょうど 1 回呼ばれる。
 *  (c) 同一 session の連続 delta で 2 回目 prev = 1 回目 curr。
 */
import { describe, expect, it, vi } from "vitest";

import { applyListFrame, type ListFrame, type OnListDelta } from "../src/ui/list-frame-glue.js";
import { emptyListState, type ListState } from "../src/realtime/list-reducer.js";

import type { SessionListItem } from "../src/realtime/contract.js";

function item(over: Partial<SessionListItem> = {}): SessionListItem {
  return {
    session_id: "s-aaaaaaaaaaaa",
    provider: "claude_code",
    source: "hook",
    agent_id: undefined,
    repo: "acme/app",
    branch: "main",
    cwd: "/w",
    state: "running.command_executing",
    current_action: undefined,
    last_event_at: "2026-06-15T00:00:00.000Z",
    needs_attention: false,
    liveness_state: "live",
    stalled_suspected: false,
    connected: true,
    ...over,
  };
}

/** handleFrame の list 反映 + ref 更新を実コード経路で再現 (use-realtime と同一: applyListFrame)。 */
function drive(state: ListState, frame: ListFrame, onListDelta: OnListDelta): ListState {
  return applyListFrame(state, frame, onListDelta);
}

describe("INV-NOTIFY-SNAPSHOT-NOT-FIRED", () => {
  it("(a) snapshot.list は onListDelta を呼ばない (既に true の session があっても)", () => {
    const spy = vi.fn();
    const next = drive(
      emptyListState,
      {
        type: "snapshot.list",
        sessions: [
          item({ session_id: "s1", needs_attention: true }),
          item({ session_id: "s2", stalled_suspected: true }),
        ],
      },
      spy,
    );
    expect(spy).not.toHaveBeenCalled();
    // state は反映される。
    expect(next.items.size).toBe(2);
    expect(next.items.get("s1")?.needs_attention).toBe(true);
  });

  it("(b) delta.list は (反映前 prev, curr) でちょうど 1 回呼ばれる", () => {
    const spy = vi.fn();
    // 既存 prev を snapshot で用意 (この呼び出しは spy を呼ばない)。
    let state = drive(
      emptyListState,
      { type: "snapshot.list", sessions: [item({ session_id: "s1", needs_attention: false })] },
      spy,
    );
    expect(spy).not.toHaveBeenCalled();

    const curr = item({ session_id: "s1", needs_attention: true });
    state = drive(state, { type: "delta.list", session: curr }, spy);
    expect(spy).toHaveBeenCalledTimes(1);
    const [prevArg, currArg] = spy.mock.calls[0]!;
    // prev は **反映前** の state (needs_attention=false)。
    expect(prevArg?.needs_attention).toBe(false);
    expect(currArg).toBe(curr);
    // state には curr が反映済み。
    expect(state.items.get("s1")?.needs_attention).toBe(true);
  });

  it("(b') 初出 session の delta は prev=undefined で 1 回呼ばれる", () => {
    const spy = vi.fn();
    const curr = item({ session_id: "new", needs_attention: true });
    drive(emptyListState, { type: "delta.list", session: curr }, spy);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toBeUndefined();
  });

  it("(c) 同一 session の連続 delta で 2 回目 prev = 1 回目 curr", () => {
    const spy = vi.fn();
    const d1 = item({ session_id: "s1", needs_attention: false, state: "running.testing" });
    const d2 = item({ session_id: "s1", needs_attention: true, state: "waiting.approval" });
    const after1 = drive(emptyListState, { type: "delta.list", session: d1 }, spy);
    drive(after1, { type: "delta.list", session: d2 }, spy);
    expect(spy).toHaveBeenCalledTimes(2);
    // 2 回目の prev は 1 回目の curr そのもの。
    expect(spy.mock.calls[1]![0]).toBe(d1);
    expect(spy.mock.calls[1]![1]).toBe(d2);
  });

  it("onListDelta 未指定でも throw しない (副作用は optional)", () => {
    expect(() =>
      applyListFrame(emptyListState, { type: "delta.list", session: item() }, undefined),
    ).not.toThrow();
  });
});
