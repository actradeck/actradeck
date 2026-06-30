/**
 * ADR 019f0c3e Phase 2: policy relay (sidecar 側) の INV。
 *  - ApprovalBridge.getPolicyConfig / setPolicyConfig: memory 権威更新 + persistPolicy(delta) 永続 + env-AND live 導出。
 *  - buildPolicyResponse: policy.request → policy.response の closed-enum NO-RAW 変換 (単一出所)。
 *
 * 固定する不変条件 (falsifiable・mutation で RED):
 *  - INV-POLICY-SET-LIVE: setPolicyConfig 後に live gate (requestApproval) が新カテゴリで即ゲートする。
 *  - INV-POLICY-SET-PERSIST: setPolicyConfig は persistPolicy へ単一 delta を渡す (TDA-R1・env 非永続)。
 *  - INV-POLICY-ENV-AND: policyEnvEnabled=false なら file.enabled=true でも live は defer (kill-switch 勝つ)。
 *    getPolicyConfig は file-level enabled=true / envGateEnabled=false を正直に返す。
 *  - INV-POLICY-EMPTY-FAILSAFE: 空 categories の set は live/persist とも DEFAULT へ縮退 (silent 全 OFF 禁止)。
 *  - INV-POLICY-NO-RAW: buildPolicyResponse は wire の未知/raw を sanitize で落とし closed enum のみ返す。
 *  - op fail-safe: 未知 op / get は変更しない。request_id 不正は undefined (黙殺)。
 */
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_GATED_CATEGORIES, PolicyCategory } from "@actradeck/event-model";

import { ApprovalBridge, type PolicyDelta } from "../src/approval-bridge.js";
import type { HookCommonInput } from "../src/normalize.js";
import { buildPolicyResponse } from "../src/policy-relay.js";

function bypassRmRf(): HookCommonInput {
  return {
    session_id: "s1",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "rm -rf /tmp/x" },
    permission_mode: "bypassPermissions",
  };
}

/** live gate がこの input をゲート (emit + deny) するか defer するかを返す。 */
async function gateBehavior(bridge: ApprovalBridge, input: HookCommonInput): Promise<string> {
  const emit = vi.fn();
  const r = await bridge.requestApproval(input, emit);
  return r.behavior;
}

