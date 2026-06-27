/**
 * Codex App Server ServerNotification → NormalizedEvent 正規化
 * (provider="codex", source="app_server"). ADR 019ea31b (b)(c).
 *
 * 仕様出所: 実 codex 0.137.0 `app-server generate-json-schema` で再生成した権威 schema
 * (/tmp/codex-schema/, ServerNotification 64 variant)。web docs より新しく、これが正典。
 *
 * 写像規律:
 * - 全イベントに provider="codex", source="app_server", session_id=canonical(thread.id),
 *   thread_id=params.threadId, turn_id=params.turnId (または params.turn.id) を付与。
 * - 未知 method は **drop** (throw しない・前方互換)。
 * - item/started・item/completed は params.item.type (string const) で分岐。
 *
 * ⚠️ ここで作る候補は EventSink.emit() に渡され、その中で redaction されてから
 *    parse/persist/send される。normalize 自体は redaction しない (choke point は一箇所)。
 *    diff / command 出力など raw を payload へ素直に載せてよい (sink.redactDeep が担保)。
 */
import type { EventType, State } from "@actradeck/event-model";

import { buildEvent } from "./event-factory.js";

/** 1 件の codex notification (JSON-RPC notification の method + params)。 */
export interface CodexNotification {
  readonly method: string;
  readonly params?: unknown;
}

/** normalize に必要な session 文脈 (canonical 確定は runner が SessionIdentity で行う)。 */
export interface CodexNormalizeContext {
  /** canonical session_id (= thread.id)。 */
  readonly sessionId: string;
  /** provider 発行 raw session id (= thread.sessionId)。 */
  readonly providerSessionId?: string;
  /** 観測時刻 (hold-then-flush 時に発生時刻を保持するため明示注入可)。既定 now。 */
  readonly timestamp?: string;
}

type Params = Record<string, unknown>;

