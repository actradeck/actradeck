/**
 * INV-CURRENT-ACTION-KIND (event-model 層): ActionKind 語彙 + eventTypeToActionKind 写像の T1 契約。
 *
 * 契約 (T1):
 * - `ACTION_KINDS` は「観測された作業の種類」の単一権威 (closed-enum)。webui action-units.ts の
 *   ActionKind union と完全一致 (後続で webui がこれを import して単一出所化するため)。
 * - `eventTypeToActionKind` は全 EventType (event-type.ts の 30 種) を ActionKind へ網羅写像する。
 *   replay-store.kindOf と同一 prefix ロジックを共有 (差は error のみ・別 inv で pin)。
 * - `isActionKind` が既知判定する (未知値は false = forward-compat に undefined 化)。
 *
 * falsifiable: 写像 1 entry を変えると該当アサートが赤化する (mutation 反証済)。
 */
import { describe, expect, it } from "vitest";

import {
  ACTION_KINDS,
  ActionKindSet,
  ALL_EVENT_TYPES,
  eventTypeToActionKind,
  isActionKind,
  type ActionKind,
} from "../src/index.js";

describe("INV-CURRENT-ACTION-KIND: vocabulary", () => {
  it("matches the webui action-units ActionKind union exactly (single source of truth)", () => {
    // webui apps/webui/src/ui/action-units.ts:33-44 の ActionKind union と完全一致を pin。
    // ここがドリフトすると realtime-frontend の import 単一出所化が壊れる。
    expect([...ACTION_KINDS].sort()).toEqual(
      [
        "approval",
        "command",
        "file",
        "tool",
        "mcp",
        "web",
        "turn",
        "session",
        "message",
        "liveness",
        "other",
      ].sort(),
    );
  });

  it("has no duplicate kinds (well-formed set)", () => {
    expect(ActionKindSet.size).toBe(ACTION_KINDS.length);
  });

  it("isActionKind agrees with the set and rejects unknown values (forward-compat)", () => {
    for (const k of ACTION_KINDS) {
      expect(isActionKind(k)).toBe(true);
      expect(ActionKindSet.has(k)).toBe(true);
    }
    expect(isActionKind("error")).toBe(false); // error は ActionKind ではない (tool へ畳む)
    expect(isActionKind("subagent")).toBe(false);
    expect(isActionKind("totally-unknown")).toBe(false);
    expect(isActionKind("")).toBe(false);
  });
});

describe("INV-CURRENT-ACTION-KIND: eventTypeToActionKind covers all 30 EventTypes", () => {
  // 全 30 EventType の期待 kind (network/normalizer が emit する正典分類)。
  const EXPECTED: Record<string, ActionKind> = {
    "session.started": "session",
    "session.ended": "session",
    "turn.started": "turn",
    "turn.plan.updated": "turn",
    "turn.completed": "turn",
    "turn.failed": "turn",
    "agent.message.delta": "message",
    "agent.reasoning_summary.delta": "message",
    "tool.started": "tool",
    "tool.output.delta": "tool",
    "tool.completed": "tool",
    "tool.failed": "tool",
    "tool.permission.requested": "approval",
    "tool.permission.resolved": "approval",
    "command.started": "command",
    "command.output.delta": "command",
    "command.completed": "command",
    "file.change.proposed": "file",
    "file.change.approved": "file",
    "file.change.applied": "file",
    "diff.updated": "file",
    "mcp.call.started": "mcp",
    "mcp.call.completed": "mcp",
    "web.search.started": "web",
    "subagent.started": "other",
    "subagent.completed": "other",
    "context.compacted": "other",
    heartbeat: "liveness",
    "stalled.detected": "liveness",
    error: "tool",
  };

  it("every EventType has an expected mapping (no gaps / no extras)", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...ALL_EVENT_TYPES].sort());
    expect(ALL_EVENT_TYPES.length).toBe(30);
  });

  for (const eventType of ALL_EVENT_TYPES) {
    it(`maps ${eventType} -> ${EXPECTED[eventType]}`, () => {
      const kind = eventTypeToActionKind(eventType);
      expect(isActionKind(kind)).toBe(true);
      expect(kind).toBe(EXPECTED[eventType]);
    });
  }

  it("maps unknown / future event_type to other (forward-compat)", () => {
    expect(eventTypeToActionKind("brand.new.future.type")).toBe("other");
    expect(eventTypeToActionKind("")).toBe("other");
  });
});
