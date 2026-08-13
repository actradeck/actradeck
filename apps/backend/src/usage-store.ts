/**
 * Local-only, aggregate usage reporting.
 *
 * The aggregation runs directly against the base tables with range-bounded predicates on the
 * indexed `sessions.started_at` / `events.timestamp` columns, so the cost is proportional to the
 * requested window — never the full append-only store (audit finding TDA-2: the earlier
 * `usage_daily` view materialized both CTEs over the entire event history on every read and
 * head-of-line blocked the single embedded-PGlite connection).
 *
 * Output stays privacy-minimal: UTC day buckets and aggregate counts only — no session/event
 * identifiers, commands, prompts, paths, repositories, or sub-day timestamps.
 *
 * Classification values (demo prefix, governance mode, event types, resolution origin) are bound
 * as SQL parameters from canonical imports — no hand-copied literals for the sentinel/prefix
 * contracts to drift against (audit finding QA-3/TDA-8).
 */
import type { Pool } from "pg";

import type { GovernanceMode, NormalizedEvent, ResolutionOrigin } from "@actradeck/event-model";
import { isUtcDay, nonNegativeCount, utcDay } from "@actradeck/telemetry-contract";

import { SAFETY_DEMO_SESSION_PREFIX } from "./safety-demo-script.js";

export interface UsageDailyRow {
  readonly day: string;
  readonly cockpit_demo_started: number;
  readonly cockpit_demo_completed: number;
  readonly real_sessions: number;
  readonly protected_sessions: number;
  readonly approval_requests: number;
  readonly operator_decisions: number;
}

export type UsageTotals = Omit<UsageDailyRow, "day">;

export interface UsageReport {
  readonly schema_version: 1;
  readonly timezone: "UTC";
  readonly semantics: "local_aggregate_not_users";
  readonly from: string;
  readonly to: string;
  readonly totals: UsageTotals;
  readonly days: readonly UsageDailyRow[];
}

export interface UsageRange {
  readonly from: string;
  readonly to: string;
}

const DAY_MS = 86_400_000;
const MAX_LOOKBACK_DAYS = 3_650;

/** `30d` or an inclusive YYYY-MM-DD start. Invalid/unbounded input is rejected. */
export function parseUsageRange(raw: string | undefined, now = new Date()): UsageRange | undefined {
  const to = utcDay(now);
  const value = raw ?? "30d";
  const duration = /^(\d+)d$/.exec(value);
  if (duration) {
    const days = Number(duration[1]);
    if (!Number.isSafeInteger(days) || days < 1 || days > MAX_LOOKBACK_DAYS) return undefined;
    return { from: utcDay(new Date(now.getTime() - (days - 1) * DAY_MS)), to };
  }
  if (!isUtcDay(value) || value > to) return undefined;
  return { from: value, to };
}

function dayString(value: unknown): string {
  if (!isUtcDay(value)) {
    throw new Error("usage aggregation returned an invalid UTC day");
  }
  return value;
}

const ZERO_TOTALS: UsageTotals = {
  cockpit_demo_started: 0,
  cockpit_demo_completed: 0,
  real_sessions: 0,
  protected_sessions: 0,
  approval_requests: 0,
  operator_decisions: 0,
};

// Classification values, compile-checked against the T1 contracts and bound as SQL parameters.
const ENFORCEMENT: GovernanceMode = "enforcement";
const SESSION_ENDED: NormalizedEvent["event_type"] = "session.ended";
const PERMISSION_REQUESTED: NormalizedEvent["event_type"] = "tool.permission.requested";
const PERMISSION_RESOLVED: NormalizedEvent["event_type"] = "tool.permission.resolved";
const HEARTBEAT: NormalizedEvent["event_type"] = "heartbeat";
/** resolution_origin value for a human decision (member of event-model RESOLUTION_ORIGINS). */
const OPERATOR_ORIGIN: ResolutionOrigin = "operator";

/** LIKE pattern for demo sessions, with LIKE metacharacters escaped defensively. */
function demoLikePattern(): string {
  return `${SAFETY_DEMO_SESSION_PREFIX.replace(/([\\%_])/g, "\\$1")}%`;
}

/** Exclusive upper bound: midnight UTC of the day after `day`. */
function nextDayUtc(day: string): string {
  return `${utcDay(new Date(new Date(`${day}T00:00:00.000Z`).getTime() + DAY_MS))}T00:00:00.000Z`;
}

export class UsageStore {
  constructor(private readonly pool: Pool) {}

