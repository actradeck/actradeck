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
 * Contract (behavior-equivalent to the former inline snippets):
 *   RC=<vitest-exit-code> node scripts/ci/assert-inv-ran.mjs <report.json> <label> <pattern>
 *   - report unreadable      -> error + exit 1 (a missing report must never pass the gate)
 *   - RC != 0                -> list the failed tests from the report + exit RC
 *   - pattern matches 0 test -> error ("did not appear — test file missing?") + exit 1
 *   - any match skipped      -> error ("SKIPPED in CI — DATABASE_URL not reaching the test") + exit 1
 *   - otherwise              -> log the ran-for-real count + exit 0
 *
 * <pattern> is a JS RegExp source matched against each test's fullName/title.
 */
import fs from "node:fs";

const [reportPath, label, patternSource] = process.argv.slice(2);
if (!reportPath || !label || !patternSource) {
  console.error(
    "usage: RC=<rc> node scripts/ci/assert-inv-ran.mjs <report.json> <label> <pattern>",
  );
  process.exit(1);
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
const skipped = inv.filter((t) => t.status === "skipped" || t.status === "pending");
if (skipped.length > 0) {
  console.error(
    `${label}: was SKIPPED in CI (DATABASE_URL not reaching the test):`,
    skipped.map((s) => s.name),
  );
  process.exit(1);
}
console.log(`${label}: ran for real — ${inv.length} assertions, none skipped.`);