describe("ApprovalBridge getPolicyConfig / setPolicyConfig (ADR 019f0c3e Phase 2)", () => {
  it("getPolicyConfig は file-level enabled + categories + envGateEnabled を返す", () => {
    const bridge = new ApprovalBridge({
      policy: { enabled: true, categories: new Set<PolicyCategory>(["recursive-rm"]) },
    });
    const v = bridge.getPolicyConfig();
    expect(v.enabled).toBe(true);
    expect([...v.categories]).toEqual(["recursive-rm"]);
    expect(v.envGateEnabled).toBe(true); // env 既定 ON。
  });

  it("policy 未設定なら getPolicyConfig は enabled=false / 空 (bypass 全 defer を表す)", () => {
    const v = new ApprovalBridge().getPolicyConfig();
    expect(v.enabled).toBe(false);
    expect(v.categories.size).toBe(0);
  });

  it("INV-POLICY-SET-LIVE: setPolicyConfig(categories) 後に live gate が新カテゴリで即ゲートする", async () => {
    const bridge = new ApprovalBridge({
      timeoutMs: 20,
      policy: { enabled: true, categories: new Set<PolicyCategory>(["disk-destroy"]) },
    });
    // 初期は recursive-rm 非対象 → bypass rm -rf は defer。
    expect(await gateBehavior(bridge, bypassRmRf())).toBe("defer");
    // recursive-rm を追加 set。
    bridge.setPolicyConfig({ categories: new Set<PolicyCategory>(["recursive-rm"]) });
    expect(await gateBehavior(bridge, bypassRmRf())).toBe("deny"); // 即ゲート (emit + timeout deny)。
  });

  it("INV-POLICY-SET-LIVE: enabled の partial update が live を切り替える (categories 維持)", async () => {
    const bridge = new ApprovalBridge({
      timeoutMs: 20,
      policy: { enabled: true, categories: new Set<PolicyCategory>(["recursive-rm"]) },
    });
    expect(await gateBehavior(bridge, bypassRmRf())).toBe("deny");
    bridge.setPolicyConfig({ enabled: false }); // categories は未指定=維持。
    expect(await gateBehavior(bridge, bypassRmRf())).toBe("defer"); // 無効化で純パススルー。
    expect([...bridge.getPolicyConfig().categories]).toEqual(["recursive-rm"]); // categories は保持。
  });

  it("INV-POLICY-SET-PERSIST: setPolicyConfig(default) は persistPolicy へ set-default delta を渡す (TDA-R1)", () => {
    const deltas: PolicyDelta[] = [];
    const bridge = new ApprovalBridge({
      policy: { enabled: true, categories: new Set<PolicyCategory>(["recursive-rm"]) },
      persistPolicy: (d) => deltas.push(d),
    });
    bridge.setPolicyConfig({
      enabled: false,
      categories: new Set<PolicyCategory>(["disk-destroy", "db-drop"]),
    });
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.kind).toBe("set-default"); // full layered でなく単一 delta (TDA-R1)。
    if (deltas[0]!.kind === "set-default") {
      expect(deltas[0]!.config.enabled).toBe(false); // file-level (default) enabled を渡す。
      expect([...deltas[0]!.config.categories].sort()).toEqual(["db-drop", "disk-destroy"]);
    }
  });

  it("INV-POLICY-FANOUT-MEMORY-ONLY (TDA-1): persist:false の set は memory を更新するが persistPolicy を呼ばない", () => {
    // multi-daemon fan-out の受信側挙動。disk を書かないことで、再接続後の stale daemon が disk を書戻して
    // 厳格 override を黙って消す silent downgrade を防ぐ (authoritative な disk 書込は owner 一点・delta RMW)。
    const deltas: PolicyDelta[] = [];
    const bridge = new ApprovalBridge({
      timeoutMs: 20,
      policy: { enabled: true, categories: new Set<PolicyCategory>() }, // default は何も gate しない。
      persistPolicy: (d) => deltas.push(d),
    });
    // persist:false で repo override を tighten (recursive-rm を追加 gate)。
    const v = bridge.setPolicyConfig({
      repoScope: "abc123",
      categories: new Set<PolicyCategory>(["recursive-rm"]),
      persist: false,
    });
    expect(v.isOverride).toBe(true);
    expect([...v.categories]).toEqual(["recursive-rm"]); // memory (live view) は更新される。
    expect(deltas).toHaveLength(0); // だが disk は書かない (persist:false)。
    // 対照: persist 省略 (= owner) の set は当該 repo の set-repo delta を書く。
    bridge.setPolicyConfig({
      repoScope: "def456",
      categories: new Set<PolicyCategory>(["db-drop"]),
    });
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.kind).toBe("set-repo");
    if (deltas[0]!.kind === "set-repo") expect(deltas[0]!.scope).toBe("def456");
  });

  it("INV-POLICY-FANOUT-MEMORY-ONLY (TDA-1): persist:false の unset は memory のみ・persistPolicy を呼ばない", () => {
    const deltas: PolicyDelta[] = [];
    const bridge = new ApprovalBridge({
      policy: { enabled: true, categories: new Set<PolicyCategory>(["recursive-rm"]) },
      policyRepos: new Map([["abc123", { enabled: true, categories: new Set<PolicyCategory>() }]]),
      persistPolicy: (d) => deltas.push(d),
    });
    const v = bridge.removePolicyRepo("abc123", { persist: false });
    expect(v.isOverride).toBe(false); // memory: override 削除 → default 継承。
    expect(deltas).toHaveLength(0); // disk は書かない。
    // 対照: persist 省略の unset は remove-repo delta を書く。
    bridge.removePolicyRepo("abc123");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.kind).toBe("remove-repo");
    if (deltas[0]!.kind === "remove-repo") expect(deltas[0]!.scope).toBe("abc123");
  });

  it("INV-POLICY-FANOUT-MEMORY-ONLY (TDA-1): wire の persist:false が buildPolicyResponse 経由で disk 抑止に伝わる", async () => {
    const deltas: PolicyDelta[] = [];
    const bridge = new ApprovalBridge({
      policy: { enabled: true, categories: new Set<PolicyCategory>() },
      persistPolicy: (d) => deltas.push(d),
    });
    // 受信した fan-out コピー (persist:false) を relay 経由で適用。
    const res = await buildPolicyResponse(bridge, {
      type: "policy.request",
      request_id: "r1",
      op: "set",
      repo_scope: "abc123",
      categories: ["recursive-rm"],
      persist: false,
    });
    expect(res?.error).toBeUndefined();
    expect(deltas).toHaveLength(0); // disk へは書かない。
    expect([...bridge.getPolicyConfig("abc123").categories]).toEqual(["recursive-rm"]); // memory は反映。
  });

  it("INV-POLICY-ENV-AND: policyEnvEnabled=false は file.enabled=true でも live を defer にする", async () => {
    const bridge = new ApprovalBridge({
      timeoutMs: 20,
      policy: { enabled: true, categories: new Set<PolicyCategory>(["recursive-rm"]) },
      policyEnvEnabled: false, // env kill-switch OFF。
    });
    // live は kill-switch で全 defer (純パススルー)。
    expect(await gateBehavior(bridge, bypassRmRf())).toBe("defer");
    // だが getPolicyConfig は file-level を正直に返す (UI 表示用)。
    const v = bridge.getPolicyConfig();
    expect(v.enabled).toBe(true); // file-level は env で歪めない。
    expect(v.envGateEnabled).toBe(false); // kill-switch を開示。
  });

  it("INV-POLICY-ENV-AND: kill-switch 中の set も live は defer のまま (file-level のみ更新)", async () => {
    const bridge = new ApprovalBridge({
      timeoutMs: 20,
      policy: { enabled: true, categories: new Set<PolicyCategory>(["disk-destroy"]) },
      policyEnvEnabled: false,
    });
    bridge.setPolicyConfig({ categories: new Set<PolicyCategory>(["recursive-rm"]) });
    expect(await gateBehavior(bridge, bypassRmRf())).toBe("defer"); // env OFF が勝つ。
    expect([...bridge.getPolicyConfig().categories]).toEqual(["recursive-rm"]); // file-level は更新。
  });

  it("INV-POLICY-EMPTY-FAILSAFE: 空 categories の set は live/persist とも DEFAULT へ縮退する", async () => {
    const deltas: PolicyDelta[] = [];
    const bridge = new ApprovalBridge({
      timeoutMs: 20,
      policy: { enabled: true, categories: new Set<PolicyCategory>(["recursive-rm"]) },
      persistPolicy: (d) => deltas.push(d),
    });
    bridge.setPolicyConfig({ categories: new Set<PolicyCategory>() }); // 全 uncheck。
    // live: DEFAULT へ縮退 ゆえ recursive-rm は依然ゲート (silent 全 OFF にしない)。
    expect(await gateBehavior(bridge, bypassRmRf())).toBe("deny");
    // persist も DEFAULT (空をそのまま書かず安全側へ healing)。set-default delta の config で確認。
    expect(deltas[0]!.kind).toBe("set-default");
    if (deltas[0]!.kind === "set-default") {
      expect([...deltas[0]!.config.categories].sort()).toEqual(
        [...DEFAULT_GATED_CATEGORIES].sort(),
      );
    }
    // 表示も DEFAULT。
    expect(bridge.getPolicyConfig().categories.size).toBe(DEFAULT_GATED_CATEGORIES.length);
  });
});

