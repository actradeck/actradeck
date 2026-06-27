/**
 * 正規化イベントタイプ enum (plan.md §6, T1 正典).
 *
 * Claude Code と Codex はイベント形状が異なるため、ここへ正規化する。
 * 値は DB `events.event_type` (TEXT 列) に格納される。
 */
import { z } from "zod";

export const EventType = z.enum([
  // セッション
  "session.started",
  "session.ended",
  // ターン
  "turn.started",
  "turn.plan.updated",
  "turn.completed",
  "turn.failed",
  // モデル出力 (streaming)
  "agent.message.delta",
  "agent.reasoning_summary.delta",
  // 汎用ツール (Codex item / Claude tool 抽象)
  "tool.started",
  "tool.output.delta",
  "tool.completed",
  "tool.failed",
  // 承認 (permission)
  "tool.permission.requested",
  "tool.permission.resolved",
  // コマンド実行 (Bash / commandExecution)
  "command.started",
  "command.output.delta",
  "command.completed",
  // ファイル変更
  "file.change.proposed",
  "file.change.approved",
  "file.change.applied",
  "diff.updated",
  // MCP / Web
  "mcp.call.started",
  "mcp.call.completed",
  "web.search.started",
  // サブエージェント
  "subagent.started",
  "subagent.completed",
  // コンテキスト圧縮
  "context.compacted",
  // Liveness / 運用
  "heartbeat",
  "stalled.detected",
  "error",
]);
export type EventType = z.infer<typeof EventType>;

/** 全イベントタイプ (列挙・テスト用)。 */
export const ALL_EVENT_TYPES = EventType.options;
