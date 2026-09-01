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

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { stripComments } from "@actradeck/event-model";

import { SidecarRegistry, type SidecarLink } from "../src/sidecar-registry.js";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

/** 指定メソッドの本体を波括弧対応で切り出す (comment-strip 済 source 前提)。 */
function methodBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  expect(start, `${signature} が見つからない (走査対象 rot)`).toBeGreaterThanOrEqual(0);
  const i = src.indexOf("{", start);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") {
      depth--;
      if (depth === 0) return src.slice(i, j + 1);
    }
  }
  throw new Error(`${signature} の本体を閉じられない`);
}

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

/**
 * INV-OBSERVABILITY-COUNTERS-READINESS (TDA-V9-7 landing): 縮退カウンタ 2 種の readiness 集約。
 *
 * 背景: `unstableRequestIdCount` (sidecar・SEC-R4-4 で「runtime consumer 未配線」と開示) と
 * `nonRetirableSkipCount` (backend reconciler・SEC-R5-2 landing) は getter として存在するだけで
 * どこからも読めなかった (「観測可能」が運用上未達)。readiness 応答が唯一の読取り路になる。
 *
 * 焦点 (falsifiable):
 *  - daemon 由来は open conn の **sum fold** (延べ数)・切断 conn は除外。
 *  - backend 由来は呼び出し側 (route) 注入値をそのまま射影 (省略 → 0)。
 *  - 受信検証は event-model 正準パーサ (負数 / 非整数 / 非 object / 余剰 field を落とす)。
 *  - reannounce で counters が落ちない (省略 hello は前回値保持・INV egress-handshake 2d と同型:
 *    片方の経路で field を落とすと観測が silent に 0 へ降格する)。
 */
