#!/usr/bin/env node
// =============================================================================
// check-conformance.mjs — validate an adapter's event stream against the contract
// =============================================================================
// For third-party adapter authors: pipe your adapter's emitted NormalizedEvents
// (one JSON object per line — JSONL) into this checker and it reports whether the
// stream conforms to the ActraDeck ingestion contract (docs/ingestion-contract.md):
// schema validity, payload.kind === event_type, per-session non-decreasing timestamps,
// and per-session dense 0-based seq (drop detection). A repeated event_id or seq is a
// WARNING, not an error — an at-least-once retry is legitimate (the backend dedupes, §3.3/§4.4).
//
// Redaction is NOT checked here — the backend ingress redaction floor (contract §5)
// is the sole redaction point, so an adapter neither can nor needs to prove it.
//
// Usage:
//   node scripts/check-conformance.mjs < events.jsonl
//   node scripts/check-conformance.mjs events.jsonl
//   node scripts/check-conformance.mjs --json events.jsonl     # machine-readable report
//
// Exit code: 0 = conformant (warnings allowed), 1 = one or more errors, 2 = usage/setup error.
// Requires the event-model package to be built:  pnpm --filter @actradeck/event-model build
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const jsonOut = args.includes("--json");
const file = args.find((a) => !a.startsWith("--"));

let checkConformance;
try {
  ({ checkConformance } = await import(
    new URL("../packages/event-model/dist/index.js", import.meta.url)
  ));
} catch {
  process.stderr.write(
    "check-conformance: @actradeck/event-model is not built.\n" +
      "  Run:  pnpm --filter @actradeck/event-model build\n",
  );
  process.exit(2);
}

let raw;
try {
  raw = file ? readFileSync(file, "utf8") : readFileSync(0, "utf8"); // fd 0 = stdin
} catch (err) {
  process.stderr.write(`check-conformance: could not read input (${err.code ?? err.message})\n`);
  process.exit(2);
}

// Parse JSONL. A line that is not valid JSON becomes a placeholder ({}) so it still
// occupies an index and surfaces as a schema error; its parse error is remembered so we
// can print a clearer message than the generic schema failure.
const lines = raw.split("\n").map((l) => l.trim());
const events = [];
const malformed = new Map(); // event index -> JSON parse message
for (const line of lines) {
  if (line.length === 0) continue;
  const index = events.length;
  try {
    events.push(JSON.parse(line));
  } catch (err) {
    malformed.set(index, err.message);
    events.push({}); // guaranteed schema failure at this index
  }
}

const report = checkConformance(events);

if (jsonOut) {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  process.exit(report.ok ? 0 : 1);
}

// Human-readable report.
const RESET = "[0m";
const color = (code, s) => (process.stdout.isTTY ? `[${code}m${s}${RESET}` : s);
const red = (s) => color("31", s);
const green = (s) => color("32", s);
const yellow = (s) => color("33", s);

process.stdout.write(
  `conformance: ${report.total} events · ${report.schemaValid} schema-valid · ${report.sessions} session(s)\n`,
);

for (const f of report.findings) {
  const where = f.index >= 0 ? `event ${f.index}` : "stream";
  const sess = f.sessionId ? ` [session ${f.sessionId}]` : "";
  const message =
    f.rule === "schema" && malformed.has(f.index)
      ? `not valid JSON: ${malformed.get(f.index)}`
      : f.message;
  const tag = f.severity === "error" ? red("ERROR") : yellow("WARN");
  process.stdout.write(`  ${tag} ${where}${sess} (${f.rule}): ${message}\n`);
}

if (report.ok) {
  const suffix = report.warnings > 0 ? ` (${report.warnings} warning(s))` : "";
  process.stdout.write(green(`PASS — the stream conforms to the ingestion contract${suffix}\n`));
  process.exit(0);
} else {
  process.stdout.write(red(`FAIL — ${report.errors} error(s), ${report.warnings} warning(s)\n`));
  process.exit(1);
}
