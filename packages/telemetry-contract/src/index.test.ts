import { describe, expect, it } from "vitest";

import {
  TELEMETRY_EVENT_NAMES,
  TelemetryBatch,
  TelemetryInstallationId,
  isUtcDay,
  nonNegativeCount,
  parseTelemetryBatch,
  telemetryPlatform,
  utcDay,
} from "./index.js";

const valid = {
  schema_version: 1,
  installation_id: "7b0994ec-91fe-4d1f-a8bb-5a0e2bf69140",
  events: [
    {
      event_name: "first_governed_session",
      occurred_on: "2026-08-11",
      app_version: "0.7.0",
      platform: "linux",
      count: 1,
    },
  ],
};

describe("anonymous telemetry contract", () => {
  it("accepts the closed aggregate-only shape", () => {
    expect(parseTelemetryBatch(valid)).toEqual(valid);
    expect(TELEMETRY_EVENT_NAMES).toContain("active_day");
  });

  it.each(["command", "prompt", "cwd", "repo", "session_id", "event_id", "user_id"])(
    "rejects forbidden arbitrary field %s",
    (field) => {
      const event = { ...valid.events[0], [field]: "must-not-ship" };
      expect(() => TelemetryBatch.parse({ ...valid, events: [event] })).toThrow();
    },
  );

  it("rejects unknown event names, invalid days, zero counts, and extra batch fields", () => {
    expect(() =>
      TelemetryBatch.parse({
        ...valid,
        events: [{ ...valid.events[0], event_name: "raw_event" }],
      }),
    ).toThrow();
    expect(() =>
      TelemetryBatch.parse({
        ...valid,
        events: [{ ...valid.events[0], occurred_on: "2026-02-31" }],
      }),
    ).toThrow();
    expect(() =>
      TelemetryBatch.parse({ ...valid, events: [{ ...valid.events[0], count: 0 }] }),
    ).toThrow();
    expect(() => TelemetryBatch.parse({ ...valid, ip: "127.0.0.1" })).toThrow();
  });

  it("coarsens unknown operating systems", () => {
    expect(telemetryPlatform("linux")).toBe("linux");
    expect(telemetryPlatform("freebsd")).toBe("other");
  });

  it("canonical UTC-day helpers round-trip and reject calendar-invalid days (TDA-5)", () => {
    expect(utcDay(new Date("2026-08-13T23:59:59.999Z"))).toBe("2026-08-13");
    expect(utcDay(new Date("2026-08-13T00:00:00.000Z"))).toBe("2026-08-13");
    for (const valid of ["2026-08-13", "2024-02-29", "1970-01-01"]) {
      expect(isUtcDay(valid), valid).toBe(true);
    }
    for (const invalid of [
      "2026-02-30", // 実在しない日
      "2026-8-13", // ゼロ埋め無し
      "2026-08-13T00:00:00Z", // 時刻付き
      "20260813",
      42,
      null,
      undefined,
      "",
    ]) {
      expect(isUtcDay(invalid), String(invalid)).toBe(false);
    }
  });

  it("nonNegativeCount folds invalid input to zero (shared coercion)", () => {
    expect(nonNegativeCount(5)).toBe(5);
    expect(nonNegativeCount("7")).toBe(7);
    expect(nonNegativeCount(0)).toBe(0);
    for (const invalid of [-1, 1.5, "abc", NaN, Infinity, null, undefined, {}, 2 ** 60]) {
      expect(nonNegativeCount(invalid), String(invalid)).toBe(0);
    }
  });

  it("exports the installation-id schema used by both sender state and wire batch", () => {
    expect(TelemetryInstallationId.safeParse("3b241101-e2bb-4255-8caf-4136c566a962").success).toBe(
      true,
    );
    expect(TelemetryInstallationId.safeParse("hostname-laptop-01").success).toBe(false);
  });
});
