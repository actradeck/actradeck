/**
 * conformance — a stream-level validator for third-party ingestion adapters.
 *
 * An external adapter author emits a stream of NormalizedEvents (the ingestion contract,
 * docs/ingestion-contract.md). Per-event schema validity is covered by `safeParseEvent`,
 * but the contract also has STREAM-level, CROSS-FIELD, and LIFECYCLE invariants a single-event
 * parse cannot see:
 *   - the stream must be non-empty (an empty stream is a vacuous pass, not a conformance proof),
 *   - `payload.kind` must be present and equal `event_type` (the loose event schema does NOT
 *     enforce either; every contract example carries `kind`, and its absence silently skips the
 *     cross-check),
 *   - `event_id` is the idempotency key: a repeat with IDENTICAL content is a legitimate
 *     at-least-once retry (contract §3.3) → WARNING; a repeat with DIFFERENT content is two
 *     distinct events colliding on one id → ERROR,
 *   - per session, `timestamp` must be non-decreasing in emission order,
 *   - per session, `seq` (when used) must be a dense 0-based counter — this is what lets the
 *     backend detect silent mid-stream drops (contract §4.4 / `evaluateSeqMissing`); an
 *     at-least-once retry re-sends the SAME (seq, event_id) and collapses, but the SAME seq on a
 *     DIFFERENT event_id is a collision → ERROR,
 *   - LIFECYCLE (ADR 0014): once a session reaches a terminal state it is immutable — a later
 *     NEW event on the same `session_id` is an error (a re-start belongs to a NEW session_id
 *     linked by lineage, not the old one); and an approval must be requested before it is
 *     resolved, with unresolved approvals at terminal surfaced.
 *
 * `checkConformance` runs these over an ordered event stream and returns a structured report.
 * It is a PURE function (no I/O); `scripts/check-conformance.mjs` is the CLI that reads JSONL and
 * reports pass/fail. Redaction is intentionally NOT checked here: the backend ingress redaction
 * floor (contract §5) is the sole redaction point, so an adapter neither can nor need "prove
 * redaction" — a conformance harness covers schema, ordering, identity, drop-detection wiring, and
 * lifecycle only. **Restart-RECOVERY fidelity is NOT provable by this checker** (it never restarts a
 * process); a separate integration harness with real process restarts covers that (ADR 0014 Phase 2).
 *
 * Severity split: `error` findings are contract breaks (the harness fails); `warning` findings
 * are contract-consistent and do NOT fail the harness — a duplicate `event_id` with identical
 * content (a true retry, §3.3), a session that emits no `seq` (forgoes drop detection), or an
 * approval left unresolved at terminal (whether that is an error depends on the adapter's declared
 * approval capability — a Phase 5 manifest concern; the checker defaults to a warning).
 */
import { safeParseEvent, type NormalizedEvent } from "./event.js";
import { isTerminalStateValue } from "./state.js";
import { toEpochMs } from "./timestamp.js";

export type ConformanceSeverity = "error" | "warning";

export type ConformanceRule =
  | "schema" // safeParseEvent rejected the event
  | "empty-stream" // the stream contained no events — a vacuous pass, not a conformance proof
  | "payload-kind-mismatch" // payload.kind !== event_type
  | "payload-kind-absent" // payload carries no `kind` — the cross-check is silently skipped
  | "event-id-duplicate" // (warning) event_id repeated with IDENTICAL content — legitimate retry (§3.3)
  | "event-id-collision" // event_id repeated with DIFFERENT content — two distinct events on one id
  | "timestamp-regression" // per-session timestamp went backwards in emission order
  | "seq-not-contiguous" // per-session seq is not a dense 0-based counter (gap / non-zero start / partial)
  | "seq-collision" // the SAME seq on a DIFFERENT event_id within a session (not a retry)
  | "seq-absent" // (warning) a session emitted no seq — no drop detection
  | "event-after-terminal" // a new event on a session that already reached a terminal state
  | "restart-after-terminal" // a created/starting event after terminal — use a NEW session_id (lineage)
  | "approval-resolved-unrequested" // tool.permission.resolved with no prior matching request in-stream
  | "approval-unresolved-at-terminal"; // (warning) an approval requested but unresolved when the session went terminal

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
  /** seq -> the event_id that first claimed it (collision detection: same seq, different id). */
  readonly seqOwner: Map<number, string>;
  /** count of events (with or without seq) — to detect a partial/mixed seq session. */
  eventCount: number;
  readonly firstIndex: number;
  /** true once an event carrying a terminal state (TERMINAL_STATES, incl. suspended) was seen. */
  terminalReached: boolean;
  /** request_ids seen on tool.permission.requested (approval keyspace ONLY — never command.*). */
  readonly requestedApprovals: Set<string>;
  /** request_ids seen on tool.permission.resolved. */
  readonly resolvedApprovals: Set<string>;
  /** snapshot of still-pending approvals at the moment the session first went terminal. */
  pendingAtTerminal: string[] | undefined;
}

