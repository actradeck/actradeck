/**
 * INV-STATE-TRANSITION (P0, testing.md / ingestion-events.md)。
 *
 * State Engine reducer の不変条件 (純関数・DB 非依存・決定論):
 *  1. terminal (completed/failed/interrupted) 後の state 変更を**拒否** (安全側・無視)。
 *  2. 不正遷移は projection に適用せず、不正としてカウントする (append-only の events には残る)。
 *  3. 妥当な遷移は適用される。
 *  4. 決定論: 同じイベント列 → 同じ最終 state。
 *  5. 承認待ち (waiting.approval / permission.requested) で needs_attention=true、解決で解除。
 *
 * 遷移真実は T1 (STATE_TRANSITIONS / isValidTransition / isTerminalState) を**唯一参照**。
 */
import { describe, expect, it } from "vitest";

import { isTerminalState, type State } from "@actradeck/event-model";

import { applyEvent, initialProjection, reduceEvents } from "../src/reducer.js";
import { makeEvent } from "./helpers.js";

const SID = "sess_state_inv";

describe("INV-STATE-TRANSITION: reducer rejects terminal-after transitions (safe side)", () => {
  it("ignores any state change after a terminal state (completed → running rejected)", () => {
    let proj = initialProjection(SID);
    proj = applyEvent(
      proj,
      makeEvent({ session_id: SID, event_type: "session.started", state: "created" }),
    ).projection;
    proj = applyEvent(
      proj,
      makeEvent({ session_id: SID, event_type: "turn.started", state: "starting" }),
    ).projection;
    proj = applyEvent(
      proj,
      makeEvent({
        session_id: SID,
        event_type: "agent.message.delta",
        state: "running.model_streaming",
      }),
    ).projection;
    proj = applyEvent(
      proj,
      makeEvent({ session_id: SID, event_type: "turn.completed", state: "completed" }),
    ).projection;
    expect(proj.state).toBe("completed");

    // terminal 後に running を投げ込む → 無視される (state は completed のまま)。
    const r = applyEvent(
      proj,
      makeEvent({ session_id: SID, event_type: "turn.started", state: "running.model_wait" }),
    );
    expect(r.ignoredAfterTerminal).toBe(true);
    expect(r.projection.state).toBe("completed");
    // last_event_* は前進してよい (観測事実)。
    expect(r.projection.last_event_id).not.toBe(proj.last_event_id);
  });

  it("rejects each terminal state's outbound transitions", () => {
    for (const terminal of ["completed", "failed", "interrupted"] as State[]) {
      expect(isTerminalState(terminal)).toBe(true);
      let proj = initialProjection(SID);
      proj = applyEvent(
        proj,
        makeEvent({
          session_id: SID,
          state: "running.model_wait",
          event_type: "agent.message.delta",
        }),
      ).projection;
      proj = applyEvent(
        proj,
        makeEvent({ session_id: SID, state: terminal, event_type: "turn.completed" }),
      ).projection;
      expect(proj.state).toBe(terminal);
      const r = applyEvent(
        proj,
        makeEvent({
          session_id: SID,
          state: "running.command_executing",
          event_type: "command.started",
        }),
      );
      expect(r.projection.state).toBe(terminal); // 据え置き
      expect(r.ignoredAfterTerminal).toBe(true);
    }
  });
});

describe("INV-STATE-TRANSITION: invalid transitions are recorded but not applied", () => {
  it("does not apply an invalid transition and increments the counter", () => {
    let proj = initialProjection(SID);
    // created → running.command_executing は遷移表に無い (created は starting/disconnected/failed のみ)。
    proj = applyEvent(
      proj,
      makeEvent({ session_id: SID, state: "created", event_type: "session.started" }),
    ).projection;
    expect(proj.state).toBe("created");
    const r = applyEvent(
      proj,
      makeEvent({
        session_id: SID,
        state: "running.command_executing",
        event_type: "command.started",
      }),
    );
    expect(r.invalidTransition).toBe(true);
    expect(r.projection.state).toBe("created"); // 据え置き
    expect(r.projection.invalid_transition_count).toBe(1);
  });

  it("applies a valid transition", () => {
    let proj = initialProjection(SID);
    proj = applyEvent(
      proj,
      makeEvent({ session_id: SID, state: "starting", event_type: "session.started" }),
    ).projection;
    const r = applyEvent(
      proj,
      makeEvent({ session_id: SID, state: "running.model_wait", event_type: "turn.started" }),
    );
    expect(r.invalidTransition).toBe(false);
    expect(r.projection.state).toBe("running.model_wait");
  });

  it("allows idempotent re-observation of the same state (delta storms)", () => {
    let proj = initialProjection(SID);
    proj = applyEvent(
      proj,
      makeEvent({
        session_id: SID,
        state: "running.model_streaming",
        event_type: "agent.message.delta",
      }),
    ).projection;
    const r = applyEvent(
      proj,
      makeEvent({
        session_id: SID,
        state: "running.model_streaming",
        event_type: "agent.message.delta",
      }),
    );
    expect(r.invalidTransition).toBe(false);
    expect(r.projection.state).toBe("running.model_streaming");
  });
});

describe("INV-STATE-TRANSITION: stateless events do not change state", () => {
  it("heartbeat / delta without state leaves state untouched but advances last_event", () => {
    let proj = initialProjection(SID);
    proj = applyEvent(
      proj,
      makeEvent({
        session_id: SID,
        state: "running.command_executing",
        event_type: "command.started",
      }),
    ).projection;
    const before = proj.state;
    const r = applyEvent(
      proj,
      makeEvent({ session_id: SID, event_type: "heartbeat", payload: { process_alive: true } }),
    );
    expect(r.projection.state).toBe(before);
    expect(r.invalidTransition).toBe(false);
    expect(r.projection.last_event_id).not.toBe(proj.last_event_id);
  });
});

describe("INV-STATE-TRANSITION: needs_attention derivation", () => {
  it("sets needs_attention on permission request and clears on resolve", () => {
    let proj = initialProjection(SID);
    proj = applyEvent(
      proj,
      makeEvent({ session_id: SID, state: "running.tool_preparing", event_type: "tool.started" }),
    ).projection;
    proj = applyEvent(
      proj,
      makeEvent({
        session_id: SID,
        state: "waiting.approval",
        event_type: "tool.permission.requested",
      }),
    ).projection;
    expect(proj.needs_attention).toBe(true);
    proj = applyEvent(
      proj,
      makeEvent({
        session_id: SID,
        state: "running.command_executing",
        event_type: "tool.permission.resolved",
        payload: { kind: "tool.permission.resolved", decision: "allow" },
      }),
    ).projection;
    expect(proj.needs_attention).toBe(false);
  });
});

describe("INV-STATE-TRANSITION: reducer is deterministic", () => {
  it("same event sequence yields same final state", () => {
    const seq = [
      makeEvent({ session_id: SID, state: "created", event_type: "session.started" }),
      makeEvent({ session_id: SID, state: "starting", event_type: "turn.started" }),
      makeEvent({
        session_id: SID,
        state: "running.model_wait",
        event_type: "agent.message.delta",
      }),
      makeEvent({
        session_id: SID,
        state: "running.command_executing",
        event_type: "command.started",
      }),
      makeEvent({ session_id: SID, state: "completed", event_type: "turn.completed" }),
    ];
    const a = reduceEvents(SID, seq);
    const b = reduceEvents(SID, seq);
    expect(a).toEqual(b);
    expect(a.state).toBe("completed");
  });
});