describe("buildPolicyResponse (closed-enum NO-RAW 変換・単一出所)", () => {
  function bridgeWith(categories: PolicyCategory[]): ApprovalBridge {
    return new ApprovalBridge({
      policy: { enabled: true, categories: new Set(categories) },
    });
  }

  it("op=get は現状を closed enum 安定順で返す (変更しない)", async () => {
    const bridge = bridgeWith(["secret-egress", "recursive-rm"]);
    const res = await buildPolicyResponse(bridge, {
      type: "policy.request",
      request_id: "r1",
      op: "get",
    });
    expect(res).toBeDefined();
    expect(res!.type).toBe("policy.response");
    expect(res!.request_id).toBe("r1");
    expect(res!.enabled).toBe(true);
    // PolicyCategory.options 安定順 (recursive-rm が先)。
    expect(res!.categories).toEqual(["recursive-rm", "secret-egress"]);
    expect(res!.env_gate_enabled).toBe(true);
  });

  it("op=set は wire categories を sanitize し更新後の状態を返す", async () => {
    const bridge = bridgeWith(["recursive-rm"]);
    const res = await buildPolicyResponse(bridge, {
      type: "policy.request",
      request_id: "r2",
      op: "set",
      enabled: true,
      // 未知/非 string/raw を混ぜる (untrusted wire)。
      categories: ["disk-destroy", "rm -rf /", "bogus", "db-drop"] as unknown as readonly string[],
    });
    expect(res!.categories).toEqual(["disk-destroy", "db-drop"]); // 未知/raw は落ちる + enum 順。
    // bridge にも反映 (set は memory 権威更新)。
    expect([...bridge.getPolicyConfig().categories].sort()).toEqual(["db-drop", "disk-destroy"]);
  });

  it("INV-POLICY-NO-RAW: 応答全体に raw コマンド片が混ざらない", async () => {
    const bridge = bridgeWith(["recursive-rm"]);
    const res = await buildPolicyResponse(bridge, {
      type: "policy.request",
      request_id: "r3",
      op: "set",
      categories: ["secret-egress", "rm -rf / --secret=AKIA"] as unknown as readonly string[],
    });
    expect(JSON.stringify(res)).not.toContain("rm -rf");
    expect(JSON.stringify(res)).not.toContain("AKIA");
  });

  it("QA-3: relay 入口で全 unknown categories の set は DEFAULT へ縮退する (silent 全 OFF 不能)", async () => {
    // bridge 単体の empty-failsafe は別テストで固定済。ここは **relay 入口 (buildPolicyResponse)** から
    // sanitize→空→setPolicyConfig の合成で DEFAULT へ healing されることを pin する (敵対 sidecar/operator が
    // junk category だけ送って全 OFF にする経路を塞ぐ)。
    const bridge = bridgeWith(["recursive-rm"]);
    const res = await buildPolicyResponse(bridge, {
      type: "policy.request",
      request_id: "r-default",
      op: "set",
      categories: ["bogus", "rm -rf /", "totally-unknown"] as unknown as readonly string[],
    });
    const expected = PolicyCategory.options.filter((c) =>
      (DEFAULT_GATED_CATEGORIES as readonly string[]).includes(c),
    );
    expect(res!.categories).toEqual(expected); // DEFAULT (options 安定順)。
    expect([...bridge.getPolicyConfig().categories].sort()).toEqual(
      [...DEFAULT_GATED_CATEGORIES].sort(),
    );
  });

  it("未知 op (get でも set でもない) は変更しない (fail-safe で get 扱い)", async () => {
    const bridge = bridgeWith(["recursive-rm"]);
    const before = [...bridge.getPolicyConfig().categories];
    const res = await buildPolicyResponse(bridge, {
      type: "policy.request",
      request_id: "r4",
      op: "delete-everything",
      categories: ["disk-destroy"] as unknown as readonly string[],
    });
    expect(res!.categories).toEqual(before); // 変更されない。
    expect([...bridge.getPolicyConfig().categories]).toEqual(before);
  });

  it("request_id 不正は undefined (黙殺・allowlist handler と同型)", async () => {
    const bridge = bridgeWith(["recursive-rm"]);
    expect(
      await buildPolicyResponse(bridge, { type: "policy.request", op: "get" }),
    ).toBeUndefined();
    expect(
      await buildPolicyResponse(bridge, { type: "policy.request", request_id: "", op: "get" }),
    ).toBeUndefined();
  });
});

