/**
 * event_type ごとの payload 型 (plan.md §6, T1 正典).
 *
 * 方針 (MVP):
 * - payload は `kind` 判別子 (= event_type の文字列) を持つ discriminated union。
 *   O(1) 判別で reducer / UI が型安全に分岐できる。
 * - 過度に厳密にしない: 各 variant は MVP で必要な構造化フィールドのみ必須化し、
 *   それ以外の正規化済み付随情報は loose (追加キー許容) で持てるようにする。
 *   provider 固有の生データはここに素通ししない (正規化層で吸収済み前提)。
 * - NormalizedEvent.payload 自体は緩い record も受理する (後方互換 / 段階導入)。
 *   厳密な型が欲しい呼び出し側はこの discriminated union を使う。
 */
import { z } from "zod";

import { EventType } from "./event-type.js";
import { REDACTION_KINDS } from "./redaction-kinds.js";

/** リスク区分 (command / file の危険度。plan.md §18 Risk Lens の素地)。 */
export const RiskLevel = z.enum(["low", "medium", "high"]);
export type RiskLevel = z.infer<typeof RiskLevel>;

/** 承認の決定 (Codex: accept/acceptForSession/decline/cancel, Claude: allow/deny を正規化)。 */
export const ApprovalDecision = z.enum(["allow", "allow_for_session", "deny", "cancel"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;

/**
 * 自動ガード (ADR 019ecc70 段階1): 承認 pause の **理由 (trigger)**。
 * - "destructive": 既存の破壊的コマンド/ファイル/MCP/WebFetch ゲート (rm -rf 等) で pause。
 * - "secret": tool_input に secret が検出されたため pause (新規・D1/D4)。
 * - "both": destructive かつ secret の両立。
 * additive optional。未設定は「(従来どおり) 理由情報なし」を意味する後方互換値。
 */
export const ApprovalTrigger = z.enum(["destructive", "secret", "both"]);
export type ApprovalTrigger = z.infer<typeof ApprovalTrigger>;

/**
 * 自動ガード (ADR 019ecc70 D3): secret-trigger の **kind 名のみ** (REDACTION_KINDS 語彙)。
 * INV-AUTOGUARD-NO-RAW: 原文 (秘匿値そのもの) は一切載せない。値は redacted 文字列の
 * `[REDACTED:<kind>]` マーカーから算出した公開可能 enum に限る (closed-enum allowlist)。
 */
export const SecretKind = z.enum(REDACTION_KINDS);
export type SecretKind = z.infer<typeof SecretKind>;

/**
 * 承認ポリシーの high-risk カテゴリ (ADR 019f0c3e・T1 単一ソース).
 *
 * operator が設定ページ (Phase 2) のチェックボックスで「YOLO/bypassPermissions でも明示承認を要する」
 * カテゴリを選ぶ。sidecar の分類器 (normalize.ts `classifyCommandCategories`) が各操作の該当カテゴリを
 * 算出し、approval-bridge が **enabled-categories と交差したらゲート**する (それ以外は従来どおり defer)。
 *
 * - recursive-rm:     rm -rf / find -delete・-exec 等の再帰強制削除・mass file 削除
 * - disk-destroy:     mkfs/dd/shred/wipefs/parted/cryptsetup/nvme format/zfs destroy/block-device 書込
 * - history-rewrite:  git push --force / git reset --hard / git clean -f
 * - db-drop:          DROP TABLE / DROP DATABASE / TRUNCATE TABLE
 * - fork-bomb:        `:(){ :|:& };:` 等の自己増殖
 * - secret-egress:    network-egress program (curl/wget/nc/scp…) に secret を同梱 (composite・approval-bridge)
 * - perm-change:      chmod -R / world-writable chmod / recursive chown
 * - inline-code:      sh -c / python -c / eval / `curl|sh` / `$(...)` / `<(...)` の動的コード実行
 * - secret-file-edit: .env / *.pem / id_rsa / kubeconfig 等の秘匿ファイル編集 (approval-bridge)
 * - external-tool:    MCP 呼び出し / WebFetch (approval-bridge)
 * - migrate-prod:     DB マイグレーション / "production" 言及 (曖昧・既定 OFF)
 * - high-risk-other:  上記 named に該当しないが分類器が high と判定した残余 (silent hole 防止 backstop)
 *
 * 後方互換 additive。値は公開可能 enum (原文非依存・redaction 件数と同カテゴリの安全な enum)。
 */
export const PolicyCategory = z.enum([
  "recursive-rm",
  "disk-destroy",
  "history-rewrite",
  "db-drop",
  "fork-bomb",
  "secret-egress",
  "perm-change",
  "inline-code",
  "secret-file-edit",
  "external-tool",
  "migrate-prod",
  "high-risk-other",
]);
export type PolicyCategory = z.infer<typeof PolicyCategory>;

/**
 * 既定でゲートする (チェック ON) カテゴリ (ADR 019f0c3e). 設定ファイル欠落/不正時の **fail-safe 既定**でもある。
 *
 * 不可逆×ブラスト半径大の「最も危険」群のみ既定 ON。perm-change / inline-code / secret-file-edit /
 * external-tool / migrate-prod は誤検知寄りゆえ既定 OFF (operator が必要なら設定ページで ON)。
 * secret-egress は leak 製品ゆえ既定 ON (operator は外せるが UI が強警告)。high-risk-other は high と
 * 判定された残余を取りこぼさない backstop ゆえ既定 ON。
 */
export const DEFAULT_GATED_CATEGORIES: readonly PolicyCategory[] = [
  "recursive-rm",
  "disk-destroy",
  "history-rewrite",
  "db-drop",
  "fork-bomb",
  "secret-egress",
  "high-risk-other",
];

/**
 * TDA-S1-3 (decision 019f0e5d): categories 集合を `PolicyCategory.options` の安定順へ整列する **単一出所**。
 * 投影 (projectPolicyCategories) とは別操作 — 既に typed な `ReadonlySet<PolicyCategory>` の serialize
 * (approval-policy-store.saveApprovalPolicy / policy-relay.buildPolicyResponse) と、投影の最終整列の両方が
 * 本関数を共有し、順序規則の 3 箇所重複を排除する。`ReadonlySet<string>` を受け PolicyCategory ⊆ string で
 * typed-Set も present-set も渡せる (戻りは常に closed enum・order/membership は options に従う)。
 */
export function orderPolicyCategories(set: ReadonlySet<string>): PolicyCategory[] {
  return PolicyCategory.options.filter((c) => set.has(c));
}

/**
 * TDA-1 (decision 019f0e2d): untrusted 入力を closed-enum `PolicyCategory[]` へ投影する **単一出所**。
 * `PolicyCategory.options` の安定順を保ち、非配列→`[]`・非 string・未知値を構造的に落とす (NO-RAW)。
 *
 * 3 トラスト境界 — sidecar `sanitizeCategories` (disk/wire load) / backend `resolvePolicy` (sidecar relay) /
 * webui `parsePolicy` (BFF 応答) — が本関数を共有し、投影ロジックの drift を防ぐ (純関数ゆえ境界ごとの
 * 多層防御は保たれる)。各境界固有の前段ガード (例: webui の「非配列は応答全棄却」) は呼び元に残す。
 * 最終整列は orderPolicyCategories に委譲 (TDA-S1-3・順序規則の単一出所)。
 */
export function projectPolicyCategories(raw: unknown): PolicyCategory[] {
  if (!Array.isArray(raw)) return [];
  const present = new Set<string>(raw.filter((c): c is string => typeof c === "string"));
  return orderPolicyCategories(present);
}

/**
 * variant ビルダー: `kind` リテラル + 固有フィールド。
 * looseObject で「正規化済みの追加キー」を許容する (MVP の前方互換)。
 */
function variant<K extends EventType, S extends z.ZodRawShape>(kind: K, shape: S) {
  return z.looseObject({ kind: z.literal(kind), ...shape });
}

// --- セッション ---------------------------------------------------------
const SessionStarted = variant("session.started", {
  repo: z.string().optional(),
  branch: z.string().optional(),
});
const SessionEnded = variant("session.ended", {
  reason: z.string().optional(),
});

// --- ターン -------------------------------------------------------------
const TurnStarted = variant("turn.started", {
  prompt_summary: z.string().optional(),
});
const TurnPlanUpdated = variant("turn.plan.updated", {
  plan: z.string().optional(),
  steps: z.array(z.string()).optional(),
});
const TurnCompleted = variant("turn.completed", {});
const TurnFailed = variant("turn.failed", {
  // `error` が正典の失敗要因フィールド (UI / projection subject の出所)。
  error: z.string().optional(),
  // TDA-2: codex rollout の turn_aborted は失敗要因を `reason` にも載せる
  //   (normalize-codex-rollout.ts: error=asString(reason) ?? "turn aborted", reason=p.reason)。
  //   sidecar の実挙動を T1 に明示するための additive optional (`session.ended` の reason とは別 variant)。
  //   消費側 (projection deriveActionSubject) は error を優先し reason を後方互換 fallback に使う。
  reason: z.string().optional(),
});

// --- モデル出力 (streaming) ---------------------------------------------
const AgentMessageDelta = variant("agent.message.delta", {
  delta: z.string(),
});
const AgentReasoningSummaryDelta = variant("agent.reasoning_summary.delta", {
  delta: z.string(),
});

// --- 汎用ツール ---------------------------------------------------------
const ToolStarted = variant("tool.started", {
  tool_name: z.string(),
  input: z.unknown().optional(),
});
const ToolOutputDelta = variant("tool.output.delta", {
  delta: z.string(),
});
const ToolCompleted = variant("tool.completed", {
  tool_name: z.string().optional(),
  output: z.unknown().optional(),
});
const ToolFailed = variant("tool.failed", {
  tool_name: z.string().optional(),
  error: z.string().optional(),
  // Bash 等の失敗時に tool_response から取れたとき (実在時のみ) command.* と整合させる。
  command: z.string().optional(),
  exit_code: z.number().int().optional(),
  request_id: z.string().optional(),
});

// --- 承認 ---------------------------------------------------------------
/**
 * INV-REQUEST-ID-NAMESPACE (T1 契約・TDA-1 decision 019ebc07):
 * `request_id` フィールドには **2 つの非交差キー空間** が同居する:
 *  1. **承認キー** (`<session_id>:apr-…` 等、sidecar 承認ブリッジが採番):
 *     tool.permission.requested / tool.permission.resolved のみが持つ。
 *  2. **`tu:<tool_use_id>`** (CC hook の tool_use_id 由来・`tu:` prefix で構造分離):
 *     command.started / command.completed / tool.failed が持つ。
 * 両者は同一フィールドを共有して下流 (projection / replay-store / UI) へ混在して流れるのが
 * **正常**。consumer は突合の前に必ず **event_type でゲート** し、namespace を跨いだ
 * request_id 突合をしてはならない (例: pending_approvals の解決は permission.* のみ、
 * command ペアリングは command.* と tool.failed のみ)。`request_id の有無` をゲートに
 * 使うのは退行 (QA-1/QA-2 decision 019ebc01 が赤テストで固定)。
 */
const ToolPermissionRequested = variant("tool.permission.requested", {
  // 承認ブリッジが採番する相関 ID (高エントロピー)。UI が承認カード→approve frame で
  // 突合する正本キー。outbound 承認経路 (ADR 019e9999) の必須要素。looseObject なので
  // 省略可だが、UI 契約として明示する (PreToolUse/PermissionRequest の双方で付与される)。
  request_id: z.string().optional(),
  tool_name: z.string().optional(),
  command: z.string().optional(),
  path: z.string().optional(),
  risk_level: RiskLevel.optional(),
  // 自動ガード (ADR 019ecc70 段階1・D3): なぜ pause したか / どの secret kind か。
  // additive optional (provider_session_id/capture_mode と同じ後方互換パターン)。
  // trigger/secret_kinds を読まない consumer は無影響。resolved には載せない (request_id 突合のみ)。
  trigger: ApprovalTrigger.optional(),
  // INV-AUTOGUARD-NO-RAW: REDACTION_KINDS allowlist の **語彙名のみ** (原文ゼロ)。
  // 空配列/未設定は「secret 起因でない」。
  secret_kinds: z.array(SecretKind).optional(),
});
const ToolPermissionResolved = variant("tool.permission.resolved", {
  // どの pending approval を解決したか (request_id 突合)。reducer が pending_approvals から
  // 該当 request_id を除去するために必要 (ADR 019e9999)。
  request_id: z.string().optional(),
  decision: ApprovalDecision,
});

// --- コマンド実行 -------------------------------------------------------
const CommandStarted = variant("command.started", {
  command: z.string(),
  cwd: z.string().optional(),
  risk_level: RiskLevel.optional(),
  // tool_use_id 由来の相関キー (`tu:<tool_use_id>`)。command.completed と同値で結ぶ。
  request_id: z.string().optional(),
});
const CommandOutputDelta = variant("command.output.delta", {
  stream: z.enum(["stdout", "stderr"]),
  delta: z.string(),
});
const CommandCompleted = variant("command.completed", {
  command: z.string().optional(),
  exit_code: z.number().int().optional(),
  // tool_use_id 由来の相関キー (`tu:<tool_use_id>`)。command.started と同値で結ぶ。
  request_id: z.string().optional(),
});

// --- ファイル変更 -------------------------------------------------------
const FileChangeProposed = variant("file.change.proposed", {
  path: z.string(),
  diff: z.string().optional(),
  risk_level: RiskLevel.optional(),
});
const FileChangeApproved = variant("file.change.approved", {
  path: z.string(),
  decision: ApprovalDecision.optional(),
});
const FileChangeApplied = variant("file.change.applied", {
  path: z.string(),
  added_lines: z.number().int().optional(),
  removed_lines: z.number().int().optional(),
});
const DiffUpdated = variant("diff.updated", {
  diff_hash: z.string().optional(),
  changed_files: z.number().int().optional(),
  added_lines: z.number().int().optional(),
  removed_lines: z.number().int().optional(),
});

// --- MCP / Web ----------------------------------------------------------
const McpCallStarted = variant("mcp.call.started", {
  server: z.string(),
  tool: z.string(),
  arguments: z.unknown().optional(),
});
const McpCallCompleted = variant("mcp.call.completed", {
  server: z.string().optional(),
  tool: z.string().optional(),
  result: z.unknown().optional(),
});
const WebSearchStarted = variant("web.search.started", {
  query: z.string(),
});

// --- サブエージェント ---------------------------------------------------
const SubagentStarted = variant("subagent.started", {
  subagent_id: z.string().optional(),
  task: z.string().optional(),
});
const SubagentCompleted = variant("subagent.completed", {
  subagent_id: z.string().optional(),
});

// --- コンテキスト圧縮 ---------------------------------------------------
const ContextCompacted = variant("context.compacted", {
  trigger: z.enum(["auto", "manual"]).optional(),
});

// --- Liveness / 運用 ----------------------------------------------------
const Heartbeat = variant("heartbeat", {
  process_alive: z.boolean().optional(),
});
const StalledDetected = variant("stalled.detected", {
  // plan.md §5 / §18: 停止を断定せず根拠を分解して保持する。
  no_model_delta_ms: z.number().int().optional(),
  no_stdout_ms: z.number().int().optional(),
  no_event_ms: z.number().int().optional(),
  process_alive: z.boolean().optional(),
  last_item: z.string().optional(),
  inference: z.string().optional(),
});
const ErrorPayload = variant("error", {
  message: z.string(),
  retryable: z.boolean().optional(),
});

/**
 * 全 event_type を網羅した payload の discriminated union。
 * 判別キーは `kind` (= event_type)。
 */
export const EventPayload = z.discriminatedUnion("kind", [
  SessionStarted,
  SessionEnded,
  TurnStarted,
  TurnPlanUpdated,
  TurnCompleted,
  TurnFailed,
  AgentMessageDelta,
  AgentReasoningSummaryDelta,
  ToolStarted,
  ToolOutputDelta,
  ToolCompleted,
  ToolFailed,
  ToolPermissionRequested,
  ToolPermissionResolved,
  CommandStarted,
  CommandOutputDelta,
  CommandCompleted,
  FileChangeProposed,
  FileChangeApproved,
  FileChangeApplied,
  DiffUpdated,
  McpCallStarted,
  McpCallCompleted,
  WebSearchStarted,
  SubagentStarted,
  SubagentCompleted,
  ContextCompacted,
  Heartbeat,
  StalledDetected,
  ErrorPayload,
]);
export type EventPayload = z.infer<typeof EventPayload>;
