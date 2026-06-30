/**
 * INV-POLICY-PER-REPO (ADR 019f0eca・decision 019f0ecd): bypass/YOLO 承認ポリシーの **per-repo overlay** の
 * 操作ごと (per-operation) 解決と fail-safe を gate 挙動で固定する。
 *
 * 核心の不変条件 (falsifiable):
 *  - **tighten**: repo override は default が gate しない category を **追加** gate できる。
 *  - **loosen**: repo override は default が gate する category を **外せる** (full override・hard-floor 無し)。
 *  - **fail-safe**: cwd 解決不能 (非 git) は **default (厳格側)** へフォールバック (緩い側へ倒さない)。
 *  - **最適化**: repos が空なら resolveRepoScope を **呼ばない** (git を叩かない・従来挙動と同等)。
 *  - **env kill-switch は global**: policyEnvEnabled=false なら repo が緩めても/厳しくしても全 defer。
 *  - **per-operation**: 同一 bridge でも操作の cwd により effective policy が変わる (session 固定でない)。
 *
 * mutation 反証: 解決を default 固定に退行させると tighten/loosen/per-operation が RED。fail-safe を
 * 「解決不能→空 (全 defer)」に退行させると fail-safe テストが RED。
 */
import { describe, expect, it, vi } from "vitest";

import { PolicyCategory } from "@actradeck/event-model";

import { ApprovalBridge, type RepoScopeResolver } from "../src/approval-bridge.js";
import type { HookCommonInput } from "../src/normalize.js";

const SANDBOX_SCOPE = "aaaa0001";
const PROD_SCOPE = "bbbb0002";

/** cwd → repoScope のテスト用解決器 (git を叩かず決定論的に写像)。未知 cwd は undefined (=非 git)。 */
const RESOLVER: RepoScopeResolver = async (cwd) => {
  if (cwd === "/repo/sandbox") return { scope: SANDBOX_SCOPE, label: "sandbox" };
  if (cwd === "/repo/prod") return { scope: PROD_SCOPE, label: "prod" };
  return undefined;
};

/** bypassPermissions の rm -rf (recursive-rm category) を指定 cwd で。 */
function bypassRmRf(cwd?: string): HookCommonInput {
  return {
    session_id: "s1",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "rm -rf /tmp/x" },
    permission_mode: "bypassPermissions",
    ...(cwd !== undefined ? { cwd } : {}),
  };
}

async function gateBehavior(bridge: ApprovalBridge, input: HookCommonInput): Promise<string> {
  const emit = vi.fn();
  const r = await bridge.requestApproval(input, emit);
  return r.behavior;
}

const cats = (...c: PolicyCategory[]): Set<PolicyCategory> => new Set(c);

describe("INV-POLICY-PER-REPO: 操作ごと repo 解決と fail-safe", () => {
  it("tighten: repo override は default が gate しない category を追加 gate する", async () => {
    // default は何も gate しない / sandbox repo のみ recursive-rm を gate する。
    const bridge = new ApprovalBridge({
      timeoutMs: 20,
      policy: { enabled: true, categories: cats() },
      policyRepos: new Map([[SANDBOX_SCOPE, { enabled: true, categories: cats("recursive-rm") }]]),
      resolveRepoScope: RESOLVER,
    });
    // sandbox repo の rm -rf → repo が gate → deny。
    expect(await gateBehavior(bridge, bypassRmRf("/repo/sandbox"))).toBe("deny");
    // override 無い cwd → default (gate なし) → defer。
    expect(await gateBehavior(bridge, bypassRmRf("/repo/other"))).toBe("defer");
  });

  it("loosen: repo override は default が gate する category を外せる (full override・hard-floor 無し)", async () => {
    // default は recursive-rm を gate / prod repo は何も gate しない (空 override = 緩和)。
    const bridge = new ApprovalBridge({
      timeoutMs: 20,
      policy: { enabled: true, categories: cats("recursive-rm") },
      policyRepos: new Map([[PROD_SCOPE, { enabled: true, categories: cats() }]]),
      resolveRepoScope: RESOLVER,
    });
    // prod repo の rm -rf → repo が緩めた → defer (gate しない)。
    expect(await gateBehavior(bridge, bypassRmRf("/repo/prod"))).toBe("defer");
    // override 無い cwd → default が gate → deny。
    expect(await gateBehavior(bridge, bypassRmRf("/repo/other"))).toBe("deny");
  });

  it("fail-safe: cwd 解決不能 (非 git) は default (厳格側) へフォールバックする", async () => {
    const bridge = new ApprovalBridge({
      timeoutMs: 20,
      policy: { enabled: true, categories: cats("recursive-rm") },
      policyRepos: new Map([[PROD_SCOPE, { enabled: true, categories: cats() }]]), // prod は緩和
      resolveRepoScope: RESOLVER,
    });
    // cwd 未指定 → resolver は undefined を返す → default (recursive-rm gate) → deny。
    expect(await gateBehavior(bridge, bypassRmRf())).toBe("deny");
    // 未知 cwd も同様に default。
    expect(await gateBehavior(bridge, bypassRmRf("/not/a/repo"))).toBe("deny");
  });

  it("最適化: repos が空なら resolveRepoScope を呼ばず default を使う (git を叩かない)", async () => {
    const spy = vi.fn(RESOLVER);
    const bridge = new ApprovalBridge({
      timeoutMs: 20,
      policy: { enabled: true, categories: cats("recursive-rm") },
      policyRepos: new Map(), // 空。
      resolveRepoScope: spy,
    });
    expect(await gateBehavior(bridge, bypassRmRf("/repo/sandbox"))).toBe("deny"); // default が gate。
    expect(spy).not.toHaveBeenCalled(); // repos 空ゆえ解決しない。
  });

  it("env kill-switch は global: policyEnvEnabled=false なら repo override に関わらず全 defer", async () => {
    const bridge = new ApprovalBridge({
      timeoutMs: 20,
      policy: { enabled: true, categories: cats("recursive-rm") },
      policyRepos: new Map([[SANDBOX_SCOPE, { enabled: true, categories: cats("recursive-rm") }]]),
      resolveRepoScope: RESOLVER,
      policyEnvEnabled: false, // kill-switch OFF。
    });
    // repo が gate していても env OFF が勝つ → defer。
    expect(await gateBehavior(bridge, bypassRmRf("/repo/sandbox"))).toBe("defer");
    expect(await gateBehavior(bridge, bypassRmRf("/repo/other"))).toBe("defer");
  });

  it("repo enabled=false は当該 repo を全 defer にする (default は不変)", async () => {
    const bridge = new ApprovalBridge({
      timeoutMs: 20,
      policy: { enabled: true, categories: cats("recursive-rm") },
      policyRepos: new Map([
        [PROD_SCOPE, { enabled: false, categories: cats("recursive-rm") }], // この repo はゲート無効
      ]),
      resolveRepoScope: RESOLVER,
    });
    expect(await gateBehavior(bridge, bypassRmRf("/repo/prod"))).toBe("defer"); // repo OFF。
    expect(await gateBehavior(bridge, bypassRmRf("/repo/other"))).toBe("deny"); // default ON。
  });
});

