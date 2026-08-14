import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  InvalidReplayRequestPathError,
  isTelemetryMutationPath,
  normalizeReplayRequestPath,
} from "../src/realtime/bff.js";
import { proxyReplayHistory, shouldProxyReplayRequest } from "../src/server/replay-proxy.js";

import type { IncomingMessage, ServerResponse } from "node:http";
import type { FetchLike } from "../src/server/replay-proxy.js";

const ENV = {
  REALTIME_TOKEN: "telemetry-bff-secret",
  BACKEND_REALTIME_WS_URL: "ws://127.0.0.1:55410/realtime/ws",
};

class FakeResponse {
  statusCode = 0;
  body = "";
  writeHead(statusCode: number): this {
    this.statusCode = statusCode;
    return this;
  }
  end(chunk?: string): this {
    this.body += chunk ?? "";
    return this;
  }
}

function request(method: "GET" | "POST", url: string, body = "{}"): IncomingMessage {
  const req = Readable.from(method === "POST" ? [Buffer.from(body)] : []) as IncomingMessage;
  Object.assign(req, {
    method,
    url,
    headers: method === "POST" ? { "sec-fetch-site": "same-origin" } : {},
  });
  return req;
}

function response(): ServerResponse & FakeResponse {
  return new FakeResponse() as ServerResponse & FakeResponse;
}

describe("telemetry BFF", () => {
  it.each([
    "/realtime/telemetry",
    "/realtime/telemetry/preview",
    "/realtime/telemetry/enable",
    "/realtime/telemetry/disable",
    "/realtime/telemetry/reset-id",
    "/realtime/telemetry/flush",
  ])("allows the exact path %s", (path) => {
    expect(shouldProxyReplayRequest(path)).toBe(true);
    expect(normalizeReplayRequestPath(path)).toBe(path);
  });

  it("rejects near misses and only classifies state-changing paths as mutations", () => {
    expect(() => normalizeReplayRequestPath("/realtime/telemetry/raw")).toThrow(
      InvalidReplayRequestPathError,
    );
    expect(() => normalizeReplayRequestPath("/realtime/telemetry/preview/x")).toThrow(
      InvalidReplayRequestPathError,
    );
    expect(isTelemetryMutationPath("/realtime/telemetry")).toBe(false);
    expect(isTelemetryMutationPath("/realtime/telemetry/preview")).toBe(false);
    expect(isTelemetryMutationPath("/realtime/telemetry/enable")).toBe(true);
    expect(isTelemetryMutationPath("/realtime/telemetry/reset-id")).toBe(true);
  });

  it("enforces GET for reads and POST + same-origin for mutations", async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => new Response("{}", { status: 200 }));
    const readPost = response();
    await proxyReplayHistory(request("POST", "/realtime/telemetry"), readPost, {
      env: ENV,
      fetchImpl,
    });
    expect(readPost.statusCode).toBe(405);

    const mutationGet = response();
    await proxyReplayHistory(request("GET", "/realtime/telemetry/disable"), mutationGet, {
      env: ENV,
      fetchImpl,
    });
    expect(mutationGet.statusCode).toBe(405);

    const mutationPost = response();
    await proxyReplayHistory(
      request("POST", "/realtime/telemetry/enable", '{"endpoint":"https://t.example/v1"}'),
      mutationPost,
      { env: ENV, fetchImpl },
    );
    expect(mutationPost.statusCode).toBe(200);
    const call = fetchImpl.mock.calls.at(-1);
    expect(call?.[1].headers.authorization).toBe(`Bearer ${ENV.REALTIME_TOKEN}`);
    expect(call?.[1].method).toBe("POST");
  });

  it("rejects a cross-site mutation", async () => {
    const req = request("POST", "/realtime/telemetry/disable");
    req.headers["sec-fetch-site"] = "cross-site";
    const fetchImpl = vi.fn(async () => new Response("{}"));
    const out = response();
    await proxyReplayHistory(req, out, { env: ENV, fetchImpl });
    expect(out.statusCode).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
