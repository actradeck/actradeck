/**
 * INV-EVENT-TYPE-CLOSED: event_type は closed enum を維持する (ADR 019f2d2c D2・非対称原則)。
 *
 * 契約 (T1):
 * - provider は slug 開放 (WHO) だが、event_type は **意味** ゆえ closed のまま。
 *   projection の状態機械 (reducer 18+ 分岐) が各 event_type に遷移を結線しており、
 *   未知 type を受理すると状態遷移が **静かに欠落** する correctness ホールになる。
 *   正規化は取込アダプタ側の責務であり、未知 type は fail-safe reject する。
 * - falsifiability: EventType を z.string() へ緩めると「未知 type reject」が RED になる。
 */
import { describe, expect, it } from "vitest";

import { EventType, ALL_EVENT_TYPES, safeParseEvent } from "../src/index.js";
import { validEvent } from "./helpers.js";

describe("INV-EVENT-TYPE-CLOSED", () => {
  it("EventType remains a closed enum (options are a fixed non-empty set)", () => {
    expect(Array.isArray(ALL_EVENT_TYPES)).toBe(true);
    expect(ALL_EVENT_TYPES.length).toBeGreaterThanOrEqual(18);
    // 代表 anchor が存在する (enum が丸ごと string 化されていない回帰検知)。
    expect(ALL_EVENT_TYPES).toContain("session.started");
    expect(ALL_EVENT_TYPES).toContain("tool.permission.requested");
    expect(ALL_EVENT_TYPES).toContain("stalled.detected");
  });

  it.each(ALL_EVENT_TYPES)("accepts known event_type %s", (t) => {
    expect(EventType.safeParse(t).success).toBe(true);
  });

  it.each([
    "tool.exploded",
    "session.paused",
    "custom.event",
    "SESSION.STARTED",
    "",
    "session started",
  ])("rejects unknown/malformed event_type %s (closed・NO widening)", (t) => {
    expect(EventType.safeParse(t).success).toBe(false);
    expect(safeParseEvent(validEvent({ event_type: t as never })).success).toBe(false);
  });

  it("rejects a non-string event_type", () => {
    expect(EventType.safeParse(42).success).toBe(false);
  });
});
