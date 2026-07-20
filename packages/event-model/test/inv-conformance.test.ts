/**
 * INV-CONFORMANCE — the third-party adapter conformance checker is FALSIFIABLE and
 * correct. `checkConformance` is the reusable core behind `scripts/check-conformance.mjs`
 * (the CLI external adapter authors run against their event stream). This test pins:
 *   - a well-formed multi-session stream passes (ok, no errors),
 *   - each contract-break class produces its specific `error` finding (falsifiable), and
 *   - a schema-valid stream that omits seq passes but emits a `seq-absent` warning.
 * Redaction is intentionally out of scope (the backend ingress floor is the sole
 * redaction point — an adapter cannot prove it; contract §5).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { checkConformance, newEventId } from "../src/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = "../../../docs/examples/conformance";
const loadJsonl = (name: string): unknown[] =>
  readFileSync(resolve(HERE, FIXTURE_DIR, name), "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as unknown);

/**
 * Minimal valid NormalizedEvent; override any field per test. Distinct event_id by default.
 * `payload` defaults to a self-describing `{ kind: <event_type> }` so a "minimal valid event"
 * is actually conformant (matches valid.jsonl: every event carries payload.kind === event_type).
 * A test that wants to exercise a missing/mismatched kind overrides `payload` explicitly.
 */
function ev(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const eventType =
    typeof overrides.event_type === "string" ? overrides.event_type : "turn.started";
  return {
    event_id: newEventId(),
    timestamp: "2026-07-18T00:00:00.000Z",
    provider: "myagent",
    source: "external",
    session_id: "s1",
    event_type: "turn.started",
    seq: 0,
    payload: { kind: eventType },
    ...overrides,
  };
}

/** Build a per-session 0-based seq + non-decreasing timestamps stream. */
function session(sessionId: string, n: number): Record<string, unknown>[] {
  return Array.from({ length: n }, (_, i) =>
    ev({
      session_id: sessionId,
      seq: i,
      timestamp: `2026-07-18T00:00:${String(i).padStart(2, "0")}.000Z`,
    }),
  );
}

