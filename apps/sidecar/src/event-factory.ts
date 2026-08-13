/**
 * NormalizedEvent 生成ヘルパ — event-model (T1 正典) のみを使う。
 *
 * Sidecar は event_id を UUIDv7 で採番 (newEventId) し、parseEvent で正規化境界を
 * バリデートする。provider=claude_code / source=hooks を既定とする。
 */
import {
  type Continuation,
  type EndKind,
  EventPayload,
  type CaptureMode,
  type GovernanceMode,
  type EventType,
  type NormalizedEvent,
  type Provider,
  type Source,
  type StartKind,
  type State,
  newEventId,
  parseEvent,
} from "@actradeck/event-model";

/** Phase 2 既定の provider/source (Claude Code hooks)。codex 連携で引数上書き可能。 */
export const DEFAULT_PROVIDER: Provider = "claude_code";
export const DEFAULT_SOURCE: Source = "hooks";

/** イベント生成入力 (event_id / timestamp / provider / source は補完)。 */
export interface BuildEventInput {
  readonly session_id: string;
  /**
   * provider (claude) が発行した raw session id (ADR 019e9462)。canonical `session_id` と
   * 分離して出所を記録する。hook 経路では `session_id` と同値、fallback 経路では未指定。
   */
  readonly provider_session_id?: string;
  /**
   * ADR 0014 Phase 3b — run 開始種別 (fresh/resume/recovery/clear/unknown)。run 起点イベント
   * (session.started 等) にのみ載せる。backend upsertSession が first-wins で確定 (3a 済)。
   */
  readonly start_kind?: StartKind;
  /**
   * ADR 0014 Phase 3b — resume run の継続元 canonical session_id (lineage エッジ)。親 run を実際に
   * 観測した境界でのみ設定 (実在 ActraDeck session_id を指す・未観測は absent)。SEC-1: redaction の
   * CORRELATION_KEY_FIELDS に allowlist 済 (D8・populate より前に着地)。
   */
  readonly resumed_from_session_id?: string;
  /**
   * ADR 0014 Phase 3b — run 終了種別 (completed/failed/interrupted/unloaded/cleared/logout/other/unknown)。
   * run 終端イベント (session.ended) にのみ載せる。backend が last-non-null-wins で確定 (3a 済)。
   */
  readonly end_kind?: EndKind;
  /**
   * ADR 0014 Phase 3b — run の再開可能性 (resumable/not_resumable/unknown)。Phase 1 直交軸
   * Continuation を再利用 (terminalContinuation(state) 単一出所)。終端イベントにのみ載せる。
   */
  readonly recoverability?: Continuation;
  /**
   * 観測モード (ADR 019ea476 D8)。managed = PTY/app-server 所有経路、attach = hooks 後付け観測。
   * 省略時は wire 上 undefined のまま (= 欠落 = managed 既定扱い, 後方互換)。
   */
  readonly capture_mode?: CaptureMode;
  /** session.started のガバナンス保証水準。欠落を enforcement と推測しない。 */
  readonly governance_mode?: GovernanceMode;
  /**
   * 権限モード (sandbox)。hook の `permission_mode` 由来 (ADR 019ea4ba 段階2)。
   * 省略時は wire 上 undefined (後方互換)。表示専用 (projection key 非使用)。
   */
  readonly permission_mode?: string;
  readonly event_type: EventType;
  /** 既定 claude_code。codex 連携時に上書き (Provider = slug 開放・ADR 019f2d2c D1 / T1 整合)。 */
  readonly provider?: Provider;
  /** 既定 hooks。app_server / sdk / external 連携時に上書き (Source = closed enum / T1 整合)。 */
  readonly source?: Source;
  readonly state?: State;
  readonly thread_id?: string;
  readonly turn_id?: string;
  readonly agent_id?: string;
  readonly cwd?: string;
  readonly summary?: string;
  readonly payload?: Record<string, unknown>;
  readonly metrics?: Record<string, number>;
  /** テスト・再送で timestamp を固定したい場合のみ。既定は now。 */
  readonly timestamp?: string;
}

