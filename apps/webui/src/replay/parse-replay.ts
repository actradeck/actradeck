"use client";

import { State, isIso8601 } from "@actradeck/event-model";

import type { ReplayEventDTO, ReplayEventsPage } from "../realtime/contract";

const REPLAY_ORDER: ReplayEventsPage["order"] = "timestamp_event_id_asc";

const REPLAY_KINDS = new Set<ReplayEventDTO["kind"]>([
  "session",
  "turn",
  "approval",
  "command",
  "file",
  "tool",
  "mcp",
  "web",
  "message",
  "liveness",
  "error",
  "other",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function optString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function optBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function optNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function parseReplayEvent(v: unknown): ReplayEventDTO | null {
  if (!isRecord(v)) return null;
  if (
    typeof v.event_id !== "string" ||
    typeof v.provider !== "string" ||
    typeof v.source !== "string" ||
    typeof v.session_id !== "string" ||
    typeof v.event_type !== "string" ||
    typeof v.kind !== "string" ||
    !REPLAY_KINDS.has(v.kind as ReplayEventDTO["kind"]) ||
    typeof v.timestamp !== "string" ||
    !isIso8601(v.timestamp) ||
    typeof v.display_text !== "string"
  ) {
    return null;
  }
  const state = optString(v.state);
  if (state !== undefined && !State.safeParse(state).success) return null;
  return {
    event_id: v.event_id,
    provider: v.provider,
    source: v.source,
    session_id: v.session_id,
    event_type: v.event_type,
    kind: v.kind as ReplayEventDTO["kind"],
    timestamp: v.timestamp,
    state,
    cwd: optString(v.cwd),
    summary: optString(v.summary),
    display_text: v.display_text,
    // 言語非依存の構造値 (P2・ADR 019eeac6)。UI は kind + subject を表示時 locale で組み立てる。
    subject: optString(v.subject),
    request_id: optString(v.request_id),
    tool_name: optString(v.tool_name),
    command: optString(v.command),
    path: optString(v.path),
    risk_level: optString(v.risk_level),
    decision: optString(v.decision),
    auto_allowed: optBool(v.auto_allowed),
    exit_code: optNumber(v.exit_code),
    elapsed_ms: optNumber(v.elapsed_ms),
  };
}

export function parseReplayEventsPage(raw: unknown): ReplayEventsPage | null {
  if (!isRecord(raw)) return null;
  if (
    typeof raw.session_id !== "string" ||
    raw.order !== REPLAY_ORDER ||
    !Array.isArray(raw.events) ||
    typeof raw.limit !== "number" ||
    !Number.isInteger(raw.limit) ||
    raw.limit <= 0 ||
    typeof raw.has_more !== "boolean"
  ) {
    return null;
  }
  const events = raw.events.map(parseReplayEvent);
  if (events.some((e) => e === null)) return null;
  const parsedEvents = events as ReplayEventDTO[];
  for (let i = 1; i < parsedEvents.length; i += 1) {
    const prev = parsedEvents[i - 1]!;
    const current = parsedEvents[i]!;
    const prevMs = Date.parse(prev.timestamp);
    const currentMs = Date.parse(current.timestamp);
    if (prevMs > currentMs) return null;
    if (prevMs === currentMs && prev.event_id > current.event_id) return null;
  }
  return {
    session_id: raw.session_id,
    order: REPLAY_ORDER,
    events: parsedEvents,
    limit: raw.limit,
    has_more: raw.has_more,
    next_cursor: optString(raw.next_cursor),
  };
}
