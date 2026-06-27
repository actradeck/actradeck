/**
 * INV-EVENT-TRANSITION: 状態遷移バリデータが T1 遷移表を強制する。
 *
 * 契約 (T1):
 * - 正当な遷移 (created -> starting -> running.* -> waiting.* / completed 等) を許可。
 * - 不正な遷移 (completed -> running 等、終端からの離脱) を拒否。
 * - 同一状態への遷移 (冪等な再観測) は許可。
 * - assertValidTransition は不正時に InvalidStateTransitionError を投げる。
 * - 遷移表の参照整合: 全 to が State enum 内であること。
 */
import { describe, expect, it } from "vitest";

import {
  ALL_STATES,
  STATE_TRANSITIONS,
  State,
  TERMINAL_STATES,
  assertValidTransition,
  isValidTransition,
  InvalidStateTransitionError,
} from "../src/index.js";

describe("INV-EVENT-TRANSITION", () => {
  const VALID: ReadonlyArray<[State, State]> = [
    ["created", "starting"],
    ["starting", "running.model_wait"],
    ["running.model_wait", "running.model_streaming"],
    ["running.model_streaming", "running.tool_preparing"],
    ["running.tool_preparing", "running.command_executing"],
    ["running.command_executing", "running.testing"],
    ["running.command_executing", "waiting.approval"],
    ["waiting.approval", "running.command_executing"],
    ["running.file_editing", "waiting.approval"],
    ["running.testing", "completed"],
    ["running.command_executing", "failed"],
    ["running.model_wait", "stalled"],
    ["stalled", "running.model_streaming"], // 復帰 (停止を断定しない)
    ["running.model_streaming", "compacting"],
    ["compacting", "running.model_streaming"],
    ["waiting.user_input", "running.model_wait"],
    ["idle", "running.planning"],
    ["disconnected", "running.command_executing"],
  ];

  const INVALID: ReadonlyArray<[State, State]> = [
    ["completed", "running.command_executing"], // 終端からの離脱
    ["completed", "starting"],
    ["failed", "running.model_wait"],
    ["interrupted", "running.testing"],
    ["created", "running.command_executing"], // starting を飛ばせない
    ["created", "completed"],
    ["created", "waiting.approval"],
    ["waiting.approval", "created"], // 後戻り不可
  ];

  it.each(VALID)("allows %s -> %s", (from, to) => {
    expect(isValidTransition(from, to)).toBe(true);
  });

  it.each(INVALID)("rejects %s -> %s", (from, to) => {
    expect(isValidTransition(from, to)).toBe(false);
  });

  it("allows idempotent same-state transitions (re-observation)", () => {
    for (const s of ALL_STATES) {
      expect(isValidTransition(s, s)).toBe(true);
    }
  });

  it("assertValidTransition throws InvalidStateTransitionError on a bad transition", () => {
    expect(() => assertValidTransition("completed", "running.command_executing")).toThrow(
      InvalidStateTransitionError,
    );
  });

  it("assertValidTransition does not throw on a valid transition", () => {
    expect(() => assertValidTransition("created", "starting")).not.toThrow();
  });

  it("terminal states have no outgoing transitions (T1)", () => {
    for (const t of TERMINAL_STATES) {
      expect(STATE_TRANSITIONS[t]).toEqual([]);
      for (const to of ALL_STATES) {
        if (to === t) continue; // 同一状態のみ冪等許可
        expect(isValidTransition(t, to)).toBe(false);
      }
    }
  });

  it("transition table only references known states (referential integrity)", () => {
    const known = new Set<string>(ALL_STATES);
    for (const [from, tos] of Object.entries(STATE_TRANSITIONS)) {
      expect(known.has(from)).toBe(true);
      for (const to of tos) {
        expect(known.has(to)).toBe(true);
      }
    }
  });

  it("every state has a transition-table entry (exhaustive)", () => {
    for (const s of ALL_STATES) {
      expect(STATE_TRANSITIONS).toHaveProperty(s);
    }
  });
});
