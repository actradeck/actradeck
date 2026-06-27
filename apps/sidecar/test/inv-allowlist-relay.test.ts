/**
 * PAL-v2 (ADR 019ee147): allowlist relay (sidecar 側) の INV。
 *  - ApprovalBridge.listPersistedApprovals / revokePersistedApproval / persistEnabled。
 *  - buildAllowlistResponse: allowlist.request → allowlist.response の NO-RAW 変換 (単一出所)。
 *
 * 固定する不変条件 (falsifiable・mutation で RED):
 *  - INV-PAL-V2-NO-RAW: 応答 entries は sha256 署名/scope/basename/risk/時刻のみ。生コマンド非含。
 *  - INV-PAL-V2-REVOKE: revoke が disk から該当署名を除去し removed を返す。enabled OFF でも revoke 可。
 *  - enabled-independence: list は enabled に関わらず disk エントリを返す (dormant 掃除可)。
 *  - 署名なし revoke は no-op (誤って全消去しない)。request_id 不正は undefined (黙殺)。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApprovalAllowlistStore } from "../src/approval-allowlist-store.js";
import { ApprovalBridge, type ApprovalPersistConfig } from "../src/approval-bridge.js";
import { buildAllowlistResponse } from "../src/allowlist-relay.js";

const NOW = 1_000_000;

let dir: string;
let store: ApprovalAllowlistStore;

function makeBridge(enabled: boolean): ApprovalBridge {
  const persist: ApprovalPersistConfig = {
    store,
    enabled,
    ttlMs: 7 * 24 * 60 * 60_000,
    resolveRepoScope: async () => undefined,
    now: () => NOW,
  };
  return new ApprovalBridge({ persist });
}

function seed(signature: string, repoScope: string, label: string, expiresInMs: number): void {
  store.add({
    signature,
    repoScope,
    repoLabel: label,
    risk: "medium",
    ttlMs: expiresInMs,
    now: NOW,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pal-v2-relay-"));
  store = new ApprovalAllowlistStore({ path: join(dir, "allowlist.json") });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ApprovalBridge PAL-v2 list/revoke/enabled", () => {
  it("listPersistedApprovals は NO-RAW ビューを返す (期限内のみ)", () => {
    seed("a".repeat(64), "scopeA", "repoA", 60_000);
    seed("b".repeat(64), "scopeB", "repoB", -1); // 期限切れ (negative ttl → expiresAt<now)
    const bridge = makeBridge(true);
    const list = bridge.listPersistedApprovals();
    expect(list).toHaveLength(1); // 期限切れは除外。
    expect(list[0]).toEqual({
      signature: "a".repeat(64),
      repoScope: "scopeA",
      repoLabel: "repoA",
      risk: "medium",
      createdAtMs: NOW,
      expiresAtMs: NOW + 60_000,
    });
    // NO-RAW: view に raw command 由来のキーが無い。
    expect(Object.keys(list[0]!)).not.toContain("command");
  });

  it("persistEnabled は config の enabled を反映する", () => {
    seed("a".repeat(64), "scopeA", "repoA", 60_000);
    expect(makeBridge(true).persistEnabled).toBe(true);
    expect(makeBridge(false).persistEnabled).toBe(false);
  });

  it("enabled-independence: enabled=false でも list は disk エントリを返す (dormant 掃除可)", () => {
    seed("a".repeat(64), "scopeA", "repoA", 60_000);
    const bridge = makeBridge(false);
    expect(bridge.persistEnabled).toBe(false);
    expect(bridge.listPersistedApprovals()).toHaveLength(1); // dormant でも見える。
  });

  it("INV-PAL-V2-REVOKE: revoke が該当署名を除去し件数を返す (enabled=false でも可)", () => {
    seed("a".repeat(64), "scopeA", "repoA", 60_000);
    seed("c".repeat(64), "scopeC", "repoC", 60_000);
    const bridge = makeBridge(false); // 永続化 OFF でも revoke できる。
    const removed = bridge.revokePersistedApproval("a".repeat(64));
    expect(removed).toBe(1);
    const remaining = bridge.listPersistedApprovals();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.signature).toBe("c".repeat(64));
  });
});

describe("buildAllowlistResponse (NO-RAW 変換・単一出所)", () => {
  it("op=list は enabled + NO-RAW entries (snake_case) を返す", () => {
    seed("a".repeat(64), "scopeA", "repoA", 60_000);
    const bridge = makeBridge(true);
    const res = buildAllowlistResponse(bridge, {
      type: "allowlist.request",
      request_id: "r1",
      op: "list",
    });
    expect(res).toBeDefined();
    expect(res!.type).toBe("allowlist.response");
    expect(res!.request_id).toBe("r1");
    expect(res!.enabled).toBe(true);
    expect(res!.entries).toHaveLength(1);
    expect(res!.entries[0]).toEqual({
      signature: "a".repeat(64),
      repo_scope: "scopeA",
      repo_label: "repoA",
      risk: "medium",
      created_at_ms: NOW,
      expires_at_ms: NOW + 60_000,
    });
    expect(res!.removed).toBeUndefined(); // list は removed を載せない。
    // INV-PAL-V2-NO-RAW: 応答全体に raw コマンド片が混ざらない。
    expect(JSON.stringify(res)).not.toContain("command");
  });

  it("op=revoke は除去後の最新一覧 + removed を返す", () => {
    seed("a".repeat(64), "scopeA", "repoA", 60_000);
    seed("c".repeat(64), "scopeC", "repoC", 60_000);
    const bridge = makeBridge(true);
    const res = buildAllowlistResponse(bridge, {
      type: "allowlist.request",
      request_id: "r2",
      op: "revoke",
      signature: "a".repeat(64),
      repo_scope: "scopeA",
    });
    expect(res!.removed).toBe(1);
    expect(res!.entries).toHaveLength(1); // revoke 後の最新一覧。
    expect(res!.entries[0]!.signature).toBe("c".repeat(64));
  });

  it("署名なし revoke は no-op (removed=0・全消去しない)", () => {
    seed("a".repeat(64), "scopeA", "repoA", 60_000);
    const bridge = makeBridge(true);
    const res = buildAllowlistResponse(bridge, {
      type: "allowlist.request",
      request_id: "r3",
      op: "revoke",
    });
    expect(res!.removed).toBe(0);
    expect(res!.entries).toHaveLength(1); // 何も消えない。
  });

  it("request_id 不正は undefined (黙殺・diff handler と同型)", () => {
    const bridge = makeBridge(true);
    expect(buildAllowlistResponse(bridge, { type: "allowlist.request" })).toBeUndefined();
    expect(
      buildAllowlistResponse(bridge, { type: "allowlist.request", request_id: "" }),
    ).toBeUndefined();
  });
});