function asParams(p: unknown): Params {
  return p !== null && typeof p === "object" && !Array.isArray(p) ? (p as Params) : {};
}
function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * thread_id を notification params から取り出す (QA-2)。
 * flat `threadId` (turn/* notification) か、`thread` オブジェクトの `thread.id`
 * (thread/started は schema 上 `params.thread.id` で flat `threadId` を持たない)。
 * これがないとセッション最初の `session.started` が join キー `thread_id` を欠く。
 */
function extractThreadId(p: Params): string | undefined {
  const flat = asString(p.threadId);
  if (flat !== undefined) return flat;
  const thread = asParams(p.thread);
  return asString(thread.id);
}

/** turn_id を notification params から取り出す。flat `turnId` か、turn オブジェクトの `turn.id`。 */
function extractTurnId(p: Params): string | undefined {
  const flat = asString(p.turnId);
  if (flat !== undefined) return flat;
  const turn = asParams(p.turn);
  return asString(turn.id);
}

/** 共通フィールドを付けて 1 件の NormalizedEvent を作る。 */
function make(
  ctx: CodexNormalizeContext,
  p: Params,
  event_type: EventType,
  state: State | undefined,
  extra: { summary?: string; payload?: Record<string, unknown>; metrics?: Record<string, number> },
): ReturnType<typeof buildEvent> {
  const threadId = extractThreadId(p);
  const turnId = extractTurnId(p);
  return buildEvent({
    session_id: ctx.sessionId,
    provider: "codex",
    source: "app_server",
    ...(ctx.providerSessionId !== undefined ? { provider_session_id: ctx.providerSessionId } : {}),
    ...(threadId !== undefined ? { thread_id: threadId } : {}),
    ...(turnId !== undefined ? { turn_id: turnId } : {}),
    event_type,
    ...(state !== undefined ? { state } : {}),
    ...(ctx.timestamp !== undefined ? { timestamp: ctx.timestamp } : {}),
    ...(extra.summary !== undefined ? { summary: extra.summary } : {}),
    payload: { kind: event_type, ...(extra.payload ?? {}) },
    ...(extra.metrics !== undefined ? { metrics: extra.metrics } : {}),
  });
}

/**
 * (c) item.type 判別。item/started・item/completed の params.item.type で分岐する。
 * 戻り値は 0..1 件 (delta 系で表現する item や除外 item.type は空配列)。
 */
function normalizeItem(
  ctx: CodexNormalizeContext,
  p: Params,
  phase: "started" | "completed",
): ReturnType<typeof buildEvent>[] {
  const item = asParams(p.item);
  const itemType = asString(item.type);
  const itemId = asString(item.id);
  const idPayload = itemId !== undefined ? { item_id: itemId } : {};

  switch (itemType) {
    case "commandExecution": {
      const command = asString(item.command) ?? "";
      if (phase === "started") {
        return [
          make(ctx, p, "command.started", "running.command_executing", {
            summary: `コマンド実行: ${command}`,
            payload: { command, ...idPayload },
          }),
        ];
      }
      // completed: status (completed/failed/declined) と exitCode を反映。
      const status = asString(item.status);
      const exitCode = asNumber(item.exitCode);
      return [
        make(ctx, p, "command.completed", "running.model_wait", {
          summary: `コマンド完了 (${status ?? "completed"})`,
          payload: {
            ...(command.length > 0 ? { command } : {}),
            ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
            ...(status !== undefined ? { status } : {}),
            ...idPayload,
          },
        }),
      ];
    }

    case "fileChange": {
      if (phase === "started") {
        return [
          make(ctx, p, "file.change.proposed", "running.file_editing", {
            summary: "ファイル変更提案",
            payload: { path: firstChangePath(item), ...idPayload },
          }),
        ];
      }
      // completed: PatchApplyStatus completed→applied、failed/declined→proposed 維持。
      const status = asString(item.status);
      if (status === "completed") {
        return [
          make(ctx, p, "file.change.applied", "running.model_wait", {
            summary: "ファイル変更適用",
            payload: { path: firstChangePath(item), ...idPayload },
          }),
        ];
      }
      // failed / declined: 適用されていない → proposed のまま (error 化しない: 表示は提案状態)。
      return [
        make(ctx, p, "file.change.proposed", "running.file_editing", {
          summary: `ファイル変更 ${status ?? "未適用"}`,
          payload: {
            path: firstChangePath(item),
            ...(status !== undefined ? { status } : {}),
            ...idPayload,
          },
        }),
      ];
    }

    case "mcpToolCall": {
      const server = asString(item.server) ?? "unknown";
      const tool = asString(item.tool) ?? "unknown";
      if (phase === "started") {
        return [
          make(ctx, p, "mcp.call.started", "running.mcp_tool_calling", {
            summary: `MCP: ${server}/${tool}`,
            payload: { server, tool, ...idPayload },
          }),
        ];
      }
      const status = asString(item.status);
      return [
        make(ctx, p, "mcp.call.completed", "running.model_wait", {
          summary: `MCP 完了: ${server}/${tool}`,
          payload: { server, tool, ...(status !== undefined ? { status } : {}), ...idPayload },
        }),
      ];
    }

    case "webSearch": {
      if (phase === "started") {
        const query = asString(item.query) ?? "";
        return [
          make(ctx, p, "web.search.started", "running.web_searching", {
            summary: `Web 検索: ${query}`,
            payload: { query, ...idPayload },
          }),
        ];
      }
      // webSearch completed は専用 event_type 無し → heartbeat (省略可)。
      return [
        make(ctx, p, "heartbeat", undefined, {
          summary: "Web 検索完了",
          payload: { process_alive: true, ...idPayload },
        }),
      ];
    }

    // agentMessage / reasoning / plan は delta 系 (下記 method) で表現 → started/completed は省略。
    // 除外 item.type (ADR (c)): userMessage/hookPrompt/dynamicToolCall/collabAgentToolCall/
    //   imageView/imageGeneration/enteredReviewMode/exitedReviewMode/contextCompaction。
    default:
      return [];
  }
}

/** fileChange item の最初の変更パスを取り出す (changes[0].path)。無ければ "unknown"。 */
function firstChangePath(item: Params): string {
  const changes = item.changes;
  if (Array.isArray(changes) && changes.length > 0) {
    const first = asParams(changes[0]);
    const path = asString(first.path);
    if (path !== undefined) return path;
  }
  return "unknown";
}

/**
 * (b) ServerNotification method → NormalizedEvent。
 * 未知 method / MVP 除外 method は **空配列** を返す (drop, 前方互換)。
 */
export function normalizeCodexNotification(
  note: CodexNotification,
  ctx: CodexNormalizeContext,
): ReturnType<typeof buildEvent>[] {
  const p = asParams(note.params);

  switch (note.method) {
    case "thread/started":
      return [
        make(ctx, p, "session.started", "starting", {
          summary: "Codex セッション開始",
          payload: {},
        }),
      ];

    case "turn/started":
      return [
        make(ctx, p, "turn.started", "running.model_wait", {
          summary: "ターン開始",
          payload: {},
        }),
      ];

    case "turn/plan/updated": {
      const explanation = asString(p.explanation);
      const plan = Array.isArray(p.plan) ? p.plan : [];
      const steps = plan
        .map((s) => asString(asParams(s).step))
        .filter((s): s is string => s !== undefined);
      return [
        make(ctx, p, "turn.plan.updated", "running.planning", {
          summary: explanation ?? `計画更新 (${steps.length} ステップ)`,
          payload: { ...(explanation !== undefined ? { plan: explanation } : {}), steps },
        }),
      ];
    }

    case "turn/diff/updated": {
      const diff = asString(p.diff) ?? "";
      return [
        make(ctx, p, "diff.updated", "running.file_editing", {
          summary: "差分更新",
          // diff は sink.redactDeep を通る (秘匿の混入はそこでマスク)。
          payload: { diff },
        }),
      ];
    }

    case "turn/completed":
      // turn 終端 (session 終端ではない)。state は省略 (idle 等へ倒さない)。
      return [
        make(ctx, p, "turn.completed", undefined, {
          summary: "ターン完了",
          payload: {},
        }),
      ];

    case "item/agentMessage/delta": {
      const delta = asString(p.delta) ?? "";
      return [
        make(ctx, p, "agent.message.delta", "running.model_streaming", {
          payload: { delta },
        }),
      ];
    }

    // reasoning の 3 系統 (summaryTextDelta / textDelta / summaryPartAdded) を
    // agent.reasoning_summary.delta に集約。summaryPartAdded は delta 本文を持たない (区切り) ため空文字。
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta": {
      const delta = asString(p.delta) ?? "";
      return [
        make(ctx, p, "agent.reasoning_summary.delta", "running.model_streaming", {
          payload: { delta },
        }),
      ];
    }
    case "item/reasoning/summaryPartAdded":
      return [
        make(ctx, p, "agent.reasoning_summary.delta", "running.model_streaming", {
          payload: { delta: "" },
        }),
      ];

    case "item/commandExecution/outputDelta": {
      const delta = asString(p.delta) ?? "";
      return [
        make(ctx, p, "command.output.delta", "running.command_executing", {
          payload: { stream: "stdout", delta },
        }),
      ];
    }

    case "item/fileChange/patchUpdated":
      return [
        make(ctx, p, "file.change.proposed", "running.file_editing", {
          summary: "パッチ更新",
          payload: { path: firstChangeFromPatch(p) },
        }),
      ];

    case "item/fileChange/outputDelta": {
      // deprecated legacy (server no longer emits)。互換のため command.output.delta に写像。
      const delta = asString(p.delta) ?? "";
      return [
        make(ctx, p, "command.output.delta", "running.file_editing", {
          payload: { stream: "stdout", delta },
        }),
      ];
    }

    case "thread/compacted":
      return [
        make(ctx, p, "context.compacted", "compacting", {
          summary: "コンテキスト圧縮",
          payload: {},
        }),
      ];

    case "thread/status/changed":
      return normalizeStatusChanged(ctx, p);

    case "thread/closed":
      return [
        make(ctx, p, "session.ended", "completed", {
          summary: "Codex セッション終了",
          payload: {},
        }),
      ];

    // process/exited は **写像しない (drop)** — AGG-1 (3 監査独立確認・schema 違反契約の偽ゲート):
    //   ProcessExitedNotification は "Final process exit notification for `process/spawn`" であり、
    //   client 供給 processHandle の補助子プロセス終了通知 (threadId 不在)。我々は MVP で
    //   `process/spawn` を送らず、実 codex も emit しない dead path。session.ended に写像すると
    //   schema 違反契約を test が人工緑化する (偽ゲート)。真の終端源は child OS exit (codex-runner)
    //   と thread/closed であり、そこで session.ended を結線する (AGG-2)。

    case "error": {
      const errObj = asParams(p.error);
      const message = asString(errObj.message) ?? "codex error";
      const willRetry = p.willRetry === true;
      return [
        make(ctx, p, "error", willRetry ? undefined : "failed", {
          summary: `エラー: ${message}`,
          payload: { message, retryable: willRetry },
        }),
      ];
    }

    case "thread/tokenUsage/updated": {
      // 専用 event_type 無し → heartbeat に metrics を載せる (省略可だが可視化のため反映)。
      const usage = asParams(p.tokenUsage);
      const total = asParams(usage.total);
      const metrics: Record<string, number> = {};
      const tin = asNumber(total.inputTokens);
      const tout = asNumber(total.outputTokens);
      if (tin !== undefined) metrics.tokens_in = tin;
      if (tout !== undefined) metrics.tokens_out = tout;
      return [
        make(ctx, p, "heartbeat", undefined, {
          summary: "トークン使用量更新",
          payload: { process_alive: true },
          ...(Object.keys(metrics).length > 0 ? { metrics } : {}),
        }),
      ];
    }

    case "item/started":
      return normalizeItem(ctx, p, "started");
    case "item/completed":
      return normalizeItem(ctx, p, "completed");

    default:
      // 未知 / MVP 除外 method は drop (throw しない・前方互換)。
      return [];
  }
}

