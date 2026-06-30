/**
 * ADR 019f1582: daemon-addressed policy relay の INV。
 *
 * 承認ポリシー設定 (get/set/unset/list/resolve) を **session を所有しない接続中 daemon** へ直接中継できる
 * ことを固定する。policy は machine-global config ゆえ、接続中の任意 daemon に届けば live 反映 + owner の
 * disk 永続 + fan-out で全 daemon へ収束する。これによりエージェント未稼働 (owned session ゼロ) でも、
 * 常時接続の attach daemon の制御チャネル経由で per-repo policy を設定できる。
 *
 * 焦点:
 *  - linchpin: `connectedDaemons()` は **owned session ゼロでも** relay 可能 (open + controlToken) な daemon を
 *    列挙する (= UI が relay-target に選べる)。observe-only (controlToken 未受領) / 切断は除外。
 *  - INV-POLICY-DAEMON-RELAY-SCOPE: `requestPolicyByDaemon(daemonId)` は **当該 daemon のみ**へ中継し、
 *    未知 daemonId / 切断は安全側 reject、他 conn に触れない (falsifiable: byDaemon.get→先頭 conn にすり替えると
 *    2 daemon 構成で RED)。
 *  - set/unset は session 経路と同じく fan-out 継続 / get・list・resolve は非 fan-out (生 path を他へ拡散しない)。
 *
 * inv-policy-relay.test.ts と同型 (FakeLink・DB/WS 非依存)。
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

/** ある link に届いた全 policy.request を解析して返す。 */
function policyReqsOn(link: FakeLink): Array<Record<string, unknown>> {
  return link.sent
    .filter((m) => m.includes('"type":"policy.request"'))
    .map((m) => JSON.parse(m) as Record<string, unknown>);
}

