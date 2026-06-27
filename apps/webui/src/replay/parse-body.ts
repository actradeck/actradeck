"use client";

/**
 * 段階2 (ADR 019ea4ba D2) の本文 pull 応答パーサ (純関数).
 *
 * diff 本文 (`GET /realtime/sessions/:id/diff`) と command stdout tail
 * (`GET /realtime/sessions/:id/commands/:eventId/output`) の応答を **寛容に** 検証する。
 *
 * SEC (security.md): ここで触る body はすべて **backend/sidecar で redaction 済み**
 * (diff は sidecar choke、stdout は redacted-at-rest)。UI は本文を再取得・再構成せず、
 * 受け取った文字列をそのまま表示するだけ (新たな本文経路を作らない)。
 */

export interface DiffBody {
  /** redaction 済み diff 本文。 */
  readonly body: string;
  readonly truncated: boolean;
  /** redaction が秘匿を検出したか (件数/bool のみ・秘匿値は含まない)。 */
  readonly secret_detected: boolean;
  readonly redaction_count: number;
}

export interface OutputBody {
  readonly session_id: string;
  readonly anchor_event_id: string | undefined;
  /** redaction 済み stdout tail。 */
  readonly output_excerpt: string;
  readonly tail: number;
  readonly truncated: boolean;
  /** SEC-1: anchor eventId が当該 command.started に一致せず空で打ち切られた (fail-closed)。 */
  readonly not_found: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function parseDiffBody(raw: unknown): DiffBody | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.body !== "string") return null;
  return {
    body: raw.body,
    truncated: raw.truncated === true,
    secret_detected: raw.secret_detected === true,
    redaction_count:
      typeof raw.redaction_count === "number" && Number.isFinite(raw.redaction_count)
        ? raw.redaction_count
        : 0,
  };
}

export function parseOutputBody(raw: unknown): OutputBody | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.session_id !== "string" || typeof raw.output_excerpt !== "string") return null;
  return {
    session_id: raw.session_id,
    anchor_event_id: typeof raw.anchor_event_id === "string" ? raw.anchor_event_id : undefined,
    output_excerpt: raw.output_excerpt,
    tail: typeof raw.tail === "number" && Number.isFinite(raw.tail) ? raw.tail : 0,
    truncated: raw.truncated === true,
    not_found: raw.not_found === true,
  };
}
