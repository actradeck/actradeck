/** Local-only, aggregate usage reporting over the usage_daily DB view. */
import type { Pool } from "pg";

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

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || utcDay(parsed) !== value || value > to) return undefined;
  return { from: value, to };
}

function count(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function dayString(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("usage_daily returned an invalid UTC day");
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

export class UsageStore {
  constructor(private readonly pool: Pool) {}

  async report(range: UsageRange): Promise<UsageReport> {
    const { rows } = await this.pool.query(
      `SELECT day::text AS day, cockpit_demo_started, cockpit_demo_completed, real_sessions,
              protected_sessions, approval_requests, operator_decisions
         FROM usage_daily
        WHERE day >= $1::date AND day <= $2::date
        ORDER BY day ASC`,
      [range.from, range.to],
    );
    const days: UsageDailyRow[] = rows.map((row: Record<string, unknown>) => ({
      day: dayString(row.day),
      cockpit_demo_started: count(row.cockpit_demo_started),
      cockpit_demo_completed: count(row.cockpit_demo_completed),
      real_sessions: count(row.real_sessions),
      protected_sessions: count(row.protected_sessions),
      approval_requests: count(row.approval_requests),
      operator_decisions: count(row.operator_decisions),
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
