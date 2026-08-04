"use client";

import { State, isIso8601 } from "@actradeck/event-model";

import type { ReplayEventDTO, ReplayEventsPage } from "../realtime/contract";

const REPLAY_ORDER: ReplayEventsPage["order"] = "timestamp_event_id_asc";

const REPLAY_KINDS = new Set<ReplayEventDTO["kind"]>([
  "session",
  "turn",
  "approval",
  "command",
  "file",
  "tool",
  "mcp",
  "web",
  "message",
  "liveness",
  "error",
  "other",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function optString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function optBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function optNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * ADR 0015 §D4/§D8 work-items carriage を wire から DTO へ復元する (client-side fold の入力)。
 * additive optional: 定義された値のキーだけ含める (exactOptionalPropertyTypes)。
 * plan_items は {step, status} だけへ再射影し余剰フィールドを構造的に落とす (NO-RAW by construction)。
 * 生 payload を独自取得せず、backend allow-list 投影の値を検証して写すのみ (security.md)。
 */
function parsePlanItems(
  v: unknown,
): readonly { readonly step: string; readonly status: string }[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: { step: string; status: string }[] = [];
  for (const el of v) {
    if (!isRecord(el) || typeof el.step !== "string") continue;
    out.push({ step: el.step, status: typeof el.status === "string" ? el.status : "" });
  }
  return out;
}

function parseWorkItemFields(
  v: Record<string, unknown>,
): Partial<
  Pick<
    ReplayEventDTO,
    | "provider_task_id"
    | "work_item_status"
    | "work_item_subject"
    | "observation_method"
    | "observation_fidelity"
    | "check_kind"
    | "check_match"
    | "head_sha"
    | "diff_hash"
    | "plan_items"
  >
> {
  const providerTaskId = optString(v.provider_task_id);
  const workItemStatus = optString(v.work_item_status);
  const workItemSubject = optString(v.work_item_subject);
  const observationMethod = optString(v.observation_method);
  const observationFidelity = optString(v.observation_fidelity);
  const checkKind = optString(v.check_kind);
  const checkMatch = optString(v.check_match);
  const headSha = optString(v.head_sha);
  const diffHash = optString(v.diff_hash);
  const planItems = parsePlanItems(v.plan_items);
  return {
    ...(providerTaskId !== undefined ? { provider_task_id: providerTaskId } : {}),
    ...(workItemStatus !== undefined ? { work_item_status: workItemStatus } : {}),
    ...(workItemSubject !== undefined ? { work_item_subject: workItemSubject } : {}),
    ...(observationMethod !== undefined ? { observation_method: observationMethod } : {}),
    ...(observationFidelity !== undefined ? { observation_fidelity: observationFidelity } : {}),
    ...(checkKind !== undefined ? { check_kind: checkKind } : {}),
    ...(checkMatch !== undefined ? { check_match: checkMatch } : {}),
    ...(headSha !== undefined ? { head_sha: headSha } : {}),
    ...(diffHash !== undefined ? { diff_hash: diffHash } : {}),
    ...(planItems !== undefined ? { plan_items: planItems } : {}),
  };
}

export function parseReplayEvent(v: unknown): ReplayEventDTO | null {
  if (!isRecord(v)) return null;
  if (
    typeof v.event_id !== "string" ||
    typeof v.provider !== "string" ||
    typeof v.source !== "string" ||
    typeof v.session_id !== "string" ||
    typeof v.event_type !== "string" ||
    typeof v.kind !== "string" ||
    !REPLAY_KINDS.has(v.kind as ReplayEventDTO["kind"]) ||
    typeof v.timestamp !== "string" ||
    !isIso8601(v.timestamp) ||
    typeof v.display_text !== "string"
  ) {
    return null;
  }
  const state = optString(v.state);
  if (state !== undefined && !State.safeParse(state).success) return null;
  return {
    event_id: v.event_id,
    provider: v.provider,
    source: v.source,
    session_id: v.session_id,
    event_type: v.event_type,
    kind: v.kind as ReplayEventDTO["kind"],
    timestamp: v.timestamp,
    state,
    cwd: optString(v.cwd),
    summary: optString(v.summary),
    display_text: v.display_text,
    // 言語非依存の構造値 (P2・ADR 019eeac6)。UI は kind + subject を表示時 locale で組み立てる。
    subject: optString(v.subject),
    request_id: optString(v.request_id),
    tool_name: optString(v.tool_name),
    command: optString(v.command),
    path: optString(v.path),
    risk_level: optString(v.risk_level),
    decision: optString(v.decision),
    auto_allowed: optBool(v.auto_allowed),
    exit_code: optNumber(v.exit_code),
    elapsed_ms: optNumber(v.elapsed_ms),
    // ADR 0015 §D4/§D8 work-items carriage (additive optional・fold 入力)。
    ...parseWorkItemFields(v),
  };
}

export function parseReplayEventsPage(raw: unknown): ReplayEventsPage | null {
  if (!isRecord(raw)) return null;
  if (
    typeof raw.session_id !== "string" ||
    raw.order !== REPLAY_ORDER ||
    !Array.isArray(raw.events) ||
    typeof raw.limit !== "number" ||
    !Number.isInteger(raw.limit) ||
    raw.limit <= 0 ||
    typeof raw.has_more !== "boolean"
  ) {
    return null;
  }
  const events = raw.events.map(parseReplayEvent);
  if (events.some((e) => e === null)) return null;
  const parsedEvents = events as ReplayEventDTO[];
  for (let i = 1; i < parsedEvents.length; i += 1) {
    const prev = parsedEvents[i - 1]!;
    const current = parsedEvents[i]!;
    const prevMs = Date.parse(prev.timestamp);
    const currentMs = Date.parse(current.timestamp);
    if (prevMs > currentMs) return null;
    if (prevMs === currentMs && prev.event_id > current.event_id) return null;
  }
  return {
    session_id: raw.session_id,
    order: REPLAY_ORDER,
    events: parsedEvents,
    limit: raw.limit,
    has_more: raw.has_more,
    next_cursor: optString(raw.next_cursor),
  };
}
