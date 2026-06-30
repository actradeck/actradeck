/**
 * INV-POLICY-RESOLVE-CONTAINMENT (SEC-1・decision 019f0f2f): resolve endpoint (方式B) の **二段封じ込め**を
 * 固定する。backend の入口 lexical gate (入力 path) は `git rev-parse --show-toplevel` が symlink を物理解決し
 * 祖先へ遡るため、解決済の git root が project-scope を抜けうる (symlink 脱出 / ancestor-root)。
 * `getPolicyConfigForPath(path, scope)` は解決済の **物理 root** を scope と再照合し、scope 外/上位を拒否する。
 *
 * 固定する不変条件 (falsifiable):
 *  - 物理 root が scope 配下 → view を返す。scope 外 (symlink 脱出) / scope の上位 (ancestor) → undefined。
 *  - scope 空 (backend default-off) → 封じ込め無し (root に関わらず view)。
 *  - 解決結果に root が無い + scope 非空 → 安全側で undefined (fail-safe)。
 * mutation 反証: getPolicyConfigForPath の `isPathWithinScope(resolved.root, scope)` ガードを消すと、
 *  scope 外/ancestor のケースが view を返して RED (real-tmpdir の symlink/ancestor 含む)。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PolicyCategory } from "@actradeck/event-model";

import { ApprovalBridge, type RepoScopeResolver } from "../src/approval-bridge.js";
import { makeRepoScopeResolver } from "../src/approval-persist-config.js";

const cats = (...c: PolicyCategory[]): Set<PolicyCategory> => new Set(c);

/** 物理 root を固定して返すテスト用 resolver (cwd 非依存・git を叩かない)。root 省略で「root 無し」を再現。 */
function resolverReturning(root: string | undefined): RepoScopeResolver {
  return async () => ({
    scope: "deadbeef0001",
    label: "repo",
    ...(root !== undefined ? { root } : {}),
  });
}

function bridgeWith(resolveRepoScope: RepoScopeResolver): ApprovalBridge {
  return new ApprovalBridge({
    policy: { enabled: true, categories: cats("recursive-rm") },
    resolveRepoScope,
  });
}

describe("INV-POLICY-RESOLVE-CONTAINMENT: 解決済 root の二段封じ込め (unit・mock resolver)", () => {
  it("物理 root が scope 配下 → view を返す", async () => {
    const bridge = bridgeWith(resolverReturning("/home/me/work/repo"));
    const view = await bridge.getPolicyConfigForPath("/home/me/work/repo/src", ["/home/me/work"]);
    expect(view).toBeDefined();
    expect(view?.repoLabel).toBe("repo");
  });

  it("symlink 脱出: 物理 root が scope 外 → undefined", async () => {
    // 入口 lexical は通る (入力 path は scope 内) が、解決済 root は scope 外 (= symlink 先) を模す。
    const bridge = bridgeWith(resolverReturning("/var/secret-repo"));
    const view = await bridge.getPolicyConfigForPath("/home/me/work/link", ["/home/me/work"]);
    expect(view).toBeUndefined();
  });

  it("ancestor-root: 物理 root が scope の上位 → undefined", async () => {
    // scope はサブディレクトリ限定。git root が親 monorepo (scope の上位) を返す経路を模す。
    const bridge = bridgeWith(resolverReturning("/home/me/mono"));
    const view = await bridge.getPolicyConfigForPath("/home/me/mono/sub", ["/home/me/mono/sub"]);
    expect(view).toBeUndefined();
  });

  it("scope 空 (backend default-off) → 封じ込め無し (root が scope 外でも view)", async () => {
    const bridge = bridgeWith(resolverReturning("/var/secret-repo"));
    const view = await bridge.getPolicyConfigForPath("/anything", []);
    expect(view).toBeDefined();
  });

  it("fail-safe: 解決結果に root が無い + scope 非空 → undefined", async () => {
    const bridge = bridgeWith(resolverReturning(undefined));
    const view = await bridge.getPolicyConfigForPath("/home/me/work/repo", ["/home/me/work"]);
    expect(view).toBeUndefined();
  });
});

/** real git repo を dir に作る。 */
function initRepoAt(dir: string): void {
  const run = (args: string[]): void => {
    execFileSync("git", args, { cwd: dir });
  };
  run(["init", "-q"]);
  run(["config", "user.email", "t@example.com"]);
  run(["config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "x\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "i"]);
}

describe("INV-POLICY-RESOLVE-CONTAINMENT: real-tmpdir (実 git + symlink/ancestor・正準 resolver)", () => {
  // realpathSync で base を物理化する (tmpdir 自体が symlink (例 /tmp→/private/tmp) でも scope と git root を
  // 同じ物理空間で比較できるようにする)。
  const bridge = bridgeWith(makeRepoScopeResolver());

  // QA-R3 (decision 019f0f64): 作成した tmpdir を毎回掃除する (/tmp leak 防止・hygiene)。
  const created: string[] = [];
  const mkBase = (prefix: string): string => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    created.push(base);
    return base;
  };
  afterEach(() => {
    for (const d of created.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("symlink-in-scope → out-of-scope repo: 物理 root が scope 外ゆえ undefined (scope 無しなら解決する)", async () => {
    const base = mkBase("ad-sec1-sym-");
    const work = join(base, "work");
    mkdirSync(work); // scope 内ディレクトリ (それ自体は repo でない)。
    const secret = join(base, "secret-repo");
    mkdirSync(secret);
    initRepoAt(secret); // scope 外の git repo。
    symlinkSync(secret, join(work, "link")); // /base/work/link -> /base/secret-repo
    const scope = [work]; // ACTRADECK_PROJECT_SCOPE = /base/work

    // scope 無しなら symlink 先の repo を解決できる (= symlink 先が正当な repo である裏取り)。
    expect(await bridge.getPolicyConfigForPath(join(work, "link"), [])).toBeDefined();
    // scope 付きなら物理 root (/base/secret-repo) が scope 外 → 二段封じ込めで拒否。
    expect(await bridge.getPolicyConfigForPath(join(work, "link"), scope)).toBeUndefined();
  });

  it("ancestor-root: scope=サブディレクトリ限定で git root が親 monorepo → undefined (scope=root なら解決)", async () => {
    const base = mkBase("ad-sec1-anc-");
    const mono = join(base, "mono");
    mkdirSync(mono);
    initRepoAt(mono); // monorepo root。
    const sub = join(mono, "sub");
    mkdirSync(sub); // サブディレクトリ (それ自体は別 repo でない)。

    // scope を sub に限定 → git root (/base/mono) は scope の上位 → 拒否。
    expect(await bridge.getPolicyConfigForPath(sub, [sub])).toBeUndefined();
    // scope を mono (= 実 root) にすれば配下扱いで解決する (正当な in-scope 解決の裏取り)。
    expect(await bridge.getPolicyConfigForPath(sub, [mono])).toBeDefined();
  });
});
