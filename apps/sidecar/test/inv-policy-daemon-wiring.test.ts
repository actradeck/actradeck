/**
 * INV-POLICY-DAEMON-WIRING (ADR 019f0c3e・QA-2): 両 daemon (managed Sidecar / AttachDaemon) が
 * ApprovalBridge へ承認ポリシー (`...buildBridgePolicyOptions()` 展開) を **実際に注入**していることを
 * real wiring で固定する。
 *
 * 背景 (QA-2): policy 解決 (approval-policy-store) とゲート (approval-bridge) は単体テスト済だが、それを
 * daemon の bridge 構築に結ぶ 1 行 (`policy: ...`) が無検証だった。配線を削除すると bridge.policy=undefined
 * となり bypass は全 defer (純パススルー) へ silent fail-open する — 機能が死ぬのに CI が緑のまま。
 * allowlist wiring (inv-allowlist-daemon-wiring) と対称に固定する。
 *
 * 固定する不変条件 (falsifiable・mutation=`policy:` 行削除で RED):
 *  - policy.json で recursive-rm を有効化した daemon の bridge は、bypassPermissions の `rm -rf` を
 *    **ゲート** (承認カード emit + timeout→deny) する。配線が無ければ defer して emit されない。
 *
 * homedir() 依存 (buildBridgePolicyOptions の loadApprovalPolicy が ~/.actradeck/approvals/policy.json を読む) ゆえ、実 ~/.actradeck
 * を汚さず非決定性を避けるため HOME を temp へ向け、kill-switch env を ON (未設定) に固定する。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { approvalsPolicyDir, approvalsPolicyPath } from "../src/approval-policy-store.js";
import { AttachDaemon } from "../src/attach-daemon.js";
import type { HookCommonInput } from "../src/normalize.js";
import { Sidecar } from "../src/sidecar.js";

let dir: string;
let origHome: string | undefined;
let origKill: string | undefined;
const closers: Array<() => void> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ad-policy-wiring-"));
  origHome = process.env.HOME;
  origKill = process.env.ACTRADECK_BYPASS_CATASTROPHIC_GATE;
  process.env.HOME = dir; // ~/.actradeck → <dir>/.actradeck
  delete process.env.ACTRADECK_BYPASS_CATASTROPHIC_GATE; // kill-switch OFF=既定 ON にする
  // daemon が起動時に読む policy.json を seed (recursive-rm のみ有効化)。
  mkdirSync(approvalsPolicyDir(dir), { recursive: true });
  writeFileSync(
    approvalsPolicyPath(dir),
    JSON.stringify({ version: 1, enabled: true, categories: ["recursive-rm"] }),
    "utf8",
  );
});

afterEach(() => {
  for (const c of closers.splice(0)) c();
  if (origHome === undefined) delete process.env.HOME;
  else process.env.HOME = origHome;
  if (origKill === undefined) delete process.env.ACTRADECK_BYPASS_CATASTROPHIC_GATE;
  else process.env.ACTRADECK_BYPASS_CATASTROPHIC_GATE = origKill;
  rmSync(dir, { recursive: true, force: true });
});

function bypassRmRf(): HookCommonInput {
  return {
    session_id: "s1",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "rm -rf /tmp/x" },
    permission_mode: "bypassPermissions",
  };
}

/** daemon の bridge が policy を注入されていれば、bypass の recursive-rm をゲートする (emit + deny)。 */
async function assertPolicyWired(bridge: {
  requestApproval: (
    input: HookCommonInput,
    emit: (id: string, reason: unknown) => void,
  ) => Promise<{ behavior: string }>;
}): Promise<void> {
  const emit = vi.fn();
  const r = await bridge.requestApproval(bypassRmRf(), emit);
  expect(
    emit,
    "policy 配線があれば bypass recursive-rm をゲート (承認カード emit)",
  ).toHaveBeenCalledTimes(1);
  expect(r.behavior, "無応答は安全側 deny (配線が無ければ defer)").toBe("deny");
}

describe("INV-POLICY-DAEMON-WIRING (QA-2): 両 daemon が ApprovalBridge へ policy を注入する", () => {
  it("managed Sidecar が policy を注入する", async () => {
    const sidecar = new Sidecar({
      sessionId: "s1",
      wsUrl: "ws://127.0.0.1:1/never",
      dbPath: ":memory:",
      approvalTimeoutMs: 20,
    });
    closers.push(() => sidecar.store.close());
    await assertPolicyWired(sidecar.approvalBridge);
  });

  it("AttachDaemon が policy を注入する", async () => {
    const daemon = new AttachDaemon({
      wsUrl: "ws://127.0.0.1:1/never",
      dbPath: join(dir, "attach.db"),
      hookToken: "tok",
      host: "127.0.0.1",
      approvalTimeoutMs: 20,
    });
    closers.push(() => void daemon.shutdown());
    await assertPolicyWired(daemon.approvalBridge);
  });
});
