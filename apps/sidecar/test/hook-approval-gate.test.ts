/**
 * QA-1 (再監査#4): handleApprovalGate の HTTP round-trip 検証 (INV-APPROVAL)。
 *
 * 旧来 handleApprovalGate (hook-receiver.ts:216-279) を貫通する HTTP-level テストが無く、
 * `permissionDecision` の応答 (deny / allow) と low-risk 時の空 `{}`、および sink への解決イベント発行が
 * 無検証退行しうる状態だった (grep permissionDecision test/*.test.ts → 0 件)。
 *
 * 実 HTTP で HookReceiver を listen し、以下を 1 本で固定する:
 *  - high-risk PreToolUse (UI 未接続 = timeout) → permissionDecision === 'deny' かつ
 *    sink に tool.permission.resolved(decision:'deny') が流れる。
 *  - low-risk PreToolUse / PermissionRequest → **空 {}** (INV-HOOK-SUBAGENT-COMPAT:
 *    "defer" 応答は CC の background subagent ランナーを壊す。#67221)。
 *  - PermissionRequest (allow resolve) → hookSpecificOutput.decision.behavior === 'allow'。
 */
import { describe, expect, it, vi } from "vitest";

import type { NormalizedEvent } from "@actradeck/event-model";

import { ApprovalBridge } from "../src/approval-bridge.js";
import { HookReceiver } from "../src/hook-receiver.js";
import type { EventSink } from "../src/sink.js";

interface CapturedSink {
  emit: ReturnType<typeof vi.fn>;
  events: NormalizedEvent[];
}

function makeSink(): CapturedSink {
  const events: NormalizedEvent[] = [];
  const emit = vi.fn((ev: NormalizedEvent) => {
    events.push(ev);
  });
  return { emit, events };
}

async function postHook(port: number, body: unknown): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${port}/hook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return text.length > 0 ? JSON.parse(text) : {};
}

interface PreToolUseOutput {
  hookSpecificOutput?: {
    hookEventName?: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
  };
}

interface PermissionRequestOutput {
  hookSpecificOutput?: {
    hookEventName?: string;
    decision?: { behavior?: string };
  };
}

