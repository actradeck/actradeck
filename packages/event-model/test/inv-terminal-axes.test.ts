/**
 * INV-TERMINAL-AXES: ADR 0014 の terminal 直交軸マップ / 失敗分割の T1 契約を固定する。
 *
 * 契約 (T1・単一正典):
 * - `FAILURE_TERMINAL_STATES` は失敗 terminal (= failed/interrupted) のみ。completed / suspended は
 *   含まない。TERMINAL_STATES の部分集合。**減算派生の再発防止** (SEC-1/TDA-1: suspended が
 *   TERMINAL_STATES へ入っても失敗集合へは自動混入しないことを membership で固定)。
 * - `terminalContinuation` / `terminalEvidenceFor` は terminal 状態から直交軸の既定を導出し、
 *   non-terminal / undefined では undefined を返す (QA-2: helper とマップの直接カバレッジ)。
 */
import { describe, expect, it } from "vitest";

import {
  ALL_STATES,
  TERMINAL_STATES,
  FAILURE_TERMINAL_STATES,
  TERMINAL_CONTINUATION,
  TERMINAL_EVIDENCE_DEFAULT,
  isFailureTerminalStateValue,
  isTerminalState,
  resolveContinuation,
  terminalContinuation,
  terminalEvidenceFor,
  type State,
} from "../src/index.js";

describe("INV-TERMINAL-AXES: failure 分割 (ADR 0014 SEC-1/TDA-1)", () => {
  it("FAILURE_TERMINAL_STATES は failed/interrupted のみ (completed/suspended を含まない)", () => {
    expect([...FAILURE_TERMINAL_STATES].sort()).toEqual(["failed", "interrupted"]);
    expect(FAILURE_TERMINAL_STATES).not.toContain("completed");
    expect(FAILURE_TERMINAL_STATES).not.toContain("suspended");
  });

  it("FAILURE_TERMINAL_STATES は TERMINAL_STATES の部分集合", () => {
    const terminal = new Set<string>(TERMINAL_STATES);
    for (const s of FAILURE_TERMINAL_STATES) expect(terminal.has(s)).toBe(true);
  });

  it("isFailureTerminalStateValue: 失敗 terminal のみ true・completed/suspended/非terminal/undefined は false", () => {
    expect(isFailureTerminalStateValue("failed")).toBe(true);
    expect(isFailureTerminalStateValue("interrupted")).toBe(true);
    expect(isFailureTerminalStateValue("completed")).toBe(false);
    expect(isFailureTerminalStateValue("suspended")).toBe(false);
    expect(isFailureTerminalStateValue("running.command_executing")).toBe(false);
    expect(isFailureTerminalStateValue(undefined)).toBe(false);
    expect(isFailureTerminalStateValue("bogus")).toBe(false);
  });
});

describe("INV-TERMINAL-AXES: continuation / terminal_evidence 導出 (ADR 0014 QA-2)", () => {
  const CONTINUATION: ReadonlyArray<[State, string]> = [
    ["completed", "not_resumable"],
    ["failed", "unknown"],
    ["interrupted", "unknown"],
    ["suspended", "resumable"],
  ];
  const EVIDENCE: ReadonlyArray<[State, string]> = [
    ["completed", "provider"],
    ["interrupted", "provider"],
    ["suspended", "provider"],
    ["failed", "inferred"],
  ];

  it.each(CONTINUATION)("terminalContinuation(%s) = %s", (state, expected) => {
    expect(terminalContinuation(state)).toBe(expected);
    expect(TERMINAL_CONTINUATION[state]).toBe(expected);
  });

  it.each(EVIDENCE)("terminalEvidenceFor(%s) = %s", (state, expected) => {
    expect(terminalEvidenceFor(state)).toBe(expected);
    expect(TERMINAL_EVIDENCE_DEFAULT[state]).toBe(expected);
  });

  it("全 terminal 状態が continuation / terminal_evidence の既定を持つ (漏れなし)", () => {
    for (const s of TERMINAL_STATES) {
      expect(terminalContinuation(s)).toBeDefined();
      expect(terminalEvidenceFor(s)).toBeDefined();
    }
  });

  it("non-terminal 状態と undefined では continuation / terminal_evidence は undefined", () => {
    for (const s of ALL_STATES) {
      if (isTerminalState(s)) continue;
      expect(terminalContinuation(s)).toBeUndefined();
      expect(terminalEvidenceFor(s)).toBeUndefined();
    }
    expect(terminalContinuation(undefined)).toBeUndefined();
    expect(terminalEvidenceFor(undefined)).toBeUndefined();
  });
});

describe("INV-TERMINAL-AXES: resolveContinuation は stored-first (ADR 0014 Phase 3c・decision 019fd250)", () => {
  it("TDA-4 実例: managed codex child-exit — stored=not_resumable が derived('failed')=unknown に勝つ", () => {
    expect(resolveContinuation("not_resumable", "failed")).toBe("not_resumable");
    // stored 不在なら derived 既定 (failed→unknown) へ fallback する。
    expect(resolveContinuation(undefined, "failed")).toBe("unknown");
  });

  it("stored があれば state に依らず stored (state 側の既定を並記/上書きしない)", () => {
    expect(resolveContinuation("resumable", "completed")).toBe("resumable");
    expect(resolveContinuation("unknown", "suspended")).toBe("unknown");
    expect(resolveContinuation("not_resumable", undefined)).toBe("not_resumable");
    expect(resolveContinuation("not_resumable", "bogus-state")).toBe("not_resumable");
  });

  it("stored 不在は terminalContinuation(state) へ fallback (全 terminal で一致)", () => {
    for (const s of TERMINAL_STATES) {
      expect(resolveContinuation(undefined, s)).toBe(terminalContinuation(s));
    }
  });

  it("stored 不在 + 非 terminal / out-of-enum / undefined state は undefined (over-claim しない)", () => {
    expect(resolveContinuation(undefined, "running.command_executing")).toBeUndefined();
    expect(resolveContinuation(undefined, "bogus-state")).toBeUndefined();
    expect(resolveContinuation(undefined, undefined)).toBeUndefined();
  });
});
