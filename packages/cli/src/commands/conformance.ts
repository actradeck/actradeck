import type { Deps } from "../lib/types.js";
import type { ConformanceFinding, ConformanceReport } from "../lib/conformance-types.js";

export interface ConformanceOpts {
  /** JSONL input file; stdin when omitted. */
  file?: string;
  /** emit the machine-readable JSON report instead of the human summary. */
  json: boolean;
}

// `actradeck conformance [file] [--json]` — validate an adapter's JSONL event stream against the
// ingestion contract (docs/ingestion-contract.md §8). It mirrors scripts/check-conformance.mjs:
// same checks (schema · payload.kind === event_type · event_id uniqueness · per-session timestamp
// monotonicity · per-session 0-based contiguous seq), the same human report or `--json` machine
// report, and the same exit codes — 0 = conformant (warnings allowed) · 1 = one or more errors ·
// 2 = usage/setup error. The checker core is event-model's `checkConformance`, injected through
// Deps (bundled into dist at build time, never a runtime dependency).
//
// Output parity, stated precisely (the reference is scripts/check-conformance.mjs):
//   - stdout is BYTE-IDENTICAL for piped / redirected / CI output — the only context ever compared
//     or machine-consumed (the equivalence E2E pipes both). Intentional, by-design differences:
//   - COLOR: the reference adds ANSI color only when stdout is a TTY; this command always prints
//     plain (so an interactive TTY differs — cosmetic only).
//   - SETUP/exit-2: the reference exits 2 with "…is not built" when @actradeck/event-model's dist
//     is missing (it imports it at runtime); here the checker is bundled, so that path cannot occur
//     — this command's exit 2 is only for an input READ failure.
//   - STDERR prefix: diagnostics are prefixed `conformance:` here vs `check-conformance:` there.
// Input is read FULLY into memory (like the reference), which is the right shape for one-shot
// adapter sample streams, not an unbounded live feed.
export async function cmdConformance(deps: Deps, opts: ConformanceOpts): Promise<number> {
  let raw: string;
  try {
    raw = await deps.readInput(opts.file);
  } catch (err) {
    const code =
      (err as { code?: string }).code ?? (err instanceof Error ? err.message : String(err));
    deps.io.err(`conformance: could not read input (${code})`);
    return 2;
  }

  // Parse JSONL. A line that is not valid JSON becomes a placeholder ({}) so it still occupies an
  // index and surfaces as a schema error; its parse message is remembered so the human report can
  // print a clearer "not valid JSON" line than the generic schema failure.
  const events: unknown[] = [];
  const malformed = new Map<number, string>();
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const index = events.length;
    try {
      events.push(JSON.parse(trimmed));
    } catch (err) {
      malformed.set(index, err instanceof Error ? err.message : String(err));
      events.push({}); // guaranteed schema failure at this index
    }
  }

  const report = await deps.checkConformance(events);

  if (opts.json) {
    deps.io.out(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }

  for (const line of renderHuman(report, malformed)) deps.io.out(line);
  return report.ok ? 0 : 1;
}

/** Human-readable report lines (plain; identical content to check-conformance.mjs non-TTY output). */
export function renderHuman(report: ConformanceReport, malformed: Map<number, string>): string[] {
  const lines: string[] = [];
  lines.push(
    `conformance: ${report.total} events · ${report.schemaValid} schema-valid · ${report.sessions} session(s)`,
  );
  for (const f of report.findings) lines.push(findingLine(f, malformed));
  if (report.ok) {
    const suffix = report.warnings > 0 ? ` (${report.warnings} warning(s))` : "";
    lines.push(`PASS — the stream conforms to the ingestion contract${suffix}`);
  } else {
    lines.push(`FAIL — ${report.errors} error(s), ${report.warnings} warning(s)`);
  }
  return lines;
}

function findingLine(f: ConformanceFinding, malformed: Map<number, string>): string {
  const where = f.index >= 0 ? `event ${f.index}` : "stream";
  const sess = f.sessionId ? ` [session ${f.sessionId}]` : "";
  const message =
    f.rule === "schema" && malformed.has(f.index)
      ? `not valid JSON: ${malformed.get(f.index)}`
      : f.message;
  const tag = f.severity === "error" ? "ERROR" : "WARN";
  return `  ${tag} ${where}${sess} (${f.rule}): ${message}`;
}
