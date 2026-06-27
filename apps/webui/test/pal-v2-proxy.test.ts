/**
 * PAL-v2 (ADR 019ee147): BFF proxy の allowlist endpoint 配線 + method/CSRF ゲートの INV。
 *
 * 固定する不変条件 (falsifiable):
 *  - allowlist 一覧 (GET) / 失効 (revoke POST) path が allow-list を通る。それ以外は 404。
 *  - revoke は POST-only (GET→405)。allowlist 一覧は GET-only (POST→405)。他 read path への POST→405。
 *  - CSRF 緩和: revoke POST は Sec-Fetch-Site=cross-site/same-site を 403 で拒否、same-origin/none/無しは通す。
 *  - POST は body + content-type + Authorization(server-side token) を upstream へ転送する。
 *  - token は応答にもエラーにも漏れない。
 */
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { isAllowlistRevokePath, normalizeReplayRequestPath } from "../src/realtime/bff.js";
import { proxyReplayHistory, shouldProxyReplayRequest } from "../src/server/replay-proxy.js";

import type { IncomingMessage, ServerResponse } from "node:http";

const VALID_ENV = {
  REALTIME_TOKEN: "secret-token-xyz",
  BACKEND_REALTIME_WS_URL: "ws://127.0.0.1:55410/realtime/ws",
};

