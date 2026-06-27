/**
 * PAL-v2 (ADR 019ee147): allowlist relay (requestAllowlist / resolveAllowlist) の round-trip INV。
 *
 * inv-detail-diff-lifecycle.test.ts と同型 (FakeLink + fake timer・DB/WS 非依存)。
 * 固定する不変条件 (falsifiable・mutation で RED):
 *  - INV-PAL-V2-RELAY-SCOPE: 未登録 / controlToken 未受領 (observe のみ) の session への requestAllowlist は
 *    即 reject (任意 PID/URL へ到達しない・SSRF 境界・requestDiff と同型)。
 *  - INV-PAL-V2-NO-RAW (backend 投影): resolveAllowlist は entries を allow-list フィールドのみへ畳む。
 *    敵対 sidecar が混ぜた余剰 raw フィールド (例 command) は構造的に落ちる。
 *  - timeout: 応答なしで allowlistTimeoutMs reject + pending 掃除 + 後続 resolve は no-op。
 *  - dispose: 未解決 pending を "server shutting down" で reject + 全件掃く。
 *  - list/revoke: 要求フレームに op/signature/repo_scope と controlToken が載る。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SidecarRegistry, type SidecarLink } from "../src/sidecar-registry.js";

class FakeLink implements SidecarLink {
  readonly sent: string[] = [];
  open = true;
  send(data: string): void {
    if (!this.open) throw new Error("closed");
    this.sent.push(data);
  }
}

function lastAllowlistReq(link: FakeLink): {
  request_id: string;
  op?: string;
  signature?: string;
  repo_scope?: string;
  token?: string;
} {
  const raw = link.sent.find((m) => m.includes('"type":"allowlist.request"'));
  if (raw === undefined) throw new Error("no allowlist.request sent");
  return JSON.parse(raw);
}

describe("INV-PAL-V2 allowlist relay (pending lifecycle, no DB/WS)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("requestAllowlist(list) は controlToken 付きで allowlist.request を送り、応答で解決する", async () => {
    const reg = new SidecarRegistry({ allowlistTimeoutMs: 5000 });
    const link = new FakeLink();
    reg.add(link);
    reg.handleHello(link, { type: "hello", control_token: "ctl", session_ids: ["s1"] });

    const p = reg.requestAllowlist("s1", "list");
    expect(reg.pendingAllowlistCount).toBe(1);
    const req = lastAllowlistReq(link);
    expect(req.op).toBe("list");
    expect(req.token).toBe("ctl"); // controlToken を付与 (認可境界)。

    reg.resolveAllowlist({
      request_id: req.request_id,
      enabled: true,
      entries: [
        {
          signature: "a".repeat(64),
          repo_scope: "deadbeef",
          repo_label: "myrepo",
          risk: "medium",
          created_at_ms: 1000,
          expires_at_ms: 2000,
        },
      ],
    });
    const res = await p;
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.enabled).toBe(true);
      expect(res.entries).toHaveLength(1);
      expect(res.entries[0]!.signature).toBe("a".repeat(64));
      expect(res.entries[0]!.repo_label).toBe("myrepo");
    }
    expect(reg.pendingAllowlistCount).toBe(0);
  });

  it("INV-PAL-V2-NO-RAW: resolveAllowlist は entries の余剰 raw フィールドを構造的に落とす", async () => {
    const reg = new SidecarRegistry({ allowlistTimeoutMs: 5000 });
    const link = new FakeLink();
    reg.add(link);
    reg.handleHello(link, { type: "hello", control_token: "ctl", session_ids: ["s1"] });

    const p = reg.requestAllowlist("s1", "list");
    const req = lastAllowlistReq(link);
    // 敵対 sidecar が raw command/secret を混ぜたエントリ。
    reg.resolveAllowlist({
      request_id: req.request_id,
      enabled: true,
      entries: [
        {
          signature: "b".repeat(64),
          repo_scope: "cafe",
          risk: "medium",
          created_at_ms: 1,
          expires_at_ms: 2,
          command: "rm -rf / --secret=AKIAIOSFODNN7EXAMPLE", // 余剰 raw
          extra: { nested: "leak" },
        },
      ],
    });
    const res = await p;
    expect(res.ok).toBe(true);
    if (res.ok) {
      const json = JSON.stringify(res.entries);
      // 余剰 raw は投影で落ちる (allow-list フィールドのみ)。
      expect(json).not.toContain("rm -rf");
      expect(json).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(json).not.toContain("leak");
      expect(res.entries[0]!.signature).toBe("b".repeat(64));
    }
  });

  it("revoke は op/signature/repo_scope を載せ、removed を返す", async () => {
    const reg = new SidecarRegistry({ allowlistTimeoutMs: 5000 });
    const link = new FakeLink();
    reg.add(link);
    reg.handleHello(link, { type: "hello", control_token: "ctl", session_ids: ["s1"] });

    const sig = "c".repeat(64);
    const p = reg.requestAllowlist("s1", "revoke", sig, "scope9");
    const req = lastAllowlistReq(link);
    expect(req.op).toBe("revoke");
    expect(req.signature).toBe(sig);
    expect(req.repo_scope).toBe("scope9");

    reg.resolveAllowlist({ request_id: req.request_id, enabled: false, entries: [], removed: 1 });
    const res = await p;
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.removed).toBe(1);
      expect(res.enabled).toBe(false); // dormant でも revoke は成立。
      expect(res.entries).toHaveLength(0);
    }
  });

  it("timeout: 応答なしで reject し pending を掃く・遅延応答は no-op", async () => {
    const reg = new SidecarRegistry({ allowlistTimeoutMs: 50 });
    const link = new FakeLink();
    reg.add(link);
    reg.handleHello(link, { type: "hello", control_token: "ctl", session_ids: ["s1"] });

    const p = reg.requestAllowlist("s1", "list");
    const req = lastAllowlistReq(link);
    expect(reg.pendingAllowlistCount).toBe(1);

    await vi.advanceTimersByTimeAsync(60);
    const res = await p;
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toBe("allowlist request timed out");
    expect(reg.pendingAllowlistCount).toBe(0);

    // 遅延応答は no-op (late resolve しない)。
    expect(() =>
      reg.resolveAllowlist({ request_id: req.request_id, enabled: true, entries: [] }),
    ).not.toThrow();
    expect(reg.pendingAllowlistCount).toBe(0);
  });

  it("dispose() は未解決 allowlist pending を 'server shutting down' で reject し全件掃く", async () => {
    const reg = new SidecarRegistry({ allowlistTimeoutMs: 5000 });
    const link = new FakeLink();
    reg.add(link);
    reg.handleHello(link, { type: "hello", control_token: "ctl", session_ids: ["s1", "s2"] });

    const p1 = reg.requestAllowlist("s1", "list");
    const p2 = reg.requestAllowlist("s2", "list");
    expect(reg.pendingAllowlistCount).toBe(2);

    reg.dispose();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok === false && r1.error).toBe("server shutting down");
    expect(r2.ok === false && r2.error).toBe("server shutting down");
    expect(reg.pendingAllowlistCount).toBe(0);
  });

  it("INV-PAL-V2-RELAY-SCOPE: controlToken 未受領 (observe のみ) は即 reject (要求を送らない)", async () => {
    const reg = new SidecarRegistry({ allowlistTimeoutMs: 5000 });
    const link = new FakeLink();
    reg.add(link);
    reg.observeSession(link, "s1"); // hello 無し = controlToken 未受領。

    const res = await reg.requestAllowlist("s1", "list");
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toBe("no control channel (handshake incomplete)");
    expect(reg.pendingAllowlistCount).toBe(0);
    expect(link.sent.some((m) => m.includes("allowlist.request"))).toBe(false);
  });

  it("INV-PAL-V2-RELAY-SCOPE: 未登録 session は 'session not registered' で即 reject", async () => {
    const reg = new SidecarRegistry({ allowlistTimeoutMs: 5000 });
    const res = await reg.requestAllowlist("never", "list");
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toBe("session not registered");
    expect(reg.pendingAllowlistCount).toBe(0);
  });
});
