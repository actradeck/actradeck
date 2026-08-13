import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  ACTRADECK_PUBLIC_TELEMETRY_ENDPOINT,
  AnonymousTelemetry,
  defaultTelemetryStatePath,
  normalizeTelemetryEndpoint,
  type TelemetryUsageSource,
} from "./telemetry.js";
import type { UsageReport, UsageRange } from "./usage-store.js";

const NOW = new Date("2026-08-11T12:00:00.000Z");

function usage(days: UsageReport["days"] = []): TelemetryUsageSource {
  return {
    report: vi.fn(async (range: UsageRange) => ({
      schema_version: 1,
      timezone: "UTC",
      semantics: "local_aggregate_not_users",
      from: range.from,
      to: range.to,
      totals: {
        cockpit_demo_started: 0,
        cockpit_demo_completed: 0,
        real_sessions: 0,
        protected_sessions: 0,
        approval_requests: 0,
        operator_decisions: 0,
      },
      days,
    })),
  };
}

async function fixture(source = usage()) {
  const directory = await mkdtemp(join(tmpdir(), "actradeck-telemetry-"));
  const statePath = join(directory, "telemetry.json");
  const fetchImpl = vi.fn(async () => new Response("{}", { status: 202 }));
  const telemetry = new AnonymousTelemetry({
    usage: source,
    statePath,
    defaultEndpoint: "https://telemetry.example.test/v1/events",
    now: () => new Date(NOW),
    fetchImpl,
  });
  return { telemetry, statePath, fetchImpl };
}

describe("anonymous telemetry", () => {
  it("is default-off and performs no network request", async () => {
    const { telemetry, fetchImpl } = await fixture();
    expect(await telemetry.status()).toMatchObject({
      mode: "off",
      offered_endpoint: "https://telemetry.example.test/v1/events",
    });
    expect(await telemetry.flush()).toEqual({ sent: false, event_count: 0, reason: "disabled" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires an explicit collector and rejects unsafe endpoints", async () => {
    expect(normalizeTelemetryEndpoint(ACTRADECK_PUBLIC_TELEMETRY_ENDPOINT)).toBe(
      ACTRADECK_PUBLIC_TELEMETRY_ENDPOINT,
    );
    expect(() => normalizeTelemetryEndpoint("http://telemetry.example.test/events")).toThrow(
      /HTTPS/,
    );
    expect(() => normalizeTelemetryEndpoint("https://user:pw@example.test/events")).toThrow();
    expect(normalizeTelemetryEndpoint("http://127.0.0.1:8789/v1/events")).toBe(
      "http://127.0.0.1:8789/v1/events",
    );
    const directory = await mkdtemp(join(tmpdir(), "actradeck-telemetry-"));
    const telemetry = new AnonymousTelemetry({
      usage: usage(),
      statePath: join(directory, "state.json"),
      now: () => new Date(NOW),
    });
    await expect(telemetry.enable()).rejects.toThrow(/collector is not configured/);
  });

  it("previews and sends only the closed daily aggregate contract", async () => {
    const source = usage([
      {
        day: "2026-08-11",
        cockpit_demo_started: 2,
        cockpit_demo_completed: 1,
        real_sessions: 4,
        protected_sessions: 3,
        approval_requests: 2,
        operator_decisions: 1,
      },
    ]);
    const { telemetry, fetchImpl, statePath } = await fixture(source);
    await telemetry.enable();
    const preview = await telemetry.preview();
    expect(preview.batch?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event_name: "install_verified", count: 1 }),
        expect.objectContaining({ event_name: "cockpit_started", count: 1 }),
        expect.objectContaining({ event_name: "governed_session_started", count: 3 }),
        expect.objectContaining({ event_name: "active_day", count: 1 }),
      ]),
    );
    expect(JSON.stringify(preview.batch)).not.toMatch(
      /command|prompt|cwd|repo|session_id|event_id|audit payload/i,
    );
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);
    await expect(telemetry.flush()).resolves.toMatchObject({ sent: true });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchImpl.mock.calls[0]?.[1].body ?? "{}") as Record<string, unknown>;
    expect(body).toEqual(preview.batch);
    expect(await readFile(statePath, "utf8")).toContain("last_success_at");
  });

  it("disable deletes the local identifier and reset-id rotates it", async () => {
    const { telemetry, statePath } = await fixture();
    const enabled = await telemetry.enable();
    const reset = await telemetry.resetId();
    expect(reset.installation_id).not.toBe(enabled.installation_id);
    await telemetry.disable();
    expect(await telemetry.status()).toMatchObject({ mode: "off" });
    expect(await readFile(statePath, "utf8")).not.toContain("installation_id");
  });

  it("derives state beside embedded data and honors an explicit path", () => {
    expect(defaultTelemetryStatePath({ ACTRADECK_PGDATA: "/data/pgdata" })).toBe(
      "/data/telemetry.json",
    );
    expect(defaultTelemetryStatePath({ ACTRADECK_TELEMETRY_STATE: "/tmp/custom.json" })).toBe(
      "/tmp/custom.json",
    );
  });
});
