/**
 * BFF custom server の upgrade ルーティング純ロジックの検証 (ADR 019e92b7).
 *
 * 契約 (T1):
 *  - `/realtime/ws` **だけ** を relay 対象に掴み、それ以外 (HMR の /_next/webpack-hmr 等) は
 *    Next へ委ねる (= false)。prefix 一致での誤捕捉をしない。
 *  - ポートは ACTRADECK_WEBUI_PORT 由来、不正値は 55400 にフォールバック。
 *  - ログ用 redaction が token/auth/secret を含む query・userinfo を伏せる (Bearer を出さない)。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_WEBUI_HOST,
  DEFAULT_WEBUI_PORT,
  REALTIME_WS_PATH,
  redactUpstreamForLog,
  resolveBindHost,
  resolveWebuiPort,
  shouldRelayUpgrade,
} from "../src/server/upgrade-routing.js";

describe("shouldRelayUpgrade: /realtime/ws のみ BFF が掴む", () => {
  it("relays exact /realtime/ws", () => {
    expect(shouldRelayUpgrade("/realtime/ws")).toBe(true);
  });

  it("relays /realtime/ws with query string (ignored)", () => {
    expect(shouldRelayUpgrade("/realtime/ws?foo=bar")).toBe(true);
  });

  it("does NOT relay Next HMR socket (delegated to Next)", () => {
    expect(shouldRelayUpgrade("/_next/webpack-hmr")).toBe(false);
  });

  it("does NOT relay prefix-like paths (/realtime/ws/extra, /realtime/wsx)", () => {
    expect(shouldRelayUpgrade("/realtime/ws/extra")).toBe(false);
    expect(shouldRelayUpgrade("/realtime/wsx")).toBe(false);
    expect(shouldRelayUpgrade("/realtime/ws-internal")).toBe(false);
  });

  it("does NOT relay unrelated paths", () => {
    expect(shouldRelayUpgrade("/")).toBe(false);
    expect(shouldRelayUpgrade("/api/anything")).toBe(false);
  });

  it("returns false for undefined / empty / unparseable url (safe: delegate to Next)", () => {
    expect(shouldRelayUpgrade(undefined)).toBe(false);
    expect(shouldRelayUpgrade("")).toBe(false);
    expect(shouldRelayUpgrade("http://[::bad")).toBe(false);
  });

  it("path constant matches publicClientConfig path", () => {
    expect(REALTIME_WS_PATH).toBe("/realtime/ws");
  });
});

describe("resolveWebuiPort: env 由来・不正値はフォールバック", () => {
  it("uses ACTRADECK_WEBUI_PORT when a valid integer", () => {
    expect(resolveWebuiPort({ ACTRADECK_WEBUI_PORT: "55401" })).toBe(55401);
  });

  it("falls back to default when unset", () => {
    expect(resolveWebuiPort({})).toBe(DEFAULT_WEBUI_PORT);
    expect(DEFAULT_WEBUI_PORT).toBe(55400);
  });

  it("falls back when empty / non-numeric / out-of-range / non-integer", () => {
    expect(resolveWebuiPort({ ACTRADECK_WEBUI_PORT: "" })).toBe(DEFAULT_WEBUI_PORT);
    expect(resolveWebuiPort({ ACTRADECK_WEBUI_PORT: "  " })).toBe(DEFAULT_WEBUI_PORT);
    expect(resolveWebuiPort({ ACTRADECK_WEBUI_PORT: "abc" })).toBe(DEFAULT_WEBUI_PORT);
    expect(resolveWebuiPort({ ACTRADECK_WEBUI_PORT: "0" })).toBe(DEFAULT_WEBUI_PORT);
    expect(resolveWebuiPort({ ACTRADECK_WEBUI_PORT: "-5" })).toBe(DEFAULT_WEBUI_PORT);
    expect(resolveWebuiPort({ ACTRADECK_WEBUI_PORT: "70000" })).toBe(DEFAULT_WEBUI_PORT);
    expect(resolveWebuiPort({ ACTRADECK_WEBUI_PORT: "3.5" })).toBe(DEFAULT_WEBUI_PORT);
  });
});

describe("resolveBindHost: SEC-A 既定 loopback・env 明示時のみ LAN bind", () => {
  it("defaults to 127.0.0.1 when ACTRADECK_WEBUI_HOST is unset (mutation: 既定を 0.0.0.0 にしたら赤)", () => {
    expect(resolveBindHost({})).toBe("127.0.0.1");
    expect(DEFAULT_WEBUI_HOST).toBe("127.0.0.1");
  });

  it("defaults to loopback for empty / whitespace-only host (safe: 誤った全 bind を防ぐ)", () => {
    expect(resolveBindHost({ ACTRADECK_WEBUI_HOST: "" })).toBe("127.0.0.1");
    expect(resolveBindHost({ ACTRADECK_WEBUI_HOST: "   " })).toBe("127.0.0.1");
  });

  it("uses the explicit host only when env provides one (LAN bind は明示判断のみ)", () => {
    expect(resolveBindHost({ ACTRADECK_WEBUI_HOST: "0.0.0.0" })).toBe("0.0.0.0");
    expect(resolveBindHost({ ACTRADECK_WEBUI_HOST: "192.168.1.10" })).toBe("192.168.1.10");
    expect(resolveBindHost({ ACTRADECK_WEBUI_HOST: " 10.0.0.5 " })).toBe("10.0.0.5");
  });
});

describe("redactUpstreamForLog: token/secret を ログへ出さない", () => {
  it("keeps a plain ws endpoint as-is (no secrets)", () => {
    expect(redactUpstreamForLog("ws://127.0.0.1:8787/realtime/ws")).toBe(
      "ws://127.0.0.1:8787/realtime/ws",
    );
  });

  it("redacts token/auth/secret/key query params if present", () => {
    const out = redactUpstreamForLog("ws://h:1/realtime/ws?token=abc&authKey=xyz&secret=s&key=k");
    expect(out).not.toContain("abc");
    expect(out).not.toContain("xyz");
    expect(out).not.toContain("=s");
    expect(out).not.toMatch(/key=k(&|$)/);
    // URL.toString() は [REDACTED] を percent-encode する (%5BREDACTED%5D)。重要なのは
    // 元値が消えていること。どちらの表現でも REDACTED マーカーが入る。
    expect(out).toMatch(/\[REDACTED\]|%5BREDACTED%5D/);
  });

  it("redacts userinfo (user:pass@host)", () => {
    const out = redactUpstreamForLog("wss://user:supersecret@host:9/realtime/ws");
    expect(out).not.toContain("supersecret");
    expect(out).toMatch(/\[REDACTED\]|%5BREDACTED%5D/);
  });

  it("returns a placeholder (never the raw value) for unparseable input", () => {
    expect(redactUpstreamForLog("::::not a url")).toBe("[unparseable-upstream-url]");
  });
});
