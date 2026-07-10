/**
 * ADR 019f4206 A段: Codex Managed spawn の webui 契約 INV。
 *
 * INV-SPAWN-BFF-ALLOWLIST: `/realtime/daemons/:id/codex/spawn` は allow-list を通り、mutating-class (POST-only +
 *   same-origin CSRF) として isCodexSpawnPath でゲートされる。近接 path / absolute-form は通さない (anchored)。
 * INV-REALTIME-RELAY-SCOPE (webui): daemon-addressed で通るのは policy と codex/spawn のみ。**approve/interrupt の
 *   daemon 宛 path は allow-list に存在しない** (session 宛のまま)。
 * INV-SPAWN-DAEMON-PARSE: parseSpawnDaemons は spawn_capable===true の id のみ返す。toSpawnErrorKey は closed enum
 *   のみ返す (未知は generic)。
 */
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { isCodexSpawnPath } from "../src/realtime/bff.js";
import { proxyReplayHistory, shouldProxyReplayRequest } from "../src/server/replay-proxy.js";
import { parseSpawnDaemons, parseDaemons } from "../src/ui/use-daemons";
import { toSpawnErrorKey } from "../src/ui/use-codex-spawn";

import type { IncomingMessage, ServerResponse } from "node:http";

const VALID_ENV = {
  REALTIME_TOKEN: "secret-token-xyz",
  BACKEND_REALTIME_WS_URL: "ws://127.0.0.1:55410/realtime/ws",
};

const SPAWN_PATH = "/realtime/daemons/11111111-2222-3333-4444-555555555555/codex/spawn";

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

function res(): FakeResponse & ServerResponse {
  return new FakeResponse() as FakeResponse & ServerResponse;
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
function okFetch() {
  return vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
}

describe("INV-SPAWN-BFF-ALLOWLIST", () => {
  it("spawn path は allow-list を通る (近接 path / absolute-form は通さない・anchored)", () => {
    expect(shouldProxyReplayRequest(SPAWN_PATH)).toBe(true);
    expect(shouldProxyReplayRequest("http://evil.invalid" + SPAWN_PATH)).toBe(false);
    expect(shouldProxyReplayRequest("/realtime/daemons/x/codex/spawnx")).toBe(false);
    expect(shouldProxyReplayRequest("/realtime/daemons/x/codex/other")).toBe(false);
  });

  it("isCodexSpawnPath は spawn path のみ true", () => {
    expect(isCodexSpawnPath(SPAWN_PATH)).toBe(true);
    expect(isCodexSpawnPath("/realtime/daemons/x/approvals/policy/set")).toBe(false);
    expect(isCodexSpawnPath("/realtime/demo/safety")).toBe(false);
  });

  it("QA-2: $ anchor 除去で RED になる near-miss falsifier (suffix/trailing を通さない)", () => {
    // `$` を落とすと以下が誤って true になる。anchored な現行実装ではすべて false でなければならない
    // (regex を `/codex/spawn$/` → `/codex/spawn/` などへ緩めた回帰をこの assert が赤で捕捉する)。
    expect(isCodexSpawnPath("/realtime/daemons/d/codex/spawnx")).toBe(false); // 末尾追記 (segment 境界なし)。
    expect(isCodexSpawnPath("/realtime/daemons/d/codex/spawn/extra")).toBe(false); // 追加 segment。
    expect(isCodexSpawnPath("/realtime/daemons/d/codex/spawn/")).toBe(false); // trailing slash。
    expect(isCodexSpawnPath("/realtime/daemons/d/codex/spawnx/set")).toBe(false); // near-miss + 続き。
  });

  it("spawn は POST-only (GET→405)・same-origin CSRF 必須 (cross-site→403)・same-origin は転送", async () => {
    // GET は 405 (mutating path)。
    {
      const r = res();
      await proxyReplayHistory(getReq(SPAWN_PATH), r, { env: VALID_ENV, fetchImpl: okFetch() });
      expect(r.statusCode).toBe(405);
    }
    // cross-site POST は 403。
    {
      const r = res();
      await proxyReplayHistory(
        postReq(SPAWN_PATH, JSON.stringify({ prompt: "p", cwd: "/r" }), {
          "sec-fetch-site": "cross-site",
        }),
        r,
        { env: VALID_ENV, fetchImpl: okFetch() },
      );
      expect(r.statusCode).toBe(403);
    }
    // same-origin POST は転送 (200)。
    {
      const fetchImpl = okFetch();
      const r = res();
      await proxyReplayHistory(
        postReq(SPAWN_PATH, JSON.stringify({ prompt: "p", cwd: "/r" }), {
          "sec-fetch-site": "same-origin",
        }),
        r,
        { env: VALID_ENV, fetchImpl },
      );
      expect(r.statusCode).toBe(200);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });
});

describe("INV-REALTIME-RELAY-SCOPE (webui): approve/interrupt の daemon 宛 path は存在しない", () => {
  it("daemon-addressed で通るのは policy と codex/spawn のみ", () => {
    // policy と spawn は通る。
    expect(shouldProxyReplayRequest("/realtime/daemons/d/approvals/policy/set")).toBe(true);
    expect(shouldProxyReplayRequest(SPAWN_PATH)).toBe(true);
    // approve / interrupt / diff / allowlist の daemon 宛 path は allow-list を通らない (session 宛のまま)。
    expect(shouldProxyReplayRequest("/realtime/daemons/d/approvals")).toBe(false);
    expect(shouldProxyReplayRequest("/realtime/daemons/d/interrupt")).toBe(false);
    expect(shouldProxyReplayRequest("/realtime/daemons/d/diff")).toBe(false);
    expect(shouldProxyReplayRequest("/realtime/daemons/d/approvals/allowlist")).toBe(false);
  });
});

describe("INV-SPAWN-DAEMON-PARSE", () => {
  it("parseSpawnDaemons は spawn_capable===true の id のみ返す", () => {
    const raw = {
      daemons: [
        { id: "a", spawn_capable: true },
        { id: "b", spawn_capable: false },
        { id: "c" }, // spawn_capable 欠落 → 除外。
        { id: "d", spawn_capable: "true" }, // 非 boolean → 除外。
      ],
    };
    expect(parseSpawnDaemons(raw)).toEqual(["a"]);
    // parseDaemons は全 id を返す (policy 用・spawn とは別集合)。
    expect(parseDaemons(raw).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("toSpawnErrorKey は closed enum のみ返す (未知/欠落は generic)", () => {
    expect(toSpawnErrorKey({ error: "cwd_out_of_scope" })).toBe("cwd_out_of_scope");
    expect(toSpawnErrorKey({ error: "spawn_cap_reached" })).toBe("spawn_cap_reached");
    expect(toSpawnErrorKey({ error: "spawn_disabled" })).toBe("spawn_disabled");
    expect(toSpawnErrorKey({ error: "unknown code" })).toBe("generic");
    expect(toSpawnErrorKey({})).toBe("generic");
    expect(toSpawnErrorKey(null)).toBe("generic");
  });
});
