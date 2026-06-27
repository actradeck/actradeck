/**
 * INV-APPROVAL-PERSIST-STORE (ADR 019ee0c0): 永続承認 allowlist ストアの不変条件。
 *
 * - NO-RAW: ディスクには署名 (sha256 hex) のみで生コマンドを書かない。
 * - TTL: 期限切れエントリは has/list で命中せず、add 時に prune される。
 * - dedup: 同一 (signature, repoScope) は 1 本へ統合し expiresAt を sliding 更新 (createdAt 保持)。
 * - scope: 別 repoScope / 別署名は構造的に has=false。
 * - 0600: ファイル mode は 0600 (所有者のみ)。
 * - 壊れたファイル: fail-safe で空扱い (= 永続 grant なし)。
 * - revoke / clear: 確実に除去する。
 *
 * mutation: TTL を無視 (expiresAt 判定を外す) すると「期限切れ非命中」が赤化。dedup を外すと
 * 「同一署名で 2 件」が赤化。0600 を 0644 にすると mode テストが赤化。
 *
 * 🔴 すべて os.tmpdir() 配下。実 ~/.actradeck 不可侵。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApprovalAllowlistStore, repoLabelOf } from "../src/approval-allowlist-store.js";

let dir: string;
let storePath: string;
let store: ApprovalAllowlistStore;

const SIG_A = "a".repeat(64);
const SIG_B = "b".repeat(64);
const SCOPE_1 = "scope0000001";
const SCOPE_2 = "scope0000002";
const TTL = 60 * 60_000; // 1h
const T0 = 1_000_000;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "actradeck-pal-store-"));
  storePath = join(dir, "allowlist.json");
  store = new ApprovalAllowlistStore({ path: storePath });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ApprovalAllowlistStore (ADR 019ee0c0)", () => {
  it("空ストア: has=false / list=[] (ファイル無し)", () => {
    expect(store.has(SIG_A, SCOPE_1, T0)).toBe(false);
    expect(store.list(T0)).toEqual([]);
  });

  it("add → has=true (期限内) / list に 1 件", () => {
    store.add({ signature: SIG_A, repoScope: SCOPE_1, risk: "medium", ttlMs: TTL, now: T0 });
    expect(store.has(SIG_A, SCOPE_1, T0)).toBe(true);
    expect(store.list(T0)).toHaveLength(1);
    expect(store.list(T0)[0]!.signature).toBe(SIG_A);
  });

  it("NO-RAW: ディスクに署名のみ・生コマンド文字列を含まない", () => {
    store.add({
      signature: SIG_A,
      repoScope: SCOPE_1,
      repoLabel: "myrepo",
      risk: "medium",
      ttlMs: TTL,
      now: T0,
    });
    const raw = readFileSync(storePath, "utf8");
    expect(raw).toContain(SIG_A);
    expect(raw).toContain("myrepo");
    // 生コマンド (例) は一切書かれない (署名は不可逆 hash)。
    expect(raw).not.toContain("rm -rf");
    expect(raw).not.toContain("npm publish");
  });

  it("0600: ファイル mode は所有者 rw のみ", () => {
    store.add({ signature: SIG_A, repoScope: SCOPE_1, risk: "medium", ttlMs: TTL, now: T0 });
    const mode = statSync(storePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("TTL: 期限切れは has=false / list から除外", () => {
    store.add({ signature: SIG_A, repoScope: SCOPE_1, risk: "medium", ttlMs: TTL, now: T0 });
    const afterExpiry = T0 + TTL + 1;
    expect(store.has(SIG_A, SCOPE_1, afterExpiry)).toBe(false);
    expect(store.list(afterExpiry)).toEqual([]);
    // 期限ちょうど直前は命中。
    expect(store.has(SIG_A, SCOPE_1, T0 + TTL - 1)).toBe(true);
  });

  it("scope: 別 repoScope / 別署名は命中しない", () => {
    store.add({ signature: SIG_A, repoScope: SCOPE_1, risk: "medium", ttlMs: TTL, now: T0 });
    expect(store.has(SIG_A, SCOPE_2, T0)).toBe(false); // 別 repo
    expect(store.has(SIG_B, SCOPE_1, T0)).toBe(false); // 別署名
  });

  it("dedup: 同一 (sig, scope) の再 add は 1 本・expiresAt を sliding・createdAt 保持", () => {
    store.add({ signature: SIG_A, repoScope: SCOPE_1, risk: "medium", ttlMs: TTL, now: T0 });
    const later = T0 + 10 * 60_000;
    store.add({ signature: SIG_A, repoScope: SCOPE_1, risk: "medium", ttlMs: TTL, now: later });
    const entries = store.list(later);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.createdAt).toBe(T0); // 元の作成時刻を保持
    expect(entries[0]!.expiresAt).toBe(later + TTL); // 期限は sliding 更新
  });

  it("同一署名でも別 repoScope は別エントリ (2 件)", () => {
    store.add({ signature: SIG_A, repoScope: SCOPE_1, risk: "medium", ttlMs: TTL, now: T0 });
    store.add({ signature: SIG_A, repoScope: SCOPE_2, risk: "medium", ttlMs: TTL, now: T0 });
    expect(store.list(T0)).toHaveLength(2);
  });

  it("add 時に期限切れエントリを prune (肥大化防止)", () => {
    store.add({ signature: SIG_A, repoScope: SCOPE_1, risk: "medium", ttlMs: TTL, now: T0 });
    // SIG_A が期限切れになった後に SIG_B を add → SIG_A は prune される。
    const later = T0 + TTL + 1;
    store.add({ signature: SIG_B, repoScope: SCOPE_1, risk: "medium", ttlMs: TTL, now: later });
    const entries = store.list(later);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.signature).toBe(SIG_B);
  });

  it("revoke: 完全一致署名を除去 (全 repoScope)", () => {
    store.add({ signature: SIG_A, repoScope: SCOPE_1, risk: "medium", ttlMs: TTL, now: T0 });
    store.add({ signature: SIG_A, repoScope: SCOPE_2, risk: "medium", ttlMs: TTL, now: T0 });
    store.add({ signature: SIG_B, repoScope: SCOPE_1, risk: "medium", ttlMs: TTL, now: T0 });
    const removed = store.revoke(SIG_A);
    expect(removed).toBe(2);
    expect(store.has(SIG_A, SCOPE_1, T0)).toBe(false);
    expect(store.has(SIG_B, SCOPE_1, T0)).toBe(true);
  });

  it("revoke: repoScope 指定でその scope のみ除去", () => {
    store.add({ signature: SIG_A, repoScope: SCOPE_1, risk: "medium", ttlMs: TTL, now: T0 });
    store.add({ signature: SIG_A, repoScope: SCOPE_2, risk: "medium", ttlMs: TTL, now: T0 });
    const removed = store.revoke(SIG_A, SCOPE_1);
    expect(removed).toBe(1);
    expect(store.has(SIG_A, SCOPE_1, T0)).toBe(false);
    expect(store.has(SIG_A, SCOPE_2, T0)).toBe(true);
  });

  it("clear: 全削除", () => {
    store.add({ signature: SIG_A, repoScope: SCOPE_1, risk: "medium", ttlMs: TTL, now: T0 });
    store.add({ signature: SIG_B, repoScope: SCOPE_2, risk: "medium", ttlMs: TTL, now: T0 });
    store.clear();
    expect(store.list(T0)).toEqual([]);
  });

  it("壊れた JSON: fail-safe で空扱い (永続 grant 漏れなし)", () => {
    writeFileSync(storePath, "{ not valid json", "utf8");
    expect(store.has(SIG_A, SCOPE_1, T0)).toBe(false);
    expect(store.list(T0)).toEqual([]);
  });

  it("不正エントリ (署名欠落 / 型崩れ) は弾く", () => {
    writeFileSync(
      storePath,
      JSON.stringify({
        version: 1,
        entries: [
          { repoScope: SCOPE_1, risk: "medium", createdAt: T0, expiresAt: T0 + TTL }, // signature 欠落
          {
            signature: 123,
            repoScope: SCOPE_1,
            risk: "medium",
            createdAt: T0,
            expiresAt: T0 + TTL,
          }, // 非文字列
          {
            signature: SIG_A,
            repoScope: SCOPE_1,
            risk: "medium",
            createdAt: T0,
            expiresAt: T0 + TTL,
          }, // OK
        ],
      }),
      "utf8",
    );
    expect(store.list(T0)).toHaveLength(1);
    expect(store.has(SIG_A, SCOPE_1, T0)).toBe(true);
  });

  it("repoLabelOf: basename のみ (絶対パスを露出しない)", () => {
    expect(repoLabelOf("/home/user/projects/myrepo")).toBe("myrepo");
    expect(repoLabelOf("/home/user/projects/myrepo/")).toBe("myrepo");
  });
});

/**
 * INV-APPROVAL-PERSIST-CONCURRENT (QA-3): **複数プロセス**から同一 store へ並走 add しても
 * withFileLock がプロセス間で read-modify-write を直列化し **lost-update しない**。
 *
 * managed Sidecar と attach daemon が同一 ~/.actradeck/approvals/allowlist.json へ並走書込しうる
 * (ADR 019ee0c0) ため、実プロセス境界で検証する。worker は実 ApprovalAllowlistStore を別 node
 * プロセスで駆動する (test/helpers/persist-add-worker.mts を tsx で実行)。
 *
 * 注: スレッドでなく**プロセス**で検証する必要がある — file-lock の stale 判定は
 * `holder === process.pid` を「自分の残骸」として奪取するため、同一 pid を共有するスレッドでは
 * 直列化が成立せず偽陽性になる (実 pid が異なるプロセスでのみ正しく検証できる)。
 *
 * falsifiability: add() から withFileLock を外す (素の read-modify-write) と、K 並走で多くの
 * エントリが last-writer-wins で消えて count < K となり赤化する (lock がこの不変条件の担い手)。
 *
 * 🔴 store は os.tmpdir 配下。実 ~/.actradeck 不可侵。
 */
