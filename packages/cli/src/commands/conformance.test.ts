import { describe, it, expect } from "vitest";
import { cmdConformance, renderHuman } from "./conformance.js";
import { run, parseConformanceOpts } from "../cli.js";
import { makeFakeDeps } from "../lib/fake.js";
import type { ConformanceReport } from "../lib/conformance-types.js";

// Minimal valid events (uuidv7 ids · payload.kind === event_type · non-decreasing ts). Built as a
// helper so each test targets one branch precisely. These flow through the SAME canonical
// `checkConformance` (event-model source) the production bundle inlines — see lib/fake.ts.
function ev(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    event_id: overrides["event_id"] ?? "019f7170-b0cf-719c-854e-b93207078fc2",
    timestamp: overrides["timestamp"] ?? "2026-07-18T00:00:00.000Z",
    provider: "myagent",
    source: "external",
    session_id: overrides["session_id"] ?? "s1",
    event_type: overrides["event_type"] ?? "session.started",
    payload: overrides["payload"] ?? { kind: overrides["event_type"] ?? "session.started" },
    ...(overrides["seq"] !== undefined ? { seq: overrides["seq"] } : {}),
  });
}

const IDS = [
  "019f7170-b0cf-719c-854e-b93207078fc2",
  "019f7170-b0cf-719c-854e-beadcc0aff6c",
  "019f7170-b0cf-719c-854e-c26e2768f07d",
];

// A fully conformant 3-event stream (seq 0,1,2 · monotonic ts).
const VALID = [
  ev({
    event_id: IDS[0],
    event_type: "session.started",
    seq: 0,
    timestamp: "2026-07-18T00:00:00.000Z",
  }),
  ev({
    event_id: IDS[1],
    event_type: "turn.started",
    seq: 1,
    timestamp: "2026-07-18T00:00:01.000Z",
  }),
  ev({
    event_id: IDS[2],
    event_type: "turn.completed",
    seq: 2,
    timestamp: "2026-07-18T00:00:02.000Z",
  }),
].join("\n");

describe("parseConformanceOpts", () => {
  it("parses file + --json in any order", () => {
    expect(parseConformanceOpts([])).toEqual({ json: false });
    expect(parseConformanceOpts(["--json"])).toEqual({ json: true });
    expect(parseConformanceOpts(["events.jsonl"])).toEqual({ file: "events.jsonl", json: false });
    expect(parseConformanceOpts(["--json", "events.jsonl"])).toEqual({
      file: "events.jsonl",
      json: true,
    });
  });
});

describe("cmdConformance — human report", () => {
  it("PASS / exit 0 on a conformant stream (stdin)", async () => {
    const f = makeFakeDeps({ stdin: VALID });
    expect(await cmdConformance(f.deps, { json: false })).toBe(0);
    const out = f.out.join("\n");
    expect(out).toMatch(/^conformance: 3 events · 3 schema-valid · 1 session\(s\)/);
    expect(out).toMatch(/PASS — the stream conforms to the ingestion contract$/);
    expect(out).not.toMatch(/warning/);
  });

  it("PASS with a warning suffix when a session emits no seq", async () => {
    const f = makeFakeDeps({ stdin: ev({ event_type: "session.started" }) }); // no seq
    expect(await cmdConformance(f.deps, { json: false })).toBe(0);
    const out = f.out.join("\n");
    expect(out).toMatch(/WARN event 0 \[session s1\] \(seq-absent\)/);
    expect(out).toMatch(/PASS — the stream conforms to the ingestion contract \(1 warning\(s\)\)$/);
  });

  it("reads from a file when a file arg is given", async () => {
    const f = makeFakeDeps({ files: { "adapter.jsonl": VALID } });
    expect(await cmdConformance(f.deps, { file: "adapter.jsonl", json: false })).toBe(0);
    expect(f.out.join("\n")).toMatch(/PASS —/);
  });

  it("FAIL / exit 1 and reports every error class (plus an event_id-repeat warning)", async () => {
    // payload-kind-mismatch (ev0) · timestamp-regression (ev2 has an earlier ts) · schema (ev3 bad
    // id) · seq-not-contiguous (0,2,3) are ERRORS. ev2 also reuses id1 — a WARNING now, since an
    // at-least-once retry is contract-legitimate (§3.3), so it does not add to the error count.
    const broken = [
      ev({
        event_id: IDS[0],
        event_type: "turn.started",
        seq: 0,
        payload: { kind: "error", message: "x", retryable: false },
        timestamp: "2026-07-18T00:00:00.000Z",
      }),
      ev({
        event_id: IDS[1],
        event_type: "turn.completed",
        seq: 2,
        timestamp: "2026-07-18T00:00:01.000Z",
      }),
      ev({
        event_id: IDS[1],
        event_type: "heartbeat",
        seq: 3,
        payload: { kind: "heartbeat", process_alive: true },
        timestamp: "2026-07-18T00:00:00.500Z",
      }),
      JSON.stringify({
        event_id: "not-a-uuid",
        timestamp: "2026-07-18T00:00:02.000Z",
        provider: "myagent",
        source: "external",
        session_id: "s1",
        event_type: "turn.started",
        seq: 4,
        payload: {},
      }),
    ].join("\n");
    const f = makeFakeDeps({ stdin: broken });
    expect(await cmdConformance(f.deps, { json: false })).toBe(1);
    const out = f.out.join("\n");
    expect(out).toMatch(/\(payload-kind-mismatch\)/);
    expect(out).toMatch(/WARN .*\(event-id-duplicate\)/); // a repeat is a warning, not an error
    expect(out).toMatch(/\(timestamp-regression\)/);
    expect(out).toMatch(/\(schema\): event failed schema validation/);
    expect(out).toMatch(/\(seq-not-contiguous\)/);
    expect(out).toMatch(/^FAIL — \d+ error\(s\), 1 warning\(s\)$/m);
  });

  it("labels a non-JSON line as 'not valid JSON' (not a generic schema failure)", async () => {
    const f = makeFakeDeps({ stdin: `${ev({ seq: 0 })}\n{ this is not json` });
    expect(await cmdConformance(f.deps, { json: false })).toBe(1);
    const out = f.out.join("\n");
    expect(out).toMatch(/ERROR event 1 \(schema\): not valid JSON:/);
  });

  it("ignores blank lines (they do not become events)", async () => {
    const f = makeFakeDeps({ stdin: `\n${ev({ seq: 0 })}\n\n` });
    expect(await cmdConformance(f.deps, { json: false })).toBe(0);
    expect(f.out.join("\n")).toMatch(/^conformance: 1 events ·/);
  });
});

