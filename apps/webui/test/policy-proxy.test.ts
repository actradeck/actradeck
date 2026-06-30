/**
 * ADR 019f0c3e Phase 2: BFF proxy の policy endpoint 配線 + method/CSRF ゲートの INV (allowlist と対称)。
 *
 * 固定する不変条件 (falsifiable):
 *  - policy get (GET) / set (POST) path が allow-list を通る。それ以外の policy 派生 path は 404。
 *  - set は POST-only (GET→405)。policy get は GET-only (POST→405)。他 read path への POST→405。
 *  - CSRF 緩和: set POST は cross-site/same-site を 403 で拒否、same-origin/none は通す。
 *  - POST は body + content-type + Authorization(server-side token) を upstream へ転送する。
 *  - token は応答にもエラーにも漏れない。
 */
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  isPolicyResolvePath,
  isPolicySetPath,
  isPolicyUnsetPath,
  normalizeReplayRequestPath,
} from "../src/realtime/bff.js";
import { proxyReplayHistory, shouldProxyReplayRequest } from "../src/server/replay-proxy.js";

import type { IncomingMessage, ServerResponse } from "node:http";

const VALID_ENV = {
  REALTIME_TOKEN: "secret-token-xyz",
  BACKEND_REALTIME_WS_URL: "ws://127.0.0.1:55410/realtime/ws",
};

const GET_PATH = "/realtime/sessions/s1/approvals/policy";
const SET_PATH = "/realtime/sessions/s1/approvals/policy/set";
const LIST_PATH = "/realtime/sessions/s1/approvals/policy/list";
const UNSET_PATH = "/realtime/sessions/s1/approvals/policy/unset";
const RESOLVE_PATH = "/realtime/sessions/s1/approvals/policy/resolve";

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
      new Response(
        JSON.stringify({ enabled: true, categories: ["recursive-rm"], env_gate_enabled: true }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  );
}

describe("Phase 2 policy bff path allow-list", () => {
  it("policy get / set path が allow-list を通る (それ以外の policy 派生 path は 404)", () => {
    expect(shouldProxyReplayRequest(GET_PATH)).toBe(true);
    expect(shouldProxyReplayRequest(SET_PATH)).toBe(true);
    // 緩めない: absolute-form や別 segment は通さない。
    expect(shouldProxyReplayRequest("http://evil.invalid" + SET_PATH)).toBe(false);
    expect(shouldProxyReplayRequest("/realtime/sessions/s1/approvals/policy/other")).toBe(false);
  });

  it("isPolicySetPath は set path のみ true", () => {
    expect(isPolicySetPath(SET_PATH)).toBe(true);
    expect(isPolicySetPath(GET_PATH)).toBe(false);
    expect(isPolicySetPath("/realtime/sessions/s1/approvals/allowlist/revoke")).toBe(false);
  });

  it("normalizeReplayRequestPath は両 path を保持する", () => {
    expect(normalizeReplayRequestPath(GET_PATH)).toBe(GET_PATH);
    expect(normalizeReplayRequestPath(SET_PATH)).toBe(SET_PATH);
  });

  // ADR 019f0eca per-repo: list (GET) / unset (POST) path も allow-list を通る。
  it("policy list / unset path が allow-list を通る (それ以外の派生 path は 404)", () => {
    expect(shouldProxyReplayRequest(LIST_PATH)).toBe(true);
    expect(shouldProxyReplayRequest(UNSET_PATH)).toBe(true);
    expect(normalizeReplayRequestPath(LIST_PATH)).toBe(LIST_PATH);
    expect(normalizeReplayRequestPath(UNSET_PATH)).toBe(UNSET_PATH);
    // 緩めない: 近接する別 segment は通さない。
    expect(shouldProxyReplayRequest("/realtime/sessions/s1/approvals/policy/listx")).toBe(false);
    expect(shouldProxyReplayRequest("/realtime/sessions/s1/approvals/policy/remove")).toBe(false);
  });

  it("isPolicyUnsetPath は unset path のみ true (set/get/list と排他)", () => {
    expect(isPolicyUnsetPath(UNSET_PATH)).toBe(true);
    expect(isPolicyUnsetPath(SET_PATH)).toBe(false);
    expect(isPolicyUnsetPath(LIST_PATH)).toBe(false);
    expect(isPolicyUnsetPath(GET_PATH)).toBe(false);
    expect(isPolicySetPath(UNSET_PATH)).toBe(false);
  });

  // ADR 019f0eca 方式B: resolve path も allow-list を通り、POST(CSRF)-only ゲートに服す。
  it("policy resolve path が allow-list を通る・isPolicyResolvePath は resolve のみ true", () => {
    expect(shouldProxyReplayRequest(RESOLVE_PATH)).toBe(true);
    expect(normalizeReplayRequestPath(RESOLVE_PATH)).toBe(RESOLVE_PATH);
    expect(isPolicyResolvePath(RESOLVE_PATH)).toBe(true);
    expect(isPolicyResolvePath(SET_PATH)).toBe(false);
    expect(isPolicyResolvePath(GET_PATH)).toBe(false);
    expect(isPolicySetPath(RESOLVE_PATH)).toBe(false);
    expect(isPolicyUnsetPath(RESOLVE_PATH)).toBe(false);
  });
});

