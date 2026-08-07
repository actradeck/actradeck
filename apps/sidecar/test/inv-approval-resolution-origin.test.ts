/**
 * INV-APPROVAL-RESOLUTION-ORIGIN (ADR 0014 Phase 4・decision 019fd705):
 * tool.permission.resolved の resolution_origin / delivery_status が **実際に起きたこと** から
 * 導出されること (「deny を送った」と偽らない) を、CC hook (実 HTTP) と codex (bridge 直結) の
 * 両経路で固定する。
 *
 * 契約 (写像表・ADR 0014 §Phase 4):
 *  - operator 決定           → origin="operator"  + delivery="sent" (応答書込成功時)
 *  - タイムアウト             → origin="timeout"   + delivery="sent" (クライアント生存時)
 *  - hook クライアント切断    → origin="child_exit" + delivery="not_sent" + **即時解決** (30s 宙吊りしない)
 *  - graceful shutdown drain → origin="shutdown"
 *  - codex child exit        → origin="child_exit" + delivery="not_sent" (死 pipe へ書かない)
 *  - codex sendResponse 失敗 → delivery="not_sent" (送れていないのに sent と言わない)
 *  - NO-RAW: resolved payload は kind/request_id/decision/resolution_origin/delivery_status のみ。
 */
import { describe, expect, it, vi } from "vitest";

import type { NormalizedEvent } from "@actradeck/event-model";

import { ApprovalBridge } from "../src/approval-bridge.js";
import { CodexApprovalBridge } from "../src/approval-bridge-codex.js";
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

async function postHook(port: number, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${port}/hook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(signal !== undefined ? { signal } : {}),
  });
  const text = await res.text();
  return text.length > 0 ? JSON.parse(text) : {};
}

const HIGH_RISK_BODY = {
  session_id: "s1",
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "rm -rf /tmp/x" },
};

type ResolvedPayload = {
  request_id?: string;
  decision?: string;
  resolution_origin?: string;
  delivery_status?: string;
};

function findResolved(events: NormalizedEvent[]): ResolvedPayload | undefined {
  return events.find((e) => e.event_type === "tool.permission.resolved")?.payload as
    | ResolvedPayload
    | undefined;
}

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

