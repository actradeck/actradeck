/**
 * Replay history read layer.
 *
 * Reads append-only `events` rows by session and returns a small allow-listed DTO. Backend does not
 * re-redact: sidecar remains the redaction choke point. This layer only avoids creating a new raw
 * payload exposure surface.
 */
import { eventTypeToActionKind } from "@actradeck/event-model";
import { deriveActionSubject } from "@actradeck/projection";

import { REPLAY_ORDER } from "./replay-contract.js";

import type { ReplayEventDTO, ReplayEventKind, ReplayEventsPage } from "./replay-contract.js";
import type { Pool } from "pg";

export const DEFAULT_REPLAY_LIMIT = 200;
export const MAX_REPLAY_LIMIT = 500;

/**
 * Live Wall 段階1 (ADR 019ead7a D1): 横断フィードの per-session 行数 (直近 N events)。
 * connected な各 session の **最新 N 件**を取得し、表示は timestamp ASC で並べる。
 * back-pressure: per-session N + 横断 session 数上限 (MAX_WALL_SESSIONS) で有界化する。
 */
export const DEFAULT_WALL_PER_SESSION = 50;
export const MAX_WALL_PER_SESSION = 200;
export const MAX_WALL_SESSIONS = 24;

/**
 * 段階2 (ADR 019ea4ba D2-A): command stdout tail の既定 / 上限 (bytes 相当 = 文字長)。
 * 出所 `command.output.delta.delta` は **既に redaction 済みで永続** (sink.emit→redactDeep)。
 * read 層は再 redaction せず、allow-list で delta を連結して末尾 tail を返すだけ
 * (新規 raw 露出面を作らない)。tail 既定 16KB / 上限 64KB。
 */
export const DEFAULT_OUTPUT_TAIL = 16 * 1024;
export const MAX_OUTPUT_TAIL = 64 * 1024;

export function normalizeOutputTail(raw: unknown): number {
  if (typeof raw !== "string" || raw.length === 0) return DEFAULT_OUTPUT_TAIL;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_OUTPUT_TAIL;
  return Math.min(n, MAX_OUTPUT_TAIL);
}

/** 段階2: command 出力 tail DTO (stdout 本文の on-demand read)。 */
export interface CommandOutputExcerpt {
  readonly session_id: string;
  /** どの command.started を起点に連結したか。anchor 未一致 (not_found) / 未指定なら undefined。 */
  readonly anchor_event_id: string | undefined;
  /** redaction 済み stdout 本文の末尾 tail (生 delta は再露出しない)。 */
  readonly output_excerpt: string;
  /** 適用した tail 上限 (bytes 相当)。 */
  readonly tail: number;
  /** tail 上限で先頭が切られたか。 */
  readonly truncated: boolean;
  /**
   * SEC-1 (fail-closed): eventId が供給されたが当該 session の `command.started` に一致しなかった
   * (not-found)。このとき session-wide fallback は **返さず** 空 excerpt + not_found=true にする
   * (same-session redacted データの over-disclosure を防ぐ)。anchor 一致 / eventId 未指定では false。
   */
  readonly not_found: boolean;
}

interface ReplayCursor {
  readonly timestamp: string;
  readonly event_id: string;
}

interface EventRow {
  event_id: string;
  provider: string;
  source: string;
  session_id: string;
  event_type: string;
  state: string | null;
  timestamp: Date;
  cwd: string | null;
  summary: string | null;
  request_id: string | null;
  tool_name: string | null;
  command: string | null;
  path: string | null;
  // subject 導出 (deriveActionSubject) 用の追加 allowlist 列。すべて `payload->>` 由来 =
  // at-rest redacted (sidecar choke 済) で、backend は再 redaction しない。
  server: string | null;
  tool: string | null;
  query: string | null;
  reason: string | null;
  error: string | null;
  risk_level: string | null;
  decision: string | null;
  auto_allowed: boolean | null;
  exit_code: number | null;
  elapsed_ms: number | null;
}

export function normalizeReplayLimit(raw: unknown): number {
  if (typeof raw !== "string" || raw.length === 0) return DEFAULT_REPLAY_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_REPLAY_LIMIT;
  return Math.min(n, MAX_REPLAY_LIMIT);
}

