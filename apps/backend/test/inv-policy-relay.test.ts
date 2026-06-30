/**
 * ADR 019f0c3e Phase 2: policy relay (requestPolicy / resolvePolicy) の round-trip INV。
 *
 * inv-allowlist-relay.test.ts と同型 (FakeLink + fake timer・DB/WS 非依存)。policy は machine-global
 * ゆえ session_id は宛先解決のみに使う。categories は closed enum (NO-RAW)。
 * 固定する不変条件 (falsifiable・mutation で RED):
 *  - INV-POLICY-RELAY-SCOPE: 未登録 / controlToken 未受領 (observe のみ) の session への requestPolicy は
 *    即 reject (任意 PID/URL へ到達しない・SSRF 境界・requestAllowlist と同型)。
 *  - INV-POLICY-CLOSED-ENUM: resolvePolicy は categories を PolicyCategory.options へ投影する。
 *    敵対 sidecar が混ぜた未知文字列 (例 "rm -rf /") は構造的に落ちる。
 *  - get/set: 要求フレームに op と controlToken が載る。set のみ categories/enabled を載せる。
 *  - error passthrough: sidecar が error を返したら ok:false で伝える。
 *  - SEC-S1-1 (decision 019f0e5d): 256 字超の sidecar error は MAX_RELAY_ERROR_LEN で clamp して反射する
 *    (browser へ反射する境界の defense-in-depth・無制限文字列の有界化)。
 *  - env_gate_enabled passthrough: 明示 false のみ false (省略は true)。
 *  - timeout: 応答なしで policyTimeoutMs reject + pending 掃除 + 後続 resolve は no-op。
 *  - dispose: 未解決 pending を "server shutting down" で reject + 全件掃く。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_RELAY_ERROR_LEN, SidecarRegistry, type SidecarLink } from "../src/sidecar-registry.js";

class FakeLink implements SidecarLink {
  readonly sent: string[] = [];
  open = true;
  send(data: string): void {
    if (!this.open) throw new Error("closed");
    this.sent.push(data);
  }
}

function lastPolicyReq(link: FakeLink): {
  request_id: string;
  op?: string;
  categories?: unknown;
  enabled?: unknown;
  token?: string;
} {
  const raw = link.sent.find((m) => m.includes('"type":"policy.request"'));
  if (raw === undefined) throw new Error("no policy.request sent");
  return JSON.parse(raw);
}

describe("INV-POLICY Phase 2 policy relay (pending lifecycle, no DB/WS)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("requestPolicy(get) は controlToken 付きで policy.request を送り、応答で解決する", async () => {
    const reg = new SidecarRegistry({ policyTimeoutMs: 5000 });
    const link = new FakeLink();
    reg.add(link);
    reg.handleHello(link, { type: "hello", control_token: "ctl", session_ids: ["s1"] });

    const p = reg.requestPolicy("s1", "get");
    expect(reg.pendingPolicyCount).toBe(1);
    const req = lastPolicyReq(link);
    expect(req.op).toBe("get");
    expect(req.token).toBe("ctl"); // controlToken を付与 (認可境界)。
    expect(req.categories).toBeUndefined(); // get は categories を載せない。
    expect(req.enabled).toBeUndefined();

    reg.resolvePolicy({
      request_id: req.request_id,
      enabled: true,
      categories: ["recursive-rm", "secret-egress"],
      env_gate_enabled: true,
    });
    const res = await p;
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.enabled).toBe(true);
      expect(res.categories).toEqual(["recursive-rm", "secret-egress"]);
      expect(res.env_gate_enabled).toBe(true);
    }
    expect(reg.pendingPolicyCount).toBe(0);
  });

  it("QA-2: send が throw (open だが送信失敗) すると relay send failed で reject し pending を残さない", async () => {
    const reg = new SidecarRegistry({ policyTimeoutMs: 5000 });
    // open=true だが send が throw する link。FakeLink は !open 時のみ throw=手前の disconnected 分岐で
    // 短絡されるため、この「open だが send 失敗」経路 (catch→pending 掃除→relay send failed) が未カバーだった。
    const link: SidecarLink = {
      open: true,
      send() {
        throw new Error("socket write boom");
      },
    };
    reg.add(link);
    reg.handleHello(link, { type: "hello", control_token: "ctl", session_ids: ["s1"] });

    const res = await reg.requestPolicy("s1", "get");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("relay send failed");
    expect(reg.pendingPolicyCount).toBe(0); // catch で pending を掃除 (leak しない)。
  });

  it("requestPolicy(set) は op=set + categories/enabled + controlToken を載せる", async () => {
    const reg = new SidecarRegistry({ policyTimeoutMs: 5000 });
    const link = new FakeLink();
    reg.add(link);
    reg.handleHello(link, { type: "hello", control_token: "ctl", session_ids: ["s1"] });

    const p = reg.requestPolicy("s1", "set", {
      categories: ["disk-destroy", "db-drop"],
      enabled: true,
    });
    const req = lastPolicyReq(link);
    expect(req.op).toBe("set");
    expect(req.token).toBe("ctl");
    expect(req.categories).toEqual(["disk-destroy", "db-drop"]);
    expect(req.enabled).toBe(true);

    reg.resolvePolicy({
      request_id: req.request_id,
      enabled: true,
      categories: ["disk-destroy", "db-drop"],
    });
    const res = await p;
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.categories).toEqual(["disk-destroy", "db-drop"]);
  });

  it("INV-POLICY-CLOSED-ENUM: resolvePolicy は未知 category を構造的に落とし enum 順に投影する", async () => {
    const reg = new SidecarRegistry({ policyTimeoutMs: 5000 });
    const link = new FakeLink();
    reg.add(link);
    reg.handleHello(link, { type: "hello", control_token: "ctl", session_ids: ["s1"] });

    const p = reg.requestPolicy("s1", "get");
    const req = lastPolicyReq(link);
    // 敵対 sidecar が未知文字列 / 非 string / raw コマンドを混ぜる。
    reg.resolvePolicy({
      request_id: req.request_id,
      enabled: true,
      // 挿入順を enum 順と変え、未知/非 string を混ぜる。
      categories: ["secret-egress", "rm -rf /", 42, "recursive-rm", "bogus-cat", null],
    });
    const res = await p;
    expect(res.ok).toBe(true);
    if (res.ok) {
      const json = JSON.stringify(res.categories);
      expect(json).not.toContain("rm -rf"); // 未知 raw は落ちる。
      expect(json).not.toContain("bogus-cat");
      // PolicyCategory.options の安定順 (recursive-rm が secret-egress より前)。
      expect(res.categories).toEqual(["recursive-rm", "secret-egress"]);
    }
  });

  it("error passthrough: sidecar が error を返したら ok:false で伝える", async () => {
    const reg = new SidecarRegistry({ policyTimeoutMs: 5000 });
    const link = new FakeLink();
    reg.add(link);
    reg.handleHello(link, { type: "hello", control_token: "ctl", session_ids: ["s1"] });

    const p = reg.requestPolicy("s1", "set", { enabled: true });
    const req = lastPolicyReq(link);
    reg.resolvePolicy({ request_id: req.request_id, error: "policy rejected" });
    const res = await p;
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toBe("policy rejected");
    expect(reg.pendingPolicyCount).toBe(0);
  });

  it("SEC-S1-1: 256 字超の sidecar error は MAX_RELAY_ERROR_LEN で clamp して反射する", async () => {
    const reg = new SidecarRegistry({ policyTimeoutMs: 5000 });
    const link = new FakeLink();
    reg.add(link);
    reg.handleHello(link, { type: "hello", control_token: "ctl", session_ids: ["s1"] });

    const p = reg.requestPolicy("s1", "set", { enabled: true });
    const req = lastPolicyReq(link);
    // 敵対/バグ sidecar が無制限長の error を返す (正規 sidecar は固定文言で常に <256)。
    const longError = "x".repeat(300);
    reg.resolvePolicy({ request_id: req.request_id, error: longError });
    const res = await p;
    expect(res.ok).toBe(false);
    if (!res.ok) {
      // `.slice(0, MAX_RELAY_ERROR_LEN)` を消す mutation だと length=300 のまま RED。
      expect(res.error.length).toBe(MAX_RELAY_ERROR_LEN);
      expect(res.error).toBe(longError.slice(0, MAX_RELAY_ERROR_LEN));
    }
    expect(reg.pendingPolicyCount).toBe(0);
  });

  it("env_gate_enabled passthrough: 明示 false のみ false (省略は true)", async () => {
    const reg = new SidecarRegistry({ policyTimeoutMs: 5000 });
    const link = new FakeLink();
    reg.add(link);
    reg.handleHello(link, { type: "hello", control_token: "ctl", session_ids: ["s1"] });

    // 明示 false。
    const p1 = reg.requestPolicy("s1", "get");
    reg.resolvePolicy({
      request_id: lastPolicyReq(link).request_id,
      enabled: true,
      categories: [],
      env_gate_enabled: false,
    });
    const r1 = await p1;
    expect(r1.ok && r1.env_gate_enabled).toBe(false);

    // 省略 → 既定 true。
    link.sent.length = 0;
    const p2 = reg.requestPolicy("s1", "get");
    reg.resolvePolicy({
      request_id: lastPolicyReq(link).request_id,
      enabled: true,
      categories: [],
    });
    const r2 = await p2;
    expect(r2.ok && r2.env_gate_enabled).toBe(true);
  });

  it("timeout: 応答なしで reject し pending を掃く・遅延応答は no-op", async () => {
    const reg = new SidecarRegistry({ policyTimeoutMs: 50 });
    const link = new FakeLink();
    reg.add(link);
    reg.handleHello(link, { type: "hello", control_token: "ctl", session_ids: ["s1"] });

    const p = reg.requestPolicy("s1", "get");
    const req = lastPolicyReq(link);
    expect(reg.pendingPolicyCount).toBe(1);

    await vi.advanceTimersByTimeAsync(60);
    const res = await p;
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toBe("policy request timed out");
    expect(reg.pendingPolicyCount).toBe(0);

    // 遅延応答は no-op (late resolve しない)。
    expect(() =>
      reg.resolvePolicy({ request_id: req.request_id, enabled: true, categories: [] }),
    ).not.toThrow();
    expect(reg.pendingPolicyCount).toBe(0);
  });

  it("dispose() は未解決 policy pending を 'server shutting down' で reject し全件掃く", async () => {
    const reg = new SidecarRegistry({ policyTimeoutMs: 5000 });
    const link = new FakeLink();
    reg.add(link);
    reg.handleHello(link, { type: "hello", control_token: "ctl", session_ids: ["s1", "s2"] });

    const p1 = reg.requestPolicy("s1", "get");
    const p2 = reg.requestPolicy("s2", "get");
    expect(reg.pendingPolicyCount).toBe(2);

    reg.dispose();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok === false && r1.error).toBe("server shutting down");
    expect(r2.ok === false && r2.error).toBe("server shutting down");
    expect(reg.pendingPolicyCount).toBe(0);
  });

  it("INV-POLICY-RELAY-SCOPE: controlToken 未受領 (observe のみ) は即 reject (要求を送らない)", async () => {
    const reg = new SidecarRegistry({ policyTimeoutMs: 5000 });
    const link = new FakeLink();
    reg.add(link);
    reg.observeSession(link, "s1"); // hello 無し = controlToken 未受領。

    const res = await reg.requestPolicy("s1", "get");
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toBe("no control channel (handshake incomplete)");
    expect(reg.pendingPolicyCount).toBe(0);
    expect(link.sent.some((m) => m.includes("policy.request"))).toBe(false);
  });

  it("INV-POLICY-RELAY-SCOPE: 未登録 session は 'session not registered' で即 reject", async () => {
    const reg = new SidecarRegistry({ policyTimeoutMs: 5000 });
    const res = await reg.requestPolicy("never", "get");
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toBe("session not registered");
    expect(reg.pendingPolicyCount).toBe(0);
  });

  it("INV-POLICY-RELAY-SCOPE: 切断中 (link.open=false) は 'sidecar disconnected' で reject", async () => {
    const reg = new SidecarRegistry({ policyTimeoutMs: 5000 });
    const link = new FakeLink();
    reg.add(link);
    reg.handleHello(link, { type: "hello", control_token: "ctl", session_ids: ["s1"] });
    link.open = false;

    const res = await reg.requestPolicy("s1", "get");
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toBe("sidecar disconnected");
    expect(reg.pendingPolicyCount).toBe(0);
  });
});

/**
 * INV-POLICY-FANOUT (QA-1/H + TDA-1/M・decision 019f0f2f): multi-daemon fan-out の意味論を固定する。
 * fanOutPolicyMutation はマシン上の全 connected daemon へ policy を live 反映する中核だが、これまで
 * 完全無テストだった (回帰検出網の外)。以下を falsifiable に pin する:
 *  - set/unset → owner 以外の全 open daemon が **各自の controlToken** で policy.request を受信する
 *    (owner は自分宛の重複を受けない)。
 *  - 伝播コピーは **persist:false** を載せる (TDA-1: 受信 daemon は memory のみ反映し disk を書かない →
 *    再接続後の stale daemon が full layered を書戻して厳格 override を黙って消す downgrade を構造遮断)。
 *    owner の直送には persist を載せない (= owner のみが disk 権威)。
 *  - get/list/resolve (読取り) は **fan-out しない** (他 daemon は受信ゼロ・resolve の path/scope は拡散しない)。
 *  - 切断 (open=false) / observe-only (controlToken 未受領) の daemon は skip する。
 */
