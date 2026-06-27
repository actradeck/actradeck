/**
 * Codex TUI rollout JSONL -> NormalizedEvent.
 *
 * This mapper intentionally does not redact. All candidates are passed to
 * EventSink.emit(), the existing INV-REDACTION choke point.
 */
import { createHash } from "node:crypto";
import { basename } from "node:path";

import type { EventType, NormalizedEvent, State } from "@actradeck/event-model";
import { parseEvent } from "@actradeck/event-model";

import { assertPayloadConsistency } from "./event-factory.js";

export interface CodexRolloutLine {
  readonly type: string;
  readonly payload?: unknown;
  readonly timestamp?: unknown;
}

export interface CodexRolloutNormalizeContext {
  readonly sessionId: string;
  readonly cwd?: string | undefined;
  readonly byteOffset?: number | undefined;
  readonly lineIndex?: number | undefined;
  readonly sourcePath?: string | undefined;
  readonly onWarning?: ((message: string) => void) | undefined;
}

type Params = Record<string, unknown>;

function asParams(value: unknown): Params {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Params)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseJsonObject(value: unknown): Params {
  if (typeof value !== "string" || value.length === 0) return {};
  try {
    return asParams(JSON.parse(value));
  } catch {
    return {};
  }
}

function warn(ctx: CodexRolloutNormalizeContext, message: string): void {
  ctx.onWarning?.(message);
}

function lineTimestamp(line: CodexRolloutLine, p: Params): string {
  const candidates = [line.timestamp, p.timestamp, p.started_at, p.completed_at];
  for (const c of candidates) {
    const s = asString(c);
    if (s !== undefined && !Number.isNaN(Date.parse(s))) return new Date(s).toISOString();
  }
  return new Date().toISOString();
}

function stableUuidV7(seed: string, timestamp: string): string {
  const hash = createHash("sha256").update(seed).digest();
  const bytes = Buffer.alloc(16);
  const parsed = Date.parse(timestamp);
  let ms = BigInt(Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : 0);
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(ms & 0xffn);
    ms >>= 8n;
  }
  bytes[6] = 0x70 | (hash[0]! & 0x0f);
  bytes[7] = hash[1]!;
  bytes[8] = 0x80 | (hash[2]! & 0x3f);
  for (let i = 9; i < 16; i++) bytes[i] = hash[i - 6]!;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function stableRolloutEventId(args: {
  readonly sessionId: string;
  readonly timestamp: string;
  readonly byteOffset?: number | undefined;
  readonly lineIndex?: number | undefined;
  readonly sourcePath?: string | undefined;
  readonly eventIndex?: number | undefined;
}): string {
  const position = args.byteOffset ?? args.lineIndex ?? 0;
  // QA-1: seed に rollout ファイル名 (basename) を含める。同一 threadUUID の複数 rollout
  //   (codex resume が同 sessionId で新ファイルを書く) で (同 offset ∧ 同 timestamp) でも
  //   event_id が衝突せず、ON CONFLICT DO NOTHING による別ファイルのイベント silent drop を防ぐ。
  //   basename は rollout ファイル名 (timestamp+UUID 入りで一意) ゆえ CODEX_HOME 移動にも頑健。
  const fileTag = args.sourcePath !== undefined ? basename(args.sourcePath) : "";
  const seed = [
    "codex-rollout",
    args.sessionId,
    fileTag,
    String(position),
    String(args.eventIndex ?? 0),
  ].join(":");
  return stableUuidV7(seed, args.timestamp);
}

