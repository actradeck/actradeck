/**
 * conformance — a stream-level validator for third-party ingestion adapters.
 *
 * An external adapter author emits a stream of NormalizedEvents (the ingestion contract,
 * docs/ingestion-contract.md). Per-event schema validity is covered by `safeParseEvent`,
 * but the contract also has STREAM-level and CROSS-FIELD invariants a single-event parse
 * cannot see:
 *   - `payload.kind` must equal `event_type` (the schema does NOT cross-validate this),
 *   - `event_id` duplicates within the stream are a WARNING, not an error: the contract uses
 *     `event_id` as the idempotency key and the backend absorbs at-least-once retries
 *     (contract §3.3), so a re-sent event is legitimate — the warning only flags it so the
 *     author can confirm they are true retries, not distinct events colliding on one id,
 *   - per session, `timestamp` must be non-decreasing in emission order,
 *   - per session, `seq` (when used) must be a dense 0-based counter — this is what lets the
 *     backend detect silent mid-stream drops (contract §4.4 / `evaluateSeqMissing`); at-least-once
 *     retries of the same seq collapse (symmetric with event_id, §3.3) and are not a gap.
 *
 * `checkConformance` runs these over an ordered event stream and returns a structured
 * report. It is a PURE function (no I/O); `scripts/check-conformance.mjs` is the CLI that
 * reads JSONL and reports pass/fail. Redaction is intentionally NOT checked here: the
 * backend ingress redaction floor (contract §5) is the sole redaction point, so an
 * adapter neither can nor need "prove redaction" — a conformance harness covers schema,
 * ordering, identity, and drop-detection wiring only.
 *
 * Severity split: `error` findings are contract breaks (the harness fails); `warning`
 * findings — a session that emits no `seq` (forgoes drop detection), or a duplicate `event_id`
 * (legitimate under at-least-once retry, §3.3) — are contract-consistent and do NOT fail the
 * harness.
 */
import { safeParseEvent } from "./event.js";
import { toEpochMs } from "./timestamp.js";

export type ConformanceSeverity = "error" | "warning";

export type ConformanceRule =
  | "schema" // safeParseEvent rejected the event
  | "payload-kind-mismatch" // payload.kind !== event_type
  | "event-id-duplicate" // (warning) event_id repeated — legitimate under at-least-once retry (§3.3)
  | "timestamp-regression" // per-session timestamp went backwards in emission order
  | "seq-not-contiguous" // per-session seq is not a dense 0-based counter (gap / non-zero start / partial); at-least-once retries collapse
  | "seq-absent"; // (warning) a session emitted no seq — no drop detection

export interface ConformanceFinding {
  /** 0-based position in the input stream; -1 for a session-level (post-scan) finding. */
  readonly index: number;
  readonly severity: ConformanceSeverity;
  readonly rule: ConformanceRule;
  readonly message: string;
  readonly sessionId?: string;
  readonly eventId?: string;
}

export interface ConformanceReport {
  readonly total: number;
  readonly schemaValid: number;
  readonly sessions: number;
  readonly findings: readonly ConformanceFinding[];
  readonly errors: number;
  readonly warnings: number;
  /** true iff there are no `error`-severity findings. */
  readonly ok: boolean;
}

interface SessionState {
  lastTsMs: number | undefined;
  /** seq value in appearance order (only for events that carried a numeric seq). */
  readonly seqs: number[];
  /** count of events (with or without seq) — to detect a partial/mixed seq session. */
  eventCount: number;
  readonly firstIndex: number;
}

/**
 * Validate an ordered stream of purported NormalizedEvents against the ingestion contract.
 * `events` MUST be in emission order (the order the adapter produced them); JSONL lines in
 * file order satisfy this.
 */