describe("TDA-V9-7 readiness counters", () => {
  it("counters 未報告 → 全 0 (closed shape・他 field を生やさない)", () => {
    const reg = new SidecarRegistry();
    const d1 = new FakeLink();
    reg.add(d1);
    reg.handleHello(d1, { type: "hello", control_token: "c1", session_ids: [] });

    const r = reg.agentReadiness();
    expect(r.counters).toEqual({ unstableRequestIdCount: 0, nonRetirableSkipCount: 0 });
    expect(Object.keys(r.counters).sort()).toEqual([
      "nonRetirableSkipCount",
      "unstableRequestIdCount",
    ]);
  });

  it("daemon 由来 unstableRequestIdCount は open conn の sum fold (切断 conn は除外)", () => {
    const reg = new SidecarRegistry();
    const d1 = new FakeLink();
    const d2 = new FakeLink();
    const gone = new FakeLink();
    reg.add(d1);
    reg.add(d2);
    reg.add(gone);
    reg.handleHello(d1, {
      type: "hello",
      control_token: "c1",
      session_ids: [],
      daemon_counters: { unstableRequestIdCount: 2 },
    });
    reg.handleHello(d2, {
      type: "hello",
      control_token: "c2",
      session_ids: [],
      daemon_counters: { unstableRequestIdCount: 9 },
    });
    reg.handleHello(gone, {
      type: "hello",
      control_token: "c3",
      session_ids: [],
      daemon_counters: { unstableRequestIdCount: 1000 },
    });
    gone.open = false;

    // 2 + 9 (切断 conn の 1000 は入らない)。OR fold でなく加算であることも pin。
    expect(reg.agentReadiness().counters.unstableRequestIdCount).toBe(11);
  });

  it("backend 由来 nonRetirableSkipCount は注入値を射影 (省略 → 0・負数/非整数は 0 へ縮退)", () => {
    const reg = new SidecarRegistry();
    const link = new FakeLink();
    reg.add(link);
    reg.handleHello(link, { type: "hello", control_token: "c", session_ids: [] });

    expect(reg.agentReadiness(3).counters.nonRetirableSkipCount).toBe(3);
    expect(reg.agentReadiness().counters.nonRetirableSkipCount).toBe(0);
    expect(reg.agentReadiness(-5).counters.nonRetirableSkipCount).toBe(0);
    expect(reg.agentReadiness(1.5).counters.nonRetirableSkipCount).toBe(0);
    expect(reg.agentReadiness(Number.NaN).counters.nonRetirableSkipCount).toBe(0);
  });

  it("handleHello は不正 daemon_counters を弾く (非 object → 未報告・負数/非整数/余剰 field → 落とす)", () => {
    const reg = new SidecarRegistry();
    for (const bad of ["x", 7, null, [], true]) {
      const link = new FakeLink();
      reg.add(link);
      expect(() =>
        reg.handleHello(link, {
          type: "hello",
          control_token: "c",
          session_ids: [],
          daemon_counters: bad,
        }),
      ).not.toThrow();
    }
    expect(reg.agentReadiness().counters.unstableRequestIdCount).toBe(0);

    // 敵対 daemon: 負数 + パス/secret 様の余剰 field。
    const hostile = new FakeLink();
    reg.add(hostile);
    reg.handleHello(hostile, {
      type: "hello",
      control_token: "c",
      session_ids: [],
      daemon_counters: {
        unstableRequestIdCount: -42,
        leakedPath: "/home/victim/.claude/settings.json",
        token: "glpat-XXXXXXXXXXXXXXXXXXXX",
      },
    });
    const r = reg.agentReadiness();
    expect(r.counters.unstableRequestIdCount).toBe(0); // 負数は透過しない。
    expect(JSON.stringify(r)).not.toContain("victim");
    expect(JSON.stringify(r)).not.toContain("glpat-");
  });

  it("SEC-SC-2: daemon_counters: null は TypeError でなく「未報告」として扱われる (前回値を保持)", () => {
    // hostile ループの not.toThrow は「落ちない」だけを見ており、null が **未報告** として
    // 扱われる意味論を pin していなかった (parseDaemonCountersWire の `raw === null` ガードを
    // 外すと typeof null === "object" ゆえ TypeError になる)。ここは意味論を直接 assert する。
    const reg = new SidecarRegistry();
    const fresh = new FakeLink();
    reg.add(fresh);
    reg.handleHello(fresh, {
      type: "hello",
      control_token: "c",
      session_ids: [],
      daemon_counters: null,
    });
    // 未報告 → 集約から除外 → 0 (「報告された 0」と同値だが、経路は「除外」であること)。
    expect(reg.agentReadiness().counters.unstableRequestIdCount).toBe(0);

    // 既報告の conn に null が来ても前回値を潰さない (未報告 = 上書きしない)。
    const known = new FakeLink();
    reg.add(known);
    reg.handleHello(known, {
      type: "hello",
      control_token: "c2",
      session_ids: [],
      daemon_counters: { unstableRequestIdCount: 4 },
    });
    expect(reg.agentReadiness().counters.unstableRequestIdCount).toBe(4);
    reg.handleHello(known, {
      type: "hello",
      control_token: "c2",
      session_ids: [],
      daemon_counters: null,
    });
    expect(reg.agentReadiness().counters.unstableRequestIdCount).toBe(4);
  });

  it("SEC-SC-2: 受信境界は handleHello 内で正準パーサを呼ぶ (source-coupling pin・sidecar 側と対称)", () => {
    // 呼び出し側 pin (sidecar inv-approval-reconcile-daemon-wiring の helper 配線 pin と対称)。
    // handleHello から parseDaemonCountersWire の呼び出しが消える / 手書き検証へ置換されると RED。
    // comment-strip 済 source を見るため、コメント文言では充足しない (自己充足の回避)。
    const src = stripComments(readFileSync(join(SRC_DIR, "sidecar-registry.ts"), "utf8"));
    const body = methodBody(src, "handleHello(link: SidecarLink, frame: HelloFrame): boolean");
    expect(
      body.includes("parseDaemonCountersWire("),
      "handleHello が正準 parseDaemonCountersWire を呼んでいない (受信境界の手書き化 / 配線落ち)",
    ).toBe(true);
    // 読む先は wire field 名でなければならない (別 field からの誤読み取りを防ぐ)。
    expect(body).toMatch(/parseDaemonCountersWire\(\s*frame\.daemon_counters\s*\)/);
    // 正準パーサは import されている (ローカル同名関数の影武者を防ぐ)。
    expect(src).toMatch(/parseDaemonCountersWire,?\n/);
  });

  it("reannounce: 有効 counters で上書き・省略では前回値を保持 (観測の silent 0 降格を防ぐ)", () => {
    const reg = new SidecarRegistry();
    const link = new FakeLink();
    reg.add(link);
    reg.handleHello(link, {
      type: "hello",
      control_token: "c",
      session_ids: [],
      daemon_counters: { unstableRequestIdCount: 4 },
    });
    expect(reg.agentReadiness().counters.unstableRequestIdCount).toBe(4);

    // 増分が届く (延べ数は daemon 側が権威・hello ごとに最新化)。
    reg.handleHello(link, {
      type: "hello",
      control_token: "c",
      session_ids: [],
      daemon_counters: { unstableRequestIdCount: 6 },
    });
    expect(reg.agentReadiness().counters.unstableRequestIdCount).toBe(6);

    // field 省略の reannounce → 前回の有効値を保持 (0 へ落とさない)。
    reg.handleHello(link, { type: "hello", control_token: "c", session_ids: [] });
    expect(reg.agentReadiness().counters.unstableRequestIdCount).toBe(6);
  });
});
