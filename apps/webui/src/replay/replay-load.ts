"use client";

import type { ReplayEventDTO } from "../realtime/contract";

export interface ReplayRequestGate {
  currentGeneration(): number;
  nextGeneration(): number;
  tryStart(generation: number): boolean;
  isCurrent(generation: number): boolean;
  finish(generation: number): void;
}

export function createReplayRequestGate(): ReplayRequestGate {
  let activeGeneration = 0;
  let inFlightGeneration: number | null = null;
  return {
    currentGeneration: () => activeGeneration,
    nextGeneration: () => {
      activeGeneration += 1;
      inFlightGeneration = null;
      return activeGeneration;
    },
    tryStart: (generation) => {
      if (inFlightGeneration === generation) return false;
      inFlightGeneration = generation;
      return true;
    },
    isCurrent: (generation) => activeGeneration === generation,
    finish: (generation) => {
      if (inFlightGeneration === generation) inFlightGeneration = null;
    },
  };
}

export interface ReplayMergeResult {
  readonly events: readonly ReplayEventDTO[];
  readonly appendedCount: number;
  readonly truncated: boolean;
}

export function mergeReplayEvents(
  previous: readonly ReplayEventDTO[],
  incoming: readonly ReplayEventDTO[],
  maxEvents: number,
): ReplayMergeResult {
  const seen = new Set(previous.map((ev) => ev.event_id));
  const remaining = Math.max(0, maxEvents - previous.length);
  const uniqueIncoming = incoming.filter((ev) => !seen.has(ev.event_id));
  const accepted = uniqueIncoming.slice(0, remaining);
  return {
    events: [...previous, ...accepted],
    appendedCount: accepted.length,
    truncated: accepted.length < uniqueIncoming.length,
  };
}
