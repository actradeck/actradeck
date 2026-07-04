import { Readable } from "node:stream";
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

  it("audit/verify: 512KiB 超の大型 body を backend へ転送する (AUDIT-VERIFY-SIZE)", async () => {
    // report route は最大 ~5MB manifest を出す。旧 verify body 上限(512KiB)はそれを弾き、多忙/長時間
    // セッションの report が再検証不能だった。1MiB 超の body が forward される(readBody で弾かれない)ことを
    // 固定する。上限を 512KiB へ戻すと readBody が "body too large" で reject→fetch 未呼出になり赤化。
    let forwardedLen = -1;
    const fetchImpl = vi.fn(async (_url: string, init: { body?: string }) => {
      forwardedLen = init.body ? Buffer.byteLength(init.body) : 0;
      return new Response(JSON.stringify({ ok: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    // 1 MiB の body (旧 512KiB 上限超・新 16MiB 上限内)。BFF は本文を parse せず verbatim 転送する。
    const payload = `{"manifest":{"pad":"${"x".repeat(1024 * 1024)}"}}`;
    const bodyReq = Readable.from([Buffer.from(payload)]) as unknown as IncomingMessage;
    bodyReq.method = "POST";
    bodyReq.url = "/realtime/audit/verify";
    bodyReq.headers = {}; // 非ブラウザ (sec-fetch-site/origin なし) → same-origin gate 通過。
    const out = res();

    await proxyReplayHistory(bodyReq, out, { env: VALID_ENV, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(forwardedLen).toBeGreaterThan(512 * 1024); // 旧上限を超える body が forward された
    expect(out.statusCode).toBe(200);
  });

  it("audit/verify: 16MiB 超の body は reject し backend へ転送しない (AUDIT-VERIFY-SIZE 上限側・QA-L1)", async () => {
    // 有界性の下限テスト: verify path でも body 上限は有界でなければならない。上限を撤去/Infinity 化する
    // mutation を捕捉する。MAX_VERIFY_BODY_BYTES(16MiB)超の body は readBody が "body too large" で reject
    // → catch → 502、fetch は呼ばれない。上限を撤去すると forward され fetch 呼出で赤化 (falsifiable)。
    const fetchImpl = vi.fn();
    // 16MiB + 1 の body (新上限超)。単一チャンクで total>max を即検出し reject させる。
    const oversize = Buffer.alloc(16 * 1024 * 1024 + 1, 0x78); // 'x'
    const bodyReq = Readable.from([oversize]) as unknown as IncomingMessage;
    bodyReq.method = "POST";
    bodyReq.url = "/realtime/audit/verify";
    bodyReq.headers = {};
    const out = res();

    await proxyReplayHistory(bodyReq, out, { env: VALID_ENV, fetchImpl });

    expect(fetchImpl).not.toHaveBeenCalled(); // 上限超は backend へ転送しない (有界)
    expect(out.statusCode).toBe(502); // readBody reject → catch → 502
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