function makeEvent(
  ctx: CodexRolloutNormalizeContext,
  line: CodexRolloutLine,
  p: Params,
  eventType: EventType,
  state: State | undefined,
  extra: {
    readonly eventIndex?: number | undefined;
    readonly turnId?: string | undefined;
    readonly summary?: string | undefined;
    readonly payload?: Params | undefined;
    readonly metrics?: Record<string, number> | undefined;
    readonly cwd?: string | undefined;
  },
): NormalizedEvent {
  const timestamp = lineTimestamp(line, p);
  const candidate: Record<string, unknown> = {
    event_id: stableRolloutEventId({
      sessionId: ctx.sessionId,
      timestamp,
      byteOffset: ctx.byteOffset,
      lineIndex: ctx.lineIndex,
      sourcePath: ctx.sourcePath,
      eventIndex: extra.eventIndex,
    }),
    provider: "codex",
    source: "rollout",
    capture_mode: "codex_rollout",
    session_id: ctx.sessionId,
    provider_session_id: ctx.sessionId,
    event_type: eventType,
    timestamp,
    payload: { kind: eventType, ...(extra.payload ?? {}) },
    metrics: extra.metrics ?? {},
  };
  if (state !== undefined) candidate.state = state;
  const turnId = extra.turnId ?? asString(p.turn_id) ?? asString(p.turnId);
  if (turnId !== undefined) candidate.turn_id = turnId;
  const cwd = extra.cwd ?? asString(p.cwd) ?? ctx.cwd;
  if (cwd !== undefined) candidate.cwd = cwd;
  if (extra.summary !== undefined) candidate.summary = extra.summary;

  const event = parseEvent(candidate);
  assertPayloadConsistency(event);
  return event;
}

function contentText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const item of content) {
    const obj = asParams(item);
    const text = asString(obj.text);
    if (text !== undefined) parts.push(text);
  }
  return parts.length > 0 ? parts.join("") : undefined;
}

function reasoningText(summary: unknown): string {
  if (typeof summary === "string") return summary;
  if (!Array.isArray(summary)) return "";
  const parts: string[] = [];
  for (const item of summary) {
    const obj = asParams(item);
    const text = asString(obj.text) ?? asString(obj.summary);
    if (text !== undefined) parts.push(text);
  }
  return parts.join("");
}

function toolNameFromNamespace(
  namespace: string | undefined,
  name: string | undefined,
): {
  server: string;
  tool: string;
} {
  const ns = namespace?.startsWith("mcp__") ? namespace.slice("mcp__".length) : namespace;
  return { server: ns ?? "unknown", tool: name ?? "unknown" };
}

function commandFromArguments(name: string | undefined, args: Params): string {
  return (
    asString(args.cmd) ??
    asString(args.command) ??
    asString(args.input) ??
    asString(args.query) ??
    name ??
    "unknown"
  );
}

function elapsedMs(duration: unknown): number | undefined {
  const d = asParams(duration);
  const secs = asNumber(d.secs);
  const nanos = asNumber(d.nanos);
  if (secs === undefined && nanos === undefined) return undefined;
  return (secs ?? 0) * 1000 + Math.round((nanos ?? 0) / 1_000_000);
}

function changedPaths(changes: unknown): string[] {
  if (Array.isArray(changes)) {
    return changes
      .map((c) => asString(asParams(c).path))
      .filter((p): p is string => p !== undefined);
  }
  const obj = asParams(changes);
  return Object.keys(obj);
}

function hashUnknown(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value ?? null))
    .digest("hex");
}

