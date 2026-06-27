/**
 * PAL-v2 (ADR 019ee147・QA-1 H 着地): sidecar daemon の allowlist 配線 INV (real wiring)。
 *
 * 背景 (QA-1): buildAllowlistResponse は単体テスト済だが、それを認可済 inbound 制御チャネルに結ぶ
 * 配線 (`wsClient.on("allowlistRequest")` → buildAllowlistResponse → `respondAllowlist`) が両 daemon
 * (attach-daemon / managed sidecar) で無検証だった。配線を削除しても機能が死ぬのに CI が緑のまま。
 * diff 経路 (inv-attach-diff-relay.test.ts の emit("diffRequest")→respondDiff spy) と対称に固定する。
 *
 * 固定する不変条件 (falsifiable・mutation=配線削除で RED):
 *  - 認可済 allowlist.request(list) を emit すると respondAllowlist が NO-RAW entries 付きで呼ばれる。
 *  - allowlist.request(revoke) で disk から該当署名が除去され removed が返る (1 往復で最新一覧)。
 *  - request_id 欠落は黙殺 (respondAllowlist を呼ばない・diff handler と同型)。
 *
 * store は homedir() 依存ゆえ、実 ~/.actradeck を汚さず非決定性を避けるため HOME を temp へ向ける。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApprovalAllowlistStore, approvalsStorePath } from "../src/approval-allowlist-store.js";
import { AttachDaemon } from "../src/attach-daemon.js";
import { Sidecar } from "../src/sidecar.js";

const SIG = "a".repeat(64);
const SCOPE = "scope12abcde";

let dir: string;
let origHome: string | undefined;
let origFlag: string | undefined;
const closers: Array<() => void> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pal-v2-wiring-"));
  origHome = process.env.HOME;
  origFlag = process.env.ACTRADECK_PERSIST_APPROVALS;
  process.env.HOME = dir; // ~/.actradeck → <dir>/.actradeck (uv_os_homedir は HOME を優先)
  process.env.ACTRADECK_PERSIST_APPROVALS = "1"; // enabled=true を観測する
  // daemon が読むのと同一パスへ 1 件 seed (生コマンドは保存しない=NO-RAW)。
  const store = new ApprovalAllowlistStore({ path: approvalsStorePath(dir) });
  store.add({
    signature: SIG,
    repoScope: SCOPE,
    repoLabel: "myrepo",
    risk: "medium",
    ttlMs: 60_000,
    now: Date.now(),
  });
});

afterEach(() => {
  for (const c of closers.splice(0)) c();
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origFlag === undefined) delete process.env.ACTRADECK_PERSIST_APPROVALS;
  else process.env.ACTRADECK_PERSIST_APPROVALS = origFlag;
  rmSync(dir, { recursive: true, force: true });
});

type AllowlistResp = {
  type: string;
  request_id: string;
  enabled: boolean;
  entries: ReadonlyArray<Record<string, unknown>>;
  removed?: number;
};

/** daemon の wsClient を持つ最小インターフェース (attach / managed 共通)。 */
interface HasWsClient {
  readonly wsClient: {
    emit: (event: string, ...args: unknown[]) => boolean;
    respondAllowlist: (msg: unknown) => void;
  };
}

function assertWiring(d: HasWsClient): void {
  const spy = vi.spyOn(d.wsClient, "respondAllowlist");

  // (1) list: 認可済 allowlist.request を emit → respondAllowlist が NO-RAW entries 付きで呼ばれる。
  d.wsClient.emit("allowlistRequest", { type: "allowlist.request", request_id: "r1", op: "list" });
  expect(spy, "list wiring must call respondAllowlist").toHaveBeenCalledTimes(1);
  const listResp = spy.mock.calls[0]![0] as AllowlistResp;
  expect(listResp.type).toBe("allowlist.response");
  expect(listResp.request_id).toBe("r1");
  expect(listResp.enabled).toBe(true);
  expect(listResp.entries).toHaveLength(1);
  expect(listResp.entries[0]!.signature).toBe(SIG);
  expect(listResp.entries[0]!.repo_scope).toBe(SCOPE);
  // NO-RAW: 生コマンド片が応答に混ざらない。
  expect(JSON.stringify(listResp)).not.toContain("command");

  // (2) revoke: 該当署名を disk から除去し removed + 最新一覧 (0 件) を返す。
  d.wsClient.emit("allowlistRequest", {
    type: "allowlist.request",
    request_id: "r2",
    op: "revoke",
    signature: SIG,
    repo_scope: SCOPE,
  });
  expect(spy).toHaveBeenCalledTimes(2);
  const revResp = spy.mock.calls[1]![0] as AllowlistResp;
  expect(revResp.removed).toBe(1);
  expect(revResp.entries).toHaveLength(0);

  // (3) request_id 欠落は黙殺 (respondAllowlist を呼ばない)。
  d.wsClient.emit("allowlistRequest", { type: "allowlist.request", op: "list" });
  expect(spy, "missing request_id must be ignored").toHaveBeenCalledTimes(2);

  spy.mockRestore();
}

describe("INV-PAL-V2 daemon allowlist wiring (QA-1)", () => {
  it("attach daemon が allowlistRequest を respondAllowlist へ結線する", () => {
    const daemon = new AttachDaemon({
      wsUrl: "ws://127.0.0.1:1/never",
      dbPath: join(dir, "attach.db"),
      hookToken: "tok",
      host: "127.0.0.1",
    });
    closers.push(() => void daemon.shutdown());
    assertWiring(daemon as unknown as HasWsClient);
  });

  it("managed sidecar が allowlistRequest を respondAllowlist へ結線する", () => {
    const sidecar = new Sidecar({
      sessionId: "s1",
      wsUrl: "ws://127.0.0.1:1/never",
      dbPath: ":memory:",
    });
    closers.push(() => sidecar.store.close());
    assertWiring(sidecar as unknown as HasWsClient);
  });
});
