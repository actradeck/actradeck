import { describe, expect, it } from "vitest";

import { isUuidV7 } from "@actradeck/event-model";

import {
  normalizeRolloutLine,
  sessionIdFromRolloutPath,
  stableRolloutEventId,
  type CodexRolloutLine,
} from "../src/normalize-codex-rollout.js";

const SESSION = "019ed895-6f24-70d2-b4b4-35bdcafb06ad";
const SOURCE_PATH = `/tmp/rollout-2026-06-18T11-35-32-${SESSION}.jsonl`;

function normalize(line: CodexRolloutLine, byteOffset = 128) {
  return normalizeRolloutLine(line, {
    sessionId: SESSION,
    cwd: "/repo",
    byteOffset,
    sourcePath: SOURCE_PATH,
  });
}

function one(line: CodexRolloutLine, byteOffset = 128) {
  const events = normalize(line, byteOffset);
  expect(events).toHaveLength(1);
  return events[0]!;
}

describe("INV-CODEX-ROLLOUT-NORMALIZE: rollout JSONL -> canonical EventType", () => {
  it("derives stable UUIDv7 event_id from session + byte offset", () => {
    const ts = "2026-06-18T03:00:00.000Z";
    const a = stableRolloutEventId({
      sessionId: SESSION,
      timestamp: ts,
      byteOffset: 42,
      sourcePath: SOURCE_PATH,
    });
    const b = stableRolloutEventId({
      sessionId: SESSION,
      timestamp: ts,
      byteOffset: 42,
      sourcePath: SOURCE_PATH,
    });
    const c = stableRolloutEventId({
      sessionId: SESSION,
      timestamp: ts,
      byteOffset: 43,
      sourcePath: SOURCE_PATH,
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(isUuidV7(a)).toBe(true);
  });

  it("extracts thread UUID from rollout path", () => {
    expect(sessionIdFromRolloutPath(SOURCE_PATH)).toBe(SESSION);
  });

  it("session_meta -> session.started with source=rollout and capture_mode=codex_rollout", () => {
    const ev = one({
      type: "session_meta",
      timestamp: "2026-06-18T03:00:00.000Z",
      payload: {
        id: SESSION,
        cwd: "/repo",
        cli_version: "0.1.0",
        source: "tui",
        model_provider: "openai",
        git: { branch: "feat/codex-attach" },
      },
    });
    expect(ev.event_type).toBe("session.started");
    expect(ev.provider).toBe("codex");
    expect(ev.source).toBe("rollout");
    expect(ev.capture_mode).toBe("codex_rollout");
    expect(ev.cwd).toBe("/repo");
  });

  it("task lifecycle event_msg variants map to turn.*", () => {
    expect(
      one({
        type: "event_msg",
        timestamp: "2026-06-18T03:00:01.000Z",
        payload: { type: "task_started", turn_id: "turn_1", started_at: "2026-06-18T03:00:01Z" },
      }).event_type,
    ).toBe("turn.started");
    expect(
      one({
        type: "event_msg",
        timestamp: "2026-06-18T03:00:02.000Z",
        payload: { type: "task_complete", turn_id: "turn_1", duration_ms: 123 },
      }).event_type,
    ).toBe("turn.completed");
    expect(
      one({
        type: "event_msg",
        timestamp: "2026-06-18T03:00:03.000Z",
        payload: { type: "turn_aborted", turn_id: "turn_1", reason: "cancelled" },
      }).event_type,
    ).toBe("turn.failed");
  });

  it("assistant message variants -> agent.message.delta", () => {
    expect(
      one({
        type: "event_msg",
        timestamp: "2026-06-18T03:00:04.000Z",
        payload: { type: "agent_message", message: "hello" },
      }).event_type,
    ).toBe("agent.message.delta");
    const ev = one({
      type: "response_item",
      timestamp: "2026-06-18T03:00:05.000Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hello" }],
      },
    });
    expect(ev.event_type).toBe("agent.message.delta");
    expect((ev.payload as { delta?: string }).delta).toBe("hello");
  });

  it("reasoning -> agent.reasoning_summary.delta", () => {
    const ev = one({
      type: "response_item",
      timestamp: "2026-06-18T03:00:06.000Z",
      payload: { type: "reasoning", summary: [{ type: "summary_text", text: "thinking" }] },
    });
    expect(ev.event_type).toBe("agent.reasoning_summary.delta");
  });

  it("function_call exec -> command.started and output -> command.output.delta + command.completed", () => {
    const started = one({
      type: "response_item",
      timestamp: "2026-06-18T03:00:07.000Z",
      payload: {
        type: "function_call",
        name: "exec_command",
        call_id: "call_1",
        arguments: JSON.stringify({ cmd: "pnpm test", workdir: "/repo" }),
      },
    });
    expect(started.event_type).toBe("command.started");
    expect((started.payload as { command?: string }).command).toBe("pnpm test");

    const completed = normalize({
      type: "response_item",
      timestamp: "2026-06-18T03:00:08.000Z",
      payload: { type: "function_call_output", call_id: "call_1", output: "ok" },
    });
    expect(completed.map((e) => e.event_type)).toEqual([
      "command.output.delta",
      "command.completed",
    ]);
    expect(completed[0]!.event_id).not.toBe(completed[1]!.event_id);
  });

  it("MCP function call/end -> mcp.call.started/completed", () => {
    expect(
      one({
        type: "response_item",
        timestamp: "2026-06-18T03:00:09.000Z",
        payload: {
          type: "function_call",
          namespace: "mcp__memorymcp",
          name: "decision_search",
          call_id: "call_mcp",
          arguments: JSON.stringify({ query: "ADR" }),
        },
      }).event_type,
    ).toBe("mcp.call.started");
    const end = one({
      type: "event_msg",
      timestamp: "2026-06-18T03:00:10.000Z",
      payload: {
        type: "mcp_tool_call_end",
        call_id: "call_mcp",
        invocation: { server: "memorymcp", tool: "decision_search", arguments: { query: "ADR" } },
        duration: { secs: 1, nanos: 1_000_000 },
        result: { Ok: "done" },
      },
    });
    expect(end.event_type).toBe("mcp.call.completed");
    expect(end.metrics.elapsed_ms).toBe(1001);
  });

  it("custom/tool search/web search variants map without new EventType", () => {
    expect(
      one({
        type: "response_item",
        timestamp: "2026-06-18T03:00:11.000Z",
        payload: { type: "custom_tool_call", name: "imagegen", input: { prompt: "x" } },
      }).event_type,
    ).toBe("tool.started");
    expect(
      one({
        type: "response_item",
        timestamp: "2026-06-18T03:00:12.000Z",
        payload: { type: "custom_tool_call_output", output: "done" },
      }).event_type,
    ).toBe("tool.completed");
    expect(
      one({
        type: "response_item",
        timestamp: "2026-06-18T03:00:13.000Z",
        payload: { type: "tool_search_call", arguments: JSON.stringify({ query: "x" }) },
      }).event_type,
    ).toBe("tool.started");
    expect(
      one({
        type: "response_item",
        timestamp: "2026-06-18T03:00:14.000Z",
        payload: { type: "tool_search_output", tools: [{ name: "x" }] },
      }).event_type,
    ).toBe("tool.completed");
    expect(
      one({
        type: "response_item",
        timestamp: "2026-06-18T03:00:15.000Z",
        payload: { type: "web_search_call", action: { query: "OpenAI Codex" } },
      }).event_type,
    ).toBe("web.search.started");
  });

  it("patch_apply_end -> file.change.applied + diff.updated", () => {
    const events = normalize({
      type: "event_msg",
      timestamp: "2026-06-18T03:00:16.000Z",
      payload: {
        type: "patch_apply_end",
        status: "completed",
        success: true,
        stdout: "Done",
        stderr: "",
        changes: {
          "/repo/src/a.ts": { type: "update", unified_diff: "@@ -1 +1 @@" },
        },
      },
    });
    expect(events.map((e) => e.event_type)).toEqual(["file.change.applied", "diff.updated"]);
    expect((events[0]!.payload as { path?: string }).path).toBe("/repo/src/a.ts");
  });

  it("context/user/goal gaps map to existing types, token_count and unknown drop", () => {
    expect(
      one({
        type: "event_msg",
        timestamp: "2026-06-18T03:00:17.000Z",
        payload: { type: "context_compacted" },
      }).event_type,
    ).toBe("context.compacted");
    expect(
      one({
        type: "compacted",
        timestamp: "2026-06-18T03:00:18.000Z",
        payload: { message: "compacted", replacement_history: [] },
      }).event_type,
    ).toBe("context.compacted");
    expect(
      one({
        type: "event_msg",
        timestamp: "2026-06-18T03:00:19.000Z",
        payload: { type: "user_message", message: "please run tests" },
      }).event_type,
    ).toBe("turn.started");
    expect(
      one({
        type: "event_msg",
        timestamp: "2026-06-18T03:00:20.000Z",
        payload: { type: "thread_goal_updated", goal: "ship it" },
      }).event_type,
    ).toBe("turn.plan.updated");

    expect(
      normalize({
        type: "event_msg",
        timestamp: "2026-06-18T03:00:21.000Z",
        payload: { type: "token_count", info: {} },
      }),
    ).toEqual([]);
    expect(normalize({ type: "turn_context", payload: { cwd: "/repo" } })).toEqual([]);
    expect(normalize({ type: "unknown", payload: {} })).toEqual([]);
  });

  it("event_id differs across rollout files of the same session at same offset/timestamp [QA-1]", () => {
    const ts = "2026-06-18T03:00:00.000Z";
    // codex resume は同一 threadUUID で新しい rollout ファイルを書く。
    const fileA = `/tmp/rollout-2026-06-18T11-35-32-${SESSION}.jsonl`;
    const fileB = `/tmp/rollout-2026-06-18T12-00-00-${SESSION}.jsonl`;
    const idA = stableRolloutEventId({
      sessionId: SESSION,
      timestamp: ts,
      byteOffset: 100,
      sourcePath: fileA,
    });
    const idB = stableRolloutEventId({
      sessionId: SESSION,
      timestamp: ts,
      byteOffset: 100,
      sourcePath: fileB,
    });
    // sourcePath を seed に含めないと衝突し ON CONFLICT DO NOTHING で別ファイルが silent drop。
    expect(idA).not.toBe(idB);
    // 同一ファイル・同一 offset は冪等 (再 tail で安定)。
    expect(
      stableRolloutEventId({
        sessionId: SESSION,
        timestamp: ts,
        byteOffset: 100,
        sourcePath: fileA,
      }),
    ).toBe(idA);
  });

  it("non-assistant message / web_search_end / empty payload drop safely [QA-2/QA-4]", () => {
    // role!=assistant の message は drop (user prompt は user_message 経路で扱う)。
    expect(
      normalize({
        type: "response_item",
        timestamp: "2026-06-18T03:00:30.000Z",
        payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      }),
    ).toEqual([]);
    // web_search_end は明示 drop (web.search.started のみが canonical)。
    expect(
      normalize({
        type: "event_msg",
        timestamp: "2026-06-18T03:00:31.000Z",
        payload: { type: "web_search_end", query: "x" },
      }),
    ).toEqual([]);
    // 空/欠落 payload は throw せず安全に drop。
    expect(
      normalize({ type: "event_msg", timestamp: "2026-06-18T03:00:32.000Z", payload: {} }),
    ).toEqual([]);
    expect(normalize({ type: "response_item", timestamp: "2026-06-18T03:00:33.000Z" })).toEqual([]);
  });
});
