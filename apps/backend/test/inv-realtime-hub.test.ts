/**
 * INV-REALTIME (純ロジック): RealtimeHub の購読/順序/配信絞り込み と
 * SidecarRegistry の UI→Sidecar 中継認可。DB / WS を使わず偽 sink で検証する。
 *
 * 縛る不変条件:
 *  - INV-REALTIME-ORDER: 1 接続への push は呼び出し順を保つ (逐次 send)。
 *  - INV-REALTIME-SUBSCRIBE: detail delta は購読者のみへ届く (非購読者へ漏れない)。
 *  - INV-REALTIME-RELAY-AUTH: 未登録/切断中/controlToken 未受領の session へ relay しない。
 *  - INV-APPROVAL: 承認中継は controlToken を付与した時のみ成立 (承認なし自動実行を作らない)。
 *  - INV-REALTIME-RELAY-IDEMPOTENT: 二重承認は両方 sidecar へ届くが request_id を保つ
 *    (冪等の責務は sidecar 側 ApprovalBridge。backend は request_id を改変しない)。
 */
import { describe, expect, it } from "vitest";

import { RealtimeHub, type SessionDetail, type SessionListItem } from "../src/realtime-hub.js";
import { SidecarRegistry, type SidecarLink } from "../src/sidecar-registry.js";

