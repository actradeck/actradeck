#!/usr/bin/env node
/**
 * "Assert real-DB INV actually RAN (not skipped)" — the single source for the three CI
 * assertion steps (db / backend / sidecar egress) and for scripts/ci-preflight.sh.
 *
 * Why this exists (decision 019fcdf4): the assertions used to live as three near-identical
 * inline `node -e` one-liners in ci.yml. A local preflight mirror would have had to copy
 * them a fourth time; any wording/logic fix would then drift across four sites. Extracting
 * them keeps ci.yml and the preflight consuming one implementation.
 *
 * Contract:
 *   RC=<vitest-exit-code> node scripts/ci/assert-inv-ran.mjs <report.json> --suite <name>
 *   RC=<vitest-exit-code> node scripts/ci/assert-inv-ran.mjs <report.json> <label> <pattern>
 *   - report unreadable      -> error + exit 1 (a missing report must never pass the gate)
 *   - RC != 0                -> list the failed tests from the report + exit RC
 *   - pattern matches 0 test -> error ("did not appear — test file missing?") + exit 1
 *   - any match skipped/todo -> error ("SKIPPED in CI — DATABASE_URL not reaching the test") + exit 1
 *   - otherwise              -> log the ran-for-real count + exit 0
 *
 * --suite form (what ci.yml and ci-preflight.sh use): the semantic core of each gate —
 * WHICH invariants must have actually run — lives in the SUITES map below, so it exists
 * exactly once (TDA-2: a raw-pattern argument at every call site would be an unpinned
 * multi-copy of gate meaning; a new INV added on one side only would silently under-assert
 * on the other). <pattern> is a JS RegExp source matched against each test's
 * fullName/title; the raw 3-arg form stays for tests/ad-hoc use.
 *
 * "skipped" detection covers vitest statuses skipped/pending/todo/disabled (SEC-3: a
 * deliberate strengthening over the former inline snippets, which knew only
 * skipped/pending — an INV demoted to `.todo` must not read as "ran for real").
 */
import fs from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Per-gate assertion suites — the single source of "which INV must have run".
 *
 * Exported so the structural coverage metatest (apps/backend/test/inv-tripwire-coverage.test.ts,
 * 3c TDA-1) can assert that EVERY backend `describe.skipIf(!reachable)` suite is matched by
 * `backend.pattern`. Adding a new real-DB suite without registering it here turns that test
 * red — this kills the "new suite outside the tripwire" recurrence class (4 occurrences:
 * 3a QA-3/TDA-4, 3b-1 QA-1, 3c TDA-1) structurally instead of by per-phase manual review.
 */
export const SUITES = {
  db: { label: "db real-DB INV", pattern: "INV-EVENT-DB-INTEGRITY" },
  backend: {
    label: "backend real-DB INV",
    pattern:
      "INV-IDEMPOTENCY|INV-EVENT-ORDER|INV-EVENT-CONTRACT|INV-LIVENESS-PARITY|" +
      "Ingestion server WS\\+HTTP|INV-GEMINI-OBSERVABILITY|INV-REDACTION-SUMMARY-STRADDLE|" +
      "INV-REDACTION-PEM-STRADDLE|INV-REDACTION-JWT-STRADDLE|INV-REDACTION-OCCURRENCE|" +
      "INV-REDACTION-BACKFILL|INV-LAST-TURN-OUTCOME-PERSIST|INV-SESSIONS-LINEAGE-PERSIST|" +
      "INV-RUN-LINEAGE|INV-TERMINAL-IMMUTABLE-ACROSS-RESUME|" +
      // 3c TDA-1: the tripwire used to cover a hand-picked subset; the coverage metatest now
      // requires every real-DB suite to be listed. Registered in one sweep (all of these run
      // in the same CI backend job, so this only strengthens the gate):
      "INV-LINEAGE-DTO|INV-AUDIT|INV-CONTRACT-GOLDEN|INV-DEMO-STATE-REAP|INV-DETAIL-PULL|" +
      "INV-INBOX|INV-INGRESS-REDACTION|INV-PROJECT-SCOPE|Realtime /realtime/ws|" +
      "INV-REDACTION-READLAYER-SYMMETRY|Replay history API|INV-SAFETY-DEMO-BACKEND-E2E|" +
      "INV-WALL|INV-WORKITEMS-WIRING",
  },
  "sidecar-egress": { label: "sidecar egress e2e (INV-EGRESS-E2E)", pattern: "INV-EGRESS-E2E" },
};

function main() {
  const argv = process.argv.slice(2);
  const usage =
    "usage: RC=<rc> node scripts/ci/assert-inv-ran.mjs <report.json> --suite <" +
    Object.keys(SUITES).join("|") +
    ">  (or: <report.json> <label> <pattern>)";
  let reportPath, label, patternSource;
  if (argv[1] === "--suite") {
    reportPath = argv[0];
    const suite = SUITES[argv[2]];
    if (!reportPath || !suite) {
      console.error(usage);
      if (argv[2] !== undefined && !SUITES[argv[2]]) console.error(`unknown suite: ${argv[2]}`);
      process.exit(1);
    }
    ({ label, pattern: patternSource } = suite);
  } else {
    [reportPath, label, patternSource] = argv;
    if (!reportPath || !label || !patternSource) {
      console.error(usage);
      process.exit(1);
    }
  }
  const rc = Number.parseInt(process.env.RC ?? "0", 10) || 0;

  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  } catch (e) {
    console.error(
      `${label}: JSON report missing/unparseable at ${reportPath} - ${e.message} (vitest rc=${rc})`,
    );
    process.exit(1);
  }

  const all = (report.testResults ?? []).flatMap((f) =>
    (f.assertionResults ?? []).map((a) => ({
      file: f.name,
      name: a.fullName || a.title,
      status: a.status,
    })),
  );

  if (rc !== 0) {
    const failed = all.filter((t) => t.status === "failed");
    if (failed.length > 0) {
      console.error(`${label}: suite FAILED (vitest rc=${rc}) - ${failed.length} failed test(s):`);
      for (const t of failed) console.error(`  x [${t.file}] ${t.name}`);
    } else {
      console.error(
        `${label}: suite FAILED (vitest rc=${rc}) but JSON has no per-test failure ` +
          `(crash/setup error?) - see vitest output above.`,
      );
    }
    process.exit(rc);
  }

  const pattern = new RegExp(patternSource);
  const inv = all.filter((t) => pattern.test(t.name));
  if (inv.length === 0) {
    console.error(`${label}: did not appear — test file missing/renamed?`);
    process.exit(1);
  }
  // SEC-3: todo/disabled included — vitest reports `.todo`-demoted tests with status "todo",
  // which the former inline snippets would have counted as "ran". Never let a demoted INV pass.
  const NOT_RUN = new Set(["skipped", "pending", "todo", "disabled"]);
  const skipped = inv.filter((t) => NOT_RUN.has(t.status));
  if (skipped.length > 0) {
    console.error(
      `${label}: was SKIPPED in CI (DATABASE_URL not reaching the test):`,
      skipped.map((s) => s.name),
    );
    process.exit(1);
  }
  console.log(`${label}: ran for real — ${inv.length} assertions, none skipped.`);
}

// CLI entrypoint guard: the coverage metatest imports { SUITES } without running the gate.
// (Import must stay side-effect free; every behavior lives in main().)
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
