/**
 * INV-CODEX-NORMALIZE — Codex ServerNotification (b) + item.type (c) → NormalizedEvent 写像。
 *
 * 仕様出所: 実 codex 0.137.0 generate-json-schema (ServerNotification 64 variant)。
 * fixture は実 schema 準拠の JSON 形。各写像が正しい event_type / state / 相関キーを持ち
 * parseEvent (T1) を通ること、未知 method が drop されることを assert する。
 */
import { describe, expect, it } from "vitest";

import { normalizeCodexNotification, type CodexNormalizeContext } from "../src/normalize-codex.js";

const CTX: CodexNormalizeContext = {
  sessionId: "019ea327-2f0f-7840-b8ed-d36285b533a1",
  providerSessionId: "019ea327-2f0f-7840-b8ed-d36285b533a1",
};

function one(method: string, params: Record<string, unknown>) {
  const evs = normalizeCodexNotification({ method, params }, CTX);
  expect(evs.length).toBe(1);
  return evs[0]!;
}

describe("INV-CODEX-NORMALIZE: notification (b) mapping", () => {
  it("thread/started → session.started / starting (QA-2: thread_id from thread.id)", () => {
    const ev = one("thread/started", { thread: { id: "T1", sessionId: "S1" } });
    expect(ev.event_type).toBe("session.started");
    expect(ev.state).toBe("starting");
    expect(ev.provider).toBe("codex");
    expect(ev.source).toBe("app_server");
    expect(ev.session_id).toBe(CTX.sessionId);
    expect(ev.provider_session_id).toBe(CTX.providerSessionId);
    // QA-2: thread/started は schema 上 params.thread.id (flat threadId 不在)。join キー
    //   thread_id を thread.id から補完すること (欠落を赤で固定)。
    expect(ev.thread_id).toBe("T1");
  });

  it("turn/started → turn.started / running.model_wait, turn_id from turn.id", () => {
    const ev = one("turn/started", {
      threadId: "T1",
      turn: { id: "turn_1", status: "inProgress" },
    });
    expect(ev.event_type).toBe("turn.started");
    expect(ev.state).toBe("running.model_wait");
    expect(ev.thread_id).toBe("T1");
    expect(ev.turn_id).toBe("turn_1");
  });

  it("turn/plan/updated → turn.plan.updated / running.planning, turn_id flat", () => {
    const ev = one("turn/plan/updated", {
      threadId: "T1",
      turnId: "turn_1",
      explanation: "do X then Y",
      plan: [
        { step: "step a", status: "pending" },
        { step: "step b", status: "pending" },
      ],
    });
    expect(ev.event_type).toBe("turn.plan.updated");
    expect(ev.state).toBe("running.planning");
    expect(ev.turn_id).toBe("turn_1");
    expect((ev.payload as { steps?: string[] }).steps).toEqual(["step a", "step b"]);
  });

  it("turn/diff/updated → diff.updated / running.file_editing", () => {
    const ev = one("turn/diff/updated", {
      threadId: "T1",
      turnId: "turn_1",
      diff: "--- a\n+++ b\n",
    });
    expect(ev.event_type).toBe("diff.updated");
    expect(ev.state).toBe("running.file_editing");
    expect((ev.payload as { diff?: string }).diff).toContain("+++ b");
  });

  it("turn/completed → turn.completed, state omitted (turn 終端・非 session 終端)", () => {
    const ev = one("turn/completed", {
      threadId: "T1",
      turn: { id: "turn_1", status: "completed" },
    });
    expect(ev.event_type).toBe("turn.completed");
    expect(ev.state).toBeUndefined();
  });

  it("item/agentMessage/delta → agent.message.delta / running.model_streaming", () => {
    const ev = one("item/agentMessage/delta", {
      threadId: "T1",
      turnId: "turn_1",
      itemId: "i1",
      delta: "hello",
    });
    expect(ev.event_type).toBe("agent.message.delta");
    expect(ev.state).toBe("running.model_streaming");
    expect((ev.payload as { delta?: string }).delta).toBe("hello");
  });

  it("item/reasoning/summaryTextDelta + textDelta + summaryPartAdded → agent.reasoning_summary.delta", () => {
    for (const m of ["item/reasoning/summaryTextDelta", "item/reasoning/textDelta"]) {
      const ev = one(m, {
        threadId: "T1",
        turnId: "turn_1",
        itemId: "i1",
        delta: "think",
        summaryIndex: 0,
      });
      expect(ev.event_type).toBe("agent.reasoning_summary.delta");
      expect(ev.state).toBe("running.model_streaming");
    }
    const part = one("item/reasoning/summaryPartAdded", {
      threadId: "T1",
      turnId: "turn_1",
      itemId: "i1",
      summaryIndex: 1,
    });
    expect(part.event_type).toBe("agent.reasoning_summary.delta");
    expect((part.payload as { delta?: string }).delta).toBe("");
  });

  it("item/commandExecution/outputDelta → command.output.delta / running.command_executing", () => {
    const ev = one("item/commandExecution/outputDelta", {
      threadId: "T1",
      turnId: "turn_1",
      itemId: "i1",
      delta: "stdout chunk",
    });
    expect(ev.event_type).toBe("command.output.delta");
    expect(ev.state).toBe("running.command_executing");
    expect((ev.payload as { stream?: string }).stream).toBe("stdout");
  });

  it("item/fileChange/patchUpdated → file.change.proposed / running.file_editing", () => {
    const ev = one("item/fileChange/patchUpdated", {
      threadId: "T1",
      turnId: "turn_1",
      itemId: "i1",
      changes: [{ path: "/repo/x.ts", kind: "update", diff: "..." }],
    });
    expect(ev.event_type).toBe("file.change.proposed");
    expect(ev.state).toBe("running.file_editing");
    expect((ev.payload as { path?: string }).path).toBe("/repo/x.ts");
  });

  it("thread/compacted → context.compacted / compacting", () => {
    const ev = one("thread/compacted", { threadId: "T1", turnId: "turn_1" });
    expect(ev.event_type).toBe("context.compacted");
    expect(ev.state).toBe("compacting");
  });

  it("thread/status/changed idle → heartbeat / idle, active → drop", () => {
    const idle = one("thread/status/changed", { threadId: "T1", status: { type: "idle" } });
    expect(idle.event_type).toBe("heartbeat");
    expect(idle.state).toBe("idle");
    const active = normalizeCodexNotification(
      {
        method: "thread/status/changed",
        params: { threadId: "T1", status: { type: "active", activeFlags: [] } },
      },
      CTX,
    );
    expect(active.length).toBe(0); // active は省略 (維持)
    const sysErr = one("thread/status/changed", {
      threadId: "T1",
      status: { type: "systemError" },
    });
    expect(sysErr.event_type).toBe("error");
    expect(sysErr.state).toBe("failed");
  });

  it("thread/closed → session.ended / completed", () => {
    const ev = one("thread/closed", { threadId: "T1" });
    expect(ev.event_type).toBe("session.ended");
    expect(ev.state).toBe("completed");
  });

  it("process/exited → DROP (AGG-1: process/spawn ライフサイクル通知・session 終端ではない)", () => {
    // ProcessExitedNotification は "Final process exit notification for `process/spawn`" であり
    // client 供給 processHandle の補助子プロセス終了通知 (threadId 不在)。MVP で process/spawn を
    // 送らず実 codex も emit しない dead path。session.ended に写像すると schema 違反契約を pin する
    // 偽ゲートになるため **drop ([])** に反転固定する。真の終端源は child OS exit と thread/closed。
    const base = {
      processHandle: "p1",
      stdout: "",
      stderr: "",
      stdoutCapReached: false,
      stderrCapReached: false,
    };
    expect(
      normalizeCodexNotification(
        { method: "process/exited", params: { exitCode: 0, ...base } },
        CTX,
      ),
    ).toEqual([]);
    expect(
      normalizeCodexNotification(
        { method: "process/exited", params: { exitCode: 137, ...base } },
        CTX,
      ),
    ).toEqual([]);
  });

  it("error willRetry=true → state 維持(undefined) / false → failed", () => {
    const retry = one("error", {
      threadId: "T1",
      turnId: "turn_1",
      error: { message: "rate limit" },
      willRetry: true,
    });
    expect(retry.event_type).toBe("error");
    expect(retry.state).toBeUndefined();
    expect((retry.payload as { retryable?: boolean }).retryable).toBe(true);
    const fail = one("error", {
      threadId: "T1",
      turnId: "turn_1",
      error: { message: "fatal" },
      willRetry: false,
    });
    expect(fail.state).toBe("failed");
  });

  it("thread/tokenUsage/updated → heartbeat with metrics", () => {
    const ev = one("thread/tokenUsage/updated", {
      threadId: "T1",
      turnId: "turn_1",
      tokenUsage: {
        last: {
          inputTokens: 1,
          outputTokens: 2,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: 3,
        },
        total: {
          inputTokens: 100,
          outputTokens: 50,
          cachedInputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: 150,
        },
      },
    });
    expect(ev.event_type).toBe("heartbeat");
    expect(ev.metrics.tokens_in).toBe(100);
    expect(ev.metrics.tokens_out).toBe(50);
  });

  it("unknown / MVP-excluded method → drop (空配列, no throw)", () => {
    for (const m of [
      "mcpServer/startupStatus/updated",
      "remoteControl/status/changed",
      "thread/realtime/outputAudio/delta",
      "marketplace/whatever",
      "fuzzyFileSearch/sessionUpdated",
      "totally/unknown/method",
    ]) {
      expect(normalizeCodexNotification({ method: m, params: {} }, CTX)).toEqual([]);
    }
  });
});

