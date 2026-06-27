import { newEventId } from "@actradeck/event-model";
import { describe, expect, it } from "vitest";

import { createReplayRequestGate, mergeReplayEvents } from "../src/replay/replay-load.js";

import type { ReplayEventDTO } from "../src/realtime/contract.js";

function dto(o: Partial<ReplayEventDTO> = {}): ReplayEventDTO {
  return {
    event_id: newEventId(),
    provider: "claude_code",
    source: "hooks",
    session_id: "s1",
    event_type: "heartbeat",
    kind: "liveness",
    timestamp: "2026-06-06T00:00:00.000Z",
    state: undefined,
    cwd: undefined,
    summary: "alive",
    display_text: "alive",
    subject: undefined,
    request_id: undefined,
    tool_name: undefined,
    command: undefined,
    path: undefined,
    risk_level: undefined,
    decision: undefined,
    auto_allowed: undefined,
    exit_code: undefined,
    elapsed_ms: undefined,
    ...o,
  };
}

describe("replay load gate", () => {
  it("rejects duplicate in-flight loads and makes stale generations non-current", () => {
    const gate = createReplayRequestGate();
    const g1 = gate.nextGeneration();
    expect(gate.tryStart(g1)).toBe(true);
    expect(gate.tryStart(g1)).toBe(false);

    const g2 = gate.nextGeneration();
    expect(gate.isCurrent(g1)).toBe(false);
    expect(gate.isCurrent(g2)).toBe(true);
    expect(gate.tryStart(g2)).toBe(true);

    gate.finish(g1);
    expect(gate.tryStart(g2)).toBe(false);
    gate.finish(g2);
    expect(gate.tryStart(g2)).toBe(true);
  });

  it("deduplicates loaded event ids and reports truncation at the retained event cap", () => {
    const keep = dto({ event_id: "ev-1" });
    const incoming = [
      dto({ event_id: "ev-1" }),
      dto({ event_id: "ev-2" }),
      dto({ event_id: "ev-3" }),
    ];

    const merged = mergeReplayEvents([keep], incoming, 2);

    expect(merged.events.map((ev) => ev.event_id)).toEqual(["ev-1", "ev-2"]);
    expect(merged.appendedCount).toBe(1);
    expect(merged.truncated).toBe(true);
  });

  it("deduplicates overlapping pages without treating duplicates as cap truncation", () => {
    const keep = dto({ event_id: "ev-1" });
    const incoming = [dto({ event_id: "ev-1" }), dto({ event_id: "ev-2" })];

    const merged = mergeReplayEvents([keep], incoming, 10);

    expect(merged.events.map((ev) => ev.event_id)).toEqual(["ev-1", "ev-2"]);
    expect(merged.appendedCount).toBe(1);
    expect(merged.truncated).toBe(false);
  });
});