/**
 * thread/status/changed の ThreadStatus.type で分岐 (ADR (b)):
 *  - active → 省略 (active 維持)。state を上書きしない heartbeat にしない = 何も emit しない。
 *  - idle → heartbeat (state=idle)。
 *  - systemError → error (state=failed)。
 *  - notLoaded → 省略。
 */
function normalizeStatusChanged(
  ctx: CodexNormalizeContext,
  p: Params,
): ReturnType<typeof buildEvent>[] {
  const status = asParams(p.status);
  const type = asString(status.type);
  switch (type) {
    case "idle":
      return [
        make(ctx, p, "heartbeat", "idle", {
          summary: "アイドル",
          payload: { process_alive: true },
        }),
      ];
    case "systemError":
      return [
        make(ctx, p, "error", "failed", {
          summary: "システムエラー",
          payload: { message: "thread systemError" },
        }),
      ];
    // active / notLoaded / 未知 → 何も emit しない (active 維持)。
    default:
      return [];
  }
}

/** patchUpdated notification の changes[0].path を取り出す。 */
function firstChangeFromPatch(p: Params): string {
  const changes = p.changes;
  if (Array.isArray(changes) && changes.length > 0) {
    const first = asParams(changes[0]);
    const path = asString(first.path);
    if (path !== undefined) return path;
  }
  return "unknown";
}