export function encodeReplayCursor(cursor: ReplayCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeReplayCursor(raw: unknown): ReplayCursor | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid replay cursor");
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.timestamp !== "string" ||
    typeof parsed.event_id !== "string"
  ) {
    throw new Error("invalid replay cursor");
  }
  if (Number.isNaN(Date.parse(parsed.timestamp)) || parsed.event_id.length === 0) {
    throw new Error("invalid replay cursor");
  }
  return { timestamp: parsed.timestamp, event_id: parsed.event_id };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Replay DTO の kind 分類。projection ↔ replay のドリフトを防ぐため、event_type → kind の写像は
 * event-model の T1 正典 `eventTypeToActionKind` を**共有**する (TDA 指摘)。ReplayEventKind は
 * ActionKind の上位集合で、唯一の差は `error` を独立 kind として持つこと: ActionKind は error を
 * tool へ畳むため、ここでだけ `error` を上書きする (action-kind.ts docstring 参照)。
 */
function kindOf(eventType: string): ReplayEventKind {
  if (eventType === "error") return "error";
  return eventTypeToActionKind(eventType);
}

function value<T>(v: T | null): T | undefined {
  return v === null ? undefined : v;
}

/**
 * @deprecated 後方互換 fallback (replay-contract.ts ReplayEventDTO.display_text 参照)。
 * summary (日本語焼付け) 優先のため表示言語に追従できない。webui は kind+subject を優先する。
 * backend は本ロジックを変更しない (新規ロジックは subject に集約)。
 */
function displayText(row: EventRow): string {
  return row.summary ?? row.command ?? row.path ?? row.tool_name ?? row.event_type;
}

/**
 * 言語非依存の subject 導出。projection の current_action_subject と **同一写像** を共有するため、
 * EventRow の at-rest redacted な `payload->>` 列から **payload-like** を組み、`@actradeck/projection`
 * の `deriveActionSubject(event_type, payload)` へ委譲する (kind→field 写像の二重実装を断つ・TDA)。
 *
 * 渡すフィールドは shared 写像が参照する allowlist (command/path/server/tool/query/tool_name/error/reason)
 * のみ。すべて redacted 列由来で backend は再 redaction しない (INV-REPLAY-SUBJECT-NO-LEAK)。
 * `summary` は **渡さない** (日本語が焼き付いているため subject 出所にしない契約)。
 */
function subjectOf(row: EventRow): string | undefined {
  return deriveActionSubject(row.event_type, {
    command: row.command ?? undefined,
    path: row.path ?? undefined,
    server: row.server ?? undefined,
    tool: row.tool ?? undefined,
    query: row.query ?? undefined,
    tool_name: row.tool_name ?? undefined,
    error: row.error ?? undefined,
    reason: row.reason ?? undefined,
  });
}

export function normalizeWallPerSession(raw: unknown): number {
  if (typeof raw !== "string" || raw.length === 0) return DEFAULT_WALL_PER_SESSION;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return DEFAULT_WALL_PER_SESSION;
  return Math.min(n, MAX_WALL_PER_SESSION);
}

/**
 * events の allow-list 投影列 (eventsPage / 横断 wall read で共有・DRY)。
 * 生 payload を直載せせず、UI 表示に必要な allow-list フィールドのみ射影する
 * (新規 raw 露出面を作らない・redaction は sidecar choke / at-rest 済)。
 */
const EVENT_COLUMNS = `event_id,
        provider,
        source,
        session_id,
        event_type,
        state,
        timestamp,
        cwd,
        summary,
        payload->>'request_id' AS request_id,
        payload->>'tool_name' AS tool_name,
        payload->>'command' AS command,
        COALESCE(payload->>'path', payload->>'file_path') AS path,
        payload->>'server' AS server,
        payload->>'tool' AS tool,
        payload->>'query' AS query,
        payload->>'reason' AS reason,
        payload->>'error' AS error,
        payload->>'risk_level' AS risk_level,
        payload->>'decision' AS decision,
        CASE
          WHEN jsonb_typeof(payload->'auto_allowed') = 'boolean'
          THEN (payload->>'auto_allowed')::boolean
          ELSE NULL
        END AS auto_allowed,
        CASE
          WHEN jsonb_typeof(payload->'exit_code') = 'number'
          THEN (payload->>'exit_code')::double precision
          ELSE NULL
        END AS exit_code,
        CASE
          WHEN jsonb_typeof(metrics->'elapsed_ms') = 'number'
          THEN (metrics->>'elapsed_ms')::double precision
          ELSE NULL
        END AS elapsed_ms`;

