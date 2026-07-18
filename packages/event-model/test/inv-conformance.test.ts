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

/** Minimal valid NormalizedEvent; override any field per test. Distinct event_id by default. */
function ev(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: newEventId(),
    timestamp: "2026-07-18T00:00:00.000Z",
    provider: "myagent",
    source: "external",
    session_id: "s1",
    event_type: "turn.started",
    seq: 0,
    payload: {},
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

  it("WARNS (not errors) on a duplicate event_id — legitimate under at-least-once retry (§3.3)", () => {
    // The contract uses event_id as the idempotency key; the backend absorbs at-least-once
    // retries (contract §3.3 / INV-EVENT-ORDER). So a re-sent event_id is contract-consistent:
    // it must NOT fail the harness, only surface a warning so the author can confirm it is a
    // true retry rather than two distinct events colliding on one id.
    const id = newEventId();
    const stream = [
      ev({ session_id: "s1", seq: 0, event_id: id, timestamp: "2026-07-18T00:00:00.000Z" }),
      ev({ session_id: "s1", seq: 1, event_id: id, timestamp: "2026-07-18T00:00:01.000Z" }),
    ];
    const r = checkConformance(stream);
    expect(r.ok).toBe(true); // a warning does not fail the harness
    expect(r.errors).toBe(0);
    const dup = r.findings.find((f) => f.rule === "event-id-duplicate");
    expect(dup).toBeDefined();
    expect(dup!.severity).toBe("warning");
    expect(dup!.index).toBe(1);
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

  it("empty stream is trivially ok", () => {
    const r = checkConformance([]);
    expect(r.ok).toBe(true);
    expect(r.total).toBe(0);
    expect(r.sessions).toBe(0);
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

    it("invalid.jsonl fails and demonstrates every documented error class", () => {
      const r = checkConformance(loadJsonl("invalid.jsonl"));
      expect(r.ok).toBe(false);
      const errorRules = new Set(
        r.findings.filter((f) => f.severity === "error").map((f) => f.rule),
      );
      for (const rule of [
        "payload-kind-mismatch",
        "timestamp-regression",
        "schema",
        "seq-not-contiguous",
      ] as const) {
        expect(errorRules.has(rule), `invalid.jsonl should demonstrate ${rule}`).toBe(true);
      }
      // event-id-duplicate is a WARNING (at-least-once retry is contract-legitimate, §3.3), not an
      // error — the fixture still carries it, but as a warning that does not fail the harness.
      const warnRules = new Set(
        r.findings.filter((f) => f.severity === "warning").map((f) => f.rule),
      );
      expect(warnRules.has("event-id-duplicate")).toBe(true);
    });
  });
});
