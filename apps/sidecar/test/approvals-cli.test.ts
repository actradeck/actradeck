/**
 * approvals-cli (ADR 019ee0c0): 永続承認 CLI (list|revoke|clear) のテスト。
 * 署名一覧/失効/全削除と usage/対象なしの exit code を固定する。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApprovalAllowlistStore } from "../src/approval-allowlist-store.js";
import { runApprovalsCli } from "../src/approvals-cli.js";

const SIG_A = "a".repeat(64);
const SIG_B = "b".repeat(64);
const TTL = 60 * 60_000;
const T0 = 1_000_000;

let dir: string;
let store: ApprovalAllowlistStore;
let out: string[];
let err: string[];

function io() {
  return { store, now: T0, out: (s: string) => out.push(s), err: (s: string) => err.push(s) };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "actradeck-pal-cli-"));
  store = new ApprovalAllowlistStore({ path: join(dir, "allowlist.json") });
  out = [];
  err = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("approvals CLI", () => {
  it("list (空) → 0 件メッセージ・exit 0", () => {
    expect(runApprovalsCli(["list"], io())).toBe(0);
    expect(out.join("")).toContain("0 件");
  });

  it("list → 署名・repo・残り期限を表示", () => {
    store.add({
      signature: SIG_A,
      repoScope: "sc1",
      repoLabel: "myrepo",
      risk: "medium",
      ttlMs: TTL,
      now: T0,
    });
    expect(runApprovalsCli(["list"], io())).toBe(0);
    const text = out.join("");
    expect(text).toContain(SIG_A);
    expect(text).toContain("myrepo");
    expect(text).toContain("expires_in=");
  });

  it("revoke <完全一致> → 失効・exit 0", () => {
    store.add({ signature: SIG_A, repoScope: "sc1", risk: "medium", ttlMs: TTL, now: T0 });
    expect(runApprovalsCli(["revoke", SIG_A], io())).toBe(0);
    expect(store.has(SIG_A, "sc1", T0)).toBe(false);
  });

  it("revoke <一意プレフィックス> → 失効", () => {
    store.add({ signature: SIG_A, repoScope: "sc1", risk: "medium", ttlMs: TTL, now: T0 });
    expect(runApprovalsCli(["revoke", "aaaaaa"], io())).toBe(0);
    expect(store.has(SIG_A, "sc1", T0)).toBe(false);
  });

  it("revoke <曖昧プレフィックス> → exit 2 (誤失効防止)", () => {
    // 異なる 2 署名が同一プレフィックスを共有するケースを構成。
    const p = "c".repeat(60);
    store.add({ signature: `${p}0001`, repoScope: "sc1", risk: "medium", ttlMs: TTL, now: T0 });
    store.add({ signature: `${p}0002`, repoScope: "sc1", risk: "medium", ttlMs: TTL, now: T0 });
    expect(runApprovalsCli(["revoke", p], io())).toBe(2);
    expect(err.join("")).toContain("曖昧");
  });

  it("revoke <不一致> → exit 1", () => {
    expect(runApprovalsCli(["revoke", SIG_B], io())).toBe(1);
  });

  it("revoke 引数なし → usage exit 2", () => {
    expect(runApprovalsCli(["revoke"], io())).toBe(2);
  });

  it("clear → 全削除・exit 0", () => {
    store.add({ signature: SIG_A, repoScope: "sc1", risk: "medium", ttlMs: TTL, now: T0 });
    store.add({ signature: SIG_B, repoScope: "sc2", risk: "medium", ttlMs: TTL, now: T0 });
    expect(runApprovalsCli(["clear"], io())).toBe(0);
    expect(store.list(T0)).toEqual([]);
  });

  it("未知サブコマンド → usage exit 2", () => {
    expect(runApprovalsCli(["bogus"], io())).toBe(2);
    expect(runApprovalsCli([], io())).toBe(2);
  });
});
