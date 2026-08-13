import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTelemetryWorker, type Env } from "./index.js";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    TEST_MIGRATIONS: D1Migration[];
  }
}

const HASH_SECRET = "h".repeat(32);
const ADMIN_TOKEN = "a".repeat(32);
const UUID = "7b0994ec-91fe-4d1f-a8bb-5a0e2bf69140";
const NOW = new Date("2026-08-13T12:00:00.000Z");
const validBatch = {
  schema_version: 1,
  installation_id: UUID,
  events: [
    {
      event_name: "active_day",
      occurred_on: "2026-08-13",
      app_version: "0.7.0",
      platform: "linux",
      count: 1,
    },
  ],
};

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM telemetry_daily").run();
});

function testEnv(rateAllowed = true): Env {
  return {
    DB: env.DB,
    HASH_SECRET,
    ADMIN_TOKEN,
    RATE_LIMITER: { limit: vi.fn(async () => ({ success: rateAllowed })) },
  };
}

async function dispatch(request: Request, workerEnv: Env = testEnv()): Promise<Response> {
  const worker = createTelemetryWorker({ now: () => NOW });
  if (!worker.fetch) throw new Error("test worker has no fetch handler");
  return await worker.fetch(request, workerEnv, {} as ExecutionContext);
}

function eventRequest(body: unknown): Request {
  return new Request("https://telemetry.example/v1/events", {
    method: "POST",
    headers: { "content-type": "application/json", "CF-Connecting-IP": "192.0.2.1" },
    body: JSON.stringify(body),
  });
}

describe("Cloudflare telemetry collector", () => {
  it("accepts a strict batch and persists only an HMAC installation hash", async () => {
    const response = await dispatch(eventRequest(validBatch));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: 1 });

    const stored = await env.DB.prepare(
      "SELECT installation_hash, count FROM telemetry_daily",
    ).first<{ installation_hash: string; count: number }>();
    expect(stored?.installation_hash).toHaveLength(64);
    expect(stored?.installation_hash).not.toContain(UUID);
    expect(stored?.count).toBe(1);
  });

  it("uses absolute counters so a retry cannot lower a daily count", async () => {
    await dispatch(
      eventRequest({
        ...validBatch,
        events: [{ ...validBatch.events[0], count: 3 }],
      }),
    );
    await dispatch(
      eventRequest({
        ...validBatch,
        events: [{ ...validBatch.events[0], count: 2 }],
      }),
    );
    const stored = await env.DB.prepare(
      "SELECT count FROM telemetry_daily WHERE event_name = 'active_day'",
    ).first<{ count: number }>();
    expect(stored?.count).toBe(3);
  });

  it("rejects unknown fields and arbitrary event names", async () => {
    const response = await dispatch(
      eventRequest({
        ...validBatch,
        events: [{ ...validBatch.events[0], prompt: "do not accept", event_name: "raw_event" }],
      }),
    );
    expect(response.status).toBe(400);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM telemetry_daily").first("count"),
    ).toBe(0);
  });

  it("enforces the edge rate limiter before reading or writing a batch", async () => {
    const workerEnv = testEnv(false);
    const response = await dispatch(eventRequest(validBatch), workerEnv);
    expect(response.status).toBe(429);
    expect(workerEnv.RATE_LIMITER.limit).toHaveBeenCalledWith({ key: "192.0.2.1" });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM telemetry_daily").first("count"),
    ).toBe(0);
  });

  it("bounds streamed request bodies", async () => {
    const response = await dispatch(
      new Request("https://telemetry.example/v1/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ padding: "x".repeat(128 * 1024) }),
      }),
    );
    expect(response.status).toBe(413);
  });

  it("keeps the contract maximum batch within D1's per-invocation query limit", async () => {
    const response = await dispatch(
      eventRequest({
        ...validBatch,
        events: Array.from({ length: 500 }, (_, index) => ({
          ...validBatch.events[0],
          count: index + 1,
        })),
      }),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: 500 });
    expect(await env.DB.prepare("SELECT count FROM telemetry_daily").first<number>("count")).toBe(
      500,
    );
  });

  it("requires admin auth and returns aggregate-only PMF metrics", async () => {
    await dispatch(
      eventRequest({
        ...validBatch,
        events: [
          { ...validBatch.events[0], event_name: "install_verified", occurred_on: "2026-08-01" },
          { ...validBatch.events[0], occurred_on: "2026-08-01" },
          { ...validBatch.events[0], occurred_on: "2026-08-02" },
          { ...validBatch.events[0], occurred_on: "2026-08-08" },
          {
            ...validBatch.events[0],
            event_name: "governed_session_started",
            count: 2,
          },
          { ...validBatch.events[0], event_name: "approval_requested", count: 3 },
          { ...validBatch.events[0], event_name: "approval_decided", count: 2 },
        ],
      }),
    );

    const unauthorized = await dispatch(new Request("https://telemetry.example/v1/admin/report"));
    expect(unauthorized.status).toBe(401);

    const response = await dispatch(
      new Request("https://telemetry.example/v1/admin/report?from=2026-08-01&to=2026-08-13", {
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
    );
    expect(response.status).toBe(200);
    const report = (await response.json()) as Record<string, unknown>;
    expect(report).toMatchObject({
      from: "2026-08-01",
      to: "2026-08-13",
      funnel: { install_verified: 1 },
      retention: {
        cohort_size: 1,
        day_1: { eligible: 1, retained: 1, rate: 1 },
        day_7: { eligible: 1, retained: 1, rate: 1 },
      },
    });
    expect(JSON.stringify(report)).not.toMatch(
      /installation_hash|installation_id|prompt|command|repo/,
    );
  });

  it("returns generic service errors instead of leaking missing secrets", async () => {
    const response = await dispatch(eventRequest(validBatch), {
      ...testEnv(),
      HASH_SECRET: "",
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "service unavailable" });
  });
});