describe("INV-CODEX-NORMALIZE: item.type (c) discriminator", () => {
  function item(
    phase: "started" | "completed",
    item: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) {
    const method = phase === "started" ? "item/started" : "item/completed";
    const params = {
      threadId: "T1",
      turnId: "turn_1",
      item,
      ...extra,
      ...(phase === "started" ? { startedAtMs: 1 } : { completedAtMs: 2 }),
    };
    return normalizeCodexNotification({ method, params }, CTX);
  }

  it("commandExecution started → command.started, completed → command.completed (exitCode/status)", () => {
    const s = item("started", {
      type: "commandExecution",
      id: "c1",
      command: "ls -la",
      status: "inProgress",
    });
    expect(s[0]!.event_type).toBe("command.started");
    expect(s[0]!.state).toBe("running.command_executing");
    const c = item("completed", {
      type: "commandExecution",
      id: "c1",
      command: "ls -la",
      status: "failed",
      exitCode: 2,
    });
    expect(c[0]!.event_type).toBe("command.completed");
    expect((c[0]!.payload as { exit_code?: number; status?: string }).exit_code).toBe(2);
    expect((c[0]!.payload as { status?: string }).status).toBe("failed");
  });

  it("fileChange started → proposed; completed status=completed → applied, declined → proposed", () => {
    const s = item("started", {
      type: "fileChange",
      id: "f1",
      status: "inProgress",
      changes: [{ path: "/a", kind: "update", diff: "" }],
    });
    expect(s[0]!.event_type).toBe("file.change.proposed");
    const applied = item("completed", {
      type: "fileChange",
      id: "f1",
      status: "completed",
      changes: [{ path: "/a", kind: "update", diff: "" }],
    });
    expect(applied[0]!.event_type).toBe("file.change.applied");
    const declined = item("completed", {
      type: "fileChange",
      id: "f1",
      status: "declined",
      changes: [{ path: "/a", kind: "update", diff: "" }],
    });
    expect(declined[0]!.event_type).toBe("file.change.proposed");
  });

  it("mcpToolCall started → mcp.call.started, completed → mcp.call.completed", () => {
    const s = item("started", {
      type: "mcpToolCall",
      id: "m1",
      server: "srv",
      tool: "do",
      status: "inProgress",
    });
    expect(s[0]!.event_type).toBe("mcp.call.started");
    expect(s[0]!.state).toBe("running.mcp_tool_calling");
    const c = item("completed", {
      type: "mcpToolCall",
      id: "m1",
      server: "srv",
      tool: "do",
      status: "completed",
    });
    expect(c[0]!.event_type).toBe("mcp.call.completed");
  });

  it("webSearch started → web.search.started; completed → heartbeat (専用 type 無し)", () => {
    const s = item("started", { type: "webSearch", id: "w1", query: "foo", action: {} });
    expect(s[0]!.event_type).toBe("web.search.started");
    expect(s[0]!.state).toBe("running.web_searching");
    const c = item("completed", { type: "webSearch", id: "w1", query: "foo", action: {} });
    expect(c[0]!.event_type).toBe("heartbeat");
  });

  it("excluded item.type (userMessage/dynamicToolCall/...) → drop", () => {
    for (const t of [
      "userMessage",
      "hookPrompt",
      "dynamicToolCall",
      "collabAgentToolCall",
      "imageView",
      "imageGeneration",
      "enteredReviewMode",
      "exitedReviewMode",
      "contextCompaction",
      "agentMessage",
      "reasoning",
      "plan",
    ]) {
      expect(item("started", { type: t, id: "x" })).toEqual([]);
      expect(item("completed", { type: t, id: "x" })).toEqual([]);
    }
  });
});
