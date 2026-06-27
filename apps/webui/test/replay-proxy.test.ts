import { describe, expect, it, vi } from "vitest";

import { proxyReplayHistory, shouldProxyReplayRequest } from "../src/server/replay-proxy.js";

import type { IncomingMessage, ServerResponse } from "node:http";

const VALID_ENV = {
  REALTIME_TOKEN: "secret-token-xyz",
  BACKEND_REALTIME_WS_URL: "ws://127.0.0.1:55410/realtime/ws",
};

class FakeResponse {
  statusCode = 0;
  headers: Record<string, string> = {};
  body = "";

  writeHead(statusCode: number, headers: Record<string, string>): this {
    this.statusCode = statusCode;
    this.headers = headers;
    return this;
  }

  end(chunk?: string): this {
    if (chunk) this.body += chunk;
    return this;
  }
}

function req(url: string, method = "GET"): IncomingMessage {
  return { method, url } as IncomingMessage;
}

function res(): FakeResponse & ServerResponse {
  return new FakeResponse() as FakeResponse & ServerResponse;
}

describe("replay HTTP proxy", () => {
  it("matches only origin-form replay history paths", () => {
    expect(shouldProxyReplayRequest("/realtime/sessions/s1/events?limit=2")).toBe(true);
    expect(shouldProxyReplayRequest("http://attacker.invalid/realtime/sessions/s1/events")).toBe(
      false,
    );
    expect(shouldProxyReplayRequest("//attacker.invalid/realtime/sessions/s1/events")).toBe(false);
  });

  it("forwards an origin-form replay path to backend with Authorization header only", async () => {
    const calls: Array<{ url: string; headers: Readonly<Record<string, string>> }> = [];
    const fetchImpl = vi.fn(
      async (url: string, init: { headers: Readonly<Record<string, string>> }) => {
        calls.push({ url, headers: init.headers });
        return new Response(JSON.stringify({ events: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    const out = res();

    await proxyReplayHistory(req("/realtime/sessions/s1/events?limit=2"), out, {
      env: VALID_ENV,
      fetchImpl,
    });

    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:55410/realtime/sessions/s1/events?limit=2",
        headers: { authorization: "Bearer secret-token-xyz" },
      },
    ]);
    expect(out.statusCode).toBe(200);
    expect(out.body).toBe(JSON.stringify({ events: [] }));
  });

  it.each([
    "http://attacker.invalid/realtime/sessions/s1/events",
    "//attacker.invalid/realtime/sessions/s1/events",
  ])("rejects %s without calling fetch or exposing the token", async (url) => {
    const fetchImpl = vi.fn();
    const out = res();

    await proxyReplayHistory(req(url), out, {
      env: VALID_ENV,
      fetchImpl,
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out.statusCode).toBe(404);
    expect(out.body).not.toContain("secret-token-xyz");
  });
});
