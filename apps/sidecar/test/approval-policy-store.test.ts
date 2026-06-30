/**
 * approval-policy-store (ADR 019f0c3e / 019f0eca): policy.json の read + env kill-switch 解決を検証する。
 * fail-safe (無し/壊れ/空 → 既定プリセット) と kill-switch (env OFF) が安全側であること、および
 * **per-repo overlay (v2)** の load/save/migration を固定する。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_GATED_CATEGORIES, type PolicyCategory } from "@actradeck/event-model";

import type { LayeredApprovalPolicy, RepoPolicyEntry } from "../src/approval-bridge.js";
import {
  buildBridgePolicyOptions,
  isBypassCatastrophicGateEnabled,
  loadApprovalPolicy,
  saveApprovalPolicy,
} from "../src/approval-policy-store.js";

let dir = "";
const policyPath = (): string => join(dir, "policy.json");
function writePolicy(obj: unknown): void {
  writeFileSync(policyPath(), JSON.stringify(obj), "utf8");
}
/** flat default-only な LayeredApprovalPolicy を組むテストヘルパ。 */
function layered(
  def: { enabled: boolean; categories: PolicyCategory[] },
  repos: Record<string, RepoPolicyEntry> = {},
): LayeredApprovalPolicy {
  return {
    default: { enabled: def.enabled, categories: new Set(def.categories) },
    repos: new Map(Object.entries(repos)),
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ad-policy-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadApprovalPolicy: default fail-safe 既定", () => {
  it("ファイル無し → enabled + 既定プリセット (out-of-box 安全) / repos 空", () => {
    const p = loadApprovalPolicy(policyPath());
    expect(p.default.enabled).toBe(true);
    expect([...p.default.categories].sort()).toEqual([...DEFAULT_GATED_CATEGORIES].sort());
    expect(p.repos.size).toBe(0);
  });

  it("categories 空 → 既定プリセットへ fail-safe (silent に全 OFF にしない)", () => {
    writePolicy({ version: 2, default: { enabled: true, categories: [] }, repos: {} });
    const p = loadApprovalPolicy(policyPath());
    expect(p.default.categories.size).toBe(DEFAULT_GATED_CATEGORIES.length);
  });

  it("categories が配列でない (壊れ) → 既定プリセット", () => {
    writePolicy({ version: 2, default: { enabled: true, categories: "nope" }, repos: {} });
    expect(loadApprovalPolicy(policyPath()).default.categories.size).toBe(
      DEFAULT_GATED_CATEGORIES.length,
    );
  });

  it("未知 category は捨てる (T1 enum allowlist)", () => {
    writePolicy({
      version: 2,
      default: { enabled: true, categories: ["recursive-rm", "bogus", "disk-destroy"] },
      repos: {},
    });
    const p = loadApprovalPolicy(policyPath());
    expect([...p.default.categories].sort()).toEqual(["disk-destroy", "recursive-rm"]);
  });

  it("enabled: false を尊重 (明示 OFF のみ)", () => {
    writePolicy({
      version: 2,
      default: { enabled: false, categories: ["recursive-rm"] },
      repos: {},
    });
    expect(loadApprovalPolicy(policyPath()).default.enabled).toBe(false);
  });

  it("有効な categories を採る", () => {
    writePolicy({
      version: 2,
      default: { enabled: true, categories: ["recursive-rm", "secret-egress"] },
      repos: {},
    });
    const p = loadApprovalPolicy(policyPath());
    expect([...p.default.categories].sort()).toEqual(["recursive-rm", "secret-egress"]);
  });
});

describe("loadApprovalPolicy: v1→v2 migration (ADR 019f0eca・後方互換)", () => {
  it("v1 flat {enabled, categories} を default として移行・repos 空", () => {
    // 旧 v1 形式 (top-level enabled/categories・default/repos キー無し)。
    writePolicy({ version: 1, enabled: true, categories: ["recursive-rm", "db-drop"] });
    const p = loadApprovalPolicy(policyPath());
    expect(p.default.enabled).toBe(true);
    expect([...p.default.categories].sort()).toEqual(["db-drop", "recursive-rm"]);
    expect(p.repos.size).toBe(0);
  });

  it("v1 flat の空 categories も default fail-safe で DEFAULT へ縮退", () => {
    writePolicy({ version: 1, enabled: true, categories: [] });
    expect(loadApprovalPolicy(policyPath()).default.categories.size).toBe(
      DEFAULT_GATED_CATEGORIES.length,
    );
  });
});

