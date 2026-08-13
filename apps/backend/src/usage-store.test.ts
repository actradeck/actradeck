import { describe, expect, it, vi } from "vitest";

import type { Pool } from "pg";

import { SAFETY_DEMO_SESSION_PREFIX } from "./safety-demo-script.js";
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

  it("TDA-R2-6: clamps an ancient explicit date to the same lookback floor as the duration form", () => {
    // `since=1970-01-01` が全履歴走査 (TDA-2 が除去した head-of-line block) を復活させない。
    // clamp は応答の from に echo される (silent でない)。
    const floor = parseUsageRange("3650d", now)?.from;
    expect(floor).toBeDefined();
    expect(parseUsageRange("1970-01-01", now)).toEqual({ from: floor, to: "2026-08-10" });
    // floor 以降の日付は clamp されない。
    expect(parseUsageRange("2026-08-01", now)?.from).toBe("2026-08-01");
  });
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

    // QA-3/TDA-8 (2026-08-13 監査): 分類値は SQL リテラルでなく正準 import のバインドで渡す。
    // 範囲は UTC 日境界の半開区間 [from 00:00Z, to+1day 00:00Z) — インデックス可能な生 timestamptz。
    expect(query).toHaveBeenCalledWith(expect.stringContaining("day::text AS day"), [
      "2026-08-09T00:00:00.000Z",
      "2026-08-11T00:00:00.000Z",
      `${SAFETY_DEMO_SESSION_PREFIX}%`,
      "enforcement",
      "session.ended",
      "tool.permission.requested",
      "tool.permission.resolved",
      "heartbeat",
      "operator",
    ]);
    const sql = (query.mock.calls[0] as [string, unknown[]])[0];
    // 全走査防止 (TDA-2): 両 CTE が範囲述語で bound されている。
    expect(sql).toMatch(/started_at >= \$1::timestamptz AND started_at < \$2::timestamptz/);
    expect(sql).toMatch(/timestamp >= \$1::timestamptz AND timestamp < \$2::timestamptz/);
    // 分類リテラルの直書きが無い (sentinel/prefix 契約の走査対象を作らない)。
    expect(sql).not.toMatch(/demo-safety|resolution_origin'\s*=\s*'/);
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