/**
 * SEC-1 (ADR 019f0c3e Phase 2 監査・decision 019f0d07): 認証済み policy set の disk 永続失敗で
 * daemon を crash させない。saveApprovalPolicy → writeJson0600 は ENOSPC/EACCES/RO-fs で同期 throw しうる。
 * setPolicyConfig の persistPolicy 呼出を try/catch で外すと、これらのテストは throw が素通しして RED になる
 * (falsifiable・mutation で赤)。memory (live gate) は throw 前に更新済みゆえ deny-safe で保持される。
 */
describe("SEC-1: policy set の disk 永続失敗で daemon を crash させない (decision 019f0d07)", () => {
  // 生 fs エラー (パス/secret 風文字列を含む) を投げる persistPolicy。固定文言で吸収されることを確認する。
  const throwingPersist = (): never => {
    throw new Error(
      "ENOSPC: no space left on device, write '/home/x/.actradeck/approvals/policy.json'",
    );
  };

  it("INV-POLICY-PERSIST-CRASH-SAFE: persistPolicy が throw しても setPolicyConfig は throw せず memory を保持する", () => {
    const bridge = new ApprovalBridge({
      policy: { enabled: true, categories: new Set<PolicyCategory>(["recursive-rm"]) },
      persistPolicy: throwingPersist,
    });
    // try/catch を外す mutation だとここで throw が素通しして RED。
    const v = bridge.setPolicyConfig({
      categories: new Set<PolicyCategory>(["disk-destroy", "db-drop"]),
    });
    // memory (live gate ソース) は更新済み。
    expect([...bridge.getPolicyConfig().categories].sort()).toEqual(["db-drop", "disk-destroy"]);
    // 失敗は persistError で伝える。生の fs エラー (パス/ENOSPC) は載せない (固定文言)。
    // QA-R2-2 (decision 019f0d22): 原文非依存の固定文言を完全一致で pin (別形状の生エラーを載せる mutation を捕捉)。
    expect(v.persistError).toBe("policy applied in memory but failed to persist to disk");
    expect(v.persistError).not.toContain("ENOSPC");
    expect(v.persistError).not.toContain(".actradeck");
  });

  it("persist 成功時は persistError を付けない (正常系で誤警告しない)", () => {
    const bridge = new ApprovalBridge({
      policy: { enabled: true, categories: new Set<PolicyCategory>(["recursive-rm"]) },
      persistPolicy: () => {}, // 成功。
    });
    const v = bridge.setPolicyConfig({ categories: new Set<PolicyCategory>(["disk-destroy"]) });
    expect(v.persistError).toBeUndefined();
  });

  // L2(a) (decision 019f0e5d): safePersist が吸収した失敗は persistFailureCount に計上し、
  // onPersistFailure(count) で operator へ **件数のみ** surface する (生 fs エラーは NO-RAW で非伝播)。
  // safePersist catch の `+= 1` / onPersistFailure 呼出を消す mutation で RED になる (falsifiable)。
  it("L2(a): persist 失敗で persistFailureCount が増え onPersistFailure(count) が呼ばれる (件数のみ surface)", () => {
    const surfaced: number[] = [];
    const bridge = new ApprovalBridge({
      policy: { enabled: true, categories: new Set<PolicyCategory>(["recursive-rm"]) },
      persistPolicy: throwingPersist,
      onPersistFailure: (count) => surfaced.push(count),
    });
    expect(bridge.persistFailureCount).toBe(0);
    bridge.setPolicyConfig({ categories: new Set<PolicyCategory>(["disk-destroy"]) });
    // `+= 1` を消す mutation だと 0 のまま RED。
    expect(bridge.persistFailureCount).toBe(1);
    // onPersistFailure 呼出を消す mutation だと surfaced 空で RED。件数 (非負整数) のみ surface される。
    expect(surfaced).toEqual([1]);
    // 2 回目の失敗で累計が増える (単調増加)。
    bridge.setPolicyConfig({ categories: new Set<PolicyCategory>(["db-drop"]) });
    expect(bridge.persistFailureCount).toBe(2);
    expect(surfaced).toEqual([1, 2]);
  });

  it("L2(a): persist 成功時は persistFailureCount を増やさず onPersistFailure を呼ばない", () => {
    const surfaced: number[] = [];
    const bridge = new ApprovalBridge({
      policy: { enabled: true, categories: new Set<PolicyCategory>(["recursive-rm"]) },
      persistPolicy: () => {}, // 成功。
      onPersistFailure: (count) => surfaced.push(count),
    });
    bridge.setPolicyConfig({ categories: new Set<PolicyCategory>(["disk-destroy"]) });
    expect(bridge.persistFailureCount).toBe(0);
    expect(surfaced).toEqual([]);
  });

  // SEC-1 (decision 019f0e7d): surface (onPersistFailure) 自身が throw しても safePersist は吸収し、
  // setPolicyConfig の primary 効果 (live gate=memory 更新) を保つ。catch 内の onPersistFailure を
  // try/catch で吸収する mutation を外すと、surface throw が setPolicyConfig を貫通 → RED。
  it("SEC-1: onPersistFailure が throw しても setPolicyConfig は throw せず live gate(memory)を保持する", () => {
    const bridge = new ApprovalBridge({
      policy: { enabled: true, categories: new Set<PolicyCategory>(["recursive-rm"]) },
      persistPolicy: throwingPersist, // disk 失敗。
      onPersistFailure: () => {
        throw new Error("stderr write boom (ENOSPC/EPIPE)"); // surface 自身も throw。
      },
    });
    let v: ReturnType<typeof bridge.setPolicyConfig> | undefined;
    expect(() => {
      v = bridge.setPolicyConfig({
        categories: new Set<PolicyCategory>(["disk-destroy", "db-drop"]),
      });
    }).not.toThrow();
    // primary 効果 (live gate=memory) は保持 (永続失敗 + surface throw でも memory 更新は確定)。
    expect([...bridge.getPolicyConfig().categories].sort()).toEqual(["db-drop", "disk-destroy"]);
    // 失敗計上は維持・persistError も正しく伝わる (応答は壊れない)。
    expect(bridge.persistFailureCount).toBe(1);
    expect(v?.persistError).toBe("policy applied in memory but failed to persist to disk");
  });

  it("persist 失敗でも live gate は新カテゴリで即ゲートする (deny-safe・memory 権威)", async () => {
    const bridge = new ApprovalBridge({
      timeoutMs: 20,
      policy: { enabled: true, categories: new Set<PolicyCategory>(["disk-destroy"]) },
      persistPolicy: throwingPersist,
    });
    expect(await gateBehavior(bridge, bypassRmRf())).toBe("defer"); // 初期 recursive-rm 非対象。
    bridge.setPolicyConfig({ categories: new Set<PolicyCategory>(["recursive-rm"]) }); // persist は失敗。
    expect(await gateBehavior(bridge, bypassRmRf())).toBe("deny"); // memory 更新済→即ゲート。
  });

  it("buildPolicyResponse(set) は persist 失敗を error へ載せ throw しない (固定文言・raw 非含)", async () => {
    const bridge = new ApprovalBridge({
      policy: { enabled: true, categories: new Set<PolicyCategory>(["recursive-rm"]) },
      persistPolicy: throwingPersist,
    });
    const res = await buildPolicyResponse(bridge, {
      type: "policy.request",
      request_id: "r-persist",
      op: "set",
      categories: ["disk-destroy"] as unknown as readonly string[],
    });
    expect(res).toBeDefined();
    expect(res!.error).toBeDefined();
    // 更新後の状態も載る (memory は権威更新済)。
    expect(res!.categories).toEqual(["disk-destroy"]);
    expect(res!.enabled).toBe(true);
    // 生の fs エラー (パス/ENOSPC) は載らない (SEC-2 と同方針)。
    expect(JSON.stringify(res)).not.toContain("ENOSPC");
    expect(JSON.stringify(res)).not.toContain(".actradeck");
  });
});

