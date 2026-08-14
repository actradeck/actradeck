/**
 * テストヘルパ: NormalizedEvent 生成 + 実 PG 接続ユーティリティ。
 * REAL DATA ONLY: モック DB は無い。実 Postgres へ接続する (DATABASE_URL)。
 */
import {
  newEventId,
  parseEvent,
  type Continuation,
  type EndKind,
  type NormalizedEvent,
  type StartKind,
} from "@actradeck/event-model";
import { Pool } from "pg";

export interface MakeEventOverrides {
  event_id?: string;
  session_id?: string;
  event_type?: string;
  state?: string;
  timestamp?: string;
  summary?: string;
  payload?: Record<string, unknown>;
  provider?: string;
  source?: string;
  /**
   * 取得方式 (ADR 019ea476/019ea4ba)。省略時は未指定 (managed 既定扱い)。
   * 型は event-model schema の indexed access で単一出所化 (ADR 0014 3a sweep TDA-3: 手コピー
   * リテラルは codex_rollout 追加時に stale 化した実例あり・再宣言しない)。
   */
  capture_mode?: NormalizedEvent["capture_mode"];
  /** session.started のガバナンス保証水準。 */
  governance_mode?: NormalizedEvent["governance_mode"];
  /** 権限モード (sandbox)。ADR 019ea4ba D3 / 段階2。省略時は未指定。 */
  permission_mode?: string;
  /** 作業ディレクトリ (sessions.cwd の出所)。project scope テスト等で指定。省略時は未指定。 */
  cwd?: string;
  /** 相関 thread_id (events 永続列)。redaction occurrence の id 列走査テスト等で指定。 */
  thread_id?: string;
  /** 相関 agent_id (events 永続列)。省略時は未指定。 */
  agent_id?: string;
  /** redaction マーカー件数 (secret_detected の出所)。省略時は未指定 (= 欠落)。 */
  redaction_count?: number;
  /** redaction マーカーの kind 別件数 (強み(a)③ 可視化の出所)。省略時は未指定 (= 欠落)。 */
  redaction_count_by_kind?: Record<string, number>;
  /** per-session seq (ADR 019f4cdb Phase2・silent-drop 下限検知)。省略時は未指定 (= 検知対象外)。 */
  seq?: number;
  /** ADR 0014 Phase 3a: provider 発行 raw session id (run lineage)。省略時は未指定 (= NULL)。 */
  provider_session_id?: string;
  /** ADR 0014 Phase 3a: run 開始種別 (event-model StartKind・単一出所)。省略時は未指定 (= NULL)。 */
  start_kind?: StartKind;
  /** ADR 0014 Phase 3a: resume 元 session_id (lineage エッジ)。省略時は未指定 (= NULL)。 */
  resumed_from_session_id?: string;
  /** ADR 0014 Phase 3a: run 終了種別 (event-model EndKind・単一出所)。省略時は未指定 (= NULL)。 */
  end_kind?: EndKind;
  /** ADR 0014 Phase 3a: 再開可能性 (event-model Continuation=Recoverability 再利用)。省略時は未指定 (= NULL)。 */
  recoverability?: Continuation;
}

/**
 * 妥当な NormalizedEvent を生成 (T1 parseEvent を通すことで検証も兼ねる)。
 * default は claude_code / hooks / heartbeat。
 */
export function makeEvent(o: MakeEventOverrides = {}): NormalizedEvent {
  const input: Record<string, unknown> = {
    event_id: o.event_id ?? newEventId(),
    provider: o.provider ?? "claude_code",
    source: o.source ?? "hooks",
    session_id: o.session_id ?? "sess_test",
    event_type: o.event_type ?? "heartbeat",
    timestamp: o.timestamp ?? new Date().toISOString(),
    payload: o.payload ?? {},
  };
  if (o.state !== undefined) input.state = o.state;
  if (o.summary !== undefined) input.summary = o.summary;
  if (o.capture_mode !== undefined) input.capture_mode = o.capture_mode;
  if (o.governance_mode !== undefined) input.governance_mode = o.governance_mode;
  if (o.permission_mode !== undefined) input.permission_mode = o.permission_mode;
  if (o.cwd !== undefined) input.cwd = o.cwd;
  if (o.thread_id !== undefined) input.thread_id = o.thread_id;
  if (o.agent_id !== undefined) input.agent_id = o.agent_id;
  if (o.redaction_count !== undefined) input.redaction_count = o.redaction_count;
  if (o.redaction_count_by_kind !== undefined)
    input.redaction_count_by_kind = o.redaction_count_by_kind;
  if (o.seq !== undefined) input.seq = o.seq;
  // ADR 0014 Phase 3a: run lineage フィールド (optional・省略時は未指定)。
  if (o.provider_session_id !== undefined) input.provider_session_id = o.provider_session_id;
  if (o.start_kind !== undefined) input.start_kind = o.start_kind;
  if (o.resumed_from_session_id !== undefined)
    input.resumed_from_session_id = o.resumed_from_session_id;
  if (o.end_kind !== undefined) input.end_kind = o.end_kind;
  if (o.recoverability !== undefined) input.recoverability = o.recoverability;
  return parseEvent(input);
}

/** ISO8601 を生成 (基準時刻 + offset ms)。順序テスト用。 */
export function iso(baseMs: number, offsetMs = 0): string {
  return new Date(baseMs + offsetMs).toISOString();
}

/** DB 到達可否 (skipIf 用)。 */
export async function dbReachable(connectionString: string): Promise<boolean> {
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 2_000, max: 1 });
  try {
    const c = await pool.connect();
    c.release();
    return true;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
}

/** テスト後のクリーンアップ: セッションを削除 (events/session_state は CASCADE)。 */
export async function cleanupSessions(pool: Pool, sessionIds: readonly string[]): Promise<void> {
  if (sessionIds.length === 0) return;
  await pool.query(`DELETE FROM sessions WHERE session_id = ANY($1::text[])`, [[...sessionIds]]);
}
