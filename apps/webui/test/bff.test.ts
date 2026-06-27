/**
 * BFF 設定の契約テスト (SEC: token は server env から・Bearer ヘッダにのみ・query 禁止).
 * ADR 019e92b7: REALTIME_TOKEN はブラウザに渡さず BFF が server-side で付与する。
 */
import { describe, expect, it } from "vitest";

import {
  InvalidReplayRequestPathError,
  InvalidUpstreamUrlError,
  MissingRealtimeTokenError,
  normalizeReplayRequestPath,
  publicClientConfig,
  resolveReplayHttpConfig,
  resolveUpstreamConfig,
} from "../src/realtime/bff.js";

describe("BFF upstream config", () => {
  it("throws when REALTIME_TOKEN is absent (no unauthenticated upstream)", () => {
    expect(() => resolveUpstreamConfig({})).toThrow(MissingRealtimeTokenError);
    expect(() => resolveUpstreamConfig({ REALTIME_TOKEN: "" })).toThrow(MissingRealtimeTokenError);
  });

  it("puts the token in the Authorization Bearer header, never in the URL query (SEC-1)", () => {
    const cfg = resolveUpstreamConfig(
      { REALTIME_TOKEN: "secret-token-xyz" },
      "ws://127.0.0.1:8787/realtime/ws",
    );
    expect(cfg.headers["authorization"]).toBe("Bearer secret-token-xyz");
    expect(cfg.url).toBe("ws://127.0.0.1:8787/realtime/ws");
    expect(cfg.url).not.toContain("token");
    expect(cfg.url).not.toContain("secret-token-xyz");
  });

  it("falls back to BACKEND_REALTIME_WS_URL then a default", () => {
    const cfg = resolveUpstreamConfig({
      REALTIME_TOKEN: "t",
      BACKEND_REALTIME_WS_URL: "ws://backend:9000/realtime/ws",
    });
    expect(cfg.url).toBe("ws://backend:9000/realtime/ws");
    const def = resolveUpstreamConfig({ REALTIME_TOKEN: "t" });
    expect(def.url).toBe("ws://127.0.0.1:8787/realtime/ws");
  });

  it("SEC-3: rejects a non-ws upstream URL before attaching the Bearer token", () => {
    // http(s):// への誤配・平文ダウングレード・不正 URL は token を載せる前に throw。
    expect(() =>
      resolveUpstreamConfig({ REALTIME_TOKEN: "t" }, "http://backend/realtime/ws"),
    ).toThrow(InvalidUpstreamUrlError);
    expect(() => resolveUpstreamConfig({ REALTIME_TOKEN: "t" }, "https://backend/x")).toThrow(
      InvalidUpstreamUrlError,
    );
    expect(() => resolveUpstreamConfig({ REALTIME_TOKEN: "t" }, "not a url")).toThrow(
      InvalidUpstreamUrlError,
    );
    // wss:// は許可。
    const cfg = resolveUpstreamConfig({ REALTIME_TOKEN: "t" }, "wss://backend:443/realtime/ws");
    expect(cfg.url).toBe("wss://backend:443/realtime/ws");
    expect(cfg.headers["authorization"]).toBe("Bearer t");
  });

  it("public client config never contains a token (only a same-origin path)", () => {
    const pub = publicClientConfig();
    expect(pub).toEqual({ path: "/realtime/ws" });
    expect(JSON.stringify(pub)).not.toContain("token");
  });

  it("builds replay REST upstream from realtime WS env and keeps token in headers only", () => {
    const cfg = resolveReplayHttpConfig(
      {
        REALTIME_TOKEN: "secret-token-xyz",
        BACKEND_REALTIME_WS_URL: "ws://127.0.0.1:55410/realtime/ws",
      },
      "/realtime/sessions/s1/events?limit=2",
    );
    expect(cfg.url).toBe("http://127.0.0.1:55410/realtime/sessions/s1/events?limit=2");
    expect(cfg.headers.authorization).toBe("Bearer secret-token-xyz");
    expect(cfg.url).not.toContain("secret-token-xyz");
  });

  it("rejects absolute or protocol-relative replay paths so they cannot override upstream origin", () => {
    expect(() =>
      resolveReplayHttpConfig(
        {
          REALTIME_TOKEN: "secret-token-xyz",
          BACKEND_REALTIME_WS_URL: "ws://127.0.0.1:55410/realtime/ws",
        },
        "http://attacker.invalid/realtime/sessions/s1/events",
      ),
    ).toThrow(InvalidReplayRequestPathError);
    expect(() =>
      resolveReplayHttpConfig(
        {
          REALTIME_TOKEN: "secret-token-xyz",
          BACKEND_REALTIME_WS_URL: "ws://127.0.0.1:55410/realtime/ws",
        },
        "//attacker.invalid/realtime/sessions/s1/events",
      ),
    ).toThrow(InvalidReplayRequestPathError);
  });

  it("normalizes replay paths to pathname plus query only", () => {
    expect(normalizeReplayRequestPath("/realtime/sessions/s1/events?limit=2#fragment")).toBe(
      "/realtime/sessions/s1/events?limit=2",
    );
    expect(() => normalizeReplayRequestPath("/realtime/ws")).toThrow(InvalidReplayRequestPathError);
  });

  // 段階2 (ADR 019ea4ba D2/D8): diff / command output の pull path を allowlist に追加した
  //   (SEC: anchored allowlist のみ・ワイルドカード化しない)。許可 path は通り、非許可は拒否。
  it("allows stage-2 diff and command-output pull paths (anchored allowlist)", () => {
    expect(normalizeReplayRequestPath("/realtime/sessions/s1/diff")).toBe(
      "/realtime/sessions/s1/diff",
    );
    expect(normalizeReplayRequestPath("/realtime/sessions/s1/commands/e1/output?tail=4096")).toBe(
      "/realtime/sessions/s1/commands/e1/output?tail=4096",
    );
  });

  it("rejects stage-2 out-of-allowlist variants (no wildcard widening)", () => {
    // command の sub-path が output 以外は拒否 (allowlist 末尾 anchor)。
    expect(() => normalizeReplayRequestPath("/realtime/sessions/s1/commands/e1/raw")).toThrow(
      InvalidReplayRequestPathError,
    );
    // diff の後ろに余計な segment は拒否。
    expect(() => normalizeReplayRequestPath("/realtime/sessions/s1/diff/secret")).toThrow(
      InvalidReplayRequestPathError,
    );
    // 別 origin への absolute-form 上書きは拒否 (既存 SSRF ガードを新 path でも維持)。
    expect(() =>
      normalizeReplayRequestPath("http://evil.invalid/realtime/sessions/s1/diff"),
    ).toThrow(InvalidReplayRequestPathError);
  });

  it("URL 正規化で `..` を畳んだ結果が allowlist 内なら通る (traversal は許可 path へ collapse)", () => {
    // `/diff/../events` は URL 正規化で `/events` へ畳まれ、これは許可 path なので通る
    //   (`..` で allowlist 外 origin/path へ抜けられないことが要点。collapse 先が許可なら安全)。
    expect(normalizeReplayRequestPath("/realtime/sessions/s1/diff/../events")).toBe(
      "/realtime/sessions/s1/events",
    );
  });

  // 段階1 (ADR 019ead14 D1): 横断 Approval Inbox の集約 pull path。固定 path (segment/wildcard なし)。
  //   QA-1: BFF allowlist が新 path を通し、近傍 (sub-path/接尾辞/別 origin) を緩めないことを固定。
  it("allows the approval-inbox pull path and rejects near-miss variants (QA-1)", () => {
    // 固定 path は通り、query は保持される。
    expect(normalizeReplayRequestPath("/realtime/approvals")).toBe("/realtime/approvals");
    expect(normalizeReplayRequestPath("/realtime/approvals?since=1")).toBe(
      "/realtime/approvals?since=1",
    );
    // 末尾に余計な segment は拒否 (anchored allowlist・サブリソース捏造を塞ぐ)。
    expect(() => normalizeReplayRequestPath("/realtime/approvals/secret")).toThrow(
      InvalidReplayRequestPathError,
    );
    // 接尾辞でのマッチ漏れ (prefix 偽装) は拒否。
    expect(() => normalizeReplayRequestPath("/realtime/approvalsX")).toThrow(
      InvalidReplayRequestPathError,
    );
    // 別 origin への absolute-form / protocol-relative 上書きは拒否 (SSRF ガード維持)。
    expect(() => normalizeReplayRequestPath("http://evil.invalid/realtime/approvals")).toThrow(
      InvalidReplayRequestPathError,
    );
    expect(() => normalizeReplayRequestPath("//evil.invalid/realtime/approvals")).toThrow(
      InvalidReplayRequestPathError,
    );
  });

  // 段階1 (ADR 019ead7a D1): Live Wall の集約 pull path。固定 path (segment/wildcard なし)、
  //   query は per_session のみ。QA-1/SEC-2: 境界ゲートの走査範囲を approvals と対称に固定し、
  //   anchor 欠落 (`$` 削除) や sub-path 開放による path-confusion / SSRF 退行を赤線化する。
  it("allows the live-wall pull path and rejects near-miss variants (QA-1/SEC-2)", () => {
    // 固定 path は通り、許す唯一の query (per_session) は保持される。
    expect(normalizeReplayRequestPath("/realtime/wall")).toBe("/realtime/wall");
    expect(normalizeReplayRequestPath("/realtime/wall?per_session=2")).toBe(
      "/realtime/wall?per_session=2",
    );
    // 末尾に余計な segment は拒否 (anchored allowlist・サブリソース捏造を塞ぐ)。
    expect(() => normalizeReplayRequestPath("/realtime/wall/secret")).toThrow(
      InvalidReplayRequestPathError,
    );
    // 接尾辞でのマッチ漏れ (prefix 偽装・anchor `$` 欠落の退行) は拒否。
    expect(() => normalizeReplayRequestPath("/realtime/wallX")).toThrow(
      InvalidReplayRequestPathError,
    );
    // 別 origin への absolute-form / protocol-relative 上書きは拒否 (SSRF ガード維持)。
    expect(() => normalizeReplayRequestPath("http://evil.invalid/realtime/wall")).toThrow(
      InvalidReplayRequestPathError,
    );
    expect(() => normalizeReplayRequestPath("//evil.invalid/realtime/wall")).toThrow(
      InvalidReplayRequestPathError,
    );
  });

  it("allows the audit pull paths and rejects near-miss variants (強み(a) 監査ビュー)", () => {
    // 期間集計 (固定 path・query from/to/limit/format は search で保持)。
    expect(normalizeReplayRequestPath("/realtime/audit/sessions")).toBe("/realtime/audit/sessions");
    expect(
      normalizeReplayRequestPath("/realtime/audit/sessions?from=2099-01-01T00:00:00Z&format=csv"),
    ).toBe("/realtime/audit/sessions?from=2099-01-01T00:00:00Z&format=csv");
    // per-session 詳細 (session セグメントは [^/]+)。
    expect(normalizeReplayRequestPath("/realtime/audit/sessions/sess_abc?format=csv")).toBe(
      "/realtime/audit/sessions/sess_abc?format=csv",
    );
    // 末尾の余計な segment は拒否 (anchored allowlist)。
    expect(() => normalizeReplayRequestPath("/realtime/audit/sessions/s1/raw")).toThrow(
      InvalidReplayRequestPathError,
    );
    // ガバナンス証跡 drill-down (decision 019f03cc): redactions path は allow・query (kind/limit) 保持。
    expect(
      normalizeReplayRequestPath("/realtime/audit/sessions/sess_abc/redactions?kind=github-token"),
    ).toBe("/realtime/audit/sessions/sess_abc/redactions?kind=github-token");
    // near-miss は拒否 (anchored・wildcard 化しない)。
    expect(() => normalizeReplayRequestPath("/realtime/audit/sessions/s1/redactions/raw")).toThrow(
      InvalidReplayRequestPathError,
    );
    expect(() => normalizeReplayRequestPath("/realtime/audit/sessions/s1/redactionsX")).toThrow(
      InvalidReplayRequestPathError,
    );
    // prefix 偽装 (anchor 欠落の退行) は拒否。
    expect(() => normalizeReplayRequestPath("/realtime/audit/sessionsX")).toThrow(
      InvalidReplayRequestPathError,
    );
    expect(() => normalizeReplayRequestPath("/realtime/auditX/sessions")).toThrow(
      InvalidReplayRequestPathError,
    );
    // 別 origin への上書きは拒否 (SSRF ガード維持)。
    expect(() => normalizeReplayRequestPath("http://evil.invalid/realtime/audit/sessions")).toThrow(
      InvalidReplayRequestPathError,
    );
    expect(() => normalizeReplayRequestPath("//evil.invalid/realtime/audit/sessions")).toThrow(
      InvalidReplayRequestPathError,
    );
  });
});