export function rowToReplayEvent(row: EventRow): ReplayEventDTO {
  return {
    event_id: row.event_id,
    provider: row.provider,
    source: row.source,
    session_id: row.session_id,
    event_type: row.event_type,
    kind: kindOf(row.event_type),
    timestamp: row.timestamp.toISOString(),
    state: row.state ?? undefined,
    cwd: row.cwd ?? undefined,
    summary: row.summary ?? undefined,
    display_text: displayText(row),
    subject: subjectOf(row),
    request_id: value(row.request_id),
    tool_name: value(row.tool_name),
    command: value(row.command),
    path: value(row.path),
    risk_level: value(row.risk_level),
    decision: value(row.decision),
    auto_allowed: value(row.auto_allowed),
    exit_code: value(row.exit_code),
    elapsed_ms: value(row.elapsed_ms),
  };
}

export class ReplayStore {
  constructor(private readonly pool: Pool) {}

  async eventsPage(opts: {
    readonly sessionId: string;
    readonly cursor?: ReplayCursor;
    readonly limit?: number;
  }): Promise<ReplayEventsPage> {
    const limit = Math.min(opts.limit ?? DEFAULT_REPLAY_LIMIT, MAX_REPLAY_LIMIT);
    const fetchLimit = limit + 1;
    const cursor = opts.cursor;
    const { rows } = await this.pool.query<EventRow>(
      `SELECT ${EVENT_COLUMNS}
         FROM events
        WHERE session_id = $1
          AND (
            $2::timestamptz IS NULL
            OR (timestamp, event_id) > ($2::timestamptz, $3::text)
          )
        ORDER BY timestamp ASC, event_id ASC
        LIMIT $4`,
      [opts.sessionId, cursor?.timestamp ?? null, cursor?.event_id ?? "", fetchLimit],
    );
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows[pageRows.length - 1];
    return {
      session_id: opts.sessionId,
      order: REPLAY_ORDER,
      events: pageRows.map(rowToReplayEvent),
      limit,
      has_more: hasMore,
      next_cursor:
        hasMore && last
          ? encodeReplayCursor({ timestamp: last.timestamp.toISOString(), event_id: last.event_id })
          : undefined,
    };
  }

  /**
   * Live Wall 段階1 (ADR 019ead7a D1): 指定 session 群の **最新 N events** を横断取得する。
   *
   * connected フィルタは呼び出し側 (route) が isLive で絞った session_id 群を渡す前提
   * (store は presence を知らない = realtime-store と同方針)。各 session の最新 N 件を
   * ROW_NUMBER 窓で **1 往復**取得し、表示用に session ごと timestamp ASC, event_id ASC
   * (REPLAY_ORDER) で返す。DTO は既存 rowToReplayEvent の allow-list 投影を再利用する
   * (新 redaction 面ゼロ・backend 再 redaction なし)。空入力は空 Map。
   */
  async recentEventsForSessions(
    sessionIds: readonly string[],
    perSession: number = DEFAULT_WALL_PER_SESSION,
  ): Promise<Map<string, ReplayEventDTO[]>> {
    const out = new Map<string, ReplayEventDTO[]>();
    if (sessionIds.length === 0) return out;
    const n = Math.min(perSession, MAX_WALL_PER_SESSION);
    const { rows } = await this.pool.query<EventRow>(
      `SELECT ${EVENT_COLUMNS}
         FROM (
           SELECT *,
                  ROW_NUMBER() OVER (
                    PARTITION BY session_id ORDER BY timestamp DESC, event_id DESC
                  ) AS rn
             FROM events
            WHERE session_id = ANY($1::text[])
         ) events
        WHERE rn <= $2
        ORDER BY session_id ASC, timestamp ASC, event_id ASC`,
      [sessionIds, n],
    );
    for (const row of rows) {
      const dto = rowToReplayEvent(row);
      const lane = out.get(row.session_id);
      if (lane) lane.push(dto);
      else out.set(row.session_id, [dto]);
    }
    return out;
  }

