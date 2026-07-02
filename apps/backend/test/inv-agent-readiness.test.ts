/**
 * ADR 019f1972 §2b (decision 019f1a29): agent 観測可能性 readiness の INV (FakeLink・DB/WS 非依存)。
 *
 * sidecar が hello frame に相乗りさせた `agent_visibility` を backend が受信検証 (event-model の正準
 * parseAgentVisibilityWire) し、全 open conn を OR 集約して `agentReadiness()` で公開することを固定する。
 *
 * 焦点 (falsifiable):
 *  - INV-AGENT-READINESS-OR: 複数 daemon の per-agent boolean が field ごと OR fold される
 *    (binaryOnPath/anyHook/rolloutDirResolved を別 daemon が持っても machine 全体で true)。
 *  - daemonCount は **open conn 総数** (visibility 未報告 daemon も観測主体として数える=policyCapable 非依存)。
 *  - handleHello が **不正 agent_visibility を弾く** (非 object / sub-object 欠落 → 未報告扱い・例外なし)、
 *    非 boolean field は安全側 false へ縮退 (NO-RAW: false positive を作らない)。
 *  - reannounce で最新の有効報告を保持 (有効 visibility で上書き / 省略では前回値を保持)。
 */
import { describe, expect, it } from "vitest";

import { SidecarRegistry, type SidecarLink } from "../src/sidecar-registry.js";

class FakeLink implements SidecarLink {
  open = true;
  send(_data: string): void {
    /* readiness は送信しない (純集約)。 */
  }
}

const VIS_NONE = {
  claude: { binaryOnPath: false, anyHook: false },
  codex: { binaryOnPath: false, rolloutDirResolved: false },
};