  async report(range: UsageRange): Promise<UsageReport> {
    const fromTs = `${range.from}T00:00:00.000Z`;
    const toExclusiveTs = nextDayUtc(range.to);
    // real_sessions counts distinct non-demo sessions with at least one non-heartbeat event on
    // the day. Deriving it from `events` (not `sessions.started_at`) keeps sessions that were
    // discovered mid-flight (attach with no observed session.started → started_at IS NULL)
    // visible as activity (audit finding QA-4: they previously produced days with
    // approval_requests > 0 but real_sessions = 0, silently suppressing active_day/retention).
    const { rows } = await this.pool.query(
      `WITH session_daily AS (
         SELECT
           (started_at AT TIME ZONE 'UTC')::date AS day,
           count(*) FILTER (WHERE session_id LIKE $3)::bigint AS cockpit_demo_started,
           count(*) FILTER (
             WHERE session_id NOT LIKE $3 AND governance_mode = $4
           )::bigint AS protected_sessions
         FROM sessions
         WHERE started_at >= $1::timestamptz AND started_at < $2::timestamptz
         GROUP BY 1
       ),
       event_daily AS (
         SELECT
           (timestamp AT TIME ZONE 'UTC')::date AS day,
           count(DISTINCT session_id) FILTER (
             WHERE session_id NOT LIKE $3 AND event_type <> $8
           )::bigint AS real_sessions,
           count(DISTINCT session_id) FILTER (
             WHERE session_id LIKE $3 AND event_type = $5
           )::bigint AS cockpit_demo_completed,
           count(*) FILTER (
             WHERE session_id NOT LIKE $3 AND event_type = $6
           )::bigint AS approval_requests,
           count(*) FILTER (
             WHERE session_id NOT LIKE $3 AND event_type = $7
               AND payload->>'resolution_origin' = $9
           )::bigint AS operator_decisions
         FROM events
         WHERE timestamp >= $1::timestamptz AND timestamp < $2::timestamptz
         GROUP BY 1
       ),
       days AS (
         SELECT day FROM session_daily
         UNION
         SELECT day FROM event_daily
       )
       SELECT
         days.day::text AS day,
         COALESCE(session_daily.cockpit_demo_started, 0)::bigint AS cockpit_demo_started,
         COALESCE(event_daily.cockpit_demo_completed, 0)::bigint AS cockpit_demo_completed,
         COALESCE(event_daily.real_sessions, 0)::bigint AS real_sessions,
         COALESCE(session_daily.protected_sessions, 0)::bigint AS protected_sessions,
         COALESCE(event_daily.approval_requests, 0)::bigint AS approval_requests,
         COALESCE(event_daily.operator_decisions, 0)::bigint AS operator_decisions
       FROM days
       LEFT JOIN session_daily USING (day)
       LEFT JOIN event_daily USING (day)
       ORDER BY days.day ASC`,
      [
        fromTs,
        toExclusiveTs,
        demoLikePattern(),
        ENFORCEMENT,
        SESSION_ENDED,
        PERMISSION_REQUESTED,
        PERMISSION_RESOLVED,
        HEARTBEAT,
        OPERATOR_ORIGIN,
      ],
    );
    const days: UsageDailyRow[] = rows.map((row: Record<string, unknown>) => ({
      day: dayString(row.day),
      cockpit_demo_started: nonNegativeCount(row.cockpit_demo_started),
      cockpit_demo_completed: nonNegativeCount(row.cockpit_demo_completed),
      real_sessions: nonNegativeCount(row.real_sessions),
      protected_sessions: nonNegativeCount(row.protected_sessions),
      approval_requests: nonNegativeCount(row.approval_requests),
      operator_decisions: nonNegativeCount(row.operator_decisions),
    }));
    const totals = days.reduce<UsageTotals>(
      (sum, row) => ({
        cockpit_demo_started: sum.cockpit_demo_started + row.cockpit_demo_started,
        cockpit_demo_completed: sum.cockpit_demo_completed + row.cockpit_demo_completed,
        real_sessions: sum.real_sessions + row.real_sessions,
        protected_sessions: sum.protected_sessions + row.protected_sessions,
        approval_requests: sum.approval_requests + row.approval_requests,
        operator_decisions: sum.operator_decisions + row.operator_decisions,
      }),
      { ...ZERO_TOTALS },
    );
    return {
      schema_version: 1,
      timezone: "UTC",
      semantics: "local_aggregate_not_users",
      from: range.from,
      to: range.to,
      totals,
      days,
    };
  }
}
