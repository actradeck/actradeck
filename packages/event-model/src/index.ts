/**
 * @actradeck/event-model — T1 canonical (正典).
 *
 * ActraDeck の正規化イベントモデル: plan.md §4 (状態) / §6 (イベント) の T1 実装。
 * Sidecar (採番・送信) / backend (ingestion・reducer・state engine) / UI が共通参照する。
 *
 * 公開面:
 * - provider: Provider (WHO・slug 開放・ADR 019f2d2c D1) / KNOWN_PROVIDERS / isKnownProvider
 * - enum: Source, State, EventType, RiskLevel, ApprovalDecision (Provider は enum ではない)
 * - schema:  NormalizedEvent, EventPayload, Metrics, Timestamp, EventId
 * - 採番:     newEventId / isUuidV7
 * - 遷移:     STATE_TRANSITIONS / isValidTransition / assertValidTransition
 * - 単調性:   MonotonicTimestampChecker / isMonotonicNonDecreasing
 */

// provider (WHO・slug 開放) / source (HOW・closed enum) — ADR 019f2d2c #6a 公開取込コントラクト
export {
  Provider,
  Source,
  KNOWN_PROVIDERS,
  PROVIDER_SLUG_RE,
  isKnownProvider,
} from "./provider.js";
export type { KnownProvider } from "./provider.js";

// state model + transitions (T1 遷移表)
export {
  State,
  ALL_STATES,
  RUNNING_STATES,
  WAITING_STATES,
  TERMINAL_STATES,
  STATE_TRANSITIONS,
  isTerminalState,
  isTerminalStateValue,
  isValidTransition,
  assertValidTransition,
  InvalidStateTransitionError,
} from "./state.js";

// event types
export { EventType, ALL_EVENT_TYPES } from "./event-type.js";

// liveness signal taxonomy (TS/SQL 単一出所: parity ガードの基準)
export {
  STDOUT_EVENT_TYPES,
  FILE_EVENT_TYPES,
  MODEL_STREAM_EVENT_TYPES,
  HEARTBEAT_EVENT_TYPE,
  PROCESS_ALIVE_PAYLOAD_KEY,
} from "./liveness-signals.js";

// payloads (discriminated union)
export {
  EventPayload,
  RiskLevel,
  ApprovalDecision,
  ApprovalTrigger,
  SecretKind,
  PolicyCategory,
  DEFAULT_GATED_CATEGORIES,
  projectPolicyCategories,
  orderPolicyCategories,
  POLICY_PRESETS,
  PRESET_ORDER,
  presetCategories,
  matchPreset,
} from "./payload.js";
export type { PolicyPresetName } from "./payload.js";

// redaction kind vocabulary (T1 single source of truth for "種類" of redaction)
export {
  REDACTION_KINDS,
  REDACTION_KINDS_SET,
  REDACTION_MARKER_KIND_CHARSET,
  REDACTION_MARKER_PREFIX,
  REDACTION_MARKER_SUFFIX,
  REDACTION_MARKER_PATTERN,
  REDACTION_MARKER_KIND_PATTERN,
  redactionMarker,
  gateRedactionCountByKind,
  isKnownRedactionKind,
} from "./redaction-kinds.js";
export type { RedactionKind } from "./redaction-kinds.js";

// action kind vocabulary (T1 single source of truth for current_action 表示時ローカライズ)
export { ACTION_KINDS, ActionKindSet, isActionKind, eventTypeToActionKind } from "./action-kind.js";
export type { ActionKind } from "./action-kind.js";

// project-scope path containment + repo_label sanitize (T1 single source: backend gate + sidecar NO-RAW 境界)
export { normalizeScopePath, isPathWithinScope, sanitizeRepoLabel } from "./path-scope.js";

// agent-visibility wire 射影 + 受信検証 + 集約 (T1 single source: sidecar 射影 / backend 検証+集約 / webui parse)
export { parseAgentVisibilityWire, aggregateAgentReadiness } from "./agent-visibility-wire.js";
export type { AgentVisibilityWire } from "./agent-visibility-wire.js";

// codex spawn wire 検証 + 失敗 enum (T1 single source: backend route/relay + sidecar daemon handler・ADR 019f4206)
export {
  parseCodexSpawnRequest,
  asCodexSpawnErrorCode,
  CODEX_SPAWN_ERROR_MESSAGE,
  MAX_SPAWN_PROMPT_LEN,
  MAX_SPAWN_CWD_LEN,
} from "./codex-spawn-wire.js";
export type {
  CodexSpawnParams,
  CodexSpawnErrorCode,
  CodexSpawnResult,
} from "./codex-spawn-wire.js";

// 契約 docs 抽出ヘルパ (INV テスト共有基盤・runtime プロダクトロジックではない・PR-2 QA-3/TDA-1)
// docs/ingestion-contract.md の golden example / event_type 列挙を event-model 契約テストと
// backend real-POST 契約テストが同一規則で抽出するための単一出所 (verbatim 二重定義の解消)。
export { GOLDEN_DOC_RELPATH, extractGoldenEvent, extractDocEventTypes } from "./contract-doc.js";

// presence / recency 表示包含述語 (LiveWall/Board 既定・external adapter を recency proxy で包含・ADR 019f474e)
// backend(wall)と webui(toDisplayList/purgeStale/liveness) が共有し境界跨ぎ drift を排除する単一出所。
export { WALL_RECENT_MS, isPresentOrRecentlyActive } from "./presence.js";
export type { PresenceRecencyInput } from "./presence.js";

// event id (UUIDv7)
export { EventId, newEventId, isUuidV7 } from "./id.js";

// timestamp + monotonicity
export {
  Timestamp,
  isIso8601,
  toEpochMs,
  MonotonicTimestampChecker,
  BoundedMonotonicTimestampChecker,
  isMonotonicNonDecreasing,
} from "./timestamp.js";
export type { BoundedMonotonicOptions } from "./timestamp.js";

// normalized event
export { NormalizedEvent, Metrics, Payload, parseEvent, safeParseEvent } from "./event.js";
export type { NormalizedEventInput } from "./event.js";

/** package メタ。 */
export const EVENT_MODEL_PACKAGE = "@actradeck/event-model" as const;
