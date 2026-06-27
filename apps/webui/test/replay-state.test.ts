import { newEventId } from "@actradeck/event-model";
import { describe, expect, it } from "vitest";

import { parseReplayEvent, parseReplayEventsPage } from "../src/replay/parse-replay.js";
import {
  buildProjectionTimeline,
  projectionAt,
  replayDtoToEvent,
  replayTimelineWindow,
  stepReplayIndex,
} from "../src/replay/replay-state.js";

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

describe("replay parser", () => {
  it("parses a valid replay page and ignores raw payload fields", () => {
    const raw = {
      session_id: "s1",
      order: "timestamp_event_id_asc",
      limit: 200,
      has_more: false,
      events: [dto({ command: "echo [REDACTED:github-token]" })],
      payload: { secret: "must-not-be-read" },
    };
    const parsed = parseReplayEventsPage(raw);
    expect(parsed?.events[0]?.command).toBe("echo [REDACTED:github-token]");
    expect(JSON.stringify(parsed)).not.toContain("must-not-be-read");
  });

  it("round-trips subject from raw DTO through parseReplayEvent (P2・ADR 019eeac6)", () => {
    // mutation 反証 (parse-replay.ts:71 の `subject: optString(v.subject)` を消すと subject が
    // undefined に落ち、UI が kind+subject でなく display_text(日本語焼込) へ silent 退行する)。
    // 構造値 (command イベントの言語非依存 subject) が parser を素通りすることを固定する。
    const parsed = parseReplayEvent({
      event_id: "ev-subj",
      provider: "claude_code",
      source: "hooks",
      session_id: "s1",
      event_type: "command.started",
      kind: "command",
      timestamp: "2026-06-06T00:00:00.000Z",
      display_text: "コマンド実行: npm test",
      subject: "npm test",
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.subject).toBe("npm test");

    // subject 非 string (型不正) は undefined へ正規化 (optString 契約)。
    const dropped = parseReplayEvent({
      event_id: "ev-bad-subj",
      provider: "claude_code",
      source: "hooks",
      session_id: "s1",
      event_type: "command.started",
      kind: "command",
      timestamp: "2026-06-06T00:00:00.000Z",
      display_text: "x",
      subject: 123,
    });
    expect(dropped?.subject).toBeUndefined();
  });

  it("rejects malformed pages and events", () => {
    expect(parseReplayEventsPage({ session_id: "s1", events: "nope" })).toBeNull();
    expect(
      parseReplayEventsPage({
        session_id: "s1",
        order: "timestamp_event_id_asc",
        limit: 1,
        has_more: false,
        events: [{}],
      }),
    ).toBeNull();
    expect(
      parseReplayEventsPage({
        session_id: "s1",
        order: "timestamp_event_id_asc",
        limit: 1,
        has_more: false,
        events: [dto({ kind: "raw" as ReplayEventDTO["kind"] })],
      }),
    ).toBeNull();
    expect(
      parseReplayEventsPage({
        session_id: "s1",
        order: "timestamp_event_id_asc",
        limit: 1,
        has_more: false,
        events: [dto({ timestamp: "not-a-date" })],
      }),
    ).toBeNull();
    expect(
      parseReplayEventsPage({
        session_id: "s1",
        order: "timestamp_event_id_asc",
        limit: 1,
        has_more: false,
        events: [dto({ state: "running.raw" })],
      }),
    ).toBeNull();
    expect(
      parseReplayEventsPage({
        session_id: "s1",
        order: "arrival_order",
        limit: 1,
        has_more: false,
        events: [dto()],
      }),
    ).toBeNull();
    expect(
      parseReplayEventsPage({
        session_id: "s1",
        order: "timestamp_event_id_asc",
        limit: 2,
        has_more: false,
        events: [
          dto({ event_id: "ev-b", timestamp: "2026-06-06T00:00:01.000Z" }),
          dto({ event_id: "ev-a", timestamp: "2026-06-06T00:00:01.000Z" }),
        ],
      }),
    ).toBeNull();
    expect(
      parseReplayEventsPage({
        session_id: "s1",
        order: "timestamp_event_id_asc",
        limit: 2,
        has_more: false,
        events: [
          dto({ timestamp: "2026-06-06T00:00:02.000Z" }),
          dto({ timestamp: "2026-06-06T00:00:01.000Z" }),
        ],
      }),
    ).toBeNull();
  });
});

describe("replay state reconstruction", () => {
  it("converts DTO to NormalizedEvent and rebuilds pending approval state deterministically", () => {
    const events: ReplayEventDTO[] = [
      dto({
        event_type: "session.started",
        kind: "session",
        state: "starting",
        summary: "start",
      }),
      dto({
        event_type: "tool.permission.requested",
        kind: "approval",
        state: "waiting.approval",
        timestamp: "2026-06-06T00:00:01.000Z",
        summary: "approval",
        request_id: "s1:apr-test",
        tool_name: "Bash",
        command: "rm -rf /tmp/x",
        risk_level: "high",
      }),
      dto({
        event_type: "tool.permission.resolved",
        kind: "approval",
        state: "running.tool_preparing",
        timestamp: "2026-06-06T00:00:02.000Z",
        summary: "resolved",
        request_id: "s1:apr-test",
        decision: "deny",
      }),
    ];

    expect(replayDtoToEvent(events[1]!)).not.toBeNull();
    const pending = projectionAt("s1", events, 1);
    expect(pending.state).toBe("waiting.approval");
    expect(pending.pending_approvals).toHaveLength(1);

    const resolvedA = projectionAt("s1", events, 2);
    const resolvedB = projectionAt("s1", events, 2);
    expect(resolvedA).toEqual(resolvedB);
    expect(resolvedA.pending_approvals).toHaveLength(0);

    const timeline = buildProjectionTimeline("s1", events);
    expect(timeline.invalid_event_count).toBe(0);
    expect(timeline.projections[1]?.pending_approvals).toHaveLength(1);
    expect(timeline.projections[2]).toEqual(resolvedA);
  });

  it("bounds stepping for empty and non-empty timelines", () => {
    expect(stepReplayIndex(-1, 0, 1)).toBe(-1);
    expect(stepReplayIndex(0, 3, -1)).toBe(0);
    expect(stepReplayIndex(2, 3, 1)).toBe(2);
    expect(stepReplayIndex(1, 3, 1)).toBe(2);
  });

  it("windows large timelines around the current event without rendering all rows", () => {
    const events = Array.from({ length: 500 }, (_, i) => dto({ event_id: `ev-${i}` }));
    const win = replayTimelineWindow(events, 250, 101);
    expect(win.items).toHaveLength(101);
    expect(win.start).toBe(200);
    expect(win.end).toBe(301);
    expect(win.items[50]?.index).toBe(250);
    expect(win.items[50]?.event.event_id).toBe("ev-250");
  });
});
