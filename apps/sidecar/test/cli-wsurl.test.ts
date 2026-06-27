import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_BACKEND_PORT, INGEST_WS_PATH, resolveWsUrl } from "../src/cli.js";

/**
 * resolveWsUrl の canonical ingestion path 付与の回帰固定。
 *
 * egress live bug の回帰防止: 旧 resolveWsUrl は base のみ返し `/ingest/ws` を欠いたため、
 * sidecar はルート `/` へ upgrade → backend で 404 → 未 OPEN → 0 送信だった
 * (egress-handshake の test ws は任意 path を受理し見逃した)。本テストは「実 backend が
 * WS を生やす唯一の path /ingest/ws に必ず接続する」ことを resolveWsUrl の出力で固定する。
 */
describe("resolveWsUrl — canonical /ingest/ws path", () => {
  const saved = { url: process.env.ACTRADECK_WS_URL, port: process.env.ACTRADECK_BACKEND_PORT };

  beforeEach(() => {
    delete process.env.ACTRADECK_WS_URL;
    delete process.env.ACTRADECK_BACKEND_PORT;
  });
  afterEach(() => {
    if (saved.url === undefined) delete process.env.ACTRADECK_WS_URL;
    else process.env.ACTRADECK_WS_URL = saved.url;
    if (saved.port === undefined) delete process.env.ACTRADECK_BACKEND_PORT;
    else process.env.ACTRADECK_BACKEND_PORT = saved.port;
  });

  it("default (no env) targets 127.0.0.1:DEFAULT_BACKEND_PORT/ingest/ws", () => {
    expect(resolveWsUrl()).toBe(`ws://127.0.0.1:${DEFAULT_BACKEND_PORT}${INGEST_WS_PATH}`);
  });

  it("appends /ingest/ws to a bare ACTRADECK_BACKEND_PORT-derived base", () => {
    process.env.ACTRADECK_BACKEND_PORT = "55410";
    const url = resolveWsUrl();
    expect(url).toBe("ws://127.0.0.1:55410/ingest/ws");
    expect(url.endsWith(INGEST_WS_PATH)).toBe(true);
  });

  it("appends /ingest/ws to a bare ACTRADECK_WS_URL (no path) — the live-bug case", () => {
    // 実バグ再現: ACTRADECK_WS_URL=ws://host:port (path 無し) でルートに繋いで 404 だった。
    process.env.ACTRADECK_WS_URL = "ws://127.0.0.1:55410";
    expect(resolveWsUrl()).toBe("ws://127.0.0.1:55410/ingest/ws");
  });

  it("respects an explicit full ACTRADECK_WS_URL that already includes /ingest/ws", () => {
    process.env.ACTRADECK_WS_URL = "ws://10.0.0.5:9999/ingest/ws";
    expect(resolveWsUrl()).toBe("ws://10.0.0.5:9999/ingest/ws");
  });

  it("is idempotent — never doubles the path", () => {
    process.env.ACTRADECK_WS_URL = "ws://127.0.0.1:55410/ingest/ws";
    const once = resolveWsUrl();
    process.env.ACTRADECK_WS_URL = once;
    expect(resolveWsUrl()).toBe(once);
    expect(once.match(/\/ingest\/ws/g)?.length).toBe(1);
  });

  it("respects an operator-specified custom path (does not force /ingest/ws)", () => {
    // フル URL に明示 path がある場合は operator 指定を尊重 (将来の reverse-proxy 等)。
    process.env.ACTRADECK_WS_URL = "ws://proxy.internal/actradeck/ingest-ws";
    expect(resolveWsUrl()).toBe("ws://proxy.internal/actradeck/ingest-ws");
  });
});