describe("loadApprovalPolicy: per-repo overlay (v2・ADR 019f0eca)", () => {
  it("repo エントリを repoScope でキーして読む (label 込み)", () => {
    writePolicy({
      version: 2,
      default: { enabled: true, categories: ["recursive-rm"] },
      repos: {
        deadbeef0001: { label: "sandbox", enabled: true, categories: ["disk-destroy"] },
      },
    });
    const p = loadApprovalPolicy(policyPath());
    const e = p.repos.get("deadbeef0001");
    expect(e).toBeDefined();
    expect(e?.label).toBe("sandbox");
    expect([...(e?.categories ?? [])]).toEqual(["disk-destroy"]);
  });

  it("SEC-R2-1: 手編集 policy.json の raw label は load 時に sanitize される (basename へ畳む)", () => {
    // 手編集で絶対パス + 制御文字を label に注入したケース (control channel を経ない経路)。
    writePolicy({
      version: 2,
      default: { enabled: true, categories: ["recursive-rm"] },
      repos: {
        deadbeef0001: {
          label: "/home/secret/.ssh",
          enabled: true,
          categories: ["disk-destroy"],
        },
      },
    });
    const e = loadApprovalPolicy(policyPath()).repos.get("deadbeef0001");
    // load 時に basename へ畳む → 絶対パスは at-rest memory/UI へ raw で載らない (relay set と二重防御)。
    expect(e?.label).toBe(".ssh");
  });

  it("repo エントリは空 categories を許容する (full override・default の DEFAULT 縮退を適用しない)", () => {
    writePolicy({
      version: 2,
      default: { enabled: true, categories: ["recursive-rm"] },
      repos: { cafef00d0002: { enabled: true, categories: [] } },
    });
    const e = loadApprovalPolicy(policyPath()).repos.get("cafef00d0002");
    expect(e).toBeDefined();
    expect(e?.categories.size).toBe(0); // この repo は何も gate しない (正当・decision 019f0ecd)
  });

  it("repo キーが repo_scope 形式でない (絶対パス等) は構造的に drop", () => {
    writePolicy({
      version: 2,
      default: { enabled: true, categories: ["recursive-rm"] },
      repos: {
        "/home/user/secret-repo": { enabled: true, categories: ["disk-destroy"] },
        "NOT-HEX!!": { enabled: true, categories: ["db-drop"] },
        beef0003: { enabled: true, categories: ["fork-bomb"] },
      },
    });
    const p = loadApprovalPolicy(policyPath());
    expect(p.repos.size).toBe(1); // hex key のみ採用 (絶対パス/非 hex は drop)
    expect(p.repos.has("beef0003")).toBe(true);
  });

  it("categories が配列でない malformed repo エントリは drop (default 継承)", () => {
    writePolicy({
      version: 2,
      default: { enabled: true, categories: ["recursive-rm"] },
      repos: { beef0004: { enabled: false } }, // categories 欠落 → drop
    });
    expect(loadApprovalPolicy(policyPath()).repos.has("beef0004")).toBe(false);
  });

  it("未知 category は repo エントリでも捨てる (closed enum)", () => {
    writePolicy({
      version: 2,
      default: { enabled: true, categories: ["recursive-rm"] },
      repos: { beef0005: { enabled: true, categories: ["disk-destroy", "bogus"] } },
    });
    expect([...(loadApprovalPolicy(policyPath()).repos.get("beef0005")?.categories ?? [])]).toEqual(
      ["disk-destroy"],
    );
  });
});