describe("ADR 019f1582 daemon-addressed policy relay", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("linchpin: connectedDaemons は owned session ゼロでも relay 可能 daemon を列挙する", () => {
    const reg = new SidecarRegistry({ policyTimeoutMs: 5000 });
    const d1 = new FakeLink();
    const d2 = new FakeLink();
    reg.add(d1);
    reg.add(d2);
    // session_ids:[] = エージェント未稼働の attach daemon。controlToken は確立する。
    reg.handleHello(d1, {
      type: "hello",
      control_token: "ctl-d1",
      session_ids: [],
      policy_capable: true,
    });
    reg.handleHello(d2, {
      type: "hello",
      control_token: "ctl-d2",
      session_ids: [],
      policy_capable: true,
    });

    const daemons = reg.connectedDaemons();
    expect(daemons).toHaveLength(2);
    for (const d of daemons) {
      // daemonId は randomUUID 形 (credential でない・NO-RAW)。
      expect(d.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
    // session を一切登録していないので session 経路は relay 不能 (対比)。
    expect(reg.canRelay("s-none")).toBe(false);
  });

  it("connectedDaemons は observe-only (controlToken 未受領) / 切断 daemon を除外する", () => {
    const reg = new SidecarRegistry({ policyTimeoutMs: 5000 });
    const live = new FakeLink();
    const observe = new FakeLink();
    const closed = new FakeLink();
    reg.add(live);
    reg.add(observe); // hello を送らない = controlToken 未受領 (observe-only)。
    reg.add(closed);
    reg.handleHello(live, {
      type: "hello",
      control_token: "ctl-live",
      session_ids: [],
      policy_capable: true,
    });
    reg.handleHello(closed, {
      type: "hello",
      control_token: "ctl-closed",
      session_ids: [],
      policy_capable: true,
    });
    closed.open = false; // hello 後に切断。

    const ids = reg.connectedDaemons();
    // relay 可能なのは live のみ。observe-only (token 無) と closed (open=false) は除外。
    expect(ids).toHaveLength(1);
  });

  it("INV-POLICY-DAEMON-CAPABILITY: policy 非対応 daemon (policy_capable 未広告) を connectedDaemons から除外する (falsifiable)", () => {
    // codex-rollout daemon は observe-only で policyRequest を処理しない (interrupt のみ wire)。
    // controlToken は確立するが policy_capable を広告しないため、UI の daemon-addressed policy 宛先
    // (connectedDaemons) に出してはならない — 出すと UI が選んで addressing し timeout する事故になる。
    // connectedDaemons の `conn.policyCapable` フィルタを外すと本テストは 2 を観測して RED。
    const reg = new SidecarRegistry({ policyTimeoutMs: 5000 });
    const policyDaemon = new FakeLink(); // managed/attach: policy 対応 (buildPolicyResponse を wire)。
    const observeOnly = new FakeLink(); // codex-rollout: policy 非対応。
    reg.add(policyDaemon);
    reg.add(observeOnly);
    reg.handleHello(policyDaemon, {
      type: "hello",
      control_token: "ctl-policy",
      session_ids: [],
      policy_capable: true,
    });
    // controlToken は確立するが policy_capable を載せない (observe-only daemon の hello)。
    reg.handleHello(observeOnly, { type: "hello", control_token: "ctl-observe", session_ids: [] });

    const daemons = reg.connectedDaemons();
    // policy 対応の 1 件のみ。observe-only (policy_capable 未広告) は controlToken があっても除外する。
    expect(daemons).toHaveLength(1);
  });

  it("INV-POLICY-DAEMON-RELAY-SCOPE: requestPolicyByDaemon は当該 daemon のみへ中継する (falsifiable)", () => {
    const reg = new SidecarRegistry({ policyTimeoutMs: 5000 });
    const d1 = new FakeLink();
    const d2 = new FakeLink();
    reg.add(d1);
    reg.add(d2);
    reg.handleHello(d1, {
      type: "hello",
      control_token: "ctl-d1",
      session_ids: [],
      policy_capable: true,
    });
    reg.handleHello(d2, {
      type: "hello",
      control_token: "ctl-d2",
      session_ids: [],
      policy_capable: true,
    });

    const daemons = reg.connectedDaemons();
    expect(daemons).toHaveLength(2);
    // **2 番目** の daemon を addressing する (byDaemon.get→先頭 conn すり替えだと d1 に届き RED)。
    void reg.requestPolicyByDaemon(daemons[1].id, "get");

    const d2Reqs = policyReqsOn(d2);
    expect(d2Reqs).toHaveLength(1);
    expect(d2Reqs[0].op).toBe("get");
    expect(d2Reqs[0].token).toBe("ctl-d2"); // 宛先 daemon 自身の controlToken。
    // 他 daemon (d1) には get が一切届かない (get は fan-out しない・誤中継もしない)。
    expect(policyReqsOn(d1)).toHaveLength(0);
  });

  it("未知 daemonId は安全側 reject (daemon not registered)・どの conn にも触れない", async () => {
    const reg = new SidecarRegistry({ policyTimeoutMs: 5000 });
    const d1 = new FakeLink();
    reg.add(d1);
    reg.handleHello(d1, {
      type: "hello",
      control_token: "ctl-d1",
      session_ids: [],
      policy_capable: true,
    });

    const res = await reg.requestPolicyByDaemon("00000000-0000-0000-0000-000000000000", "get");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("daemon not registered");
    expect(policyReqsOn(d1)).toHaveLength(0); // 既存 conn に誤送しない。
  });

  it("切断 daemon (open=false) への requestPolicyByDaemon は sidecar disconnected で reject", async () => {
    const reg = new SidecarRegistry({ policyTimeoutMs: 5000 });
    const d1 = new FakeLink();
    reg.add(d1);
    reg.handleHello(d1, {
      type: "hello",
      control_token: "ctl-d1",
      session_ids: [],
      policy_capable: true,
    });
    const id = reg.connectedDaemons()[0].id;
    d1.open = false; // hello 後に切断。

    const res = await reg.requestPolicyByDaemon(id, "get");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("sidecar disconnected");
  });

  it("daemon 経路の set は他 daemon へ fan-out する (machine-wide・persist:false)", () => {
    const reg = new SidecarRegistry({ policyTimeoutMs: 5000 });
    const d1 = new FakeLink();
    const d2 = new FakeLink();
    reg.add(d1);
    reg.add(d2);
    reg.handleHello(d1, {
      type: "hello",
      control_token: "ctl-d1",
      session_ids: [],
      policy_capable: true,
    });
    reg.handleHello(d2, {
      type: "hello",
      control_token: "ctl-d2",
      session_ids: [],
      policy_capable: true,
    });
    const targetId = reg.connectedDaemons()[0].id; // d1 (先頭)。

    void reg.requestPolicyByDaemon(targetId, "set", {
      categories: ["disk-destroy"],
      enabled: true,
      repo_scope: "abc123",
    });

    // owner (addressed daemon=d1): 直送 1 通・persist 無し (disk 権威)・自 token。
    const d1Reqs = policyReqsOn(d1);
    expect(d1Reqs).toHaveLength(1);
    expect(d1Reqs[0].op).toBe("set");
    expect(d1Reqs[0].token).toBe("ctl-d1");
    expect("persist" in d1Reqs[0]).toBe(false);
    // 他 daemon (d2): fan-out コピー・persist:false・自 token (session 経路と同一挙動)。
    const d2Reqs = policyReqsOn(d2);
    expect(d2Reqs).toHaveLength(1);
    expect(d2Reqs[0].op).toBe("set");
    expect(d2Reqs[0].token).toBe("ctl-d2");
    expect(d2Reqs[0].persist).toBe(false);
    expect(d2Reqs[0].categories).toEqual(["disk-destroy"]);
  });

  it("daemon 経路の get / resolve は fan-out しない (他 daemon は受信ゼロ・生 path 非拡散)", () => {
    for (const op of ["get", "resolve"] as const) {
      const reg = new SidecarRegistry({ policyTimeoutMs: 5000 });
      const d1 = new FakeLink();
      const d2 = new FakeLink();
      reg.add(d1);
      reg.add(d2);
      reg.handleHello(d1, {
        type: "hello",
        control_token: "ctl-d1",
        session_ids: [],
        policy_capable: true,
      });
      reg.handleHello(d2, {
        type: "hello",
        control_token: "ctl-d2",
        session_ids: [],
        policy_capable: true,
      });
      const targetId = reg.connectedDaemons()[0].id;

      void reg.requestPolicyByDaemon(
        targetId,
        op,
        op === "resolve"
          ? { path: "/home/me/work/repo", resolveScope: ["/home/me/work"] }
          : undefined,
      );

      expect(policyReqsOn(d1)).toHaveLength(1); // addressed daemon のみ。
      expect(policyReqsOn(d2)).toHaveLength(0); // 他 daemon へ拡散しない (生 path 漏洩なし)。
    }
  });

  it("INV-POLICY-DAEMON-LIFECYCLE: remove(link) 後 byDaemon からも消える (add↔remove 対称・falsifiable)", async () => {
    // 回帰ガード: byDaemon ⊆ conns 不変。remove() が byDaemon.delete を欠くと、切断 daemon の
    // SidecarConn (link + sessions + controlToken) が byDaemon に蓄積し GC されない (長命 backend +
    // reconnect churn でリーク)。capability leak でなく resource leak だが、ADR 019f1582 が remove で
    // 削除すると明記済 (T1↔T2 ドリフト)。
    const reg = new SidecarRegistry({ policyTimeoutMs: 5000 });
    const d1 = new FakeLink();
    reg.add(d1);
    reg.handleHello(d1, {
      type: "hello",
      control_token: "ctl-d1",
      session_ids: [],
      policy_capable: true,
    });
    const oldId = reg.connectedDaemons()[0].id;

    d1.open = false; // 実 close と同じく link は閉じてから remove される。
    reg.remove(d1);

    // (a) connectedDaemons は当該 id を落とす (conns 走査ゆえ修正前も通るが、対称性の明示)。
    expect(reg.connectedDaemons()).toHaveLength(0);
    // (b) **falsifiable な核**: byDaemon から消えていれば "daemon not registered"。
    //     remove() の byDaemon.delete を消すと byDaemon に conn(open=false) が残留し、
    //     relayPolicyVia の link.open 検査で "sidecar disconnected" を返す → RED。
    const res = await reg.requestPolicyByDaemon(oldId, "get");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("daemon not registered");
  });
});
