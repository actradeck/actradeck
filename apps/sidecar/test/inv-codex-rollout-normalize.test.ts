import { describe, expect, it } from "vitest";

import { isUuidV7 } from "@actradeck/event-model";

import {
  normalizeRolloutLine,
  rolloutStartLineage,
  sessionIdFromRolloutPath,
  stableRolloutEventId,
  type CodexRolloutLine,
  type CodexRolloutNormalizeContext,
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
    // ADR 0014 Phase 1: turn_aborted は turn.failed イベントを保つが state は非 terminal `idle`
    //   (session を誤終端させない・poisoning 修正)。「失敗」は直交軸 last_turn_outcome で表す。
    const aborted = one({
      type: "event_msg",
      timestamp: "2026-06-18T03:00:03.000Z",
      payload: { type: "turn_aborted", turn_id: "turn_1", reason: "cancelled" },
    });
    expect(aborted.event_type).toBe("turn.failed");
    expect(aborted.state).toBe("idle");
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

describe("INV-CODEX-ROLLOUT-LINEAGE: run lineage (ADR 0014 Phase 3b-2 D6/D7・REAL DATA)", () => {
  // tailer と同じ配線 (rolloutStartLineage で session_meta payload から lineage を導出し ctx へ載せる)。
  function normalizeMeta(payload: Record<string, unknown>) {
    const lineage = rolloutStartLineage(payload);
    const runId = (payload.id as string | undefined) ?? SESSION;
    const ctx: CodexRolloutNormalizeContext = {
      sessionId: runId,
      cwd: "/repo",
      byteOffset: 0,
      sourcePath: SOURCE_PATH,
      providerSessionId: lineage.providerSessionId,
      resumedFromSessionId: lineage.resumedFromSessionId,
      startKind: lineage.startKind,
    };
    return { ctx, lineage };
  }
  function startedFromMeta(payload: Record<string, unknown>) {
    const { ctx } = normalizeMeta(payload);
    const events = normalizeRolloutLine(
      { type: "session_meta", timestamp: "2026-07-15T23:39:06.000Z", payload },
      ctx,
    );
    expect(events).toHaveLength(1);
    return events[0]!;
  }

  it("forked_from_id + distinct stable session_id → resume lineage + provider_session_id 分離 [REAL 019f6637]", () => {
    // 実データ ~/.codex/sessions/rollout-...-019f6637...jsonl: id≠session_id, forked_from=session_id。
    const id = "019f6637-96c4-74f2-91e9-b3b208762cd9";
    const stable = "019f4f85-ec41-7e80-8e8d-857897d73b51";
    const ev = startedFromMeta({
      id,
      session_id: stable,
      forked_from_id: stable,
      cwd: "/repo",
      thread_source: "subagent",
      parent_thread_id: "019f0000-aaaa-7000-8000-000000000000",
    });
    expect(ev.event_type).toBe("session.started");
    // 1-file-1-run 不変: session_id は run/ファイル id のまま。
    expect(ev.session_id).toBe(id);
    // provider_session_id は安定 session_id (id と乖離)。MUTATION: makeEvent を ctx.sessionId 固定に
    //   戻すと本行が RED (distinct が消える)。
    expect(ev.provider_session_id).toBe(stable);
    expect(ev.provider_session_id).not.toBe(ev.session_id);
    // lineage エッジ。MUTATION: forked_from→resumed_from 写像を外すと RED。
    expect(ev.start_kind).toBe("resume");
    expect(ev.resumed_from_session_id).toBe(stable);
    // parent_thread_id は payload-only (resumed_from に写像しない)。
    expect((ev.payload as { parent_thread_id?: string }).parent_thread_id).toBe(
      "019f0000-aaaa-7000-8000-000000000000",
    );
  });

  it("forked_from_id referencing an observed sibling rollout id, no stable session_id → provider_session_id falls back to run id [REAL 019df85e→019df343]", () => {
    // 実データ: child 019df85e forked_from parent 019df343 (両方 disk 上・session_id 無し)。
    const id = "019df85e-d921-76f2-84dd-53e5102be2c3";
    const parent = "019df343-27d1-7eb1-895c-61433424c1a7";
    const ev = startedFromMeta({ id, forked_from_id: parent, cwd: "/repo" });
    expect(ev.session_id).toBe(id);
    // session_id 欠落 → provider_session_id は run id へ fallback (common case: 両者同値)。
    expect(ev.provider_session_id).toBe(id);
    expect(ev.start_kind).toBe("resume");
    expect(ev.resumed_from_session_id).toBe(parent);
  });

  it("WITHOUT forked_from_id → start_kind unknown, resumed_from absent (observe-only honesty・NOT fresh) [REAL 019f6669]", () => {
    const id = "019f6669-9969-7213-b7bf-68f5f75c7f31";
    const stable = "019f4f85-ec41-7e80-8e8d-857897d73b51";
    const ev = startedFromMeta({ id, session_id: stable, cwd: "/repo", thread_source: "subagent" });
    expect(ev.session_id).toBe(id);
    // 安定 session_id は forked が無くても provider_session_id として分離される。
    expect(ev.provider_session_id).toBe(stable);
    // MUTATION: startKind を "fresh" 固定にすると RED (over-claim 禁止)。
    expect(ev.start_kind).toBe("unknown");
    expect(ev.resumed_from_session_id).toBeUndefined();
  });

  it("bare session_meta (id のみ) → provider_session_id===session_id, start_kind unknown", () => {
    const ev = startedFromMeta({ id: SESSION, cwd: "/repo" });
    expect(ev.provider_session_id).toBe(SESSION);
    expect(ev.session_id).toBe(SESSION);
    expect(ev.start_kind).toBe("unknown");
    expect(ev.resumed_from_session_id).toBeUndefined();
  });

  it("lineage エッジは session.started のみ・provider_session_id は全イベントに載る", () => {
    const id = "019f6637-96c4-74f2-91e9-b3b208762cd9";
    const stable = "019f4f85-ec41-7e80-8e8d-857897d73b51";
    const { ctx } = normalizeMeta({ id, session_id: stable, forked_from_id: stable });
    const turn = normalizeRolloutLine(
      {
        type: "event_msg",
        timestamp: "2026-07-15T23:40:00.000Z",
        payload: { type: "task_started", turn_id: "t1" },
      },
      ctx,
    );
    expect(turn).toHaveLength(1);
    expect(turn[0]!.event_type).toBe("turn.started");
    // provider_session_id は全イベントに載る (従来 NULL からの回帰固定)。
    expect(turn[0]!.provider_session_id).toBe(stable);
    // MUTATION: gate を外して lineage を全イベントへ載せると本 2 行が RED。
    expect(turn[0]!.start_kind).toBeUndefined();
    expect(turn[0]!.resumed_from_session_id).toBeUndefined();
  });

  it("rolloutStartLineage 写像規律: parent_thread_id は resumed_from に使わない (subagent spawn ≠ 継続)", () => {
    // parent_thread_id (~99 files) は subagent の親スレッド = spawn 階層で resume ではない。
    const l = rolloutStartLineage({ id: "A", parent_thread_id: "PARENT_SPAWN", session_id: "S" });
    expect(l.resumedFromSessionId).toBeUndefined();
    expect(l.startKind).toBe("unknown");
    expect(l.providerSessionId).toBe("S");
    // forked_from_id のみが継続エッジ。
    const l2 = rolloutStartLineage({ id: "A", forked_from_id: "PARENT" });
    expect(l2.resumedFromSessionId).toBe("PARENT");
    expect(l2.startKind).toBe("resume");
    expect(l2.providerSessionId).toBe("A"); // session_id 無し → id
  });
});