describe("saveApprovalPolicy: 永続側 (Phase 2 / ADR 019f0eca)", () => {
  it("save → load で default の enabled/categories が roundtrip する", () => {
    const cats: PolicyCategory[] = ["recursive-rm", "secret-egress", "disk-destroy"];
    saveApprovalPolicy(layered({ enabled: true, categories: cats }), policyPath());
    const loaded = loadApprovalPolicy(policyPath());
    expect(loaded.default.enabled).toBe(true);
    expect([...loaded.default.categories].sort()).toEqual([...cats].sort());
  });

  it("per-repo エントリも roundtrip する (label/enabled/categories)", () => {
    const policy = layered(
      { enabled: true, categories: ["recursive-rm"] },
      {
        abc0006: { label: "myrepo", enabled: false, categories: new Set(["db-drop", "fork-bomb"]) },
      },
    );
    saveApprovalPolicy(policy, policyPath());
    const e = loadApprovalPolicy(policyPath()).repos.get("abc0006");
    expect(e?.label).toBe("myrepo");
    expect(e?.enabled).toBe(false);
    expect([...(e?.categories ?? [])].sort()).toEqual(["db-drop", "fork-bomb"]);
  });

  it("version 2 + default + repos の shape で書く", () => {
    saveApprovalPolicy(
      layered(
        { enabled: true, categories: ["recursive-rm"] },
        {
          abc0007: { enabled: true, categories: new Set(["disk-destroy"]) },
        },
      ),
      policyPath(),
    );
    const raw = JSON.parse(readFileSync(policyPath(), "utf8")) as {
      version: number;
      default: { enabled: boolean; categories: string[] };
      repos: Record<string, { categories: string[] }>;
    };
    expect(raw.version).toBe(2);
    expect(raw.default.categories).toEqual(["recursive-rm"]);
    expect(raw.repos.abc0007.categories).toEqual(["disk-destroy"]);
  });

  it("categories は T1 enum (PolicyCategory.options) の安定順で書く (Set 挿入順非依存・diff 安定)", () => {
    saveApprovalPolicy(
      layered({ enabled: true, categories: ["secret-egress", "recursive-rm"] }),
      policyPath(),
    );
    const raw = JSON.parse(readFileSync(policyPath(), "utf8")) as {
      default: { categories: string[] };
    };
    expect(raw.default.categories.indexOf("recursive-rm")).toBeLessThan(
      raw.default.categories.indexOf("secret-egress"),
    );
  });

  it("file-level enabled=false を永続する (env kill-switch は載せない・version=2)", () => {
    saveApprovalPolicy(layered({ enabled: false, categories: ["recursive-rm"] }), policyPath());
    const raw = JSON.parse(readFileSync(policyPath(), "utf8")) as {
      default: { enabled: boolean };
      version: number;
    };
    expect(raw.default.enabled).toBe(false);
    expect(raw.version).toBe(2);
    expect(loadApprovalPolicy(policyPath()).default.enabled).toBe(false);
  });

  it("空 default categories を書いても load は fail-safe で既定プリセットへ縮退する (silent 全 OFF にしない)", () => {
    saveApprovalPolicy(layered({ enabled: true, categories: [] }), policyPath());
    const raw = JSON.parse(readFileSync(policyPath(), "utf8")) as {
      default: { categories: string[] };
    };
    expect(raw.default.categories).toEqual([]); // 書込は空をそのまま (operator 意図を歪めない)
    expect(loadApprovalPolicy(policyPath()).default.categories.size).toBe(
      DEFAULT_GATED_CATEGORIES.length,
    );
  });
});

describe("isBypassCatastrophicGateEnabled: kill-switch (既定 ON)", () => {
  it("未設定 → ON", () => {
    expect(isBypassCatastrophicGateEnabled({})).toBe(true);
  });
  it.each(["0", "false"])("'%s' → OFF", (v) => {
    expect(isBypassCatastrophicGateEnabled({ ACTRADECK_BYPASS_CATASTROPHIC_GATE: v })).toBe(false);
  });
  it.each(["1", "true", "yes"])("'%s' → ON", (v) => {
    expect(isBypassCatastrophicGateEnabled({ ACTRADECK_BYPASS_CATASTROPHIC_GATE: v })).toBe(true);
  });
});

