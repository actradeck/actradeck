/**
 * approval-persist-config (ADR 019ee0c0): env 解決と repo スコープ解決の単一出所テスト。
 * opt-in 既定 OFF / TTL clamp / repo 解決不能時 undefined を固定する。
 */
import { describe, expect, it } from "vitest";

import {
  buildApprovalPersistConfig,
  DEFAULT_PERSIST_TTL_MS,
  isPersistApprovalsEnabled,
  resolvePersistTtlMs,
} from "../src/approval-persist-config.js";

describe("isPersistApprovalsEnabled (既定 OFF)", () => {
  it("未設定は false", () => {
    expect(isPersistApprovalsEnabled({})).toBe(false);
  });
  it('"1" / "true" のみ true', () => {
    expect(isPersistApprovalsEnabled({ ACTRADECK_PERSIST_APPROVALS: "1" })).toBe(true);
    expect(isPersistApprovalsEnabled({ ACTRADECK_PERSIST_APPROVALS: "true" })).toBe(true);
  });
  it('"0" / "yes" / 任意文字列は false (fail-safe)', () => {
    expect(isPersistApprovalsEnabled({ ACTRADECK_PERSIST_APPROVALS: "0" })).toBe(false);
    expect(isPersistApprovalsEnabled({ ACTRADECK_PERSIST_APPROVALS: "yes" })).toBe(false);
  });
});

describe("resolvePersistTtlMs (clamp)", () => {
  it("未設定/不正は既定 7 日", () => {
    expect(resolvePersistTtlMs({})).toBe(DEFAULT_PERSIST_TTL_MS);
    expect(resolvePersistTtlMs({ ACTRADECK_PERSIST_APPROVALS_TTL_MS: "abc" })).toBe(
      DEFAULT_PERSIST_TTL_MS,
    );
    expect(resolvePersistTtlMs({ ACTRADECK_PERSIST_APPROVALS_TTL_MS: "-5" })).toBe(
      DEFAULT_PERSIST_TTL_MS,
    );
  });
  it("下限 1 分 / 上限 90 日に clamp", () => {
    expect(resolvePersistTtlMs({ ACTRADECK_PERSIST_APPROVALS_TTL_MS: "100" })).toBe(60_000);
    const huge = String(1000 * 24 * 60 * 60_000);
    expect(resolvePersistTtlMs({ ACTRADECK_PERSIST_APPROVALS_TTL_MS: huge })).toBe(
      90 * 24 * 60 * 60_000,
    );
  });
  it("範囲内はそのまま", () => {
    const oneDay = String(24 * 60 * 60_000);
    expect(resolvePersistTtlMs({ ACTRADECK_PERSIST_APPROVALS_TTL_MS: oneDay })).toBe(
      24 * 60 * 60_000,
    );
  });
});

describe("buildApprovalPersistConfig.resolveRepoScope", () => {
  it("cwd 無し → undefined (unscoped grant を作らない)", async () => {
    const cfg = buildApprovalPersistConfig({ env: {}, resolveRepoRoot: async () => "/repo" });
    expect(await cfg.resolveRepoScope(undefined)).toBeUndefined();
    expect(await cfg.resolveRepoScope("")).toBeUndefined();
  });
  it("git 管理外 (repo root 解決不能) → undefined", async () => {
    const cfg = buildApprovalPersistConfig({ env: {}, resolveRepoRoot: async () => undefined });
    expect(await cfg.resolveRepoScope("/tmp/not-a-repo")).toBeUndefined();
  });
  it("repo root 解決 → { scope(hash), label(basename) }", async () => {
    const cfg = buildApprovalPersistConfig({
      env: {},
      resolveRepoRoot: async () => "/home/u/projects/myrepo",
    });
    const r = await cfg.resolveRepoScope("/home/u/projects/myrepo/sub");
    expect(r?.label).toBe("myrepo");
    expect(r?.scope).toMatch(/^[0-9a-f]{12}$/); // scopeHash = 12-hex
  });
  it("enabled は env を反映 (既定 OFF)", () => {
    expect(buildApprovalPersistConfig({ env: {} }).enabled).toBe(false);
    expect(buildApprovalPersistConfig({ env: { ACTRADECK_PERSIST_APPROVALS: "1" } }).enabled).toBe(
      true,
    );
  });
});
