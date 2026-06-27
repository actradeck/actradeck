"use client";

import { safeParseEvent, type NormalizedEvent } from "@actradeck/event-model";
import {
  applyEvent,
  initialProjection,
  reduceEvents,
  type SessionProjection,
} from "@actradeck/projection";

import type { ReplayEventDTO } from "../realtime/contract";

function dtoPayload(dto: ReplayEventDTO): Record<string, unknown> {
  return {
    ...(dto.request_id !== undefined ? { request_id: dto.request_id } : {}),
    ...(dto.tool_name !== undefined ? { tool_name: dto.tool_name } : {}),
    ...(dto.command !== undefined ? { command: dto.command } : {}),
    ...(dto.path !== undefined ? { path: dto.path } : {}),
    ...(dto.risk_level !== undefined ? { risk_level: dto.risk_level } : {}),
    ...(dto.decision !== undefined ? { decision: dto.decision } : {}),
    ...(dto.auto_allowed !== undefined ? { auto_allowed: dto.auto_allowed } : {}),
    ...(dto.exit_code !== undefined ? { exit_code: dto.exit_code } : {}),
  };
}

export function replayDtoToEvent(dto: ReplayEventDTO): NormalizedEvent | null {
  const parsed = safeParseEvent({
    event_id: dto.event_id,
    provider: dto.provider,
    source: dto.source,
    session_id: dto.session_id,
    event_type: dto.event_type,
    ...(dto.state !== undefined ? { state: dto.state } : {}),
    timestamp: dto.timestamp,
    ...(dto.cwd !== undefined ? { cwd: dto.cwd } : {}),
    ...(dto.summary !== undefined ? { summary: dto.summary } : {}),
    payload: dtoPayload(dto),
    metrics: dto.elapsed_ms !== undefined ? { elapsed_ms: dto.elapsed_ms } : {},
  });
  return parsed.success ? parsed.data : null;
}

export function projectionAt(
  sessionId: string,
  events: readonly ReplayEventDTO[],
  index: number,
): SessionProjection {
  if (events.length === 0 || index < 0) return initialProjection(sessionId);
  const normalized = events
    .slice(0, Math.min(index + 1, events.length))
    .map(replayDtoToEvent)
    .filter((ev): ev is NormalizedEvent => ev !== null);
  return reduceEvents(sessionId, normalized);
}

export interface ProjectionTimeline {
  readonly initial: SessionProjection;
  readonly projections: readonly SessionProjection[];
  readonly invalid_event_count: number;
}

export function buildProjectionTimeline(
  sessionId: string,
  events: readonly ReplayEventDTO[],
): ProjectionTimeline {
  let projection = initialProjection(sessionId);
  let invalid = 0;
  const projections: SessionProjection[] = [];
  for (const dto of events) {
    const normalized = replayDtoToEvent(dto);
    if (normalized === null) {
      invalid += 1;
    } else {
      projection = applyEvent(projection, normalized).projection;
    }
    projections.push(projection);
  }
  return { initial: initialProjection(sessionId), projections, invalid_event_count: invalid };
}

export function clampReplayIndex(index: number, length: number): number {
  if (length <= 0) return -1;
  return Math.min(Math.max(index, 0), length - 1);
}

export function stepReplayIndex(index: number, length: number, delta: -1 | 1): number {
  return clampReplayIndex(index + delta, length);
}

export interface ReplayTimelineWindow<T> {
  readonly start: number;
  readonly end: number;
  readonly items: readonly { readonly index: number; readonly event: T }[];
}

export function replayTimelineWindow<T>(
  events: readonly T[],
  currentIndex: number,
  windowSize = 120,
): ReplayTimelineWindow<T> {
  if (events.length === 0) return { start: 0, end: 0, items: [] };
  const size = Math.max(1, Math.min(windowSize, events.length));
  const center = clampReplayIndex(currentIndex, events.length);
  const half = Math.floor(size / 2);
  const start = Math.min(Math.max(center - half, 0), Math.max(events.length - size, 0));
  const end = Math.min(start + size, events.length);
  return {
    start,
    end,
    items: events.slice(start, end).map((event, offset) => ({ index: start + offset, event })),
  };
}