async function waitFor(cond: () => boolean, budgetMs = 2000): Promise<void> {
  for (let i = 0; i < budgetMs / 5 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
}

describe("INV-APPROVAL-RESOLUTION-ORIGIN: CC hook 経路 (実 HTTP)", () => {
  it("operator allow → origin=operator + delivery=sent (+ summary は従来表示)", async () => {
    const { emit, events } = makeSink();
    const bridge = new ApprovalBridge({ timeoutMs: 5000 });
    const receiver = new HookReceiver({
      sink: { emit } as unknown as EventSink,
      approvalBridge: bridge,
    });
    const port = await receiver.listen();
    try {
      const pending = postHook(port, HIGH_RISK_BODY);
      const reqId = await waitForRequestId(events);
      expect(bridge.resolve(reqId, "allow", "user approved")).toBe(true);
      await pending;

      const resolved = findResolved(events);
      expect(resolved?.decision).toBe("allow");
      expect(resolved?.resolution_origin).toBe("operator");
      expect(resolved?.delivery_status).toBe("sent");
      const summary = events.find((e) => e.event_type === "tool.permission.resolved")?.summary;
      expect(summary).toBe("承認 許可"); // operator は従来表示のまま (suffix 無し)。
    } finally {
      await receiver.close();
    }
  });

  it("timeout → origin=timeout + delivery=sent (クライアント生存・deny は実際に届く)", async () => {
    const { emit, events } = makeSink();
    const receiver = new HookReceiver({
      sink: { emit } as unknown as EventSink,
      approvalBridge: new ApprovalBridge({ timeoutMs: 40 }),
    });
    const port = await receiver.listen();
    try {
      const out = (await postHook(port, HIGH_RISK_BODY)) as {
        hookSpecificOutput?: { permissionDecision?: string };
      };
      expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");

      const resolved = findResolved(events);
      expect(resolved?.decision).toBe("deny");
      expect(resolved?.resolution_origin).toBe("timeout");
      expect(resolved?.delivery_status).toBe("sent"); // 実際にクライアントへ書けた。
      const summary = events.find((e) => e.event_type === "tool.permission.resolved")?.summary;
      expect(summary).toBe("承認 拒否 (タイムアウト)");
    } finally {
      await receiver.close();
    }
  });

  it("hook クライアント切断 → origin=child_exit + delivery=not_sent を **即時** 解決 (30s 宙吊りしない)", async () => {
    const { emit, events } = makeSink();
    // timeout を長く (10s) 取り、切断検知が timeout でなく 'close' で解決したことを時間で判別する。
    const bridge = new ApprovalBridge({ timeoutMs: 10_000 });
    const receiver = new HookReceiver({
      sink: { emit } as unknown as EventSink,
      approvalBridge: bridge,
    });
    const port = await receiver.listen();
    try {
      const aborter = new AbortController();
      const pending = postHook(port, HIGH_RISK_BODY, aborter.signal).catch(() => undefined);
      await waitForRequestId(events);
      expect(bridge.pendingCount).toBe(1);

      const startedAt = Date.now();
      aborter.abort(); // CC プロセス消失を模す (hook HTTP 接続の切断)。
      await pending;

      // 'close' 検知で即時 deny 解決される (timeout 10s を待たない)。
      await waitFor(() => bridge.pendingCount === 0);
      await waitFor(() => findResolved(events) !== undefined);
      expect(Date.now() - startedAt).toBeLessThan(5000); // 10s timeout より十分早い。

      const resolved = findResolved(events);
      expect(resolved?.decision).toBe("deny");
      expect(resolved?.resolution_origin).toBe("child_exit");
      // 切断済みソケットへは書けない → 「送った」と偽らない。
      expect(resolved?.delivery_status).toBe("not_sent");
    } finally {
      await receiver.close();
    }
  });

  it("shutdown drain → origin=shutdown (+ delivery はクライアント生存なら sent)", async () => {
    const { emit, events } = makeSink();
    const bridge = new ApprovalBridge({ timeoutMs: 10_000 });
    const receiver = new HookReceiver({
      sink: { emit } as unknown as EventSink,
      approvalBridge: bridge,
    });
    const port = await receiver.listen();
    try {
      const pending = postHook(port, HIGH_RISK_BODY);
      await waitForRequestId(events);
      bridge.drain();
      const out = (await pending) as { hookSpecificOutput?: { permissionDecision?: string } };
      expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");

      const resolved = findResolved(events);
      expect(resolved?.resolution_origin).toBe("shutdown");
      expect(resolved?.delivery_status).toBe("sent");
    } finally {
      await receiver.close();
    }
  });

  it("NO-RAW: resolved payload は closed field のみ (raw command/path を再掲しない)", async () => {
    const { emit, events } = makeSink();
    const receiver = new HookReceiver({
      sink: { emit } as unknown as EventSink,
      approvalBridge: new ApprovalBridge({ timeoutMs: 40 }),
    });
    const port = await receiver.listen();
    try {
      await postHook(port, HIGH_RISK_BODY);
      const resolvedEvent = events.find((e) => e.event_type === "tool.permission.resolved");
      expect(resolvedEvent).toBeDefined();
      const keys = Object.keys(resolvedEvent!.payload as Record<string, unknown>).sort();
      expect(keys).toEqual(
        ["decision", "delivery_status", "kind", "request_id", "resolution_origin"].sort(),
      );
      expect(JSON.stringify(resolvedEvent!.payload)).not.toContain("rm -rf");
    } finally {
      await receiver.close();
    }
  });
});

describe("INV-APPROVAL-RESOLUTION-ORIGIN: ApprovalBridge 単体契約", () => {
  it("cancelPending は pending を指定 origin で deny 解決し、不在/二重は false (冪等)", async () => {
    const bridge = new ApprovalBridge({ timeoutMs: 10_000 });
    let captured: string | undefined;
    const p = bridge.requestApproval(
      {
        session_id: "s1",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /tmp/x" },
      },
      (requestId) => {
        captured = requestId;
      },
    );
    await waitFor(() => captured !== undefined);
    expect(bridge.pendingRequestIds()).toEqual([captured]);

    expect(bridge.cancelPending(captured!, "child_exit", "client gone")).toBe(true);
    const result = await p;
    expect(result.behavior).toBe("deny");
    expect(result.origin).toBe("child_exit");
    // 二重 cancel / 解決済みへの cancel は no-op false。
    expect(bridge.cancelPending(captured!, "child_exit")).toBe(false);
    expect(bridge.pendingRequestIds()).toEqual([]);
    expect(bridge.cancelPending("unknown-id", "child_exit")).toBe(false);
  });

  it("resolve()=operator / timeout / drain=shutdown が ApprovalResult.origin を設定する", async () => {
    // operator
    const b1 = new ApprovalBridge({ timeoutMs: 10_000 });
    let id1: string | undefined;
    const p1 = b1.requestApproval(
      { session_id: "s1", hook_event_name: "PermissionRequest", tool_name: "Bash" },
      (rid) => {
        id1 = rid;
      },
    );
    await waitFor(() => id1 !== undefined);
    b1.resolve(id1!, "deny", "no");
    expect((await p1).origin).toBe("operator");

    // timeout
    const b2 = new ApprovalBridge({ timeoutMs: 30 });
    const p2 = b2.requestApproval(
      { session_id: "s1", hook_event_name: "PermissionRequest", tool_name: "Bash" },
      () => {},
    );
    expect((await p2).origin).toBe("timeout");

    // drain → shutdown
    const b3 = new ApprovalBridge({ timeoutMs: 10_000 });
    let id3: string | undefined;
    const p3 = b3.requestApproval(
      { session_id: "s1", hook_event_name: "PermissionRequest", tool_name: "Bash" },
      (rid) => {
        id3 = rid;
      },
    );
    await waitFor(() => id3 !== undefined);
    b3.drain();
    expect((await p3).origin).toBe("shutdown");
  });
});

describe("INV-APPROVAL-RESOLUTION-ORIGIN: codex 経路 (CodexApprovalBridge)", () => {
  interface CodexHarness {
    bridge: ApprovalBridge;
    codex: CodexApprovalBridge;
    resolvedCalls: { requestId: string; decision: string; origin?: string; delivery: string }[];
    sentResponses: unknown[];
    cardRequestIds: string[];
  }

  function makeCodexHarness(opts?: { timeoutMs?: number; sendThrows?: boolean }): CodexHarness {
    const bridge = new ApprovalBridge({ timeoutMs: opts?.timeoutMs ?? 10_000 });
    const resolvedCalls: CodexHarness["resolvedCalls"] = [];
    const sentResponses: unknown[] = [];
    const cardRequestIds: string[] = [];
    const codex = new CodexApprovalBridge({
      bridge,
      sessionId: () => "s1",
      emitCard: (_card, requestId) => {
        cardRequestIds.push(requestId);
      },
      emitResolved: (requestId, decision, origin, delivery) => {
        resolvedCalls.push({
          requestId,
          decision,
          ...(origin !== undefined ? { origin } : {}),
          delivery,
        });
      },
      sendResponse: (_id, result) => {
        if (opts?.sendThrows === true) throw new Error("dead pipe");
        sentResponses.push(result);
      },
    });
    return { bridge, codex, resolvedCalls, sentResponses, cardRequestIds };
  }

  const EXEC_PARAMS = { command: ["rm", "-rf", "/tmp/x"], cwd: "/tmp" };

  it("operator allow → emitResolved(origin=operator, delivery=sent) + Response 送出", async () => {
    const h = makeCodexHarness();
    expect(h.codex.handleServerRequest(1, "execCommandApproval", EXEC_PARAMS)).toBe(true);
    await waitFor(() => h.cardRequestIds.length === 1);
    expect(h.bridge.resolve(h.cardRequestIds[0]!, "allow", "user approved")).toBe(true);
    await waitFor(() => h.resolvedCalls.length === 1);

    expect(h.resolvedCalls[0]).toEqual({
      requestId: h.cardRequestIds[0],
      decision: "allow",
      origin: "operator",
      delivery: "sent",
    });
    expect(h.sentResponses).toHaveLength(1);
  });

  it("timeout → emitResolved(origin=timeout, delivery=sent・decline は実際に送れた)", async () => {
    const h = makeCodexHarness({ timeoutMs: 40 });
    h.codex.handleServerRequest(2, "execCommandApproval", EXEC_PARAMS);
    await waitFor(() => h.resolvedCalls.length === 1);

    expect(h.resolvedCalls[0]!.decision).toBe("deny");
    expect(h.resolvedCalls[0]!.origin).toBe("timeout");
    expect(h.resolvedCalls[0]!.delivery).toBe("sent");
    expect(h.sentResponses).toHaveLength(1); // decline は child 生存中に実送出。
  });

  it("child exit (cancelInFlight) → origin=child_exit + delivery=not_sent + Response 非送出", async () => {
    const h = makeCodexHarness();
    h.codex.handleServerRequest(3, "execCommandApproval", EXEC_PARAMS);
    await waitFor(() => h.cardRequestIds.length === 1);
    expect(h.bridge.pendingCount).toBe(1);

    h.codex.cancelInFlight();
    await waitFor(() => h.resolvedCalls.length === 1);

    expect(h.resolvedCalls[0]).toEqual({
      requestId: h.cardRequestIds[0],
      decision: "deny",
      origin: "child_exit",
      delivery: "not_sent",
    });
    expect(h.sentResponses).toHaveLength(0); // 死 pipe へ書かない。
    expect(h.bridge.pendingCount).toBe(0); // bridge pending も即解決 (30s 宙吊りしない)。
    // 遅延 microtask (.then(finish)) が走っても二重 emit しない。
    await new Promise((r) => setTimeout(r, 20));
    expect(h.resolvedCalls).toHaveLength(1);
  });

  it("sendResponse の同期 throw (死 pipe) → delivery=not_sent (「送った」と偽らない)", async () => {
    const h = makeCodexHarness({ sendThrows: true });
    h.codex.handleServerRequest(4, "execCommandApproval", EXEC_PARAMS);
    await waitFor(() => h.cardRequestIds.length === 1);
    h.bridge.resolve(h.cardRequestIds[0]!, "deny", "user denied");
    await waitFor(() => h.resolvedCalls.length === 1);

    expect(h.resolvedCalls[0]!.origin).toBe("operator");
    expect(h.resolvedCalls[0]!.delivery).toBe("not_sent");
  });
});