/**
 * Validate an ordered stream of purported NormalizedEvents against the ingestion contract.
 * `events` MUST be in emission order (the order the adapter produced them); JSONL lines in
 * file order satisfy this.
 */
export function checkConformance(events: readonly unknown[]): ConformanceReport {
  const findings: ConformanceFinding[] = [];
  /** event_id -> canonical content of its first appearance (retry vs collision). */
  const idContent = new Map<string, string>();
  const sessions = new Map<string, SessionState>();
  let schemaValid = 0;

  // A stream with no events cannot demonstrate conformance — flag it rather than pass vacuously.
  if (events.length === 0) {
    findings.push({
      index: -1,
      severity: "error",
      rule: "empty-stream",
      message: "the stream contained no events — an empty stream is not a conformance proof",
    });
  }

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

    // event_id identity: capture whether this id was already seen BEFORE recording it, so the
    // terminal/lifecycle checks below can treat a true retry (a re-sent prior event) as benign.
    const priorContent = idContent.get(eventId);
    const isRetry = priorContent !== undefined;

    // cross-field: payload.kind must be present AND equal event_type. The loose event schema
    // enforces neither; every contract example carries kind, and its absence silently skips the
    // match check — so an absent kind is itself a break (contract §8, ADR 0014 Phase 2).
    const payload = ev.payload as Record<string, unknown>;
    const kind = payload?.kind;
    if (typeof kind !== "string") {
      findings.push({
        index,
        severity: "error",
        rule: "payload-kind-absent",
        sessionId,
        eventId,
        message: `payload has no string "kind" — every event must self-describe with payload.kind === event_type "${ev.event_type}" (contract §4/§8)`,
      });
    } else if (kind !== ev.event_type) {
      findings.push({
        index,
        severity: "error",
        rule: "payload-kind-mismatch",
        sessionId,
        eventId,
        message: `payload.kind "${kind}" !== event_type "${ev.event_type}"`,
      });
    }

    // stream: event_id identity. A repeat with IDENTICAL content is a legitimate at-least-once
    // retry (§3.3) → warning; a repeat with DIFFERENT content is two distinct events colliding on
    // one id → error (the backend would dedupe the second away, silently dropping it).
    if (priorContent === undefined) {
      idContent.set(eventId, canonicalize(ev));
    } else if (priorContent === canonicalize(ev)) {
      findings.push({
        index,
        severity: "warning",
        rule: "event-id-duplicate",
        sessionId,
        eventId,
        message: `event_id "${eventId}" repeats with identical content — fine as an at-least-once retry (the backend dedupes, §3.3)`,
      });
    } else {
      findings.push({
        index,
        severity: "error",
        rule: "event-id-collision",
        sessionId,
        eventId,
        message: `event_id "${eventId}" repeats with DIFFERENT content — two distinct events must not share an id (the backend would dedupe the later one away, §3.3)`,
      });
    }

    // per-session bookkeeping.
    let st = sessions.get(sessionId);
    if (!st) {
      st = {
        lastTsMs: undefined,
        seqs: [],
        seqOwner: new Map(),
        eventCount: 0,
        firstIndex: index,
        terminalReached: false,
        requestedApprovals: new Set(),
        resolvedApprovals: new Set(),
        pendingAtTerminal: undefined,
      };
      sessions.set(sessionId, st);
    }
    st.eventCount += 1;

    // LIFECYCLE (ADR 0014): a terminal session is immutable. A NEW event after terminal is a
    // break; a re-start (created/starting) after terminal is the lineage violation the design
    // forbids (resume must mint a NEW session_id). A true retry of a prior event is benign.
    if (st.terminalReached && !isRetry) {
      const restarting = ev.state === "created" || ev.state === "starting";
      findings.push({
        index,
        severity: "error",
        rule: restarting ? "restart-after-terminal" : "event-after-terminal",
        sessionId,
        eventId,
        message: restarting
          ? `session "${sessionId}" emits state "${ev.state}" after it already reached a terminal state — a resume must use a NEW session_id linked by lineage, not re-open the terminal run (ADR 0014)`
          : `session "${sessionId}" emits a new event after it already reached a terminal state — terminal is immutable; later events on this run are dropped (ADR 0014)`,
      });
    }

    // per-session timestamp monotonicity (non-decreasing in emission order).
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

    // per-session seq: collect for the dense-0-based check, and flag a SAME-seq/DIFFERENT-id
    // collision (a true retry re-sends the same seq AND the same event_id).
    if (typeof ev.seq === "number") {
      const owner = st.seqOwner.get(ev.seq);
      if (owner !== undefined && owner !== eventId) {
        findings.push({
          index,
          severity: "error",
          rule: "seq-collision",
          sessionId,
          eventId,
          message: `seq ${ev.seq} in session "${sessionId}" is used by two different event_ids ("${owner}" and "${eventId}") — a re-sent seq must carry the same event_id (§4.4)`,
        });
      } else if (owner === undefined) {
        st.seqOwner.set(ev.seq, eventId);
      }
      st.seqs.push(ev.seq);
    }

    // approval lifecycle (request_id keyspace = permission.* ONLY; never command.*).
    if (ev.event_type === "tool.permission.requested") {
      const rid = payload?.request_id;
      if (typeof rid === "string") st.requestedApprovals.add(rid);
    } else if (ev.event_type === "tool.permission.resolved") {
      const rid = payload?.request_id;
      if (typeof rid === "string") {
        if (!st.requestedApprovals.has(rid)) {
          findings.push({
            index,
            severity: "error",
            rule: "approval-resolved-unrequested",
            sessionId,
            eventId,
            message: `tool.permission.resolved references request_id "${rid}" that was never requested earlier in this session — emit the tool.permission.requested first (a mid-session capture is not a conformance sample)`,
          });
        } else {
          st.resolvedApprovals.add(rid);
        }
      }
    }

    // record terminal AFTER the post-terminal check, and snapshot still-pending approvals at the
    // moment the run first goes terminal (a resolution that arrives later is itself a post-terminal
    // error and must not retroactively clear this snapshot).
    if (!st.terminalReached && isTerminalStateValue(ev.state)) {
      st.terminalReached = true;
      st.pendingAtTerminal = [...st.requestedApprovals].filter((r) => !st.resolvedApprovals.has(r));
    }
  });

  // post-scan: per-session seq analysis + unresolved-at-terminal approvals.
  for (const [sessionId, st] of sessions) {
    seqFindings(sessionId, st, findings);

    // An approval requested but never resolved when the session went terminal. Whether this is an
    // error depends on the adapter's declared approval capability (a Phase 5 manifest concern) —
    // default to a warning so an observe-only adapter that merely witnesses a crash-with-pending
    // is not failed.
    if (st.pendingAtTerminal && st.pendingAtTerminal.length > 0) {
      findings.push({
        index: st.firstIndex,
        severity: "warning",
        rule: "approval-unresolved-at-terminal",
        sessionId,
        message: `session "${sessionId}" reached a terminal state with ${st.pendingAtTerminal.length} unresolved approval(s) (request_id: ${st.pendingAtTerminal.join(", ")}) — confirm this matches the run's real outcome`,
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

/** Per-session seq analysis: no-seq warning, partial/mixed error, or non-dense-0-based error. */
function seqFindings(sessionId: string, st: SessionState, findings: ConformanceFinding[]): void {
  if (st.seqs.length === 0) {
    findings.push({
      index: st.firstIndex,
      severity: "warning",
      rule: "seq-absent",
      sessionId,
      message: `session "${sessionId}" emits no seq — the backend cannot detect silent mid-stream drops (contract §4.4)`,
    });
    return;
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
    return;
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

/**
 * A stable, key-sorted JSON of a parsed event — the content identity used to tell a true
 * at-least-once retry (identical content) from an event_id collision (different content). Sorting
 * keys makes it order-insensitive; the input is already schema-validated with defaults applied.
 */
function canonicalize(ev: NormalizedEvent): string {
  return JSON.stringify(ev, replacerSortKeys(ev));
}

/** Build a JSON.stringify replacer that emits object keys in sorted order (recursively). */
function replacerSortKeys(_root: unknown): (key: string, value: unknown) => unknown {
  return (_key, value) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
      return sorted;
    }
    return value;
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
