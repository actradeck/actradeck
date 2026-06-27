/**
 * ActionKind 語彙の T1 正典 (single source of truth).
 *
 * 「現在のアクション要約 (current_action)」を**表示時ローカライズ**可能にするための分類軸
 * (ADR 019eeac6)。両 normalizer (apps/sidecar/src/normalize.ts / normalize-codex.ts) が
 * `event.summary` に日本語固定文字列を焼き込むため、projection がそれを current_action へ素通し
 * すると UI を英語にしても要約が日本語のまま残る (根因)。
 *
 * これを断つため projection は **(kind, subject)** という構造へ分解する:
 *  - `current_action_kind`: event_type を本語彙 (ActionKind) へ写した closed-enum。
 *  - `current_action_subject`: redacted payload の allowlist フィールドから引いた構造値
 *    (command / path / server/tool / query / tool_name / reason)。**日本語述語は含まない**。
 * webui は (kind, subject) を locale 別の述語テンプレートへ流し込んで表示する (述語の出所を UI へ移す)。
 *
 * ## webui との単一出所 (重要)
 * 値の集合は webui 既存 `apps/webui/src/ui/action-units.ts` の `ActionKind` union と**完全一致**する。
 * 後続で realtime-frontend-engineer がこの `ActionKind` を import して action-units.ts を単一出所化
 * するため、ここがドリフトすると UI 側が壊れる。値を増減する場合は両所を lock-step で更新すること。
 *
 * ## eventTypeToActionKind の共有 (TDA ドリフト防止)
 * `eventTypeToActionKind` は event_type → ActionKind の純写像であり、`apps/backend/src/replay-store.ts`
 * の `kindOf()` (ReplayEventKind を返す) が本写像を import して共有する。両者の差は **`error` のみ**:
 * ReplayEventKind は `"error"` を独立 kind として持つが、ActionKind は `error` を持たず `tool` へ畳む
 * (action-units.ts の `KIND_OF_REPLAY` が `error → tool` とするのに合わせる)。replay-store は
 * `error` のみ本写像の結果を上書きする。これで projection ↔ replay の分類ドリフトを構造的に防ぐ。
 *
 * ## forward-compat (redaction-kinds.ts T1 昇格 019ec744 と同型)
 * schema は loose のまま維持し、読み出し時に `isActionKind` ゲートで未知値を graceful に undefined 化
 * する (DB text + 読み出しゲート)。未知 event_type は `eventTypeToActionKind` が "other" を返す。
 */

/**
 * 観測された作業の種類 (closed-enum)。値は webui action-units.ts の ActionKind union と完全一致。
 */
export const ACTION_KINDS = [
  "approval", // 承認チェーン (tool.permission.requested / resolved)
  "command", // command.* (Bash 等)
  "file", // file.change.* / diff.updated
  "tool", // tool.* / error (汎用ツール・失敗)
  "mcp", // mcp.call.*
  "web", // web.search.*
  "turn", // turn.*
  "session", // session.*
  "message", // agent.message / reasoning
  "liveness", // heartbeat / stalled.detected
  "other", // 上記いずれにも属さない (subagent.* / context.compacted 等)
] as const;

/** 1 つの ActionKind 名 (closed-enum)。 */
export type ActionKind = (typeof ACTION_KINDS)[number];

/**
 * 既知 ActionKind の高速判定用集合。DB 読み出し / DTO 投影の closed-enum gate に使う。
 * `ReadonlySet<string>` として公開し、任意の string を照合できる。
 */
export const ActionKindSet: ReadonlySet<string> = new Set(ACTION_KINDS);

/** 与えられた文字列が既知の ActionKind か判定する (未知値は forward-compat に undefined 化)。 */
export function isActionKind(x: string): x is ActionKind {
  return ActionKindSet.has(x);
}

/**
 * event_type → ActionKind の純写像 (T1 正典)。全 EventType (event-type.ts の 30 種) を網羅する。
 *
 * replay-store.kindOf() と**同一の prefix ロジック**を共有する (差は `error` のみ・docstring 参照)。
 * 未知 / 未来の event_type は "other" を返す (forward-compat)。
 */
export function eventTypeToActionKind(eventType: string): ActionKind {
  if (eventType.startsWith("session.")) return "session";
  if (eventType.startsWith("turn.")) return "turn";
  if (eventType.startsWith("tool.permission.")) return "approval";
  if (eventType.startsWith("command.")) return "command";
  if (eventType.startsWith("file.") || eventType === "diff.updated") return "file";
  if (eventType.startsWith("mcp.")) return "mcp";
  if (eventType.startsWith("web.")) return "web";
  if (eventType.startsWith("agent.")) return "message";
  if (eventType === "heartbeat" || eventType === "stalled.detected") return "liveness";
  // error は ActionKind では tool へ畳む (ReplayEventKind は "error" を独立に持つ・差はここのみ)。
  if (eventType === "error") return "tool";
  if (eventType.startsWith("tool.")) return "tool";
  return "other";
}
