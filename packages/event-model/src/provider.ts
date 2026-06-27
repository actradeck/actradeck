/**
 * Provider / Source enums (plan.md §6).
 *
 * provider 固有のイベント形状 (Claude Code hooks / Codex App Server) は
 * 正規化層で吸収し、ここでは「どの CLI 由来か」「どの取り込み経路か」だけを
 * 安定した enum として固定する。UI へ provider 固有形状を素通ししない。
 */
import { z } from "zod";

/** イベントを発生させた開発エージェント CLI。 */
export const Provider = z.enum(["claude_code", "codex"]);
export type Provider = z.infer<typeof Provider>;

/**
 * 取り込み経路。
 * - hooks: Claude Code hooks (HTTP) — Phase 2 の初期スライス。
 * - app_server: Codex App Server (JSON-RPC) — 後続スライス。
 * - rollout: Codex TUI rollout JSONL passive tail — Codex Attach Phase A。
 * - sdk: SDK streaming connector — 後続スライス。
 */
export const Source = z.enum(["hooks", "app_server", "rollout", "sdk"]);
export type Source = z.infer<typeof Source>;
