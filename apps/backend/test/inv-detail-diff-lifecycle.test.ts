/**
 * TDA-1 (段階2 full 再監査 / 裁定 019ea595 unblock): diff pending lifecycle の回帰 INV。
 *
 * 背景: SidecarRegistry の段階2 新コード (requestDiff / resolveDiff / dispose の diff pending 掃除 /
 *   no-control-channel guard) は test 0 件だった。前ラウンド live-presence で dispose 欠如を赤化
 *   テストで是正した (ADR 019ea2dc) のと同型 defect の回帰ガードが diff 経路で不在。**code は正しい**
 *   ので落ちる INV を足して真ゲート化する (inv-live-presence.test.ts と同じ FakeLink + fake timer)。
 *
 * 固定する不変条件 (falsifiable・mutation で RED):
 *  (1) timeout: 応答が来ないと diffTimeoutMs で安全側 reject ("diff request timed out")。pending は
 *      掃かれ (pendingDiffCount=0)、後続の resolveDiff は no-op (二重 reject しない)。
 *  (2) dispose: pending を抱えたまま dispose() すると "server shutting down" で reject され、
 *      全 pending が掃かれる (pendingDiffCount=0)。
 *  (3) no-control-channel: registered だが controlToken 未受領 (observe のみ = handshake 未完) の
 *      session への requestDiff は "no control channel (handshake incomplete)" で即 reject。
 *
 * DB / WS を使わず純粋に赤化可能 (registry の lifecycle ロジックを直接駆動)。
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

describe("INV-DETAIL-DIFF-LIFECYCLE (pending lifecycle, no DB/WS)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // (1) timeout: 応答なし → diffTimeoutMs で reject + pending 掃除 + 後続 resolveDiff は no-op。
  it("requestDiff が応答なしのとき diffTimeoutMs で timeout reject し、pending を掃く", async () => {
    const reg = new SidecarRegistry({ diffTimeoutMs: 50 });
    const link = new FakeLink();
    reg.add(link);
    reg.handleHello(link, { type: "hello", control_token: "ctl", session_ids: ["s1"] });

    const p = reg.requestDiff("s1");
    // 要求は出ているが応答は来ない。pending が1件。
    expect(reg.pendingDiffCount).toBe(1);
    expect(link.sent.some((m) => m.includes('"type":"diff.request"'))).toBe(true);

    // timeout を満了させる。
    await vi.advanceTimersByTimeAsync(60);
    const res = await p;
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toBe("diff request timed out");
    // pending は掃かれている (timer の reject 経路で delete)。
    expect(reg.pendingDiffCount).toBe(0);

    // 遅れて到着した応答は no-op (二重 reject / late resolve しない)。
    const req = JSON.parse(link.sent.find((m) => m.includes("diff.request"))!) as {
      request_id: string;
    };
    expect(() =>
      reg.resolveDiff({ request_id: req.request_id, body: "late", truncated: false }),
    ).not.toThrow();
    expect(reg.pendingDiffCount).toBe(0);
  });

  // 正常応答が来れば resolveDiff で解決され pending も掃かれる (timeout が誤発火しない対比)。
  it("requestDiff は diff.response 到着で解決し pending を掃く (timeout 前)", async () => {
    const reg = new SidecarRegistry({ diffTimeoutMs: 5000 });
    const link = new FakeLink();
    reg.add(link);
    reg.handleHello(link, { type: "hello", control_token: "ctl", session_ids: ["s1"] });

    const p = reg.requestDiff("s1");
    expect(reg.pendingDiffCount).toBe(1);
    const req = JSON.parse(link.sent.find((m) => m.includes("diff.request"))!) as {
      request_id: string;
    };
    reg.resolveDiff({
      request_id: req.request_id,
      body: "diff --git a/x b/x\n",
      truncated: false,
      secret_detected: false,
      redaction_count: 0,
    });
    const res = await p;
    expect(res.ok).toBe(true);
    expect(res.ok === true && res.diff.body).toBe("diff --git a/x b/x\n");
    expect(reg.pendingDiffCount).toBe(0);
  });

  // (2) dispose: pending を抱えたまま dispose → "server shutting down" reject + 全 pending 掃除。
  it("dispose() は未解決 diff pending を 'server shutting down' で reject し、全件掃く", async () => {
    const reg = new SidecarRegistry({ diffTimeoutMs: 5000 });
    const link = new FakeLink();
    reg.add(link);
    reg.handleHello(link, { type: "hello", control_token: "ctl", session_ids: ["s1", "s2"] });

    const p1 = reg.requestDiff("s1");
    const p2 = reg.requestDiff("s2");
    expect(reg.pendingDiffCount).toBe(2);

    reg.dispose();

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok).toBe(false);
    expect(r1.ok === false && r1.error).toBe("server shutting down");
    expect(r2.ok).toBe(false);
    expect(r2.ok === false && r2.error).toBe("server shutting down");
    // 全 pending が掃かれ、observability surface が 0 を返す。
    expect(reg.pendingDiffCount).toBe(0);
  });

  // (3) no-control-channel: observe のみ (handshake 未完) の session への requestDiff は即 reject。
  it("controlToken 未受領 (observe のみ) の session への requestDiff は 'no control channel' で即 reject", async () => {
    const reg = new SidecarRegistry({ diffTimeoutMs: 5000 });
    const link = new FakeLink();
    reg.add(link);
    reg.observeSession(link, "s1"); // hello 無し = controlToken 未受領。

    const res = await reg.requestDiff("s1");
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toBe("no control channel (handshake incomplete)");
    // pending は作られない (要求送信前に弾く)。
    expect(reg.pendingDiffCount).toBe(0);
    expect(link.sent.some((m) => m.includes("diff.request"))).toBe(false);
  });

  // 未登録 session も即 reject (SSRF 境界; relayApproval と同型・diff 経路でも維持)。
  it("未登録 session への requestDiff は 'session not registered' で即 reject", async () => {
    const reg = new SidecarRegistry({ diffTimeoutMs: 5000 });
    const res = await reg.requestDiff("never");
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toBe("session not registered");
    expect(reg.pendingDiffCount).toBe(0);
  });
});