describe("INV-POLICY-FANOUT multi-daemon fan-out (QA-1/TDA-1)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** ある link に届いた全 policy.request を解析して返す。 */
  function policyReqsOn(link: FakeLink): Array<Record<string, unknown>> {
    return link.sent
      .filter((m) => m.includes('"type":"policy.request"'))
      .map((m) => JSON.parse(m) as Record<string, unknown>);
  }

  /** 3 daemon (owner=s1 / other=s2 / other=s3) を別々の controlToken で確立する。 */
  function threeDaemons() {
    const reg = new SidecarRegistry({ policyTimeoutMs: 5000 });
    const owner = new FakeLink();
    const d2 = new FakeLink();
    const d3 = new FakeLink();
    reg.add(owner);
    reg.add(d2);
    reg.add(d3);
    reg.handleHello(owner, { type: "hello", control_token: "ctl-owner", session_ids: ["s1"] });
    reg.handleHello(d2, { type: "hello", control_token: "ctl-d2", session_ids: ["s2"] });
    reg.handleHello(d3, { type: "hello", control_token: "ctl-d3", session_ids: ["s3"] });
    return { reg, owner, d2, d3 };
  }

  it("set は owner 以外の全 open daemon へ各自の token で伝播し、コピーは persist:false (owner 直送は persist 無し)", () => {
    const { reg, owner, d2, d3 } = threeDaemons();

    void reg.requestPolicy("s1", "set", {
      categories: ["disk-destroy"],
      enabled: true,
      repo_scope: "abc123",
      repo_label: "myrepo",
    });

    // owner: 直送 1 通のみ・persist フィールド無し (= owner が disk 権威)・自分の token。
    const ownerReqs = policyReqsOn(owner);
    expect(ownerReqs).toHaveLength(1);
    expect(ownerReqs[0].op).toBe("set");
    expect(ownerReqs[0].token).toBe("ctl-owner");
    expect("persist" in ownerReqs[0]).toBe(false);
    expect(ownerReqs[0].repo_scope).toBe("abc123");

    // d2 / d3: fan-out コピー 1 通ずつ・各自の token・persist:false・同 payload。
    for (const [link, tok] of [
      [d2, "ctl-d2"],
      [d3, "ctl-d3"],
    ] as const) {
      const reqs = policyReqsOn(link);
      expect(reqs).toHaveLength(1);
      expect(reqs[0].op).toBe("set");
      expect(reqs[0].token).toBe(tok); // 受信 daemon 自身の controlToken (memory-authoritative)。
      expect(reqs[0].persist).toBe(false); // TDA-1: 受信側は memory のみ。
      expect(reqs[0].categories).toEqual(["disk-destroy"]);
      expect(reqs[0].repo_scope).toBe("abc123");
    }
  });

  it("unset も owner 以外へ persist:false で伝播する", () => {
    const { reg, owner, d2, d3 } = threeDaemons();
    void reg.requestPolicy("s1", "unset", { repo_scope: "deadbeef" });

    expect(policyReqsOn(owner)).toHaveLength(1);
    expect("persist" in policyReqsOn(owner)[0]).toBe(false);
    for (const link of [d2, d3]) {
      const reqs = policyReqsOn(link);
      expect(reqs).toHaveLength(1);
      expect(reqs[0].op).toBe("unset");
      expect(reqs[0].persist).toBe(false);
      expect(reqs[0].repo_scope).toBe("deadbeef");
    }
  });

  it("get / list は fan-out しない (他 daemon は受信ゼロ)", () => {
    for (const op of ["get", "list"] as const) {
      const { reg, owner, d2, d3 } = threeDaemons();
      void reg.requestPolicy("s1", op);
      expect(policyReqsOn(owner)).toHaveLength(1); // owner だけが受け取る。
      expect(policyReqsOn(d2)).toHaveLength(0);
      expect(policyReqsOn(d3)).toHaveLength(0);
    }
  });

  it("resolve は fan-out しない: path / resolve_scope は他 daemon へ拡散しない (owner のみ)", () => {
    const { reg, owner, d2, d3 } = threeDaemons();
    void reg.requestPolicy("s1", "resolve", {
      path: "/home/me/work/repo",
      resolveScope: ["/home/me/work"],
    });

    const ownerReqs = policyReqsOn(owner);
    expect(ownerReqs).toHaveLength(1);
    expect(ownerReqs[0].op).toBe("resolve");
    expect(ownerReqs[0].path).toBe("/home/me/work/repo");
    expect(ownerReqs[0].resolve_scope).toEqual(["/home/me/work"]);

    // 他 daemon は resolve を一切受信しない → 生 path / scope が他 conn へ漏れない。
    expect(policyReqsOn(d2)).toHaveLength(0);
    expect(policyReqsOn(d3)).toHaveLength(0);
  });

  it("切断 (open=false) / observe-only (controlToken 未受領) の daemon は fan-out から skip する", () => {
    const reg = new SidecarRegistry({ policyTimeoutMs: 5000 });
    const owner = new FakeLink();
    const closed = new FakeLink();
    const observe = new FakeLink();
    const live = new FakeLink();
    reg.add(owner);
    reg.add(closed);
    reg.add(observe);
    reg.add(live);
    reg.handleHello(owner, { type: "hello", control_token: "ctl-owner", session_ids: ["s1"] });
    reg.handleHello(closed, { type: "hello", control_token: "ctl-closed", session_ids: ["s2"] });
    reg.observeSession(observe, "s3"); // hello 無し = controlToken 未受領。
    reg.handleHello(live, { type: "hello", control_token: "ctl-live", session_ids: ["s4"] });
    closed.open = false; // hello 後に切断。

    void reg.requestPolicy("s1", "set", { categories: [], enabled: true });

    expect(policyReqsOn(closed)).toHaveLength(0); // 切断は skip (send しない)。
    expect(policyReqsOn(observe)).toHaveLength(0); // controlToken 無しは skip (token を付与できない)。
    const liveReqs = policyReqsOn(live);
    expect(liveReqs).toHaveLength(1); // 生存 + token 受領済みのみ受け取る。
    expect(liveReqs[0].persist).toBe(false);
    expect(liveReqs[0].token).toBe("ctl-live");
  });
});