function normalizeResponseItem(
  ctx: CodexRolloutNormalizeContext,
  line: CodexRolloutLine,
  p: Params,
): NormalizedEvent[] {
  const payloadType = asString(p.type);
  switch (payloadType) {
    case "message": {
      const role = asString(p.role);
      if (role !== "assistant") return [];
      const text = contentText(p.content);
      if (text === undefined) return [];
      return [
        makeEvent(ctx, line, p, "agent.message.delta", "running.model_streaming", {
          payload: { delta: text, role },
        }),
      ];
    }

    case "reasoning":
      return [
        makeEvent(ctx, line, p, "agent.reasoning_summary.delta", "running.model_streaming", {
          payload: { delta: reasoningText(p.summary) },
        }),
      ];

    case "function_call": {
      const name = asString(p.name);
      const namespace = asString(p.namespace);
      const args = parseJsonObject(p.arguments);
      const callId = asString(p.call_id);
      if (namespace?.startsWith("mcp__")) {
        const tool = toolNameFromNamespace(namespace, name);
        return [
          makeEvent(ctx, line, p, "mcp.call.started", "running.mcp_tool_calling", {
            summary: `MCP: ${tool.server}/${tool.tool}`,
            payload: {
              server: tool.server,
              tool: tool.tool,
              arguments: args,
              ...(callId !== undefined ? { request_id: callId } : {}),
            },
          }),
        ];
      }
      const command = commandFromArguments(name, args);
      return [
        makeEvent(ctx, line, p, "command.started", "running.command_executing", {
          summary: `Command: ${command}`,
          cwd: asString(args.workdir) ?? asString(args.cwd) ?? ctx.cwd,
          payload: {
            command,
            ...(asString(args.workdir) !== undefined ? { cwd: asString(args.workdir) } : {}),
            ...(callId !== undefined ? { request_id: callId } : {}),
            arguments: args,
            tool_name: name,
          },
        }),
      ];
    }

    case "function_call_output": {
      const output = asString(p.output) ?? "";
      const callId = asString(p.call_id);
      const events: NormalizedEvent[] = [];
      if (output.length > 0) {
        events.push(
          makeEvent(ctx, line, p, "command.output.delta", "running.command_executing", {
            eventIndex: 0,
            payload: { stream: "stdout", delta: output, ...(callId ? { request_id: callId } : {}) },
          }),
        );
      }
      events.push(
        makeEvent(ctx, line, p, "command.completed", "running.model_wait", {
          eventIndex: events.length,
          summary: "Command completed",
          payload: { ...(callId ? { request_id: callId } : {}) },
        }),
      );
      return events;
    }

    case "custom_tool_call": {
      const name = asString(p.name) ?? "custom_tool";
      return [
        makeEvent(ctx, line, p, "tool.started", "running.tool_preparing", {
          payload: { tool_name: name, input: p.input, status: p.status },
        }),
      ];
    }

    case "custom_tool_call_output":
      return [
        makeEvent(ctx, line, p, "tool.completed", "running.model_wait", {
          payload: {
            tool_name: "custom_tool",
            output: p.output,
            ...(asString(p.call_id) ? { request_id: asString(p.call_id) } : {}),
          },
        }),
      ];

    case "tool_search_call":
      return [
        makeEvent(ctx, line, p, "tool.started", "running.tool_preparing", {
          payload: { tool_name: "tool_search", input: parseJsonObject(p.arguments) },
        }),
      ];

    case "tool_search_output":
      return [
        makeEvent(ctx, line, p, "tool.completed", "running.model_wait", {
          payload: { tool_name: "tool_search", output: p.tools ?? p.execution ?? p.status },
        }),
      ];

    case "web_search_call": {
      const action = asParams(p.action);
      return [
        makeEvent(ctx, line, p, "web.search.started", "running.web_searching", {
          payload: { query: asString(action.query) ?? "" },
        }),
      ];
    }

    default:
      warn(ctx, `unknown response_item payload.type=${payloadType ?? "unknown"}`);
      return [];
  }
}

