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
  FAILURE_TERMINAL_STATES,
  STATE_TRANSITIONS,
  isTerminalState,
  isTerminalStateValue,
  isFailureTerminalStateValue,
  isValidTransition,
  assertValidTransition,
  InvalidStateTransitionError,
  // ADR 0014 直交軸 (provider lifecycle fidelity)
  TERMINAL_CONTINUATION,
  TERMINAL_EVIDENCE_DEFAULT,
  terminalContinuation,
  resolveContinuation,
  terminalEvidenceFor,
  // ADR 0014 Phase 3 (run lineage) — recoverability は Continuation を再利用した zod enum。
  Recoverability,
  StartKind,
  EndKind,
  // ADR 0014 Phase 3a (TDA-1 昇格): LastTurnOutcome も zod enum を値の単一出所として value export
  //   する (ingest-store gate が .safeParse/.options を再利用・手写し Set 廃止)。
  LastTurnOutcome,
  // ADR 0014 Phase 2 (TDA-2): 初期状態集合の正典 (conformance restart-after-terminal が参照)。
  INITIAL_STATES,
} from "./state.js";
export type { Continuation, TerminalEvidence } from "./state.js";

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
  ResolutionOrigin,
  RESOLUTION_ORIGINS,
  SYNTHETIC_RETIRE_ORIGIN,
  isSyntheticRetireOrigin,
  APPROVAL_DECISIONS,
  DeliveryStatus,
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
  REDACT_SWALLOWED_PREFIX,
  redactionMarker,
  redactSwallowedHint,
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

// 承認 request_id 採番の正準実装 (T1 single source: sidecar bridge / backend safety-demo が共有・Phase 4 R3)
export {
  APPROVAL_REQUEST_ID_RE,
  mintApprovalRequestId,
  deriveDemoApprovalRequestId,
} from "./approval-request-id.js";

// approval reconcile hello 宣言の wire 構築 + 受信検証 (T1 single source: sidecar 送信 / backend 検証・ADR 0014 Phase 4)
export {
  MAX_ACTIVE_PENDING_IDS,
  MAX_REQUEST_ID_LEN,
  ACTIVE_PENDING_FIELD,
  RUNTIME_EPOCH_FIELD,
  buildApprovalReconcileHelloFields,
  parseActivePendingRequestIds,
  parseRuntimeEpoch,
} from "./approval-reconcile-wire.js";

// audit-coverage 導出 (per-provider 最終受信・gap 候補) の T1 single source
//   (backend SQL 射影 / route / webui parse が共有・ingested_at 権威 + 非稼働≠gap + NO-RAW・ADR 019f4cdb)
export {
  projectProviderCoverageRow,
  computeProviderCoverage,
  buildCoverageReport,
  parseProviderCoverageWire,
  parseAuditCoverageReportWire,
} from "./audit-coverage.js";
export type {
  ProviderCoverageInput,
  AuditProviderCoverage,
  AuditCoverageReport,
} from "./audit-coverage.js";

// seq-drop 検知 (client 申告 seq による中間 silent-drop の下限導出 + 密性抑制) の T1 single source
//   (backend SQL 集約 ↔ TS reference parity / ADR 019f4cdb Phase2・decision 019f502c + 抑制規則)。
// N-TDA-1: 集約に使うべきは **抑制込み** の `evaluateSeqMissing` のみ。raw な
//   `computeSeqMissingLowerBound` は public barrel から **意図的に非公開** (module 内部・診断/境界テスト
//   専用) にし、consumer が抑制前の生下限を誤って集約する footgun (SEC-1 の再導入) を構造的に防ぐ。
export { evaluateSeqMissing } from "./seq-drop.js";
export type { SeqMissingEvaluation } from "./seq-drop.js";

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

// isomorphic 同期 SHA-256 (work-item id / tree fingerprint の素・browser/Node 共通・ADR 0015)
export { sha256Hex } from "./hash.js";

// work item / completion claim / verification 契約 (ADR 0015 evidence-based completion・T1 正典)
//   enum 群 + 正準導出 (deriveWorkItemId / treeFingerprint)。fold は packages/projection。
export {
  WorkItemStatus,
  VerificationState,
  CheckKind,
  CheckMatch,
  ObservationAvailability,
  ObservationMethod,
  ObservationFidelity,
  ObservedCapability,
  ObservationStamp,
  CapabilityEvidence,
  WorkItemIdScheme,
  coerceWorkItemStatus,
  deriveWorkItemId,
  treeFingerprint,
} from "./work-item.js";

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
export { BoundedLruMap } from "./bounded-lru-map.js";

// normalized event
export {
  CaptureMode,
  GovernanceMode,
  NormalizedEvent,
  Metrics,
  Payload,
  parseEvent,
  safeParseEvent,
} from "./event.js";
export type { NormalizedEventInput } from "./event.js";

// Stream-level conformance checker for third-party ingestion adapters (schema + cross-field
// + ordering + drop-detection wiring). scripts/check-conformance.mjs is the CLI wrapper.
export { checkConformance } from "./conformance.js";
export type {
  ConformanceReport,
  ConformanceFinding,
  ConformanceRule,
  ConformanceSeverity,
} from "./conformance.js";

// test harness の production-DB 接続ガード (SEC-2・裁定 019fc4c6)。backend/webui/db/sidecar の
// vitest setup + webui boot-smoke が共有する単一出所 (runtime コードからは import しない)。
// barrel には cross-package 消費される 2 入口のみ載せる — 補助 (forbiddenTestDbPorts /
// isForbiddenTestDatabaseUrl / 定数) は module 内部 + 境界テスト専用で、テストは
// ./test-db-guard.js から直接 import する (seq-drop の computeSeqMissingLowerBound と同じ規範・
// TDA-1・裁定 019fcd5f)。
export { applyDotenvForTests, applyTestDatabaseGuard } from "./test-db-guard.js";

/** package メタ。 */
export const EVENT_MODEL_PACKAGE = "@actradeck/event-model" as const;