describe("ADR 019f1972 §2b agentReadiness", () => {
  it("報告ゼロ (誰も agent_visibility を送らない) → 全 false・daemonCount は open conn 数", () => {
    const reg = new SidecarRegistry();
    const d1 = new FakeLink();
    const d2 = new FakeLink();
    reg.add(d1);
    reg.add(d2);
    reg.handleHello(d1, { type: "hello", control_token: "c1", session_ids: [] });
    reg.handleHello(d2, { type: "hello", control_token: "c2", session_ids: [] });

    const r = reg.agentReadiness();
    expect(r.daemonCount).toBe(2); // visibility 未報告でも open conn は数える。
    expect(r).toMatchObject(VIS_NONE);
  });

  it("INV-AGENT-READINESS-OR: per-agent boolean を field ごと OR fold する (falsifiable)", () => {
    const reg = new SidecarRegistry();
    const d1 = new FakeLink();
    const d2 = new FakeLink();
    reg.add(d1);
    reg.add(d2);
    // d1: Claude binary のみ (未配線)・Codex 未検出。
    reg.handleHello(d1, {
      type: "hello",
      control_token: "c1",
      session_ids: [],
      agent_visibility: {
        claude: { binaryOnPath: true, anyHook: false },
        codex: { binaryOnPath: false, rolloutDirResolved: false },
      },
    });
    // d2: Claude hook 配線済み・Codex rollout 解決済み。
    reg.handleHello(d2, {
      type: "hello",
      control_token: "c2",
      session_ids: [],
      agent_visibility: {
        claude: { binaryOnPath: true, anyHook: true },
        codex: { binaryOnPath: true, rolloutDirResolved: true },
      },
    });

    const r = reg.agentReadiness();
    expect(r.daemonCount).toBe(2);
    // OR fold: いずれかの daemon が見えていれば true。
    expect(r.claude).toEqual({ binaryOnPath: true, anyHook: true });
    expect(r.codex).toEqual({ binaryOnPath: true, rolloutDirResolved: true });
  });

  it("open conn のみ集約・切断 conn は daemonCount にも reports にも含めない", () => {
    const reg = new SidecarRegistry();
    const open = new FakeLink();
    const closed = new FakeLink();
    reg.add(open);
    reg.add(closed);
    reg.handleHello(open, {
      type: "hello",
      control_token: "c1",
      session_ids: [],
      agent_visibility: {
        claude: { binaryOnPath: true, anyHook: false },
        codex: { binaryOnPath: false, rolloutDirResolved: false },
      },
    });
    reg.handleHello(closed, {
      type: "hello",
      control_token: "c2",
      session_ids: [],
      agent_visibility: {
        claude: { binaryOnPath: true, anyHook: true }, // 切断後は集約に効かない。
        codex: { binaryOnPath: true, rolloutDirResolved: true },
      },
    });
    closed.open = false;

    const r = reg.agentReadiness();
    expect(r.daemonCount).toBe(1); // open のみ。
    // closed の anyHook/rollout は反映されない (open daemon の状態のみ)。
    expect(r.claude).toEqual({ binaryOnPath: true, anyHook: false });
    expect(r.codex).toEqual({ binaryOnPath: false, rolloutDirResolved: false });
  });

  it("handleHello は不正 agent_visibility を弾く (非 object / sub-object 欠落 → 未報告・例外なし)", () => {
    const reg = new SidecarRegistry();
    for (const bad of [
      "not-an-object",
      123,
      null,
      [],
      {}, // claude/codex 欠落。
      { claude: { binaryOnPath: true, anyHook: true } }, // codex 欠落。
      { claude: "x", codex: "y" }, // sub-object が非 object。
    ]) {
      const link = new FakeLink();
      reg.add(link);
      // 例外を投げない (fail-safe)。
      expect(() =>
        reg.handleHello(link, {
          type: "hello",
          control_token: "c",
          session_ids: [],
          agent_visibility: bad,
        }),
      ).not.toThrow();
    }
    // すべて未報告扱い → 集約は全 false (daemonCount は open conn 数)。
    const r = reg.agentReadiness();
    expect(r).toMatchObject(VIS_NONE);
    expect(r.daemonCount).toBe(7);
  });

  it("非 boolean field は安全側 false へ縮退する (NO-RAW: false positive を作らない)", () => {
    const reg = new SidecarRegistry();
    const link = new FakeLink();
    reg.add(link);
    reg.handleHello(link, {
      type: "hello",
      control_token: "c",
      session_ids: [],
      // 余剰 field (secret 様) や非 boolean 値を混ぜても boolean のみ抽出され余剰は落ちる。
      agent_visibility: {
        claude: { binaryOnPath: "yes", anyHook: 1, leaked: "/home/me/.env" },
        codex: { binaryOnPath: true, rolloutDirResolved: "true" },
      },
    });
    const r = reg.agentReadiness();
    // 非 boolean は false へ縮退。binaryOnPath:true (真の boolean) のみ通る。
    expect(r.claude).toEqual({ binaryOnPath: false, anyHook: false });
    expect(r.codex).toEqual({ binaryOnPath: true, rolloutDirResolved: false });
    // NO-RAW: 余剰 field は集約結果に存在しない。
    expect(JSON.stringify(r)).not.toContain("leaked");
    expect(JSON.stringify(r)).not.toContain(".env");
  });

  it("reannounce: 有効 visibility で上書き・省略では前回値を保持 (最新の有効報告)", () => {
    const reg = new SidecarRegistry();
    const link = new FakeLink();
    reg.add(link);
    // 初回: Claude binary のみ。
    reg.handleHello(link, {
      type: "hello",
      control_token: "c",
      session_ids: [],
      agent_visibility: {
        claude: { binaryOnPath: true, anyHook: false },
        codex: { binaryOnPath: false, rolloutDirResolved: false },
      },
    });
    expect(reg.agentReadiness().claude).toEqual({ binaryOnPath: true, anyHook: false });

    // reannounce で hook 配線済みへ更新。
    reg.handleHello(link, {
      type: "hello",
      control_token: "c",
      session_ids: [],
      agent_visibility: {
        claude: { binaryOnPath: true, anyHook: true },
        codex: { binaryOnPath: false, rolloutDirResolved: false },
      },
    });
    expect(reg.agentReadiness().claude).toEqual({ binaryOnPath: true, anyHook: true });

    // agent_visibility 省略の reannounce → 前回の有効値を保持 (上書きしない)。
    reg.handleHello(link, { type: "hello", control_token: "c", session_ids: [] });
    expect(reg.agentReadiness().claude).toEqual({ binaryOnPath: true, anyHook: true });
  });
});