function normalizeEventMsg(
  ctx: CodexRolloutNormalizeContext,
  line: CodexRolloutLine,
  p: Params,
): NormalizedEvent[] {
  const payloadType = asString(p.type);
  switch (payloadType) {
    case "task_started":
      return [
        makeEvent(ctx, line, p, "turn.started", "running.model_wait", {
          turnId: asString(p.turn_id),
          summary: "Turn started",
          payload: {
            model_context_window: p.model_context_window,
            collaboration_mode_kind: p.collaboration_mode_kind,
          },
        }),
      ];

    case "task_complete": {
      const metrics: Record<string, number> = {};
      const duration = asNumber(p.duration_ms);
      const ttft = asNumber(p.time_to_first_token_ms);
      if (duration !== undefined) metrics.elapsed_ms = duration;
      if (ttft !== undefined) metrics.time_to_first_token_ms = ttft;
      return [
        makeEvent(ctx, line, p, "turn.completed", undefined, {
          turnId: asString(p.turn_id),
          summary: "Turn completed",
          payload: { last_agent_message: p.last_agent_message },
          metrics,
        }),
      ];
    }

    case "turn_aborted":
      return [
        makeEvent(ctx, line, p, "turn.failed", "failed", {
          turnId: asString(p.turn_id),
          summary: "Turn aborted",
          payload: { error: asString(p.reason) ?? "turn aborted", reason: p.reason },
          metrics:
            asNumber(p.duration_ms) !== undefined ? { elapsed_ms: asNumber(p.duration_ms)! } : {},
        }),
      ];

    case "agent_message": {
      const message = asString(p.message);
      if (message === undefined) return [];
      return [
        makeEvent(ctx, line, p, "agent.message.delta", "running.model_streaming", {
          payload: { delta: message, phase: p.phase },
        }),
      ];
    }

    case "user_message": {
      const message = asString(p.message) ?? contentText(p.text_elements);
      if (message === undefined) return [];
      return [
        makeEvent(ctx, line, p, "turn.started", "running.model_wait", {
          summary: "User message",
          payload: { prompt_summary: message, gap_source: "event_msg/user_message" },
        }),
      ];
    }

    case "mcp_tool_call_end": {
      const invocation = asParams(p.invocation);
      const duration = elapsedMs(p.duration);
      return [
        makeEvent(ctx, line, p, "mcp.call.completed", "running.model_wait", {
          summary: "MCP call completed",
          payload: {
            server: asString(invocation.server),
            tool: asString(invocation.tool),
            result: p.result,
            ...(asString(p.call_id) ? { request_id: asString(p.call_id) } : {}),
          },
          metrics: duration !== undefined ? { elapsed_ms: duration } : {},
        }),
      ];
    }

    case "patch_apply_end": {
      const paths = changedPaths(p.changes);
      const firstPath = paths[0] ?? "unknown";
      return [
        makeEvent(ctx, line, p, "file.change.applied", "running.model_wait", {
          eventIndex: 0,
          summary: "Patch applied",
          payload: {
            path: firstPath,
            changed_files: paths.length,
            paths,
            status: p.status,
            success: p.success,
          },
        }),
        makeEvent(ctx, line, p, "diff.updated", "running.file_editing", {
          eventIndex: 1,
          summary: "Patch diff updated",
          payload: {
            diff_hash: hashUnknown(p.changes),
            changed_files: paths.length,
            changes: p.changes,
            stdout: p.stdout,
            stderr: p.stderr,
            status: p.status,
            success: p.success,
          },
        }),
      ];
    }

    case "context_compacted":
      return [
        makeEvent(ctx, line, p, "context.compacted", "compacting", {
          payload: { trigger: "auto" },
          summary: "Context compacted",
        }),
      ];

    case "thread_goal_updated": {
      const goal = asString(p.goal) ?? JSON.stringify(p.goal ?? "");
      return [
        makeEvent(ctx, line, p, "turn.plan.updated", "running.planning", {
          turnId: asString(p.turnId),
          summary: "Thread goal updated",
          payload: { plan: goal },
        }),
      ];
    }

    case "web_search_end":
    case "token_count":
      return [];

    default:
      warn(ctx, `unknown event_msg payload.type=${payloadType ?? "unknown"}`);
      return [];
  }
}

export function normalizeRolloutLine(
  line: CodexRolloutLine,
  ctx: CodexRolloutNormalizeContext,
): NormalizedEvent[] {
  const p = asParams(line.payload);

  try {
    switch (line.type) {
      case "session_meta": {
        const cwd = asString(p.cwd) ?? ctx.cwd;
        return [
          makeEvent(ctx, line, p, "session.started", "starting", {
            summary: "Codex rollout session started",
            cwd,
            payload: {
              cwd,
              originator: p.originator,
              cli_version: p.cli_version,
              model_provider: p.model_provider,
              source: p.source,
              thread_source: p.thread_source,
              git: p.git,
            },
          }),
        ];
      }

      case "turn_context":
        return [];

      case "response_item":
        return normalizeResponseItem(ctx, line, p);

      case "event_msg":
        return normalizeEventMsg(ctx, line, p);

      case "compacted":
        return [
          makeEvent(ctx, line, p, "context.compacted", "compacting", {
            summary: "Context compacted",
            payload: { trigger: "auto", replacement_history: p.replacement_history },
          }),
        ];

      default:
        warn(ctx, `unknown rollout type=${line.type}`);
        return [];
    }
  } catch (err) {
    warn(
      ctx,
      `failed to normalize rollout type=${line.type}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

export function sessionIdFromRolloutPath(path: string): string | undefined {
  const match =
    /rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(path);
  return match?.[1];
}
