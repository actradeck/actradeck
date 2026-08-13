/**
 * Closed, privacy-minimal wire contract for explicitly opted-in ActraDeck telemetry.
 *
 * This package intentionally has no escape hatch for arbitrary properties. Commands, prompts,
 * paths, repository labels, audit events, and product session/event identifiers cannot be
 * represented by the schema. The sender publishes absolute UTC-day counters so retries are
 * idempotent at the collector.
 */
import { z } from "zod";

export const TELEMETRY_SCHEMA_VERSION = 1 as const;
export const TELEMETRY_MAX_EVENTS_PER_BATCH = 500 as const;
export const TELEMETRY_MAX_COUNT = 1_000_000_000 as const;

export const TelemetryEventName = z.enum([
  "install_verified",
  "cockpit_started",
  "cockpit_demo_started",
  "cockpit_demo_completed",
  "first_agent_observed",
  "first_governed_session",
  "governed_session_started",
  "approval_requested",
  "approval_decided",
  "active_day",
]);
export type TelemetryEventName = z.infer<typeof TelemetryEventName>;
export const TELEMETRY_EVENT_NAMES = TelemetryEventName.options;

export const TelemetryPlatform = z.enum(["linux", "darwin", "win32", "other"]);
export type TelemetryPlatform = z.infer<typeof TelemetryPlatform>;

/**
 * Canonical UTC-day helpers. Sender (backend), collector, and any tooling must consume these
 * instead of re-deriving `toISOString().slice(...)` / day regexes locally — the day predicate is
 * part of the wire contract, and hand copies drift (audit finding TDA-5, 2026-08-13).
 */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function isUtcDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && utcDay(parsed) === value;
}

/** Coerce an untrusted value to a non-negative safe integer (invalid input folds to 0). */
export function nonNegativeCount(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

const UtcDay = z.string().refine(isUtcDay, "invalid UTC day");

const AppVersion = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  .max(64);

export const TelemetryDailyEvent = z
  .object({
    event_name: TelemetryEventName,
    occurred_on: UtcDay,
    app_version: AppVersion,
    platform: TelemetryPlatform,
    count: z.number().int().min(1).max(TELEMETRY_MAX_COUNT),
  })
  .strict();
export type TelemetryDailyEvent = z.infer<typeof TelemetryDailyEvent>;

/** Random (never machine-derived) installation identifier — the batch's only correlation key. */
export const TelemetryInstallationId = z.uuid();

export const TelemetryBatch = z
  .object({
    schema_version: z.literal(TELEMETRY_SCHEMA_VERSION),
    installation_id: TelemetryInstallationId,
    events: z.array(TelemetryDailyEvent).min(1).max(TELEMETRY_MAX_EVENTS_PER_BATCH),
  })
  .strict();
export type TelemetryBatch = z.infer<typeof TelemetryBatch>;

export function telemetryPlatform(platform: string): TelemetryPlatform {
  return platform === "linux" || platform === "darwin" || platform === "win32" ? platform : "other";
}

export function parseTelemetryBatch(value: unknown): TelemetryBatch {
  return TelemetryBatch.parse(value);
}
