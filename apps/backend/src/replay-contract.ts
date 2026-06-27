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
