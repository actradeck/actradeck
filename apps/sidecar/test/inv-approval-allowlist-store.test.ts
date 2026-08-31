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
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApprovalAllowlistStore, repoLabelOf } from "../src/approval-allowlist-store.js";
import { spawnWorker, workerScript } from "./helpers/lock-test-support.js";

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

  it("SEC-R3-1: resolver 導出 label も sanitizeRepoLabel parity (制御文字除去 + 64cap)", () => {
    // git root basename に制御文字 (0x01) が混ざっても表示へ生で出さない (client 由来 label と同一意味論)。
    // 旧実装 (素の basename) なら "repo\x01name" がそのまま返り RED。
    const ctrl = String.fromCharCode(1);
    expect(repoLabelOf("/home/me/repo" + ctrl + "name")).toBe("reponame");
    // 過長 basename は 64 字へ cap (旧実装は 100 字を返し RED)。
    expect(repoLabelOf("/home/me/" + "z".repeat(100))).toHaveLength(64);
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
  // FL-L5b: tsx 解決 + spawn ラッパの骨格は lock 系 INV の共有ハーネスへ集約済み
  // (実プロセス = distinct pid でしか検証できない理由もそちらに記載)。
  const workerPath = workerScript("persist-add-worker.mts");

  /**
   * worker を 1 プロセス spawn し exit code を待つ。
   * `acquireDelayMs` を渡すと withFileLock の「排他生成直後・fn 前」に deschedule 窓を注入する
   * (INV-FILELOCK-NO-EMPTY-WINDOW の実プロセス反証用・本番デーモンはこの env を設定しない)。
   */
  function spawnAdd(
    storePath: string,
    signature: string,
    acquireDelayMs?: number,
  ): Promise<number> {
    return spawnWorker(workerPath, {
      STORE_PATH: storePath,
      SIG: signature,
      SCOPE: "scope0000001",
      TTL_MS: String(60 * 60_000),
      NOW: "1000000",
      ...(acquireDelayMs ? { ACTRADECK_TEST_LOCK_ACQUIRE_DELAY_MS: String(acquireDelayMs) } : {}),
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

  /**
   * INV-FILELOCK-NO-EMPTY-WINDOW: 排他生成直後 (fn 前) の deschedule 窓を注入しても二重取得しない。
   *
   * 上の K プロセステストは無負荷では緑だが、CPU 逼迫 (全 suite 並列 + cold-start 競合) 下で稀に
   * 初回 fail→再実行 pass する flake を観測していた (PR-2 QA)。原因は timing budget でなく
   * withFileLock の **空ファイル窓**: 旧 openSync 方式は「排他生成」と「pid 書込」が 2 syscall に
   * 分かれ、その間に契約者が deschedule されると lockPath が pid 無しで一瞬存在し、別プロセスが
   * `holder===undefined`=stale と誤判定して奪取 → 二重保持 → lost-update した。linkSync 方式は
   * lockPath が出現の瞬間から pid を持つため窓自体が無い。
   *
   * このテストは `acquireDelayMs` (env `ACTRADECK_TEST_LOCK_ACQUIRE_DELAY_MS`) で取得直後 deschedule を
   * **決定的に**注入し、flake を待たずに窓の有無を検出する。複数ラウンドで感度を上げる。
   *
   * falsifiability (mutation 反証・本 PR turn で実証): file-lock.ts の取得を旧 openSync+後追い pid 書込へ
   * 戻し、遅延を openSync と pid 書込の間へ置くと、本テストが lost-update で RED になる (linkSync 方式は緑)。
   *
   * 🔴 store は os.tmpdir 配下。実 ~/.actradeck 不可侵。実プロセス (distinct pid) で検証。
   */
  it("INV-FILELOCK-NO-EMPTY-WINDOW: 取得直後 deschedule 窓を注入しても lost-update しない", async () => {
    const ROUNDS = 4;
    const K = 8;
    const ACQUIRE_DELAY_MS = 40; // openSync 方式なら空ファイル窓が確実に広がる幅
    for (let r = 0; r < ROUNDS; r++) {
      const cdir = mkdtempSync(join(tmpdir(), "actradeck-pal-window-"));
      const cpath = join(cdir, "allowlist.json");
      try {
        // ラウンド跨ぎで衝突しない distinct な 64hex 署名 (r*K+i を 2hex へ)。
        const signatures = Array.from({ length: K }, (_, i) =>
          (r * K + i).toString(16).padStart(2, "0").repeat(32),
        );
        const codes = await Promise.all(
          signatures.map((sig) => spawnAdd(cpath, sig, ACQUIRE_DELAY_MS)),
        );
        expect(
          codes.every((c) => c === 0),
          `round ${r}: a worker aborted`,
        ).toBe(true);
        const store = new ApprovalAllowlistStore({ path: cpath });
        const persisted = store.list(1_000_000);
        // 窓が閉じていれば全 K 生存 (二重保持による lost-update ゼロ)。
        expect(
          persisted,
          `round ${r}: lost-update under injected acquire-delay window`,
        ).toHaveLength(K);
        expect(new Set(persisted.map((e) => e.signature))).toEqual(new Set(signatures));
        expect(statSync(cpath).mode & 0o777).toBe(0o600);
      } finally {
        rmSync(cdir, { recursive: true, force: true });
      }
    }
  }, 120_000);
});
