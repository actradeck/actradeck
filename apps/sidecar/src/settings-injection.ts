/**
 * Claude Code hook 設定の注入。
 *
 * Managed Mode では claude 起動時に「各 hook が sidecar の HTTP endpoint を叩く」設定を
 * 与える。HTTP hook の設定形 (WebSearch 2026-06):
 *   settings.json { "hooks": { "<EventName>": [ { "hooks": [ { "type":"http", "url":"..." } ] } ] } }
 *
 * 実体は一時ディレクトリに settings.json を生成し、CLAUDE_* 環境変数 or --settings 引数で
 * 読ませる。これにより既存のユーザー settings を汚さない (sidecar 専用設定)。
 */
import { randomBytes } from "node:crypto";

import { writeJson0600 } from "./fs-atomic.js";

/** hook receiver の per-launch 認証トークン用ヘッダ名 (SEC-3)。 */
export const HOOK_TOKEN_HEADER = "X-ActraDeck-Hook-Token";

/** per-launch のランダムトークンを生成する (crypto, URL-safe, 256bit)。 */
export function generateHookToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * 配線する hook 一覧 (plan.md §9 + 現行イベントから採用分)。
 *
 * これは managed (temp settings) と attach (settings-merge の `ATTACH_HOOK_EVENTS`) の **単一出所**。
 * 追加はここだけで行う (両モードが自動追随・非破壊 merge / 可逆 detach / 0600 atomic は generic)。
 *
 * ADR 0015 §D2 (B2): `TaskCreated` / `TaskCompleted` を追加し CC の task list 観測を
 *   `work.item.updated` (observation=official_hook/observed) へ配線する。これらは semantic な
 *   専用 hook で、live 検証 (2026-08-04・CC 2.1.220) で 8 field payload
 *   {session_id, transcript_path, cwd, prompt_id, hook_event_name, task_id, task_subject,
 *   task_description} を発火することを確認済 (agent_id は無い)。未登録の間は発火しないだけ
 *   (partial deploy は benign 縮退)・不明 hook は normalizer 既定 case (heartbeat) へ落ちる。
 */
export const MANAGED_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "Stop",
  "SessionEnd",
  // ADR 0015 §D2 (B2): CC task-list 観測 (work.item.updated・official_hook/observed)。
  "TaskCreated",
  "TaskCompleted",
] as const;

export interface HookHttpEntry {
  readonly type: "http";
  readonly url: string;
  readonly timeout?: number;
  /** HTTP ヘッダ (SEC-3: per-launch トークンを注入)。 */
  readonly headers?: Record<string, string>;
}

export interface ClaudeSettings {
  readonly hooks: Record<string, Array<{ hooks: HookHttpEntry[] }>>;
}

/**
 * sidecar endpoint を全 hook に配線した settings オブジェクトを生成。
 *
 * SEC-3: token を渡すと各 hook entry に認証ヘッダ (HOOK_TOKEN_HEADER) を注入する。
 * receiver 側が同じトークンを照合し、不一致は 403 で event を一切 emit しない。
 * トークン値はリテラルで書く (settings.json は sidecar 専用 temp file。$VAR 補間は
 * allowedEnvVars 必須で取り回しが増えるため、loopback-only + temp 限定で直書きする)。
 */
export function buildHookSettings(endpoint: string, token?: string): ClaudeSettings {
  const hooks: Record<string, Array<{ hooks: HookHttpEntry[] }>> = {};
  const headers = token ? { [HOOK_TOKEN_HEADER]: token } : undefined;
  for (const ev of MANAGED_HOOK_EVENTS) {
    // PreToolUse / PermissionRequest は応答待ちが必要なので timeout を少し長めに。
    const timeout = ev === "PreToolUse" || ev === "PermissionRequest" ? 35 : 10;
    const entry: HookHttpEntry = {
      type: "http",
      url: endpoint,
      timeout,
      ...(headers ? { headers } : {}),
    };
    hooks[ev] = [{ hooks: [entry] }];
  }
  return { hooks };
}

/**
 * settings.json を書き出し、書いたパスを返す。
 *
 * SEC (TDA-2): この settings.json は per-launch hook token を **リテラルで含む** (buildHookSettings)。
 * 親 dir は呼び元 (managed-runner) が mkdtemp で 0700 生成するが、file 自体も fs-atomic の
 * writeJson0600 で **0600 + atomic** にし、親 dir 0700 への単層依存を避ける (defense-in-depth)。
 */
export function writeHookSettings(filePath: string, endpoint: string, token?: string): string {
  const settings = buildHookSettings(endpoint, token);
  writeJson0600(filePath, settings);
  return filePath;
}