/**
 * ADR 019f0eca: buildPolicyResponse の per-repo wire (repo_scope + op get/set/unset/list)。
 * repo_scope 検証 (NO-RAW)・set/unset/list の往復・default 継承を relay 入口で固定する。
 */
describe("buildPolicyResponse: per-repo wire (ADR 019f0eca)", () => {
  const SCOPE = "abcdef012345"; // scopeHash 形式 (12 hex)

  it("op=set + repo_scope は repo override を作り is_override=true / repo_scope を返す", async () => {
    const bridge = new ApprovalBridge({
      policy: { enabled: true, categories: new Set<PolicyCategory>(["recursive-rm"]) },
    });
    const res = await buildPolicyResponse(bridge, {
      type: "policy.request",
      request_id: "r1",
      op: "set",
      repo_scope: SCOPE,
      repo_label: "sandbox",
      categories: ["disk-destroy"] as unknown as readonly string[],
    });
    expect(res!.repo_scope).toBe(SCOPE);
    expect(res!.is_override).toBe(true);
    expect(res!.repo_label).toBe("sandbox");
    expect(res!.categories).toEqual(["disk-destroy"]);
  });

  it("SEC-R2-1: relay set の repo_label は sidecar 側でも sanitize (control-token 直送の raw を遮断)", async () => {
    const bridge = new ApprovalBridge({
      policy: { enabled: true, categories: new Set<PolicyCategory>(["recursive-rm"]) },
    });
    // control-token 直送 (backend sanitize を経ない) で絶対パス + 制御文字を載せる。
    const res = await buildPolicyResponse(bridge, {
      type: "policy.request",
      request_id: "r-label",
      op: "set",
      repo_scope: SCOPE,
      repo_label: "/home/secret/.env\nLEAK",
      categories: ["disk-destroy"] as unknown as readonly string[],
    });
    // sidecar が basename へ畳み制御文字除去 → 絶対パス/改行は at-rest/UI へ載らない (二重防御)。
    expect(res!.repo_label).toBe(".envLEAK"); // basename + 制御文字除去 (改行のみ消える)。
    expect(String(res!.repo_label)).not.toContain("/");
    expect(String(res!.repo_label)).not.toContain("\n");
  });

  it("op=set + repo_scope + 空 categories は repo を緩和 (空 honor・default の DEFAULT 縮退を適用しない)", async () => {
    const bridge = new ApprovalBridge({
      policy: { enabled: true, categories: new Set<PolicyCategory>(["recursive-rm"]) },
    });
    const res = await buildPolicyResponse(bridge, {
      type: "policy.request",
      request_id: "r2",
      op: "set",
      repo_scope: SCOPE,
      categories: [] as unknown as readonly string[],
    });
    expect(res!.categories).toEqual([]); // 空を honor (full override)。
    expect(res!.is_override).toBe(true);
  });

  it("op=get + repo_scope (override 無し) は default 継承で is_override=false", async () => {
    const bridge = new ApprovalBridge({
      policy: { enabled: true, categories: new Set<PolicyCategory>(["recursive-rm"]) },
    });
    const res = await buildPolicyResponse(bridge, {
      type: "policy.request",
      request_id: "r3",
      op: "get",
      repo_scope: SCOPE,
    });
    expect(res!.is_override).toBe(false);
    expect(res!.categories).toEqual(["recursive-rm"]); // default 継承。
  });

  it("op=unset は repo override を削除し default 継承へ戻す", async () => {
    const bridge = new ApprovalBridge({
      policy: { enabled: true, categories: new Set<PolicyCategory>(["recursive-rm"]) },
      policyRepos: new Map([[SCOPE, { enabled: true, categories: new Set<PolicyCategory>() }]]),
    });
    const res = await buildPolicyResponse(bridge, {
      type: "policy.request",
      request_id: "r4",
      op: "unset",
      repo_scope: SCOPE,
    });
    expect(res!.is_override).toBe(false);
    expect(res!.categories).toEqual(["recursive-rm"]); // default へ戻った。
  });

  it("op=list は default + 全 repo override 一覧を返す", async () => {
    const bridge = new ApprovalBridge({
      policy: { enabled: true, categories: new Set<PolicyCategory>(["recursive-rm"]) },
      policyRepos: new Map([
        [
          SCOPE,
          { label: "sandbox", enabled: true, categories: new Set<PolicyCategory>(["db-drop"]) },
        ],
      ]),
    });
    const res = await buildPolicyResponse(bridge, {
      type: "policy.request",
      request_id: "r5",
      op: "list",
    });
    expect(res!.categories).toEqual(["recursive-rm"]); // default。
    expect(res!.repos).toHaveLength(1);
    expect(res!.repos![0]).toMatchObject({
      repo_scope: SCOPE,
      repo_label: "sandbox",
      categories: ["db-drop"],
    });
  });

  it("op=resolve は path を git root 解決し scope+label+effective を返す (方式B・変更しない)", async () => {
    // gate と同一 resolver を注入 (path→scope+label の決定論写像)。
    const bridge = new ApprovalBridge({
      policy: { enabled: true, categories: new Set<PolicyCategory>(["recursive-rm"]) },
      resolveRepoScope: async (cwd) =>
        cwd === "/home/me/sandbox" ? { scope: SCOPE, label: "sandbox" } : undefined,
    });
    const res = await buildPolicyResponse(bridge, {
      type: "policy.request",
      request_id: "r-res",
      op: "resolve",
      path: "/home/me/sandbox",
    });
    expect(res!.repo_scope).toBe(SCOPE);
    expect(res!.repo_label).toBe("sandbox"); // override 未存在でも resolver の basename を補う。
    expect(res!.is_override).toBe(false); // まだ override 無し (default 継承)。
    expect(res!.categories).toEqual(["recursive-rm"]); // default 継承。
    // 生 path は echo しない (NO-RAW)。
    expect(JSON.stringify(res)).not.toContain("/home/me/sandbox");
    // resolve は読取りのみ: repos は作られない。
    expect(bridge.listPolicyRepos()).toHaveLength(0);
  });

  it("op=resolve: git 管理外/解決不能/空 path は固定 error (生 path 非含)", async () => {
    const bridge = new ApprovalBridge({
      policy: { enabled: true, categories: new Set<PolicyCategory>(["recursive-rm"]) },
      resolveRepoScope: async () => undefined, // 常に解決不能。
    });
    const res = await buildPolicyResponse(bridge, {
      type: "policy.request",
      request_id: "r-res-bad",
      op: "resolve",
      path: "/not/a/repo",
    });
    expect(res!.error).toBe("path is not a resolvable git repository");
    expect(JSON.stringify(res)).not.toContain("/not/a/repo");
    // 空 path も同じ固定 error。
    const empty = await buildPolicyResponse(bridge, {
      type: "policy.request",
      request_id: "r-res-empty",
      op: "resolve",
      path: "",
    });
    expect(empty!.error).toBe("path is not a resolvable git repository");
  });

  it("不正な repo_scope (絶対パス/非 hex) は変更せず error 応答 (NO-RAW・多層検証)", async () => {
    const bridge = new ApprovalBridge({
      policy: { enabled: true, categories: new Set<PolicyCategory>(["recursive-rm"]) },
    });
    const res = await buildPolicyResponse(bridge, {
      type: "policy.request",
      request_id: "r6",
      op: "set",
      repo_scope: "/home/user/secret" as unknown as string,
      categories: [] as unknown as readonly string[],
    });
    expect(res!.error).toBe("invalid repo_scope");
    // default は変更されていない (絶対パスを repo key にしない)。
    expect(bridge.listPolicyRepos()).toHaveLength(0);
    expect([...bridge.getPolicyConfig().categories]).toEqual(["recursive-rm"]);
  });
});