const LIST_PATH = "/realtime/sessions/s1/approvals/allowlist";
const REVOKE_PATH = "/realtime/sessions/s1/approvals/allowlist/revoke";

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
      _init: {
        headers: Readonly<Record<string, string>>;
        method?: string;
        body?: string;
      },
    ) =>
      new Response(JSON.stringify({ enabled: true, entries: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
}

describe("PAL-v2 bff path allow-list", () => {
  it("allowlist 一覧 / 失効 path が allow-list を通る (それ以外の approvals path は 404)", () => {
    expect(shouldProxyReplayRequest(LIST_PATH)).toBe(true);
    expect(shouldProxyReplayRequest(REVOKE_PATH)).toBe(true);
    // 緩めない: 別 segment や absolute-form は通さない。
    expect(shouldProxyReplayRequest("http://evil.invalid" + REVOKE_PATH)).toBe(false);
    expect(shouldProxyReplayRequest("/realtime/sessions/s1/approvals/allowlist/other")).toBe(false);
  });

  it("isAllowlistRevokePath は revoke path のみ true", () => {
    expect(isAllowlistRevokePath(REVOKE_PATH)).toBe(true);
    expect(isAllowlistRevokePath(LIST_PATH)).toBe(false);
    expect(isAllowlistRevokePath("/realtime/sessions/s1/diff")).toBe(false);
  });

  it("normalizeReplayRequestPath は両 path を保持する", () => {
    expect(normalizeReplayRequestPath(LIST_PATH)).toBe(LIST_PATH);
    expect(normalizeReplayRequestPath(REVOKE_PATH)).toBe(REVOKE_PATH);
  });
});

describe("PAL-v2 proxy method/CSRF gate", () => {
  it("GET allowlist 一覧を Authorization 付きで転送する (POST でない)", async () => {
    const fetchImpl = okFetch();
    const out = res();
    await proxyReplayHistory(getReq(LIST_PATH), out, { env: VALID_ENV, fetchImpl });
    expect(out.statusCode).toBe(200);
    const call = fetchImpl.mock.calls[0]!;
    expect(call[0]).toBe("http://127.0.0.1:55410" + LIST_PATH);
    expect(call[1].headers.authorization).toBe("Bearer secret-token-xyz");
    expect(call[1].method).toBeUndefined(); // GET は method 未指定 (既定 GET)。
  });

  it("revoke は POST body + content-type + Authorization を転送する", async () => {
    const fetchImpl = okFetch();
    const out = res();
    const body = JSON.stringify({ signature: "a".repeat(64), repo_scope: "scope" });
    await proxyReplayHistory(postReq(REVOKE_PATH, body, { "sec-fetch-site": "same-origin" }), out, {
      env: VALID_ENV,
      fetchImpl,
    });
    expect(out.statusCode).toBe(200);
    const call = fetchImpl.mock.calls[0]!;
    expect(call[0]).toBe("http://127.0.0.1:55410" + REVOKE_PATH);
    expect(call[1].method).toBe("POST");
    expect(call[1].body).toBe(body);
    expect(call[1].headers.authorization).toBe("Bearer secret-token-xyz");
    expect(call[1].headers["content-type"]).toBe("application/json");
  });

  it("revoke への GET は 405 (revoke は POST-only)", async () => {
    const fetchImpl = okFetch();
    const out = res();
    await proxyReplayHistory(getReq(REVOKE_PATH), out, { env: VALID_ENV, fetchImpl });
    expect(out.statusCode).toBe(405);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("allowlist 一覧への POST は 405 (read path は GET-only)", async () => {
    const fetchImpl = okFetch();
    const out = res();
    await proxyReplayHistory(postReq(LIST_PATH, "{}", { "sec-fetch-site": "same-origin" }), out, {
      env: VALID_ENV,
      fetchImpl,
    });
    expect(out.statusCode).toBe(405);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("既存 read path (events) への POST も 405 (mutating は revoke のみ)", async () => {
    const fetchImpl = okFetch();
    const out = res();
    await proxyReplayHistory(
      postReq("/realtime/sessions/s1/events", "{}", { "sec-fetch-site": "same-origin" }),
      out,
      { env: VALID_ENV, fetchImpl },
    );
    expect(out.statusCode).toBe(405);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("CSRF: cross-site の revoke POST は 403 で拒否し fetch を呼ばない", async () => {
    const fetchImpl = okFetch();
    const out = res();
    await proxyReplayHistory(postReq(REVOKE_PATH, "{}", { "sec-fetch-site": "cross-site" }), out, {
      env: VALID_ENV,
      fetchImpl,
    });
    expect(out.statusCode).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out.body).not.toContain("secret-token-xyz");
  });

  it("CSRF: same-site の revoke POST も 403 (同一オリジン以外は拒否)", async () => {
    const fetchImpl = okFetch();
    const out = res();
    await proxyReplayHistory(postReq(REVOKE_PATH, "{}", { "sec-fetch-site": "same-site" }), out, {
      env: VALID_ENV,
      fetchImpl,
    });
    expect(out.statusCode).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("Sec-Fetch-Site なし (非ブラウザ) の revoke POST は通す (curl 等の運用経路)", async () => {
    const fetchImpl = okFetch();
    const out = res();
    await proxyReplayHistory(postReq(REVOKE_PATH, "{}"), out, { env: VALID_ENV, fetchImpl });
    expect(out.statusCode).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("CSRF 二段目: Origin が Host と不一致の revoke POST は 403 (Sec-Fetch-Site 非対応ブラウザ対策)", async () => {
    const fetchImpl = okFetch();
    const out = res();
    await proxyReplayHistory(
      postReq(REVOKE_PATH, "{}", { origin: "http://evil.invalid", host: "127.0.0.1:55400" }),
      out,
      { env: VALID_ENV, fetchImpl },
    );
    expect(out.statusCode).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("CSRF 二段目: Origin が Host と一致する same-origin revoke POST は通す", async () => {
    const fetchImpl = okFetch();
    const out = res();
    await proxyReplayHistory(
      postReq(REVOKE_PATH, "{}", {
        origin: "http://127.0.0.1:55400",
        host: "127.0.0.1:55400",
        "sec-fetch-site": "same-origin",
      }),
      out,
      { env: VALID_ENV, fetchImpl },
    );
    expect(out.statusCode).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("CSRF 二段目: 壊れた Origin ヘッダの revoke POST は 403", async () => {
    const fetchImpl = okFetch();
    const out = res();
    await proxyReplayHistory(
      postReq(REVOKE_PATH, "{}", { origin: "://broken", host: "127.0.0.1:55400" }),
      out,
      { env: VALID_ENV, fetchImpl },
    );
    expect(out.statusCode).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