describe("INV-APPROVAL-PERSIST-CONCURRENT (QA-3): multi-process withFileLock 直列化", () => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(testDir, "../../..");
  const sidecarRoot = resolve(testDir, "..");
  // tsx is a devDependency of @actradeck/sidecar. pnpm's strict (non-hoisted)
  // layout — the default on a clean `pnpm install` (fresh clone) — puts its bin
  // under the package's OWN node_modules; only an older/hoisted dev install puts
  // it at the workspace root. Resolve robustly across both so this invariant
  // test runs on a fresh clone, not just on a hoisted dev machine.
  const tsxBin =
    [join(sidecarRoot, "node_modules/.bin/tsx"), join(repoRoot, "node_modules/.bin/tsx")].find(
      (p) => existsSync(p),
    ) ?? join(repoRoot, "node_modules/.bin/tsx");
  const workerPath = join(testDir, "helpers/persist-add-worker.mts");

  /** worker を 1 プロセス spawn し exit code を待つ。 */
  function spawnAdd(storePath: string, signature: string): Promise<number> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(tsxBin, [workerPath], {
        env: {
          ...process.env,
          STORE_PATH: storePath,
          SIG: signature,
          SCOPE: "scope0000001",
          TTL_MS: String(60 * 60_000),
          NOW: "1000000",
        },
        stdio: ["ignore", "ignore", "inherit"],
      });
      child.on("error", reject);
      child.on("exit", (code) => resolvePromise(code ?? -1));
    });
  }

  it("K プロセス並走 add → 全 K エントリが残る (lost-update なし)", async () => {
    const cdir = mkdtempSync(join(tmpdir(), "actradeck-pal-concurrent-"));
    const cpath = join(cdir, "allowlist.json");
    try {
      const K = 10;
      // 各 worker は distinct な署名を同一ファイルへ並走 add する。
      const signatures = Array.from({ length: K }, (_, i) => `${i}`.padStart(2, "0").repeat(32));
      const codes = await Promise.all(signatures.map((sig) => spawnAdd(cpath, sig)));
      // 全 worker が正常終了。
      expect(codes.every((c) => c === 0)).toBe(true);
      // 直列化されていれば K 件すべて残る (lost-update なし)。
      const store = new ApprovalAllowlistStore({ path: cpath });
      const persisted = store.list(1_000_000);
      expect(persisted).toHaveLength(K);
      expect(new Set(persisted.map((e) => e.signature))).toEqual(new Set(signatures));
      // ファイル mode は 0600 維持 (並走書込でも緩まない)。
      expect(statSync(cpath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(cdir, { recursive: true, force: true });
    }
  }, 60_000);
});