/**
 * payload 判別 union の整合エラー (3#TDA-1)。
 * payload.kind が event_type と食い違う / union に適合しない場合に投げる。
 */
export class PayloadKindMismatchError extends Error {
  constructor(
    readonly eventType: string,
    readonly detail: string,
  ) {
    super(`payload kind mismatch for event_type=${eventType}: ${detail}`);
    this.name = "PayloadKindMismatchError";
  }
}

/**
 * 3#TDA-1: payload 判別 union (EventPayload) を emit 経路で強制する。
 *
 * NormalizedEvent.payload は段階導入のため loose record だが、payload が `kind` を持つ場合は
 *   (a) `payload.kind` が `event_type` と一致し、
 *   (b) EventPayload discriminated union に適合する、
 * ことを要求する。不整合 (kind != event_type / union 不適合) は弾く。
 *
 * `kind` を持たない payload (= 構造化フィールド未充填の最小 payload) は後方互換で許容する。
 */
export function assertPayloadConsistency(event: NormalizedEvent): void {
  const payload = event.payload as Record<string, unknown> | undefined;
  if (payload === undefined || typeof payload !== "object") return;
  if (!("kind" in payload)) return; // kind なし → loose 許容 (前方互換)
  // (a) kind と event_type の突合。
  if (payload.kind !== event.event_type) {
    throw new PayloadKindMismatchError(
      event.event_type,
      `payload.kind=${String(payload.kind)} != event_type`,
    );
  }
  // (b) discriminated union 適合 (kind 固有の必須フィールド・型を検証)。
  const res = EventPayload.safeParse(payload);
  if (!res.success) {
    throw new PayloadKindMismatchError(
      event.event_type,
      res.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
  }
}

/**
 * NormalizedEvent を生成し parseEvent で検証して返す。
 * exactOptionalPropertyTypes 環境のため optional は存在時のみ付与する。
 * 3#TDA-1: payload.kind と event_type の整合 (判別 union) も強制する。
 */
export function buildEvent(input: BuildEventInput): NormalizedEvent {
  const candidate: Record<string, unknown> = {
    event_id: newEventId(),
    provider: input.provider ?? DEFAULT_PROVIDER,
    source: input.source ?? DEFAULT_SOURCE,
    session_id: input.session_id,
    event_type: input.event_type,
    timestamp: input.timestamp ?? new Date().toISOString(),
    payload: input.payload ?? {},
    metrics: input.metrics ?? {},
  };
  if (input.provider_session_id !== undefined)
    candidate.provider_session_id = input.provider_session_id;
  // ADR 0014 Phase 3b run lineage (additive・存在時のみ付与)。
  if (input.start_kind !== undefined) candidate.start_kind = input.start_kind;
  if (input.resumed_from_session_id !== undefined)
    candidate.resumed_from_session_id = input.resumed_from_session_id;
  if (input.end_kind !== undefined) candidate.end_kind = input.end_kind;
  if (input.recoverability !== undefined) candidate.recoverability = input.recoverability;
  if (input.capture_mode !== undefined) candidate.capture_mode = input.capture_mode;
  if (input.governance_mode !== undefined) candidate.governance_mode = input.governance_mode;
  if (input.permission_mode !== undefined) candidate.permission_mode = input.permission_mode;
  if (input.state !== undefined) candidate.state = input.state;
  if (input.thread_id !== undefined) candidate.thread_id = input.thread_id;
  if (input.turn_id !== undefined) candidate.turn_id = input.turn_id;
  if (input.agent_id !== undefined) candidate.agent_id = input.agent_id;
  if (input.cwd !== undefined) candidate.cwd = input.cwd;
  if (input.summary !== undefined) candidate.summary = input.summary;
  const event = parseEvent(candidate);
  // 3#TDA-1: payload 判別 union を emit 前に強制 (kind と event_type の突合 + 型検証)。
  assertPayloadConsistency(event);
  return event;
}
