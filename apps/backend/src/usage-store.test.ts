import { describe, expect, it, vi } from "vitest";

import type { Pool } from "pg";

import { parseUsageRange, UsageStore } from "./usage-store.js";

describe("parseUsageRange", () => {
  const now = new Date("2026-08-10T23:59:59.000Z");

  it("defaults to an inclusive 30-day UTC range", () => {
    expect(parseUsageRange(undefined, now)).toEqual({ from: "2026-07-12", to: "2026-08-10" });
  });

  it("accepts bounded day durations and explicit start dates", () => {
    expect(parseUsageRange("1d", now)).toEqual({ from: "2026-08-10", to: "2026-08-10" });
    expect(parseUsageRange("2026-08-01", now)).toEqual({
      from: "2026-08-01",
      to: "2026-08-10",
    });
  });

  it.each(["0d", "3651d", "all", "2026-02-30", "2026-08-11"])(
    "rejects invalid or unbounded value %s",
    (value) => expect(parseUsageRange(value, now)).toBeUndefined(),
  );
});

describe("UsageStore", () => {
  it("converts bigint strings and returns aggregate-only totals", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          day: "2026-08-09",
          cockpit_demo_started: "2",
          cockpit_demo_completed: "1",
          real_sessions: "4",
          protected_sessions: "3",
          approval_requests: "2",
          operator_decisions: "1",
        },
        {
          day: "2026-08-10",
          cockpit_demo_started: "0",
          cockpit_demo_completed: "0",
          real_sessions: "1",
          protected_sessions: "1",
          approval_requests: "1",
          operator_decisions: "1",
        },
      ],
    });
    const store = new UsageStore({ query } as unknown as Pool);
    const report = await store.report({ from: "2026-08-09", to: "2026-08-10" });

    expect(query).toHaveBeenCalledWith(expect.stringContaining("day::text AS day"), [
      "2026-08-09",
      "2026-08-10",
    ]);
    expect(report.totals).toEqual({
      cockpit_demo_started: 2,
      cockpit_demo_completed: 1,
      real_sessions: 5,
      protected_sessions: 4,
      approval_requests: 3,
      operator_decisions: 2,
    });
    expect(JSON.stringify(report)).not.toMatch(/session_id|event_id|command|prompt|cwd|repo/);
  });

  it("returns zero totals for an empty range", async () => {
    const store = new UsageStore({
      query: vi.fn().mockResolvedValue({ rows: [] }),
    } as unknown as Pool);
    const report = await store.report({ from: "2026-08-10", to: "2026-08-10" });
    expect(report.days).toEqual([]);
    expect(Object.values(report.totals).every((value) => value === 0)).toBe(true);
  });

  it("fails visibly if a driver returns a timezone-bearing Date instead of the SQL text cast", async () => {
    const store = new UsageStore({
      query: vi.fn().mockResolvedValue({ rows: [{ day: new Date("2026-08-06T15:00:00.000Z") }] }),
    } as unknown as Pool);
    await expect(store.report({ from: "2026-08-07", to: "2026-08-07" })).rejects.toThrow(
      "invalid UTC day",
    );
  });
});