describe("QA-1: handleApprovalGate HTTP round-trip (INV-APPROVAL)", () => {
  it("high-risk PreToolUse (no UI) round-trips to permissionDecision=deny + resolved(deny) event", async () => {
    const { emit, events } = makeSink();
    const receiver = new HookReceiver({
      sink: { emit } as unknown as EventSink,
      approvalBridge: new ApprovalBridge({ timeoutMs: 40 }),
    });
    const port = await receiver.listen();
    try {
      const out = (await postHook(port, {
        session_id: "s1",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /tmp/x" },
      })) as PreToolUseOutput;

      expect(out.hookSpecificOutput?.hookEventName).toBe("PreToolUse");
      // UI 未接続 → タイムアウト → 安全側 deny (force-allow しない)。
      expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");

      // 承認要求 (waiting.approval) と 解決 (tool.permission.resolved) が sink に流れる。
      const requested = events.find((e) => e.event_type === "tool.permission.requested");
      const resolved = events.find((e) => e.event_type === "tool.permission.resolved");
      expect(resolved, "a tool.permission.resolved event must be emitted").toBeDefined();
      expect((resolved?.payload as { decision?: string } | undefined)?.decision).toBe("deny");

      // QA-3 (ADR 019e99ad): resolved は requested と**同じ request_id を同梱**しなければならない
      // (reducer が pending_approvals から該当 request_id を除去する突合キー)。これが欠けると
      // pending が滞留する。requested→resolved の request_id 一致を契約として固定する。
      const reqId = (requested?.payload as { request_id?: string } | undefined)?.request_id;
      const resId = (resolved?.payload as { request_id?: string } | undefined)?.request_id;
      expect(reqId, "requested must carry a request_id").toBeTruthy();
      expect(resId, "resolved must carry the matching request_id").toBe(reqId);
    } finally {
      await receiver.close();
    }
  });

  // INV-HOOK-SUBAGENT-COMPAT: low-risk PreToolUse の応答は**完全に空の JSON `{}`** でなければ
  // ならない。`permissionDecision: "defer"` を返すと CC 2.1.17x の background subagent ランナーが
  // 処理できず、全 subagent ツール結果が "[Tool result missing due to internal error]" に化ける
  // (upstream anthropics/claude-code#67221・A/B/A + proxy 応答書換で実証)。空 {} は仕様上
  // 「no opinion = 通常 permission flow へ委譲」で、force-allow しない (INV-APPROVAL) も維持する。
  it("low-risk PreToolUse round-trips to EMPTY {} (no hookSpecificOutput / no defer) — INV-HOOK-SUBAGENT-COMPAT", async () => {
    const { emit, events } = makeSink();
    const receiver = new HookReceiver({
      sink: { emit } as unknown as EventSink,
      approvalBridge: new ApprovalBridge({ timeoutMs: 40 }),
    });
    const port = await receiver.listen();
    try {
      const out = await postHook(port, {
        session_id: "s1",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls -la" },
      });

      // 部分一致でなく deep-equal で {} を固定する (キー 1 つでも増えたら赤)。
      expect(out).toEqual({});

      // defer は observe のため command.started を出すが、resolved は出さない (force-allow しない)。
      expect(events.some((e) => e.event_type === "tool.permission.resolved")).toBe(false);
      expect(events.some((e) => e.event_type === "command.started")).toBe(true);
    } finally {
      await receiver.close();
    }
  });

  // PermissionRequest の defer (bypassPermissions: 純観測・decision 019eace6) も空 {} を固定する。
  it("bypassPermissions PermissionRequest round-trips to EMPTY {} — INV-HOOK-SUBAGENT-COMPAT", async () => {
    const { emit, events } = makeSink();
    const receiver = new HookReceiver({
      sink: { emit } as unknown as EventSink,
      approvalBridge: new ApprovalBridge({ timeoutMs: 40 }),
    });
    const port = await receiver.listen();
    try {
      const out = await postHook(port, {
        session_id: "s1",
        hook_event_name: "PermissionRequest",
        permission_mode: "bypassPermissions",
        tool_name: "Bash",
        tool_input: { command: "ls -la" },
      });

      expect(out).toEqual({});
      // PermissionRequest の defer は waiting.approval を出さない (通常フロー委譲)。
      expect(events.some((e) => e.event_type === "tool.permission.requested")).toBe(false);
      expect(events.some((e) => e.event_type === "tool.permission.resolved")).toBe(false);
    } finally {
      await receiver.close();
    }
  });

  it("PermissionRequest with UI allow round-trips to decision.behavior=allow", async () => {
    const { emit, events } = makeSink();
    const bridge = new ApprovalBridge({ timeoutMs: 1000 });
    const receiver = new HookReceiver({
      sink: { emit } as unknown as EventSink,
      approvalBridge: bridge,
    });
    const port = await receiver.listen();
    try {
      // request を投げてから、emit された request_id を拾って UI allow を resolve する。
      const pending = postHook(port, {
        session_id: "s1",
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "npm install" },
      }) as Promise<PermissionRequestOutput>;

      // 承認要求イベントが emit されるまで待ち、request_id を取得して resolve(allow)。
      const requestId = await waitForRequestId(events);
      expect(bridge.resolve(requestId, "allow", "user approved")).toBe(true);

      const out = await pending;
      expect(out.hookSpecificOutput?.hookEventName).toBe("PermissionRequest");
      expect(out.hookSpecificOutput?.decision?.behavior).toBe("allow");

      const resolved = events.find((e) => e.event_type === "tool.permission.resolved");
      expect((resolved?.payload as { decision?: string } | undefined)?.decision).toBe("allow");
    } finally {
      await receiver.close();
    }
  });

  it("段階③: allow_for_session auto-allows the SAME command next time WITHOUT a new card or stray resolved", async () => {
    const { emit, events } = makeSink();
    const bridge = new ApprovalBridge({ timeoutMs: 1000 });
    const receiver = new HookReceiver({
      sink: { emit } as unknown as EventSink,
      approvalBridge: bridge,
    });
    const port = await receiver.listen();
    try {
      const body = {
        session_id: "s1",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /tmp/x" },
      };

      // 1 回目: ゲートされ承認カード (requested) が出る → UI が allow_for_session で許可。
      const pending = postHook(port, body) as Promise<PreToolUseOutput>;
      const reqId = await waitForRequestId(events);
      expect(bridge.resolve(reqId, "allow_for_session", "approved for session")).toBe(true);
      const out1 = await pending;
      expect(out1.hookSpecificOutput?.permissionDecision).toBe("allow");
      const requestedAfter1 = events.filter((e) => e.event_type === "tool.permission.requested");
      expect(requestedAfter1).toHaveLength(1);

      // 2 回目: 同一署名 → UI を経ず即 allow。新しい requested は出ず、
      // request_id 無しの resolved も出さない (他 pending を誤消去しないため)。代わりに観測 (command.started)。
      const out2 = (await postHook(port, body)) as PreToolUseOutput;
      expect(out2.hookSpecificOutput?.permissionDecision).toBe("allow");
      const requested = events.filter((e) => e.event_type === "tool.permission.requested");
      expect(requested, "no new approval card on auto-allow").toHaveLength(1);
      // auto-allow は resolved を出さず command.started を観測として出す。
      const strayResolvedNoReqId = events.filter(
        (e) =>
          e.event_type === "tool.permission.resolved" &&
          (e.payload as { request_id?: string }).request_id === undefined,
      );
      expect(
        strayResolvedNoReqId,
        "auto-allow must not emit a request_id-less resolved",
      ).toHaveLength(0);
      const autoStarted = events.find((e) => e.event_type === "command.started");
      expect(autoStarted).toBeDefined();
      // SEC-2: auto-allow された高リスク観測は auto_allowed マーカーで監査可能 (low-risk と識別)。
      expect((autoStarted?.payload as { auto_allowed?: boolean } | undefined)?.auto_allowed).toBe(
        true,
      );
    } finally {
      await receiver.close();
    }
  });
});

/** waiting.approval イベントの payload.request_id を polling で待つ (最大 1s)。 */
async function waitForRequestId(events: NormalizedEvent[]): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const req = events.find((e) => e.event_type === "tool.permission.requested");
    const id = (req?.payload as { request_id?: string } | undefined)?.request_id;
    if (typeof id === "string" && id.length > 0) return id;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("request_id was not emitted within timeout");
}