describe("cmdConformance — --json report", () => {
  it("emits the machine report and exits by ok", async () => {
    const f = makeFakeDeps({ stdin: VALID });
    expect(await cmdConformance(f.deps, { json: true })).toBe(0);
    const report = JSON.parse(f.out.join("\n")) as ConformanceReport;
    expect(report.ok).toBe(true);
    expect(report.total).toBe(3);
    expect(report.schemaValid).toBe(3);
    expect(report.findings).toEqual([]);
  });

  it("exits 1 with findings for a broken stream", async () => {
    const f = makeFakeDeps({
      stdin: ev({ event_type: "turn.started", payload: { kind: "session.started" }, seq: 0 }),
    });
    expect(await cmdConformance(f.deps, { json: true })).toBe(1);
    const report = JSON.parse(f.out.join("\n")) as ConformanceReport;
    expect(report.ok).toBe(false);
    expect(report.findings[0]?.rule).toBe("payload-kind-mismatch");
  });
});

describe("cmdConformance — input errors", () => {
  it("exit 2 with the OS error code when reading a file fails", async () => {
    const enoent = Object.assign(new Error("nope"), { code: "ENOENT" });
    const f = makeFakeDeps({ files: { "missing.jsonl": enoent } });
    expect(await cmdConformance(f.deps, { file: "missing.jsonl", json: false })).toBe(2);
    expect(f.err.join("\n")).toMatch(/conformance: could not read input \(ENOENT\)/);
    expect(f.out).toEqual([]);
  });

  it("exit 2 falling back to the message when the error has no code", async () => {
    const f = makeFakeDeps({ stdin: new Error("stdin exploded") });
    expect(await cmdConformance(f.deps, { json: false })).toBe(2);
    expect(f.err.join("\n")).toMatch(/conformance: could not read input \(stdin exploded\)/);
  });

  it("exit 2 stringifying a non-Error rejection (no code, not an Error)", async () => {
    const f = makeFakeDeps();
    // Override just readInput to reject with a plain string (neither a `code` nor an Error).
    const deps = {
      ...f.deps,
      readInput: async () => {
        throw "raw-string-failure";
      },
    };
    expect(await cmdConformance(deps, { json: false })).toBe(2);
    expect(f.err.join("\n")).toMatch(/conformance: could not read input \(raw-string-failure\)/);
  });
});

describe("run — routes conformance", () => {
  it("dispatches the conformance subcommand over stdin", async () => {
    const f = makeFakeDeps({ stdin: VALID });
    expect(await run(f.deps, ["conformance"])).toBe(0);
    expect(f.out.join("\n")).toMatch(/PASS —/);
  });

  it("passes --json and the file arg through the router", async () => {
    const f = makeFakeDeps({ files: { "a.jsonl": VALID } });
    expect(await run(f.deps, ["conformance", "--json", "a.jsonl"])).toBe(0);
    expect(JSON.parse(f.out.join("\n")).ok).toBe(true);
  });
});

describe("renderHuman — direct (session-level + no-session branches)", () => {
  it("renders a stream-level finding (index -1) and a finding without a sessionId", () => {
    const report: ConformanceReport = {
      total: 0,
      schemaValid: 0,
      sessions: 0,
      errors: 1,
      warnings: 0,
      ok: false,
      findings: [{ index: -1, severity: "error", rule: "schema", message: "boom" }],
    };
    const lines = renderHuman(report, new Map());
    expect(lines[1]).toBe("  ERROR stream (schema): boom");
    expect(lines[2]).toBe("FAIL — 1 error(s), 0 warning(s)");
  });
});
