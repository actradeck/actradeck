/**
 * Session Replay DTO contract.
 *
 * This is deliberately not a raw NormalizedEvent export. Replay may show only allow-listed fields
 * that are already safe for UI display and sufficient to rebuild projection with
 * `@actradeck/projection`.
 */
export type ReplayEventKind =
  | "session"
  | "turn"
  | "approval"
  | "command"
  | "file"
  | "tool"
  | "mcp"
  | "web"
  | "message"
  | "liveness"
  | "error"
  | "other";

export type ReplayOrder = "timestamp_event_id_asc";
export const REPLAY_ORDER: ReplayOrder = "timestamp_event_id_asc";

export interface ReplayEventDTO {
  readonly event_id: string;
  readonly provider: string;
  readonly source: string;
  readonly session_id: string;
  readonly event_type: string;
  readonly kind: ReplayEventKind;
  readonly timestamp: string;
  readonly state: string | undefined;
  readonly cwd: string | undefined;
  /**
   * legacy summary (normalizer が焼き込んだ表示文字列・redacted)。turn.started/completed のみ
   * `boundTurnSummary` (projection 正典・SUMMARY_SUBJECT_CAP=200+…) で搬送有界化される
   * (gemini-obs SEC-3=TDA-3: adapter uncapped 送出の at-rest 値を DTO で unbounded 搬送しない)。
   */
  readonly summary: string | undefined;
  /**
   * @deprecated 後方互換 fallback。`row.summary ?? command ?? path ?? tool_name ?? event_type` で
   * 組まれるため **summary (normalizer が焼き込んだ日本語固定文字列) が優先**され、表示言語に
   * 追従できない。表示時ローカライズ (ADR 019eeac6) では webui は `kind` + `subject` を優先し、
   * これは両者を解釈できない旧クライアント向けに温存する。新規ロジックはここに依存しない。
   */
  readonly display_text: string;
  /**
   * 言語非依存の「対象」構造値 (command / path / server/tool / query / tool_name / error/reason 由来)。
   * webui は `kind` (述語テンプレート) + `subject` (対象) を表示時 locale で組み立てる。
   *
   * 出所は **redacted payload の kind 別 allowlist フィールドのみ** (`payload->>` = at-rest redacted)。
   * projection の current_action_subject と **完全に同一の写像** (`@actradeck/projection`
   * `deriveActionSubject`) を共有し、projection↔replay のドリフトを防ぐ。`summary` や未 redaction 値
   * からは決して引かない (INV-REPLAY-SUBJECT-NO-LEAK・INV-CURRENT-ACTION-NO-LEAK と同型)。
   * subject に出来る構造値が無い event_type は undefined。
   */
  readonly subject: string | undefined;
  readonly request_id: string | undefined;
  readonly tool_name: string | undefined;
  readonly command: string | undefined;
  readonly path: string | undefined;
  readonly risk_level: string | undefined;
  readonly decision: string | undefined;
  readonly auto_allowed: boolean | undefined;
  readonly exit_code: number | undefined;
  readonly elapsed_ms: number | undefined;
  /**
   * ADR 0015 §D4/§D8 work-items carriage (additive・all `| undefined`・JSON は undefined を落とす
   * ため非 work イベントでは wire に載らない). webui は既存イベントフィードを **client-side fold**
   * (`@actradeck/projection` `reduceWorkItems`) で work_items へ畳む。ReplayEventDTO の allow-list は
   * fold 入力フィールドを剥がすため、fold が本番で常に空にならないよう **fold が読む payload フィールドを
   * additive 露出**する (per-event redaction_count follow-up 019ec841 / additive subject 019eeb1d と同機構)。
   *
   * すべて **at-rest redacted payload** (`payload->>` 由来) の closed-enum / hash / content-free id /
   * redacted+bounded 自由文のみ。生 provider text / 生パス / secret は載せない (NO-RAW・§D10)。
   */
  /**
   * additive optional (後方互換・`capture_mode?` と同じ欠落=キー落とし方式)。非 work イベントでは
   * キーごと落ちるため wire にも載らない。旧 backend/DTO は欠落で degrade する。
   */
  /** work.item.updated: provider の task id (CC serial 等・§D3 で非 secret・fold が hash 化して id 導出)。 */
  readonly provider_task_id?: string;
  /** work.item.updated: WorkItemStatus (closed enum・fold が coerce)。 */
  readonly work_item_status?: string;
  /** work.item.updated: task subject (redacted+bounded・boundTurnSummary で post-floor 有界化)。 */
  readonly work_item_subject?: string;
  /** work.item.updated: ObservationStamp.method (closed enum・§D7)。 */
  readonly observation_method?: string;
  /** work.item.updated: ObservationStamp.fidelity (closed enum・§D7)。 */
  readonly observation_fidelity?: string;
  /** command.*: check 分類 (CheckKind closed enum・§D6)。 */
  readonly check_kind?: string;
  /** command.completed: check_match (CheckMatch closed enum・§D6)。 */
  readonly check_match?: string;
  /** diff.updated: HEAD commit id (content-free・§D5 tree fingerprint 素材)。 */
  readonly head_sha?: string;
  /** diff.updated: working-tree dirty fingerprint hash (§D5)。 */
  readonly diff_hash?: string;
  /**
   * turn.plan.updated: typed plan items ({step, status} のみへ再射影・§D2)。step は redacted+bounded、
   * status は WorkItemStatus。他フィールドは backend で構造的に落とす (NO-RAW by construction)。
   */
  readonly plan_items?: readonly { readonly step: string; readonly status: string }[];
}

export interface ReplayEventsPage {
  readonly session_id: string;
  /** T1 replay order: chronological event timestamp, event_id as stable same-timestamp tie-break. */
  readonly order: ReplayOrder;
  readonly events: readonly ReplayEventDTO[];
  readonly limit: number;
  readonly has_more: boolean;
  readonly next_cursor: string | undefined;
}
