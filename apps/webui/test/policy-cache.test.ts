/**
 * ADR 019f0eca per-repo 承認ポリシー画面の **localStorage キャッシュ** (policy-cache.ts) の INV。
 *
 * 固定する不変条件 (falsifiable・security 寄り):
 *  - admin cache: raw + fetchedAt を round-trip 保存し、SSR (window 不在) では throw せず undefined/no-op。
 *  - candidate スタブ: **untrusted source** として load/save 双方で
 *      ① repo_scope を hex (server gate と同 bound {1,64}) でゲート (非 hex / 空 / 過長 / 重複を落とす)、
 *      ② repo_label を canonical sanitizeRepoLabel へ畳む (絶対パス→basename・制御文字除去・64 cap)。
 *  - 壊れ JSON / 非配列は [] へ畳む (throw しない)。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isPolicyRepoScope,
  loadCandidateStubs,
  loadPolicyAdminCache,
  POLICY_ADMIN_CACHE_KEY,
  POLICY_CANDIDATES_KEY,
  saveCandidateStubs,
  savePolicyAdminCache,
  type PersistedCandidate,
} from "../src/ui/policy-cache";

// TDA-5: キー名は policy-cache から import (ハードコード再掲で silent drift しないように)。
const ADMIN_KEY = POLICY_ADMIN_CACHE_KEY;
const CANDIDATES_KEY = POLICY_CANDIDATES_KEY;

/** node 環境用の最小 in-memory localStorage + window スタブ。 */
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  raw(k: string): string | undefined {
    return this.m.get(k);
  }
}

let store: MemStorage;
// globalThis.window は型上 non-optional な Window。stub 差し替え/削除のため optional な形へ再キャストする。
const g = globalThis as unknown as { window?: { localStorage: MemStorage } };

beforeEach(() => {
  store = new MemStorage();
  g.window = { localStorage: store };
});

afterEach(() => {
  delete g.window;
});

describe("policy-cache: admin raw cache", () => {
  it("raw + fetchedAt を round-trip 保存する (revive は parsePolicyAdmin が担う)", () => {
    const raw = { enabled: true, categories: ["recursive-rm"], repos: [] };
    savePolicyAdminCache(raw, 1717000000000);
    expect(loadPolicyAdminCache()).toEqual({ raw, fetchedAt: 1717000000000 });
  });

  it("未保存なら undefined", () => {
    expect(loadPolicyAdminCache()).toBeUndefined();
  });

  it("壊れ JSON は undefined (throw しない)", () => {
    store.setItem(ADMIN_KEY, "{not json");
    expect(loadPolicyAdminCache()).toBeUndefined();
  });

  it("fetchedAt 非数値/欠落は 0 へ畳む (raw は保持)", () => {
    store.setItem(ADMIN_KEY, JSON.stringify({ raw: { enabled: true }, fetchedAt: "nope" }));
    expect(loadPolicyAdminCache()).toEqual({ raw: { enabled: true }, fetchedAt: 0 });
    store.setItem(ADMIN_KEY, JSON.stringify({ raw: { enabled: true } }));
    expect(loadPolicyAdminCache()).toEqual({ raw: { enabled: true }, fetchedAt: 0 });
  });

  it("raw 欠落のエンベロープは undefined", () => {
    store.setItem(ADMIN_KEY, JSON.stringify({ fetchedAt: 123 }));
    expect(loadPolicyAdminCache()).toBeUndefined();
  });
});

describe("policy-cache: isPolicyRepoScope (untrusted scope ゲート・server と同 bound {1,64})", () => {
  it("hex(1-64) を通し非 hex/空/過長/非 string を弾く", () => {
    expect(isPolicyRepoScope("a")).toBe(true); // {1,...} ゆえ 1 字 hex も valid (server と同 bound)。
    expect(isPolicyRepoScope("aaaa0001")).toBe(true);
    expect(isPolicyRepoScope("f".repeat(64))).toBe(true);
    expect(isPolicyRepoScope("NOTHEX")).toBe(false);
    expect(isPolicyRepoScope("")).toBe(false);
    expect(isPolicyRepoScope("a".repeat(65))).toBe(false);
    expect(isPolicyRepoScope(123)).toBe(false);
    expect(isPolicyRepoScope(undefined)).toBe(false);
  });
});

describe("policy-cache: candidate スタブ (untrusted source・NO-RAW)", () => {
  it("hex scope を round-trip し label を保持する", () => {
    const stubs: PersistedCandidate[] = [{ repoScope: "aaaa0001", repoLabel: "sandbox" }];
    saveCandidateStubs(stubs);
    expect(loadCandidateStubs()).toEqual(stubs);
  });

  it("非 hex / 空 / 過長 scope を落とす (bound は server と同じ {1,64})", () => {
    store.setItem(
      CANDIDATES_KEY,
      JSON.stringify([
        { repoScope: "aaaa0001" }, // ok
        { repoScope: "ab" }, // 短い hex も ok ({1,64} ゆえ・server と同 bound)
        { repoScope: "NOTHEX!!" }, // 非 hex → drop
        { repoScope: "" }, // 空 → drop
        { repoScope: "a".repeat(65) }, // 64 字超 → drop
      ]),
    );
    expect(loadCandidateStubs()).toEqual([{ repoScope: "aaaa0001" }, { repoScope: "ab" }]);
  });

  it("repo_label を canonical sanitize へ畳む (絶対パス→basename・制御文字除去)", () => {
    store.setItem(
      CANDIDATES_KEY,
      JSON.stringify([{ repoScope: "bbbb0002", repoLabel: "/home/user/secret/repo" }]),
    );
    // sanitizeRepoLabel は最終 path segment へ畳む (絶対パスを at-rest/UI へ持ち込ませない)。
    expect(loadCandidateStubs()).toEqual([{ repoScope: "bbbb0002", repoLabel: "repo" }]);
  });

  it("重複 scope は先勝ちで 1 件へ", () => {
    store.setItem(
      CANDIDATES_KEY,
      JSON.stringify([
        { repoScope: "cccc0003", repoLabel: "first" },
        { repoScope: "cccc0003", repoLabel: "second" },
      ]),
    );
    expect(loadCandidateStubs()).toEqual([{ repoScope: "cccc0003", repoLabel: "first" }]);
  });

  it("非配列 / 壊れは [] へ畳む (throw しない)", () => {
    store.setItem(CANDIDATES_KEY, JSON.stringify({ nope: true }));
    expect(loadCandidateStubs()).toEqual([]);
    store.setItem(CANDIDATES_KEY, "{broken");
    expect(loadCandidateStubs()).toEqual([]);
  });

  it("保存時も不正値を弾く (at-rest に raw を残さない)", () => {
    saveCandidateStubs([
      { repoScope: "dddd0004", repoLabel: "/abs/path/clean" },
      { repoScope: "BAD" } as PersistedCandidate,
    ]);
    const persisted = JSON.parse(store.raw(CANDIDATES_KEY) ?? "[]") as unknown;
    expect(persisted).toEqual([{ repoScope: "dddd0004", repoLabel: "clean" }]);
  });
});

describe("policy-cache: SSR (window 不在) は no-op", () => {
  it("window 無しで load は undefined/[] ・save は throw しない", () => {
    delete g.window;
    expect(loadPolicyAdminCache()).toBeUndefined();
    expect(loadCandidateStubs()).toEqual([]);
    expect(() => savePolicyAdminCache({ a: 1 }, 123)).not.toThrow();
    expect(() => saveCandidateStubs([{ repoScope: "aaaa0001" }])).not.toThrow();
  });
});