export function checkConformance(events: readonly unknown[]): ConformanceReport {
  const findings: ConformanceFinding[] = [];
  const seenIds = new Set<string>();
  const sessions = new Map<string, SessionState>();
  let schemaValid = 0;

  events.forEach((raw, index) => {
    const parsed = safeParseEvent(raw);
    if (!parsed.success) {
      findings.push({
        index,
        severity: "error",
        rule: "schema",
        message: `event failed schema validation: ${firstIssue(parsed.error)}`,
      });
      return; // fields untrustworthy — skip the field/stream checks for this event
    }
    schemaValid += 1;
    const ev = parsed.data;
    const sessionId = ev.session_id;
    const eventId = ev.event_id;

    // cross-field: payload.kind === event_type (schema does not enforce this).
    const payload = ev.payload as Record<string, unknown> | undefined;
    if (payload && typeof payload === "object" && typeof payload.kind === "string") {
      if (payload.kind !== ev.event_type) {
        findings.push({
          index,
          severity: "error",
          rule: "payload-kind-mismatch",
          sessionId,
          eventId,
          message: `payload.kind "${payload.kind}" !== event_type "${ev.event_type}"`,
        });
      }
    }

    // stream: event_id duplicates. The contract uses event_id as the idempotency key and the
    // backend absorbs at-least-once retries (§3.3), so a repeat is legitimate — surface it as a
    // WARNING (not a contract break) so the author can confirm it is a true retry of the SAME
    // event, not two distinct events colliding on one id.
    if (seenIds.has(eventId)) {
      findings.push({
        index,
        severity: "warning",
        rule: "event-id-duplicate",
        sessionId,
        eventId,
        message: `event_id "${eventId}" repeats earlier in the stream — fine as an at-least-once retry (the backend dedupes, §3.3); confirm it is the SAME event, not a distinct one reusing the id`,
      });
    } else {
      seenIds.add(eventId);
    }

    // per-session bookkeeping (timestamp monotonicity + seq collection).
    let st = sessions.get(sessionId);
    if (!st) {
      st = { lastTsMs: undefined, seqs: [], eventCount: 0, firstIndex: index };
      sessions.set(sessionId, st);
    }
    st.eventCount += 1;
    const tsMs = toEpochMs(ev.timestamp);
    if (st.lastTsMs !== undefined && tsMs < st.lastTsMs) {
      findings.push({
        index,
        severity: "error",
        rule: "timestamp-regression",
        sessionId,
        eventId,
        message: `timestamp ${ev.timestamp} is earlier than a preceding event in session "${sessionId}"`,
      });
    }
    if (st.lastTsMs === undefined || tsMs > st.lastTsMs) st.lastTsMs = tsMs;
    if (typeof ev.seq === "number") st.seqs.push(ev.seq);
  });

  // post-scan: per-session seq analysis (0-based contiguous, or a no-seq warning).
  for (const [sessionId, st] of sessions) {
    if (st.seqs.length === 0) {
      findings.push({
        index: st.firstIndex,
        severity: "warning",
        rule: "seq-absent",
        sessionId,
        message: `session "${sessionId}" emits no seq — the backend cannot detect silent mid-stream drops (contract §4.4)`,
      });
      continue;
    }
    // A session that carried seq on SOME but not all events is a partial/mixed counter.
    if (st.seqs.length !== st.eventCount) {
      findings.push({
        index: st.firstIndex,
        severity: "error",
        rule: "seq-not-contiguous",
        sessionId,
        message: `session "${sessionId}" has seq on ${st.seqs.length} of ${st.eventCount} events — seq must be on every event or none`,
      });
      continue;
    }
    // At-least-once retries re-send the SAME event = the same seq (symmetric with event_id, §3.3 /
    // §4.4): `distinct(seq)` absorbs them, so collapse duplicates — preserving first-appearance
    // order, which is the original emission order — before the dense-0-based check. A gap or a
    // non-zero start is still an error; a re-sent seq is not (matching the backend's
    // `evaluateSeqMissing`, which counts `distinct(seq)`).
    const seen = new Set<number>();
    const distinctInOrder: number[] = [];
    for (const s of st.seqs) {
      if (!seen.has(s)) {
        seen.add(s);
        distinctInOrder.push(s);
      }
    }
    const contiguous = distinctInOrder.every((s, i) => s === i);
    if (!contiguous) {
      findings.push({
        index: st.firstIndex,
        severity: "error",
        rule: "seq-not-contiguous",
        sessionId,
        message: `session "${sessionId}" seq is not a dense 0-based counter (expected 0..${distinctInOrder.length - 1} after collapsing at-least-once retries; got distinct ${distinctInOrder.join(",")})`,
      });
    }
  }

  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.length - errors;
  return {
    total: events.length,
    schemaValid,
    sessions: sessions.size,
    findings,
    errors,
    warnings,
    ok: errors === 0,
  };
}

/** First zod issue as a compact "path: message" string (never echoes the whole event). */
function firstIssue(error: {
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>;
}): string {
  const issue = error.issues[0];
  if (!issue) return "unknown validation error";
  const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
  return `${path}: ${issue.message}`;
}
