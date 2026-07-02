/**
 * @actradeck/event-model — T1 canonical (正典).
 *
 * ActraDeck の正規化イベントモデル: plan.md §4 (状態) / §6 (イベント) の T1 実装。
 * Sidecar (採番・送信) / backend (ingestion・reducer・state engine) / UI が共通参照する。
 *
 * 公開面:
 * - 型/enum: Provider, Source, State, EventType, RiskLevel, ApprovalDecision
 * - schema:  NormalizedEvent, EventPayload, Metrics, Timestamp, EventId
 * - 採番:     newEventId / isUuidV7
 * - 遷移:     STATE_TRANSITIONS / isValidTransition / assertValidTransition
 * - 単調性:   MonotonicTimestampChecker / isMonotonicNonDecreasing
 */

// provider / source
export { Provider, Source } from "./provider.js";

// state model + transitions (T1 遷移表)
export {
  State,
  ALL_STATES,
  RUNNING_STATES,
  WAITING_STATES,
  TERMINAL_STATES,
  STATE_TRANSITIONS,
  isTerminalState,
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
} from "./payload.js";

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
