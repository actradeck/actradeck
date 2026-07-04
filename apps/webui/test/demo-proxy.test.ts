/**
 * ADR 019f22a7 P1: BFF proxy のセーフティデモ起動 endpoint 配線 + method/CSRF ゲートの INV
 * (policy set と対称・mutating-class)。
 *
 * 固定する不変条件 (falsifiable):
 *  - `/realtime/demo/safety` path が allow-list を通る。near-miss/traversal 派生は 404。
 *  - isDemoLaunchPath は当該 path のみ true。
 *  - POST-only (GET→405)。CSRF: cross-site/same-site の POST は 403、same-origin/none は通す。
 *  - POST は body + content-type + Authorization(server-side token) を upstream へ転送する。
 *  - token は応答にもエラーにも漏れない。
 */
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  InvalidReplayRequestPathError,
  isDemoLaunchPath,
  normalizeReplayRequestPath,
} from "../src/realtime/bff.js";
import { proxyReplayHistory, shouldProxyReplayRequest } from "../src/server/replay-proxy.js";

import type { IncomingMessage, ServerResponse } from "node:http";

const VALID_ENV = {
  REALTIME_TOKEN: "secret-token-demo-xyz",
  BACKEND_REALTIME_WS_URL: "ws://127.0.0.1:55410/realtime/ws",
};

const DEMO_PATH = "/realtime/demo/safety";

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

function getReq(url: string, headers: Record<string, string> = {}): IncomingMessage {
  return { method: "GET", url, headers } as unknown as IncomingMessage;
}

function postReq(url: string, body: string, headers: Record<string, string> = {}): IncomingMessage {
  const r = Readable.from([Buffer.from(body, "utf8")]) as unknown as IncomingMessage;
  (r as { method?: string }).method = "POST";
  (r as { url?: string }).url = url;
  (r as { headers?: Record<string, string> }).headers = headers;
  return r;
}

function res(): FakeResponse & ServerResponse {
  return new FakeResponse() as FakeResponse & ServerResponse;
}

function okFetch() {
  return vi.fn(
    async (
      _url: string,
      _init: { headers: Readonly<Record<string, string>>; method?: string; body?: string },
    ) =>
      new Response(JSON.stringify({ session_id: "demo-safety-abcd1234" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
}

describe("safety demo bff path allow-list", () => {
  it("demo launch path が allow-list を通る (near-miss/traversal は 404)", () => {
    expect(shouldProxyReplayRequest(DEMO_PATH)).toBe(true);
    expect(normalizeReplayRequestPath(DEMO_PATH)).toBe(DEMO_PATH);
    expect(normalizeReplayRequestPath(`${DEMO_PATH}?x=1`)).toBe(`${DEMO_PATH}?x=1`);
    // near-miss / 余剰 segment / 別名は拒否。
    expect(() => normalizeReplayRequestPath("/realtime/demo/safetyX")).toThrow(
      InvalidReplayRequestPathError,
    );
    expect(() => normalizeReplayRequestPath("/realtime/demo/safety/secret")).toThrow(
      InvalidReplayRequestPathError,
    );
    expect(() => normalizeReplayRequestPath("/realtime/demo")).toThrow(
      InvalidReplayRequestPathError,
    );
    // absolute-form / protocol-relative は origin 上書きゆえ拒否。
    expect(() => normalizeReplayRequestPath("http://evil.invalid/realtime/demo/safety")).toThrow(
      InvalidReplayRequestPathError,
    );
    expect(() => normalizeReplayRequestPath("//evil.invalid/realtime/demo/safety")).toThrow(
      InvalidReplayRequestPathError,
    );
  });

  it("isDemoLaunchPath は当該 path のみ true", () => {
    expect(isDemoLaunchPath(DEMO_PATH)).toBe(true);
    expect(isDemoLaunchPath(`${DEMO_PATH}?x=1`)).toBe(true);
    expect(isDemoLaunchPath("/realtime/demo/safetyX")).toBe(false);
    expect(isDemoLaunchPath("/realtime/demo/safety/secret")).toBe(false);
    expect(isDemoLaunchPath("/realtime/approvals")).toBe(false);
  });
});

describe("safety demo proxy method/CSRF gate", () => {
  it("same-origin POST を body+content-type+Authorization 付きで転送する", async () => {
    const fetchImpl = okFetch();
    const out = res();
    await proxyReplayHistory(postReq(DEMO_PATH, "{}", { "sec-fetch-site": "same-origin" }), out, {
      env: VALID_ENV,
      fetchImpl,
    });
    expect(out.statusCode).toBe(200);
    const call = fetchImpl.mock.calls[0]!;
    expect(call[1].method).toBe("POST");
    expect(call[1].headers["authorization"]).toBe(`Bearer ${VALID_ENV.REALTIME_TOKEN}`);
    expect(call[1].headers["content-type"]).toBe("application/json");
    // token は応答本文に漏れない。
    expect(out.body).not.toContain(VALID_ENV.REALTIME_TOKEN);
  });

  it("GET は 405 (デモ起動は POST-only・mutating-class)", async () => {
    const fetchImpl = okFetch();
    const out = res();
    await proxyReplayHistory(getReq(DEMO_PATH), out, { env: VALID_ENV, fetchImpl });
    expect(out.statusCode).toBe(405);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("CSRF: cross-site POST は 403 で拒否し fetch を呼ばない", async () => {
    const fetchImpl = okFetch();
    const out = res();
    await proxyReplayHistory(postReq(DEMO_PATH, "{}", { "sec-fetch-site": "cross-site" }), out, {
      env: VALID_ENV,
      fetchImpl,
    });
    expect(out.statusCode).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("CSRF: same-site POST も 403 (同一オリジン以外は拒否)", async () => {
    const fetchImpl = okFetch();
    const out = res();
    await proxyReplayHistory(postReq(DEMO_PATH, "{}", { "sec-fetch-site": "same-site" }), out, {
      env: VALID_ENV,
      fetchImpl,
    });
    expect(out.statusCode).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("Sec-Fetch-Site なし (非ブラウザ) の POST は通す (curl 等の運用経路)", async () => {
    const fetchImpl = okFetch();
    const out = res();
    await proxyReplayHistory(postReq(DEMO_PATH, "{}"), out, { env: VALID_ENV, fetchImpl });
    expect(out.statusCode).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