describe("INV-POLICY-PER-REPO: set/get/remove of per-repo (live + view)", () => {
  it("setPolicyConfig(repoScope) は当該 repo を override し live gate に即反映 (空も honor=緩和)", async () => {
    const bridge = new ApprovalBridge({
      timeoutMs: 20,
      policy: { enabled: true, categories: cats("recursive-rm") },
      resolveRepoScope: RESOLVER,
    });
    // 初期: prod も default 継承で deny。
    expect(await gateBehavior(bridge, bypassRmRf("/repo/prod"))).toBe("deny");
    // prod を空 override (緩和)。
    const v = bridge.setPolicyConfig({
      repoScope: PROD_SCOPE,
      repoLabel: "prod",
      categories: cats(),
    });
    expect(v.isOverride).toBe(true);
    expect(v.repoScope).toBe(PROD_SCOPE);
    expect(v.categories.size).toBe(0); // repo は空を honor (default の DEFAULT 縮退を適用しない)。
    // live: prod は defer / 他は default で deny。
    expect(await gateBehavior(bridge, bypassRmRf("/repo/prod"))).toBe("defer");
    expect(await gateBehavior(bridge, bypassRmRf("/repo/other"))).toBe("deny");
  });

  it("getPolicyConfig(scope): override は isOverride=true・未 override は default 継承で isOverride=false", () => {
    const bridge = new ApprovalBridge({
      policy: { enabled: true, categories: cats("recursive-rm") },
      policyRepos: new Map([
        [SANDBOX_SCOPE, { label: "sandbox", enabled: true, categories: cats("db-drop") }],
      ]),
      resolveRepoScope: RESOLVER,
    });
    const ov = bridge.getPolicyConfig(SANDBOX_SCOPE);
    expect(ov.isOverride).toBe(true);
    expect(ov.repoLabel).toBe("sandbox");
    expect([...ov.categories]).toEqual(["db-drop"]);

    const inh = bridge.getPolicyConfig(PROD_SCOPE); // override 無し。
    expect(inh.isOverride).toBe(false);
    expect([...inh.categories]).toEqual(["recursive-rm"]); // default 継承。
  });

  it("removePolicyRepo は override を消して default 継承へ戻す (live + view)", async () => {
    const bridge = new ApprovalBridge({
      timeoutMs: 20,
      policy: { enabled: true, categories: cats("recursive-rm") },
      policyRepos: new Map([[PROD_SCOPE, { enabled: true, categories: cats() }]]), // prod 緩和。
      resolveRepoScope: RESOLVER,
    });
    expect(await gateBehavior(bridge, bypassRmRf("/repo/prod"))).toBe("defer"); // 緩和中。
    const v = bridge.removePolicyRepo(PROD_SCOPE);
    expect(v.isOverride).toBe(false); // default 継承へ。
    expect(await gateBehavior(bridge, bypassRmRf("/repo/prod"))).toBe("deny"); // default で gate。
  });

  it("listPolicyRepos は override 一覧を label 安定順で返す", () => {
    const bridge = new ApprovalBridge({
      policy: { enabled: true, categories: cats("recursive-rm") },
      policyRepos: new Map([
        [PROD_SCOPE, { label: "prod", enabled: true, categories: cats("recursive-rm") }],
        [SANDBOX_SCOPE, { label: "alpha", enabled: true, categories: cats() }],
      ]),
    });
    const list = bridge.listPolicyRepos();
    expect(list.map((e) => e.label)).toEqual(["alpha", "prod"]); // label 昇順。
    expect(list.map((e) => e.scope)).toEqual([SANDBOX_SCOPE, PROD_SCOPE]);
  });
});