describe("INV-CONFORMANCE: adapter stream conformance checker", () => {
  it("a well-formed multi-session stream passes with zero errors", () => {
    const stream = [...session("s1", 3), ...session("s2", 2)];
    const r = checkConformance(stream);
    expect(r.ok).toBe(true);
    expect(r.errors).toBe(0);
    expect(r.warnings).toBe(0);
    expect(r.total).toBe(5);
    expect(r.schemaValid).toBe(5);
    expect(r.sessions).toBe(2);
  });

  it("accepts a matching payload.kind and rejects a mismatched one (schema misses this)", () => {
    const good = checkConformance([
      ev({ seq: 0, event_type: "heartbeat", payload: { kind: "heartbeat", process_alive: true } }),
    ]);
    expect(good.ok).toBe(true);

    const bad = checkConformance([
      ev({
        seq: 0,
        event_type: "turn.started",
        payload: { kind: "error", message: "x", retryable: false },
      }),
    ]);
    expect(bad.ok).toBe(false);
    expect(bad.findings.map((f) => f.rule)).toContain("payload-kind-mismatch");
  });

  it("WARNS (not errors) on a duplicate event_id with IDENTICAL content — at-least-once retry (§3.3)", () => {
    // The contract uses event_id as the idempotency key; the backend absorbs at-least-once
    // retries (contract §3.3 / INV-EVENT-ORDER). A re-sent event with the SAME content is
    // contract-consistent: it must NOT fail the harness, only surface a warning. (A repeat with
    // DIFFERENT content is a collision → error; see the collision test below.)
    const id = newEventId();
    const same = { session_id: "s1", seq: 0, event_id: id, timestamp: "2026-07-18T00:00:00.000Z" };
    const stream = [ev(same), ev(same)];
    const r = checkConformance(stream);
    expect(r.ok).toBe(true); // a warning does not fail the harness
    expect(r.errors).toBe(0);
    const dup = r.findings.find((f) => f.rule === "event-id-duplicate");
    expect(dup).toBeDefined();
    expect(dup!.severity).toBe("warning");
    expect(dup!.index).toBe(1);
  });

  it("ERRORS on a duplicate event_id with DIFFERENT content — two distinct events on one id", () => {
    // A repeat of an event_id whose content differs is NOT a retry: the backend would dedupe the
    // later one away (§3.3), silently dropping a distinct event. That is a contract break.
    const id = newEventId();
    const stream = [
      ev({ session_id: "s1", seq: 0, event_id: id, timestamp: "2026-07-18T00:00:00.000Z" }),
      ev({
        session_id: "s1",
        seq: 1,
        event_id: id,
        event_type: "turn.completed",
        timestamp: "2026-07-18T00:00:01.000Z",
      }),
    ];
    const r = checkConformance(stream);
    expect(r.ok).toBe(false);
    const collision = r.findings.find((f) => f.rule === "event-id-collision");
    expect(collision).toBeDefined();
    expect(collision!.severity).toBe("error");
    expect(collision!.index).toBe(1);
    // must NOT be downgraded to the retry warning
    expect(r.findings.map((f) => f.rule)).not.toContain("event-id-duplicate");
  });

  it("flags a per-session timestamp regression (emission-order non-decreasing)", () => {
    const stream = [
      ev({ session_id: "s1", seq: 0, timestamp: "2026-07-18T00:00:05.000Z" }),
      ev({ session_id: "s1", seq: 1, timestamp: "2026-07-18T00:00:02.000Z" }), // goes backwards
    ];
    const r = checkConformance(stream);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.rule)).toContain("timestamp-regression");
  });

  it("does NOT flag interleaved sessions with independent timestamp floors", () => {
    // s1 at t=10 then s2 at t=1: per-session floors are independent, so this is fine.
    const stream = [
      ev({ session_id: "s1", seq: 0, timestamp: "2026-07-18T00:00:10.000Z" }),
      ev({ session_id: "s2", seq: 0, timestamp: "2026-07-18T00:00:01.000Z" }),
      ev({ session_id: "s1", seq: 1, timestamp: "2026-07-18T00:00:11.000Z" }),
    ];
    const r = checkConformance(stream);
    expect(r.ok).toBe(true);
    expect(r.sessions).toBe(2);
  });

  it("flags a seq gap (0-based contiguity)", () => {
    const stream = [
      ev({ session_id: "s1", seq: 0, timestamp: "2026-07-18T00:00:00.000Z" }),
      ev({ session_id: "s1", seq: 2, timestamp: "2026-07-18T00:00:01.000Z" }), // gap: missing 1
    ];
    const r = checkConformance(stream);
    expect(r.ok).toBe(false);
    const gap = r.findings.find((f) => f.rule === "seq-not-contiguous");
    expect(gap).toBeDefined();
    expect(gap!.sessionId).toBe("s1");
  });

  it("PASSES a full at-least-once retry — same event_id AND seq collapse, no seq gap (§4.4)", () => {
    // A true retry re-sends the SAME event: same event_id, same seq, same timestamp. The seq check
    // must absorb the duplicate `seq` (distinct(seq), symmetric with event_id idempotency) — it is
    // NOT a gap. Only the event_id repeat surfaces, as a warning. Guards against the asymmetric fix
    // where event_id was downgraded but the retry's seq still errored (QA-1).
    const idC = newEventId();
    const stream = [
      ev({ session_id: "s1", seq: 0, timestamp: "2026-07-18T00:00:00.000Z" }),
      ev({ session_id: "s1", seq: 1, timestamp: "2026-07-18T00:00:01.000Z" }),
      ev({ session_id: "s1", seq: 2, event_id: idC, timestamp: "2026-07-18T00:00:02.000Z" }),
      ev({ session_id: "s1", seq: 2, event_id: idC, timestamp: "2026-07-18T00:00:02.000Z" }), // retry
    ];
    const r = checkConformance(stream);
    expect(r.ok, JSON.stringify(r.findings)).toBe(true); // a legitimate retry must not FAIL
    expect(r.errors).toBe(0);
    expect(r.findings.map((f) => f.rule)).not.toContain("seq-not-contiguous");
    const warn = r.findings.filter((f) => f.severity === "warning").map((f) => f.rule);
    expect(warn).toContain("event-id-duplicate");
  });

  it("flags a non-zero-based seq (must start at 0)", () => {
    const stream = [
      ev({ session_id: "s1", seq: 1, timestamp: "2026-07-18T00:00:00.000Z" }),
      ev({ session_id: "s1", seq: 2, timestamp: "2026-07-18T00:00:01.000Z" }),
    ];
    const r = checkConformance(stream);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.rule)).toContain("seq-not-contiguous");
  });

  it("flags a partial-seq session (seq on some events but not all)", () => {
    const withSeq = ev({ session_id: "s1", seq: 0, timestamp: "2026-07-18T00:00:00.000Z" });
    const noSeq = ev({ session_id: "s1", timestamp: "2026-07-18T00:00:01.000Z" });
    delete (noSeq as { seq?: unknown }).seq;
    const r = checkConformance([withSeq, noSeq]);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.rule)).toContain("seq-not-contiguous");
  });

  it("warns (not errors) when a session emits no seq at all — schema-valid but no drop detection", () => {
    const a = ev({ session_id: "s1", timestamp: "2026-07-18T00:00:00.000Z" });
    const b = ev({ session_id: "s1", timestamp: "2026-07-18T00:00:01.000Z" });
    delete (a as { seq?: unknown }).seq;
    delete (b as { seq?: unknown }).seq;
    const r = checkConformance([a, b]);
    expect(r.ok).toBe(true); // warnings do not fail the harness
    expect(r.errors).toBe(0);
    expect(r.warnings).toBe(1);
    expect(r.findings[0]!.rule).toBe("seq-absent");
  });

  it("flags a schema-invalid event and keeps scanning the rest", () => {
    const stream = [
      ev({
        session_id: "s1",
        seq: 0,
        event_id: "not-a-uuid",
        timestamp: "2026-07-18T00:00:00.000Z",
      }),
      ev({ session_id: "s1", seq: 1, timestamp: "2026-07-18T00:00:01.000Z" }),
    ];
    const r = checkConformance(stream);
    expect(r.ok).toBe(false);
    expect(r.schemaValid).toBe(1); // the second event still parsed
    const schema = r.findings.find((f) => f.rule === "schema");
    expect(schema).toBeDefined();
    expect(schema!.index).toBe(0);
  });

  it("an empty stream is an ERROR (a vacuous pass is not a conformance proof)", () => {
    const r = checkConformance([]);
    expect(r.ok).toBe(false);
    expect(r.total).toBe(0);
    expect(r.sessions).toBe(0);
    expect(r.findings.map((f) => f.rule)).toEqual(["empty-stream"]);
    expect(r.findings[0]!.index).toBe(-1);
  });

  it("ERRORS on an absent payload.kind (the cross-check is silently skipped otherwise)", () => {
    const r = checkConformance([ev({ seq: 0, payload: {} })]);
    expect(r.ok).toBe(false);
    const absent = r.findings.find((f) => f.rule === "payload-kind-absent");
    expect(absent).toBeDefined();
    expect(absent!.severity).toBe("error");
    // present-but-matching kind is fine (no absent/mismatch finding)
    const ok = checkConformance([ev({ seq: 0, payload: { kind: "turn.started" } })]);
    expect(ok.ok).toBe(true);
  });

  it("ERRORS on the SAME seq carried by two different event_ids (not a retry) — seq-collision", () => {
    const stream = [
      ev({ session_id: "s1", seq: 0, timestamp: "2026-07-18T00:00:00.000Z" }),
      ev({ session_id: "s1", seq: 0, timestamp: "2026-07-18T00:00:01.000Z" }), // same seq, new id
    ];
    const r = checkConformance(stream);
    expect(r.ok).toBe(false);
    const collision = r.findings.find((f) => f.rule === "seq-collision");
    expect(collision).toBeDefined();
    expect(collision!.severity).toBe("error");
  });

  it("ERRORS on a new event after the session reached a terminal state (event-after-terminal)", () => {
    const stream = [
      ev({ session_id: "s1", seq: 0, event_type: "turn.completed", state: "completed" }),
      ev({
        session_id: "s1",
        seq: 1,
        event_type: "turn.started",
        state: "running.model_wait",
        timestamp: "2026-07-18T00:00:01.000Z",
      }),
    ];
    const r = checkConformance(stream);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.rule)).toContain("event-after-terminal");
  });

  it("ERRORS on a re-start (created/starting) after terminal — resume must use a NEW session_id", () => {
    const stream = [
      ev({ session_id: "s1", seq: 0, event_type: "session.ended", state: "completed" }),
      ev({
        session_id: "s1",
        seq: 1,
        event_type: "session.started",
        state: "starting",
        timestamp: "2026-07-18T00:00:01.000Z",
      }),
    ];
    const r = checkConformance(stream);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.rule)).toContain("restart-after-terminal");
    // it is the lineage-specific rule, not the generic post-terminal one
    expect(r.findings.map((f) => f.rule)).not.toContain("event-after-terminal");
  });

  it("suspended (ADR 0014 terminal) makes a later new event a post-terminal error too", () => {
    const stream = [
      ev({ session_id: "s1", seq: 0, event_type: "session.ended", state: "suspended" }),
      ev({
        session_id: "s1",
        seq: 1,
        event_type: "turn.started",
        state: "running.model_wait",
        timestamp: "2026-07-18T00:00:01.000Z",
      }),
    ];
    const r = checkConformance(stream);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.rule)).toContain("event-after-terminal");
  });

  it("does NOT flag a true RETRY of a prior event after terminal (same event_id, idempotent)", () => {
    const term = {
      session_id: "s1",
      seq: 0,
      event_id: newEventId(), // SAME id on both → a true at-least-once retry, not a new event
      event_type: "turn.completed",
      state: "completed",
      timestamp: "2026-07-18T00:00:00.000Z",
    };
    const stream = [ev(term), ev(term)]; // identical retry of the terminal event
    const r = checkConformance(stream);
    expect(r.ok).toBe(true); // a retry is not a post-terminal emission
    expect(r.findings.map((f) => f.rule)).not.toContain("event-after-terminal");
    expect(r.findings.map((f) => f.rule)).toContain("event-id-duplicate"); // still the retry warning
  });

  it("ERRORS on a tool.permission.resolved with no prior matching request (approval-resolved-unrequested)", () => {
    const stream = [
      ev({
        session_id: "s1",
        seq: 0,
        event_type: "tool.permission.resolved",
        state: "running.tool_preparing",
        payload: { kind: "tool.permission.resolved", request_id: "apr-never" },
      }),
    ];
    const r = checkConformance(stream);
    expect(r.ok).toBe(false);
    expect(r.findings.map((f) => f.rule)).toContain("approval-resolved-unrequested");
  });

  it("PASSES a requested-then-resolved approval pair (happy path, request keyspace = permission.*)", () => {
    const stream = [
      ev({
        session_id: "s1",
        seq: 0,
        event_type: "tool.permission.requested",
        state: "waiting.approval",
        payload: { kind: "tool.permission.requested", request_id: "apr-1" },
      }),
      ev({
        session_id: "s1",
        seq: 1,
        event_type: "tool.permission.resolved",
        state: "running.tool_preparing",
        timestamp: "2026-07-18T00:00:01.000Z",
        payload: { kind: "tool.permission.resolved", request_id: "apr-1" },
      }),
    ];
    const r = checkConformance(stream);
    expect(r.ok, JSON.stringify(r.findings)).toBe(true);
    expect(r.findings.map((f) => f.rule)).not.toContain("approval-resolved-unrequested");
  });

  it("WARNS on an approval left unresolved when the session goes terminal (manifest default)", () => {
    const stream = [
      ev({
        session_id: "s1",
        seq: 0,
        event_type: "tool.permission.requested",
        state: "waiting.approval",
        payload: { kind: "tool.permission.requested", request_id: "apr-1" },
      }),
      ev({
        session_id: "s1",
        seq: 1,
        event_type: "turn.failed",
        state: "failed",
        timestamp: "2026-07-18T00:00:01.000Z",
        payload: { kind: "turn.failed", error: "boom" },
      }),
    ];
    const r = checkConformance(stream);
    expect(r.ok).toBe(true); // a warning (severity depends on the adapter's Phase 5 manifest)
    const warn = r.findings.find((f) => f.rule === "approval-unresolved-at-terminal");
    expect(warn).toBeDefined();
    expect(warn!.severity).toBe("warning");
    // a command.* request_id must NOT count as an approval (distinct keyspaces)
  });

  it("does NOT treat a command.* request_id as an approval (distinct request_id keyspaces)", () => {
    // command.started carries request_id in the command-pairing keyspace, not the approval one.
    const stream = [
      ev({
        session_id: "s1",
        seq: 0,
        event_type: "command.started",
        state: "running.command_executing",
        payload: { kind: "command.started", request_id: "tu:1", command: "echo hi" },
      }),
      ev({ session_id: "s1", seq: 1, event_type: "turn.completed", state: "completed" }),
    ];
    const r = checkConformance(stream);
    expect(r.ok, JSON.stringify(r.findings)).toBe(true);
    expect(r.findings.map((f) => f.rule)).not.toContain("approval-unresolved-at-terminal");
    expect(r.findings.map((f) => f.rule)).not.toContain("approval-resolved-unrequested");
  });

  it("ignores a permission event with no request_id (nothing to correlate)", () => {
    // A permission.* event that omits request_id cannot be correlated — it is neither tracked as a
    // pending request nor flagged as an unrequested resolution (defensive: no crash, no finding).
    const stream = [
      ev({
        session_id: "s1",
        seq: 0,
        event_type: "tool.permission.requested",
        state: "waiting.approval",
        payload: { kind: "tool.permission.requested" }, // no request_id
      }),
      ev({
        session_id: "s1",
        seq: 1,
        event_type: "tool.permission.resolved",
        state: "running.tool_preparing",
        timestamp: "2026-07-18T00:00:01.000Z",
        payload: { kind: "tool.permission.resolved" }, // no request_id
      }),
      ev({
        session_id: "s1",
        seq: 2,
        event_type: "turn.completed",
        state: "completed",
        timestamp: "2026-07-18T00:00:02.000Z",
      }),
    ];
    const r = checkConformance(stream);
    expect(r.ok, JSON.stringify(r.findings)).toBe(true);
    expect(r.findings.map((f) => f.rule)).not.toContain("approval-resolved-unrequested");
    expect(r.findings.map((f) => f.rule)).not.toContain("approval-unresolved-at-terminal");
  });

  // The shipped teaching fixtures (docs/examples/conformance/) must stay accurate as the
  // schema evolves: valid.jsonl must PASS and invalid.jsonl must FAIL with a known rule
  // set. Anchors the CLI's runnable example against drift (same spirit as the golden test).
  describe("shipped example fixtures stay accurate", () => {
    it("valid.jsonl conforms (the runnable PASS example)", () => {
      const r = checkConformance(loadJsonl("valid.jsonl"));
      expect(r.ok, JSON.stringify(r.findings)).toBe(true);
      expect(r.errors).toBe(0);
      expect(r.warnings).toBe(0);
    });

    it("invalid.jsonl fails and demonstrates the documented error classes", () => {
      const r = checkConformance(loadJsonl("invalid.jsonl"));
      expect(r.ok).toBe(false);
      const errorRules = new Set(
        r.findings.filter((f) => f.severity === "error").map((f) => f.rule),
      );
      for (const rule of [
        "payload-kind-mismatch",
        "event-id-collision",
        "timestamp-regression",
        "seq-not-contiguous",
        "event-after-terminal",
        "approval-resolved-unrequested",
        "schema",
      ] as const) {
        expect(errorRules.has(rule), `invalid.jsonl should demonstrate ${rule}`).toBe(true);
      }
    });
  });
});