describe("Phase 2 policy proxy method/CSRF gate", () => {
  it("GET policy を Authorization 付きで転送する (POST でない)", async () => {
    const fetchImpl = okFetch();
    const out = res();
    await proxyReplayHistory(getReq(GET_PATH), out, { env: VALID_ENV, fetchImpl });
    expect(out.statusCode).toBe(200);
    const call = fetchImpl.mock.calls[0]!;
    expect(call[0]).toBe("http://127.0.0.1:55410" + GET_PATH);
    expect(call[1].headers.authorization).toBe("Bearer secret-token-xyz");
    expect(call[1].method).toBeUndefined(); // GET は method 未指定。
  });

  it("set は POST body + content-type + Authorization を転送する", async () => {
    const fetchImpl = okFetch();
    const out = res();
    const body = JSON.stringify({ enabled: true, categories: ["recursive-rm", "disk-destroy"] });
    await proxyReplayHistory(postReq(SET_PATH, body, { "sec-fetch-site": "same-origin" }), out, {
      env: VALID_ENV,
      fetchImpl,
    });
    expect(out.statusCode).toBe(200);
    const call = fetchImpl.mock.calls[0]!;
    expect(call[0]).toBe("http://127.0.0.1:55410" + SET_PATH);
    expect(call[1].method).toBe("POST");
    expect(call[1].body).toBe(body);
    expect(call[1].headers.authorization).toBe("Bearer secret-token-xyz");
    expect(call[1].headers["content-type"]).toBe("application/json");
  });

  it("set への GET は 405 (set は POST-only)", async () => {
    const fetchImpl = okFetch();
    const out = res();
    await proxyReplayHistory(getReq(SET_PATH), out, { env: VALID_ENV, fetchImpl });
    expect(out.statusCode).toBe(405);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("policy get への POST は 405 (read path は GET-only)", async () => {
    const fetchImpl = okFetch();
    const out = res();
    await proxyReplayHistory(postReq(GET_PATH, "{}", { "sec-fetch-site": "same-origin" }), out, {
      env: VALID_ENV,
      fetchImpl,
    });
    expect(out.statusCode).toBe(405);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("CSRF: cross-site の set POST は 403 で拒否し fetch を呼ばない・token 非漏洩", async () => {
    const fetchImpl = okFetch();
    const out = res();
    await proxyReplayHistory(postReq(SET_PATH, "{}", { "sec-fetch-site": "cross-site" }), out, {
      env: VALID_ENV,
      fetchImpl,
    });
    expect(out.statusCode).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out.body).not.toContain("secret-token-xyz");
  });

  it("CSRF: same-site の set POST も 403 (同一オリジン以外は拒否)", async () => {
    const fetchImpl = okFetch();
    const out = res();
    await proxyReplayHistory(postReq(SET_PATH, "{}", { "sec-fetch-site": "same-site" }), out, {
      env: VALID_ENV,
      fetchImpl,
    });
    expect(out.statusCode).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("Sec-Fetch-Site なし (非ブラウザ) の set POST は通す (curl 等の運用経路)", async () => {
    const fetchImpl = okFetch();
    const out = res();
    await proxyReplayHistory(postReq(SET_PATH, "{}"), out, { env: VALID_ENV, fetchImpl });
    expect(out.statusCode).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  // ADR 019f0eca per-repo: unset は set と同じ mutating ゲートに服す。list は read (GET-only)。
  it("unset は POST body + content-type + Authorization を転送する", async () => {
    const fetchImpl = okFetch();
    const out = res();
    const body = JSON.stringify({ repo_scope: "bbbb0002" });
    await proxyReplayHistory(postReq(UNSET_PATH, body, { "sec-fetch-site": "same-origin" }), out, {
      env: VALID_ENV,
      fetchImpl,
    });
    expect(out.statusCode).toBe(200);
    const call = fetchImpl.mock.calls[0]!;
    expect(call[0]).toBe("http://127.0.0.1:55410" + UNSET_PATH);
    expect(call[1].method).toBe("POST");
    expect(call[1].body).toBe(body);
    expect(call[1].headers.authorization).toBe("Bearer secret-token-xyz");
  });

  it("unset への GET は 405 (unset は POST-only)", async () => {
    const fetchImpl = okFetch();
    const out = res();
    await proxyReplayHistory(getReq(UNSET_PATH), out, { env: VALID_ENV, fetchImpl });
    expect(out.statusCode).toBe(405);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("CSRF: cross-site の unset POST は 403 で拒否し fetch を呼ばない", async () => {
    const fetchImpl = okFetch();
    const out = res();
    await proxyReplayHistory(postReq(UNSET_PATH, "{}", { "sec-fetch-site": "cross-site" }), out, {
      env: VALID_ENV,
      fetchImpl,
    });
    expect(out.statusCode).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("list は GET で転送する・POST は 405 (read path は GET-only)", async () => {
    const fetchImpl = okFetch();
    const okOut = res();
    await proxyReplayHistory(getReq(LIST_PATH), okOut, { env: VALID_ENV, fetchImpl });
    expect(okOut.statusCode).toBe(200);
    expect(fetchImpl.mock.calls[0]![0]).toBe("http://127.0.0.1:55410" + LIST_PATH);

    const postFetch = okFetch();
    const badOut = res();
    await proxyReplayHistory(
      postReq(LIST_PATH, "{}", { "sec-fetch-site": "same-origin" }),
      badOut,
      {
        env: VALID_ENV,
        fetchImpl: postFetch,
      },
    );
    expect(badOut.statusCode).toBe(405);
    expect(postFetch).not.toHaveBeenCalled();
  });

  // ADR 019f0eca 方式B: resolve は POST(path in body) で転送・GET 405・cross-site 403。
  it("resolve は POST body を転送する (path は body で・query へ載せない=SEC-1)", async () => {
    const fetchImpl = okFetch();
    const out = res();
    const body = JSON.stringify({ path: "/home/me/work/sandbox" });
    await proxyReplayHistory(
      postReq(RESOLVE_PATH, body, { "sec-fetch-site": "same-origin" }),
      out,
      {
        env: VALID_ENV,
        fetchImpl,
      },
    );
    expect(out.statusCode).toBe(200);
    const call = fetchImpl.mock.calls[0]!;
    expect(call[0]).toBe("http://127.0.0.1:55410" + RESOLVE_PATH); // path は URL/query に出ない。
    expect(call[1].method).toBe("POST");
    expect(call[1].body).toBe(body);
  });

  it("resolve への GET は 405 (resolve は POST-only)", async () => {
    const fetchImpl = okFetch();
    const out = res();
    await proxyReplayHistory(getReq(RESOLVE_PATH), out, { env: VALID_ENV, fetchImpl });
    expect(out.statusCode).toBe(405);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("CSRF: cross-site の resolve POST は 403 (cross-site の任意パス探索を遮断)", async () => {
    const fetchImpl = okFetch();
    const out = res();
    await proxyReplayHistory(
      postReq(RESOLVE_PATH, JSON.stringify({ path: "/x" }), { "sec-fetch-site": "cross-site" }),
      out,
      { env: VALID_ENV, fetchImpl },
    );
    expect(out.statusCode).toBe(403);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

// ADR 019f1582: daemon-addressed policy relay path (エージェント未稼働でも設定可)。session 版と **同一の**
// allow-list + method/CSRF ゲートに服し、approve/interrupt/diff/allowlist の daemon 版は通さない
// (session-scoped 維持・INV-REALTIME-RELAY-SCOPE) ことを固定する。
const D = "d1f2a3b4-c5d6-4e8f-9a0b-1c2d3e4f5061"; // randomUUID 形の daemonId。
const DAEMONS_PATH = "/realtime/daemons";
const D_GET = `/realtime/daemons/${D}/approvals/policy`;
const D_LIST = `/realtime/daemons/${D}/approvals/policy/list`;
const D_SET = `/realtime/daemons/${D}/approvals/policy/set`;
const D_UNSET = `/realtime/daemons/${D}/approvals/policy/unset`;
const D_RESOLVE = `/realtime/daemons/${D}/approvals/policy/resolve`;

describe("ADR 019f1582 daemon-addressed policy bff path + gate", () => {
  it("daemon 一覧 + daemon policy get/list/set/unset/resolve path が allow-list を通る", () => {
    for (const p of [DAEMONS_PATH, D_GET, D_LIST, D_SET, D_UNSET, D_RESOLVE]) {
      expect(shouldProxyReplayRequest(p)).toBe(true);
      expect(normalizeReplayRequestPath(p)).toBe(p);
    }
    // 緩めない: daemon approve/interrupt/diff/allowlist は通さない (session-scoped 維持・回帰ガード)。
    expect(shouldProxyReplayRequest(`/realtime/daemons/${D}/interrupt`)).toBe(false);
    expect(shouldProxyReplayRequest(`/realtime/daemons/${D}/diff`)).toBe(false);
    expect(shouldProxyReplayRequest(`/realtime/daemons/${D}/approvals/allowlist`)).toBe(false);
    expect(shouldProxyReplayRequest(`/realtime/daemons/${D}/approvals/policy/other`)).toBe(false);
  });

  it("classifier は daemon set/unset/resolve を session 版と同じ mutating-class に分類する", () => {
    expect(isPolicySetPath(D_SET)).toBe(true);
    expect(isPolicyUnsetPath(D_UNSET)).toBe(true);
    expect(isPolicyResolvePath(D_RESOLVE)).toBe(true);
    // get/list は mutating でない (GET-only)。
    expect(isPolicySetPath(D_GET)).toBe(false);
    expect(isPolicyUnsetPath(D_LIST)).toBe(false);
    expect(isPolicyResolvePath(D_GET)).toBe(false);
  });

  it("daemon set は POST-only (GET→405) + CSRF (cross-site→403)・same-origin で転送する", async () => {
    {
      const fetchImpl = okFetch();
      const out = res();
      await proxyReplayHistory(getReq(D_SET), out, { env: VALID_ENV, fetchImpl });
      expect(out.statusCode).toBe(405); // GET → 405 (set は POST-only)。
      expect(fetchImpl).not.toHaveBeenCalled();
    }
    {
      const fetchImpl = okFetch();
      const out = res();
      await proxyReplayHistory(postReq(D_SET, "{}", { "sec-fetch-site": "cross-site" }), out, {
        env: VALID_ENV,
        fetchImpl,
      });
      expect(out.statusCode).toBe(403); // cross-site → 403。
      expect(fetchImpl).not.toHaveBeenCalled();
    }
    {
      const fetchImpl = okFetch();
      const out = res();
      const body = JSON.stringify({ enabled: true, categories: ["recursive-rm"] });
      await proxyReplayHistory(postReq(D_SET, body, { "sec-fetch-site": "same-origin" }), out, {
        env: VALID_ENV,
        fetchImpl,
      });
      expect(out.statusCode).toBe(200);
      const call = fetchImpl.mock.calls[0]!;
      expect(call[0]).toBe("http://127.0.0.1:55410" + D_SET);
      expect(call[1].method).toBe("POST");
      expect(call[1].headers.authorization).toBe("Bearer secret-token-xyz");
    }
  });

  it("daemon get / 一覧は GET で転送する (read path)", async () => {
    for (const p of [D_GET, DAEMONS_PATH]) {
      const fetchImpl = okFetch();
      const out = res();
      await proxyReplayHistory(getReq(p), out, { env: VALID_ENV, fetchImpl });
      expect(out.statusCode).toBe(200);
      expect(fetchImpl.mock.calls[0]![0]).toBe("http://127.0.0.1:55410" + p);
    }
  });

  // QA-3: daemon unset/resolve も session 版と完全対称に method/CSRF ゲートへ服する
  //   (set だけでなく全 mutating-class を固定)。
  it("daemon unset/resolve も GET→405 (mutating は POST-only)・cross-site POST→403 である", async () => {
    for (const p of [D_UNSET, D_RESOLVE]) {
      {
        const fetchImpl = okFetch();
        const out = res();
        await proxyReplayHistory(getReq(p), out, { env: VALID_ENV, fetchImpl });
        expect(out.statusCode).toBe(405); // GET → mutating path は POST-only。
        expect(fetchImpl).not.toHaveBeenCalled();
      }
      {
        const fetchImpl = okFetch();
        const out = res();
        await proxyReplayHistory(postReq(p, "{}", { "sec-fetch-site": "cross-site" }), out, {
          env: VALID_ENV,
          fetchImpl,
        });
        expect(out.statusCode).toBe(403); // cross-site POST → CSRF 拒否。
        expect(fetchImpl).not.toHaveBeenCalled();
      }
    }
  });

  // QA-3: read path (/realtime/daemons 一覧) への POST は 405 (mutating でないため POST 不可)。
  //   same-origin でも 405 = CSRF でなく method↔path 整合で弾く (mutating endpoint 最小化)。
  it("daemon 一覧 (/realtime/daemons) への POST → 405 (read path は GET-only)", async () => {
    const fetchImpl = okFetch();
    const out = res();
    await proxyReplayHistory(
      postReq(DAEMONS_PATH, "{}", { "sec-fetch-site": "same-origin" }),
      out,
      {
        env: VALID_ENV,
        fetchImpl,
      },
    );
    expect(out.statusCode).toBe(405);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