  /**
   * 段階2 (ADR 019ea4ba D2-A): 指定 session の command stdout 本文 tail を返す。
   *
   * 出所 `command.output.delta.delta` は **既に redaction 済みで永続** (sink.emit→redactDeep)。
   * 本メソッドは生 payload を再露出せず、allow-list で delta 文字列のみを timestamp,event_id 昇順で
   * 連結し、末尾 tail を返す (backend 再 redaction なし = sidecar choke 維持)。
   *
   * anchor (eventId) が指定され、それが当該 session の `command.started` 行のときは、その timestamp
   * 以降・**次の command.started** の timestamp 未満の output delta のみ連結する (どの command の出力かを
   * 絞り、過剰露出を避ける)。
   *
   * SEC-1 (fail-closed・over-disclosure 防止): eventId が供給されたが当該 session の `command.started`
   *   に **一致しない** (typo / 別 event_type / 別 session の id) ときは session-wide fallback を返さず、
   *   空 excerpt + not_found=true を返す (same-session の redacted データ全量を不一致 anchor で開示しない)。
   *   eventId **未指定**のみ session 全体連結を許す (明示的な whole-session モード)。
   *
   * tail 上限超過時は **末尾 tail** を保持し先頭を捨てる (truncated=true)。各 delta は per-delta で
   * redaction 済みなので、tail slice で境界断片に secret は残らない (3#SEC-2 と整合)。
   */
  async commandOutput(opts: {
    readonly sessionId: string;
    readonly eventId?: string;
    readonly tail?: number;
  }): Promise<CommandOutputExcerpt> {
    const tail = Math.min(opts.tail ?? DEFAULT_OUTPUT_TAIL, MAX_OUTPUT_TAIL);
    const hasAnchor = typeof opts.eventId === "string" && opts.eventId.length > 0;

    // anchor command.started の時間窓 [startTs, nextStartTs) を解決する (指定時のみ)。
    let startTs: Date | undefined;
    let nextStartTs: Date | undefined;
    let anchorEventId: string | undefined;
    if (hasAnchor) {
      const { rows: anchorRows } = await this.pool.query<{ timestamp: Date }>(
        `SELECT timestamp FROM events
          WHERE session_id = $1 AND event_id = $2 AND event_type = 'command.started'
          LIMIT 1`,
        [opts.sessionId, opts.eventId],
      );
      const anchor = anchorRows[0];
      if (!anchor) {
        // SEC-1 fail-closed: 不一致 anchor は session-wide fallback を返さず空で打ち切る。
        return {
          session_id: opts.sessionId,
          anchor_event_id: undefined,
          output_excerpt: "",
          tail,
          truncated: false,
          not_found: true,
        };
      }
      startTs = anchor.timestamp;
      anchorEventId = opts.eventId;
      const { rows: nextRows } = await this.pool.query<{ timestamp: Date }>(
        `SELECT timestamp FROM events
          WHERE session_id = $1 AND event_type = 'command.started' AND timestamp > $2
          ORDER BY timestamp ASC, event_id ASC
          LIMIT 1`,
        [opts.sessionId, anchor.timestamp],
      );
      nextStartTs = nextRows[0]?.timestamp;
    }

    // 該当 output delta を昇順で取得 (allow-list: delta 文字列のみ)。
    const { rows } = await this.pool.query<{ delta: string | null }>(
      `SELECT payload->>'delta' AS delta
         FROM events
        WHERE session_id = $1
          AND event_type = 'command.output.delta'
          AND ($2::timestamptz IS NULL OR timestamp >= $2::timestamptz)
          AND ($3::timestamptz IS NULL OR timestamp < $3::timestamptz)
        ORDER BY timestamp ASC, event_id ASC`,
      [opts.sessionId, startTs ?? null, nextStartTs ?? null],
    );

    const combined = rows.map((r) => r.delta ?? "").join("");
    let output = combined;
    let truncated = false;
    if (output.length > tail) {
      // 末尾 tail を保持し先頭を捨てる (最新の出力を見せる)。
      output = output.slice(output.length - tail);
      truncated = true;
    }
    return {
      session_id: opts.sessionId,
      anchor_event_id: anchorEventId,
      output_excerpt: output,
      tail,
      truncated,
      not_found: false,
    };
  }
}
