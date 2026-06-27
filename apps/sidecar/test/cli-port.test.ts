/**
 * 3#TDA-3: backend WS port の単一出所 (ACTRADECK_BACKEND_PORT, 既定 55410)。
 *
 * 旧実装は cli.ts が `ws://127.0.0.1:8787` をハードコードし、.env.example の
 * ACTRADECK_BACKEND_PORT=55410 / ポート割当メモ 019e8e7f と不整合だった。
 * resolveWsUrl は ACTRADECK_BACKEND_PORT を参照し、ACTRADECK_WS_URL の明示指定が
 * あればそれを優先する (運用上書き)。不正な port は既定 55410 にフォールバックする。
 *
 * 「赤→緑」: 8787 ハードコード (修正前) なら既定が 55410 にならず赤。BACKEND_PORT 参照
 *           (修正後) で緑。
 *
 * egress live-bug 修正後: resolveWsUrl は canonical な ingestion path `/ingest/ws` を付与する
 * (backend は WS を /ingest/ws でしか生やさず、旧 bare URL はルートに繋いで 404 だった)。
 * 本テストは port 単一出所を検証する責務なので、期待値に INGEST_WS_PATH を含めて更新する
 * (path 契約そのものの網羅は cli-wsurl.test.ts)。実装追従でなく実 backend 契約に合わせる (T1)。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_BACKEND_PORT, INGEST_WS_PATH, resolveWsUrl } from "../src/cli.js";

const KEYS = ["ACTRADECK_WS_URL", "ACTRADECK_BACKEND_PORT"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("3#TDA-3: WS backend port single source", () => {
  it("default port is 55410 (matches .env.example), NOT the old 8787", () => {
    expect(DEFAULT_BACKEND_PORT).toBe(55410);
    expect(resolveWsUrl()).toBe(`ws://127.0.0.1:55410${INGEST_WS_PATH}`);
    expect(resolveWsUrl()).not.toContain("8787");
  });

  it("derives the URL from ACTRADECK_BACKEND_PORT", () => {
    process.env.ACTRADECK_BACKEND_PORT = "55411";
    expect(resolveWsUrl()).toBe(`ws://127.0.0.1:55411${INGEST_WS_PATH}`);
  });

  it("ACTRADECK_WS_URL explicit override wins over BACKEND_PORT", () => {
    process.env.ACTRADECK_BACKEND_PORT = "55411";
    process.env.ACTRADECK_WS_URL = "ws://backend.internal:9000";
    // 明示 base override が優先。canonical path は付与される (backend は /ingest/ws のみ)。
    expect(resolveWsUrl()).toBe(`ws://backend.internal:9000${INGEST_WS_PATH}`);
  });

  it("falls back to default 55410 on invalid/out-of-range port", () => {
    for (const bad of ["0", "-1", "70000", "abc", ""]) {
      process.env.ACTRADECK_BACKEND_PORT = bad;
      expect(resolveWsUrl(), `bad port ${JSON.stringify(bad)}`).toBe(
        `ws://127.0.0.1:55410${INGEST_WS_PATH}`,
      );
    }
  });
});