/** 送信を記録する偽 UI sink。 */
class FakeSink {
  readonly sent: string[] = [];
  open = true;
  send(data: string): void {
    if (!this.open) throw new Error("closed");
    this.sent.push(data);
  }
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

/** 送信を記録する偽 sidecar link。 */
class FakeLink implements SidecarLink {
  readonly sent: string[] = [];
  open = true;
  send(data: string): void {
    if (!this.open) throw new Error("closed");
    this.sent.push(data);
  }
  msgs(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

function listItem(o: Partial<SessionListItem> & { session_id: string }): SessionListItem {
  return {
    provider: "claude_code",
    source: "hooks",
    agent_id: undefined,
    repo: undefined,
    branch: undefined,
    cwd: undefined,
    state: "running.model_wait",
    current_action: undefined,
    last_event_at: undefined,
    needs_attention: false,
    liveness_state: "live",
    stalled_suspected: false,
    ...o,
  };
}

function detail(o: Partial<SessionDetail> & { session_id: string }): SessionDetail {
  return {
    ...listItem(o),
    last_event_id: undefined,
    liveness_evidence: {},
    liveness_reason: "",
    liveness_evaluated_at_ms: 0,
    invalid_transition_count: 0,
    ...o,
  };
}

describe("INV-REALTIME-ORDER: per-connection push order is preserved", () => {
  it("delivers list deltas in the order they were pushed", () => {
    const hub = new RealtimeHub();
    const sink = new FakeSink();
    hub.register(sink);
    for (let i = 0; i < 50; i++) {
      hub.broadcastListDelta(listItem({ session_id: `s${i}`, current_action: `a${i}` }));
    }
    const frames = sink.frames();
    expect(frames).toHaveLength(50);
    frames.forEach((f, i) => {
      expect(f.type).toBe("delta.list");
      expect((f.session as Record<string, unknown>).session_id).toBe(`s${i}`);
    });
  });

  it("delivers detail deltas to a subscriber in push order", () => {
    const hub = new RealtimeHub();
    const sink = new FakeSink();
    const h = hub.register(sink);
    h.subscribe("sx");
    for (let i = 0; i < 30; i++) {
      hub.pushDetailDelta("sx", detail({ session_id: "sx", current_action: `step${i}` }));
    }
    const detailFrames = sink.frames().filter((f) => f.type === "delta.detail");
    expect(detailFrames).toHaveLength(30);
    detailFrames.forEach((f, i) => {
      expect((f.detail as Record<string, unknown>).current_action).toBe(`step${i}`);
    });
  });
});

describe("INV-REALTIME-SUBSCRIBE: detail deltas reach only subscribers", () => {
  it("does not leak detail to non-subscribers", () => {
    const hub = new RealtimeHub();
    const subscriber = new FakeSink();
    const bystander = new FakeSink();
    const hsub = hub.register(subscriber);
    hub.register(bystander); // 購読しない
    hsub.subscribe("s1");

    hub.pushDetailDelta("s1", detail({ session_id: "s1" }));

    expect(subscriber.frames().some((f) => f.type === "delta.detail")).toBe(true);
    expect(bystander.frames().some((f) => f.type === "delta.detail")).toBe(false);
  });

  it("list deltas broadcast to all connections regardless of subscription", () => {
    const hub = new RealtimeHub();
    const a = new FakeSink();
    const b = new FakeSink();
    hub.register(a);
    hub.register(b);
    hub.broadcastListDelta(listItem({ session_id: "s1" }));
    expect(a.frames().some((f) => f.type === "delta.list")).toBe(true);
    expect(b.frames().some((f) => f.type === "delta.list")).toBe(true);
  });

  it("stops delivering after unsubscribe and after remove", () => {
    const hub = new RealtimeHub();
    const sink = new FakeSink();
    const h = hub.register(sink);
    h.subscribe("s1");
    hub.pushDetailDelta("s1", detail({ session_id: "s1" }));
    h.unsubscribe("s1");
    hub.pushDetailDelta("s1", detail({ session_id: "s1", current_action: "after" }));
    expect(hub.subscriberCount("s1")).toBe(0);
    const detailCount = sink.frames().filter((f) => f.type === "delta.detail").length;
    expect(detailCount).toBe(1); // unsubscribe 後の push は届かない

    h.remove();
    expect(hub.connectionCount).toBe(0);
  });

  it("does not push to a closed sink", () => {
    const hub = new RealtimeHub();
    const sink = new FakeSink();
    hub.register(sink);
    sink.open = false;
    hub.broadcastListDelta(listItem({ session_id: "s1" }));
    expect(sink.sent).toHaveLength(0);
  });

  it("keeps other subscribers when one of many unsubscribes / is removed (QA-3 branch)", () => {
    const hub = new RealtimeHub();
    const a = new FakeSink();
    const b = new FakeSink();
    const ha = hub.register(a);
    const hb = hub.register(b);
    ha.subscribe("s1");
    hb.subscribe("s1");
    expect(hub.subscriberCount("s1")).toBe(2);

    // a が抜けても set は残る (set.size>0 の分岐: 削除しない)。
    ha.unsubscribe("s1");
    expect(hub.subscriberCount("s1")).toBe(1);
    hub.pushDetailDelta("s1", detail({ session_id: "s1", current_action: "still-b" }));
    expect(a.frames().some((f) => f.type === "delta.detail")).toBe(false);
    expect(b.frames().some((f) => f.type === "delta.detail")).toBe(true);

    // b を close 除去すると最後の購読者が消え set ごと解放 (set.size===0 の分岐)。
    hb.remove();
    expect(hub.subscriberCount("s1")).toBe(0);
    expect(hub.connectionCount).toBe(1); // a はまだ接続中 (購読のみ解除済み)
  });

  it("isSubscribed reflects subscribe/unsubscribe state (QA-3)", () => {
    const hub = new RealtimeHub();
    const h = hub.register(new FakeSink());
    expect(h.isSubscribed("s1")).toBe(false);
    h.subscribe("s1");
    expect(h.isSubscribed("s1")).toBe(true);
    expect(h.isSubscribed("s2")).toBe(false);
    h.unsubscribe("s1");
    expect(h.isSubscribed("s1")).toBe(false);
  });
});

describe("INV-REALTIME-RELAY-AUTH / INV-APPROVAL: UI→Sidecar relay authorization", () => {
  it("refuses relay for an unregistered session (SSRF/registration limit)", () => {
    const reg = new SidecarRegistry();
    const res = reg.relayApproval({ session_id: "ghost", request_id: "r1", decision: "allow" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not registered/i);
    expect(reg.canRelay("ghost")).toBe(false);
  });

  it("refuses relay before handshake (no controlToken) even if session is observed", () => {
    const reg = new SidecarRegistry();
    const link = new FakeLink();
    reg.add(link);
    reg.observeSession(link, "s1"); // ingest で所有は学習したが hello 未到達
    expect(reg.canRelay("s1")).toBe(false);
    const res = reg.relayApproval({ session_id: "s1", request_id: "r1", decision: "allow" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/control channel|handshake/i);
    expect(link.sent).toHaveLength(0); // 何も sidecar へ送られない
  });

  it("relays only after hello provides a controlToken; token is attached", () => {
    const reg = new SidecarRegistry();
    const link = new FakeLink();
    reg.add(link);
    reg.handleHello(link, {
      type: "hello",
      control_token: "ctl-secret-123",
      session_ids: ["s1"],
    });
    expect(reg.canRelay("s1")).toBe(true);

    const res = reg.relayApproval({
      session_id: "s1",
      request_id: "r1",
      decision: "allow_for_session",
      reason: "user approved",
    });
    expect(res.ok).toBe(true);
    const msg = link.msgs()[0];
    expect(msg.type).toBe("approval");
    expect(msg.request_id).toBe("r1");
    expect(msg.decision).toBe("allow_for_session");
    expect(msg.token).toBe("ctl-secret-123"); // controlToken を付与 (sidecar の fail-safe を通す)
    expect(msg.reason).toBe("user approved");
  });

  it("refuses relay when the sidecar link has closed", () => {
    const reg = new SidecarRegistry();
    const link = new FakeLink();
    reg.add(link);
    reg.handleHello(link, { type: "hello", control_token: "ctl", session_ids: ["s1"] });
    link.open = false;
    expect(reg.canRelay("s1")).toBe(false);
    const res = reg.relayApproval({ session_id: "s1", request_id: "r1", decision: "deny" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/disconnected/i);
  });

  it("releases session ownership on remove (no relay to a removed sidecar)", () => {
    const reg = new SidecarRegistry();
    const link = new FakeLink();
    reg.add(link);
    reg.handleHello(link, { type: "hello", control_token: "ctl", session_ids: ["s1"] });
    reg.remove(link);
    expect(reg.canRelay("s1")).toBe(false);
    expect(reg.connectionCount).toBe(0);
    const res = reg.relayInterrupt("s1");
    expect(res.ok).toBe(false);
  });

  it("INV-REALTIME-RELAY-IDEMPOTENT: double approval keeps the same request_id (dedup is sidecar's job)", () => {
    const reg = new SidecarRegistry();
    const link = new FakeLink();
    reg.add(link);
    reg.handleHello(link, { type: "hello", control_token: "ctl", session_ids: ["s1"] });

    reg.relayApproval({ session_id: "s1", request_id: "dup-req", decision: "allow" });
    reg.relayApproval({ session_id: "s1", request_id: "dup-req", decision: "allow" });
    const msgs = link.msgs();
    expect(msgs).toHaveLength(2);
    // backend は request_id を改変せず両方同一で中継する。冪等な二重承認防止は
    // sidecar の ApprovalBridge (request_id で 1 回だけ resolve) が担保する契約。
    expect(msgs.every((m) => m.request_id === "dup-req")).toBe(true);
  });

  it("relays interrupt with controlToken and session_id", () => {
    const reg = new SidecarRegistry();
    const link = new FakeLink();
    reg.add(link);
    reg.handleHello(link, { type: "hello", control_token: "ctl-xyz", session_ids: ["s1"] });
    const res = reg.relayInterrupt("s1");
    expect(res.ok).toBe(true);
    const msg = link.msgs()[0];
    expect(msg.type).toBe("interrupt");
    expect(msg.session_id).toBe("s1");
    expect(msg.token).toBe("ctl-xyz");
  });

  it("last reconnect wins session ownership", () => {
    const reg = new SidecarRegistry();
    const link1 = new FakeLink();
    const link2 = new FakeLink();
    reg.add(link1);
    reg.handleHello(link1, { type: "hello", control_token: "ctl1", session_ids: ["s1"] });
    reg.add(link2);
    reg.handleHello(link2, { type: "hello", control_token: "ctl2", session_ids: ["s1"] });

    reg.relayApproval({ session_id: "s1", request_id: "r", decision: "allow" });
    expect(link1.sent).toHaveLength(0); // 旧接続には来ない
    expect(link2.msgs()[0]?.token).toBe("ctl2"); // 最新接続が所有
  });
});

describe("INV-REALTIME-RELAY-SCOPE: relay reaches ONLY the requested session's sidecar", () => {
  /**
   * decision 019e929a の load-bearing 不変条件: 承認/interrupt は **要求 session を所有する
   * sidecar にのみ** 中継され、別 session の sidecar へは漏れない (cross-session 誤中継 = SSRF/
   * INV-APPROVAL 侵害)。`sessionOwner.get(session_id)` の宛先弁別を固定する。
   *
   * 退行検出: 宛先解決を `[...this.sessionOwner.values()][0]` 等の「登録先頭へ送る」実装に
   * すり替えると本テストが赤くなる (s2 を先に登録し values()[0]=link2 になるよう構成)。
   */
  function twoSidecars() {
    const reg = new SidecarRegistry();
    const link1 = new FakeLink();
    const link2 = new FakeLink();
    // link2(s2) を **先に** 登録 → sessionOwner の反復先頭は s2(link2)。
    reg.add(link2);
    reg.handleHello(link2, { type: "hello", control_token: "ctl2", session_ids: ["s2"] });
    reg.add(link1);
    reg.handleHello(link1, { type: "hello", control_token: "ctl1", session_ids: ["s1"] });
    return { reg, link1, link2 };
  }

  it("relays approval to s1's sidecar only, never to s2's sidecar", () => {
    const { reg, link1, link2 } = twoSidecars();
    const res = reg.relayApproval({ session_id: "s1", request_id: "r1", decision: "allow" });
    expect(res.ok).toBe(true);
    // link1 のみが受信し、controlToken は s1 所有接続のもの。
    expect(link1.msgs()).toHaveLength(1);
    expect(link1.msgs()[0]?.request_id).toBe("r1");
    expect(link1.msgs()[0]?.token).toBe("ctl1");
    // s2 の sidecar には一切漏れない (cross-session 誤中継の不在)。
    expect(link2.sent).toHaveLength(0);
  });

  it("relays approval to s2's sidecar only (symmetric: 宛先で弁別している)", () => {
    const { reg, link1, link2 } = twoSidecars();
    const res = reg.relayApproval({ session_id: "s2", request_id: "r2", decision: "deny" });
    expect(res.ok).toBe(true);
    expect(link2.msgs()).toHaveLength(1);
    expect(link2.msgs()[0]?.token).toBe("ctl2");
    expect(link1.sent).toHaveLength(0);
  });

  it("relays interrupt to s1's sidecar only", () => {
    const { reg, link1, link2 } = twoSidecars();
    const res = reg.relayInterrupt("s1");
    expect(res.ok).toBe(true);
    expect(link1.msgs()).toHaveLength(1);
    expect(link1.msgs()[0]?.session_id).toBe("s1");
    expect(link1.msgs()[0]?.token).toBe("ctl1");
    expect(link2.sent).toHaveLength(0);
  });

  it("refuses an unregistered session and touches no registered sidecar", () => {
    const { reg, link1, link2 } = twoSidecars();
    const res = reg.relayApproval({ session_id: "ghost", request_id: "rg", decision: "allow" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not registered/i);
    expect(link1.sent).toHaveLength(0);
    expect(link2.sent).toHaveLength(0);
  });
});

describe("INV-REALTIME-RELAY: send failure on the sidecar link is reported as ok:false (QA-3)", () => {
  /** open=true だが send が throw する link (back-pressure / half-open 等の relay 失敗)。 */
  function throwingLink(): SidecarLink {
    return {
      open: true,
      send() {
        throw new Error("boom");
      },
    };
  }

  it("relayApproval returns ok:false when the link send throws", () => {
    const reg = new SidecarRegistry();
    const link = throwingLink();
    reg.add(link);
    reg.handleHello(link, { type: "hello", control_token: "ctl", session_ids: ["s1"] });
    const res = reg.relayApproval({ session_id: "s1", request_id: "r1", decision: "allow" });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/relay send failed/i);
  });

  it("relayInterrupt returns ok:false when the link send throws", () => {
    const reg = new SidecarRegistry();
    const link = throwingLink();
    reg.add(link);
    reg.handleHello(link, { type: "hello", control_token: "ctl", session_ids: ["s1"] });
    const res = reg.relayInterrupt("s1");
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/relay send failed/i);
  });
});
