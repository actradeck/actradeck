import { describe, expect, it } from "vitest";

import {
  TELEMETRY_EVENT_NAMES,
  TelemetryBatch,
  parseTelemetryBatch,
  telemetryPlatform,
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
});