describe("buildBridgePolicyOptions: default/repos/resolver と env を分離して bridge へ渡す (ADR 019f0eca)", () => {
  it("file enabled + env ON → policy(default).enabled=true / policyEnvEnabled=true / resolver あり", () => {
    writePolicy({
      version: 2,
      default: { enabled: true, categories: ["recursive-rm"] },
      repos: {},
    });
    const o = buildBridgePolicyOptions({ env: {}, path: policyPath() });
    expect(o.policy.enabled).toBe(true);
    expect(o.policy.categories.has("recursive-rm")).toBe(true);
    expect(o.policyEnvEnabled).toBe(true);
    expect(typeof o.resolveRepoScope).toBe("function");
    expect(o.policyRepos.size).toBe(0);
  });

  it("repos も bridge へ渡す (per-repo overlay 配線)", () => {
    writePolicy({
      version: 2,
      default: { enabled: true, categories: ["recursive-rm"] },
      repos: { beef0008: { enabled: true, categories: ["disk-destroy"] } },
    });
    const o = buildBridgePolicyOptions({ env: {}, path: policyPath() });
    expect(o.policyRepos.get("beef0008")?.categories.has("disk-destroy")).toBe(true);
  });

  it("file enabled + env kill-switch(0) → policy.enabled は file-level のまま true・policyEnvEnabled=false", () => {
    writePolicy({
      version: 2,
      default: { enabled: true, categories: ["recursive-rm"] },
      repos: {},
    });
    const o = buildBridgePolicyOptions({
      env: { ACTRADECK_BYPASS_CATASTROPHIC_GATE: "0" },
      path: policyPath(),
    });
    expect(o.policy.enabled).toBe(true);
    expect(o.policyEnvEnabled).toBe(false);
  });

  it("persistPolicy(set-default) は path 束縛され disk へ RMW 永続する (load で roundtrip)", () => {
    const o = buildBridgePolicyOptions({ env: {}, path: policyPath() });
    o.persistPolicy({
      kind: "set-default",
      config: { enabled: false, categories: new Set<PolicyCategory>(["secret-egress"]) },
    });
    const loaded = loadApprovalPolicy(policyPath());
    expect(loaded.default.enabled).toBe(false);
    expect([...loaded.default.categories]).toEqual(["secret-egress"]);
  });

  it("TDA-R1: delta persist は disk の他 repo override を保全する (stale owner が clobber しない)", () => {
    // daemon A が repo aaaa の override を disk へ書く。
    const oA = buildBridgePolicyOptions({ env: {}, path: policyPath() });
    oA.persistPolicy({
      kind: "set-repo",
      scope: "aaaa0001",
      entry: { enabled: true, categories: new Set<PolicyCategory>(["recursive-rm"]), label: "a" },
    });
    // 別 daemon B (= 別インスタンス・aaaa を memory に持たない=stale owner) が repo bbbb を set。
    // 旧実装 (currentLayered の full overwrite) なら B の write で aaaa が disk から消えていた。
    const oB = buildBridgePolicyOptions({ env: {}, path: policyPath() });
    oB.persistPolicy({
      kind: "set-repo",
      scope: "bbbb0002",
      entry: { enabled: true, categories: new Set<PolicyCategory>(["db-drop"]), label: "b" },
    });
    const loaded = loadApprovalPolicy(policyPath());
    // delta RMW ゆえ aaaa は保全され bbbb も追加される (multi-writer disk-completeness)。
    expect(loaded.repos.has("aaaa0001")).toBe(true);
    expect(loaded.repos.has("bbbb0002")).toBe(true);
    // unset bbbb は bbbb のみ除去し aaaa を残す (remove も delta)。
    oB.persistPolicy({ kind: "remove-repo", scope: "bbbb0002" });
    const after = loadApprovalPolicy(policyPath());
    expect(after.repos.has("aaaa0001")).toBe(true);
    expect(after.repos.has("bbbb0002")).toBe(false);
  });

  it("QA-R3-1: set-default delta は disk の既存 repo override を保全する (TDA-R1 対称・default 変更で gate を黙殺しない)", () => {
    // daemon A が repo aaaa の override を disk へ書く。
    const oA = buildBridgePolicyOptions({ env: {}, path: policyPath() });
    oA.persistPolicy({
      kind: "set-repo",
      scope: "aaaa0001",
      entry: { enabled: true, categories: new Set<PolicyCategory>(["recursive-rm"]), label: "a" },
    });
    // 別インスタンス (stale base) が default を変更する set-default delta を撃つ。旧 full-overwrite なら
    // default 変更で aaaa が disk から消えた (operator が default を変える度に全 per-repo gate が黙って
    // 消える silent security-control downgrade)。
    const oB = buildBridgePolicyOptions({ env: {}, path: policyPath() });
    oB.persistPolicy({
      kind: "set-default",
      config: { enabled: false, categories: new Set<PolicyCategory>(["secret-egress"]) },
    });
    const loaded = loadApprovalPolicy(policyPath());
    // applyPolicyDelta の set-default 分岐 `new Map(disk.repos)` を `new Map()` に変異させたら aaaa が落ちて RED。
    expect(loaded.repos.has("aaaa0001")).toBe(true);
    expect(loaded.repos.get("aaaa0001")?.categories.has("recursive-rm")).toBe(true);
    // 新 default も反映される (set-default が no-op でないこと)。
    expect(loaded.default.enabled).toBe(false);
    expect([...loaded.default.categories]).toEqual(["secret-egress"]);
  });
});
