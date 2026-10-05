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
 *   - --suite with minTests  -> fewer matching tests ran than minTests -> error + exit 1
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
      "INV-WALL|INV-WORKITEMS-WIRING|" +
      // ADR 0014 Phase 4 (decision 019fd705): approval restart reconciliation の受入#6/#7。
      "INV-APPROVAL-RECONCILE",
  },
  "sidecar-egress": { label: "sidecar egress e2e (INV-EGRESS-E2E)", pattern: "INV-EGRESS-E2E" },
  // SEC-HPR2-1 (裁定 01a0586b): the linear metatest's executable controls ARE the detector's
  // self-check, and the in-file count pins are registration-time (`it.skip` or an early return
  // leaves them green). The in-process backstop is an afterAll on an executed-case counter;
  // this entry is the CI-side second layer, which additionally refuses a skipped/todo suite.
  "sidecar-linear": {
    label: "sidecar linear metatest (INV-LITERAL-RULES-LINEAR)",
    pattern: "INV-LITERAL-RULES-LINEAR",
  },
  // QA-CSX-2 / TDA-CSX-4: INV-STRIP-COMMENTS owns the scan view that nine tripwires share
  // (the comment-strip normalisation). Its in-file counters are registration-time for the
  // file as a whole: a `describe.skip` inside is caught by the top-level afterAll, but
  // skipping or deleting the whole file is not. This is the CI-side second layer, which
  // additionally refuses a skipped/todo suite. Same two-layer shape as sidecar-linear.
  "strip-comments": {
    label: "comment-strip scan normalisation (INV-STRIP-COMMENTS)",
    pattern: "INV-STRIP-COMMENTS",
  },
  // TDA-HS-5 (task 01a108ac-cd47): INV-APPROVAL-TIMEOUT-ORDERING pins approval wait < shim
  // deadline < Claude Code hook timeout. If the hook timeout is reached first, the hook stops
  // gating (upstream treats it as non-blocking). Before this entry a `describe.skip` on the suite
  // plus a margin edit kept every gate green (measured by the TDA lane). Same report as
  // strip-comments. `minTests` is the exact count in the full event-model report this step reads
  // (8, all in inv-approval-timeout-ordering.test.ts). Raise it by hand when tests are added.
  "event-model-timeout-ordering": {
    label: "approval timeout ordering (INV-APPROVAL-TIMEOUT-ORDERING)",
    pattern: "INV-APPROVAL-TIMEOUT-ORDERING",
    minTests: 8,
  },
  // QA-FLV2-R2-4 (task 01a058f0): the advisory file-lock invariants guard the persistent
  // allowlist / per-repo policy / attach settings writers (security.md "advisory file lock").
  // They ride the same sidecar JSON report as sidecar-egress / sidecar-linear. Matched by the
  // three describe-title prefixes below (13 describes in 6 files as of task 01a05a63 R1).
  // EXCLUDED on purpose: the describe "INV-FILELOCK-IDENTITY-V2: EISDIR ..." calls ctx.skip when
  // the filesystem does not reuse the freed inode number for a directory, so whether it runs
  // depends on the runner; this gate turns any skip into rc=1, which would make that one
  // environment-dependent. The negative lookahead keeps it out. Task 01a05a63 did not make that
  // real-filesystem case deterministic. Instead the EISDIR decision is pinned by two matched
  // describes that do not depend on inode reuse: "INV-FILELOCK-IDENTITY-V2: 解放の所有判定 ..."
  // (the pure decision function) and "INV-FILELOCK-IDENTITY-V2: 解放路の所有判定の結線 ..." (the
  // release path's call site; scope in that test file's header). The EISDIR describe is kept as an
  // extra real-fs axis and stays excluded. Describes titled INV-ATTACH-WIRE-LOCK are outside
  // these prefixes (some of them skip when running as root, where chmod does not restrict), as
  // is the INV-FILELOCK-NO-EMPTY-WINDOW it (inside INV-APPROVAL-PERSIST-CONCURRENT); none of
  // them are asserted here.
  // What this entry catches (measured, task 01a058f0): a skipped/todo test in any matched
  // describe, every matched describe disappearing at once, and — through `minTests` — one
  // describe renamed out of the prefixes while the others still match (measured 27 -> 25 before
  // `minTests` existed: rc=0; with it: rc=1). `minTests` is a floor, not an exact count: adding
  // tests does not trip it, and it must be raised by hand when tests are added (it cannot see a
  // rename that is offset by an equal number of new matching tests).
  "sidecar-filelock": {
    label: "sidecar advisory file-lock INV (INV-FILELOCK-*)",
    pattern:
      "INV-FILELOCK-STALE-TAKEOVER-IDENTITY|INV-FILELOCK-TESTHOOKS-BOUNDARY|" +
      "INV-FILELOCK-IDENTITY-V2: (?!EISDIR)",
    minTests: 40,
  },
  // QA-FC-R2-4: INV-APPROVAL-FAIL-CLOSED pins that an approval hook the daemon has accepted is
  // answered with a deny when handling it fails (including the crash-chain case run in a real
  // child process). Same report and two-layer shape as sidecar-filelock.
  // `minTests` is the exact count in the full sidecar report this step reads (measured when the
  // entry was added): 20 tests in inv-approval-fail-closed.test.ts plus 2 in
  // hook-approval-gate.test.ts whose titles name the invariant = 22. At 22, skipping or renaming
  // any one matched describe (the crash-chain one included) fails the gate (QA-AFC-1). Raise it by
  // hand when tests are added.
  // What this entry catches: a skipped/todo matched test, a matched describe renamed out of the
  // pattern, the file removed. What it does not catch: a removed `expect` in an afterAll, or an
  // early return inside a test — the gate sees only each test's status (QA-AFC-2 / QA-AFC-3).
  "sidecar-approval-fail-closed": {
    label: "sidecar approval fail-closed INV (INV-APPROVAL-FAIL-CLOSED)",
    pattern: "INV-APPROVAL-FAIL-CLOSED",
    minTests: 22,
  },
  // Task 01a108ac-cd47 (T-A, ADR 0016): the PreToolUse command shim turns every transport
  // failure into exit 2. INV-HOOK-SHIM-FAIL-CLOSED drives the real shim process through a
  // table of failure sources; its in-file afterAll counter catches a skipped/early-returned
  // case, and this entry is the CI-side second layer that also refuses a skipped/todo suite
  // and - through `minTests` - a table that silently shrank. `minTests` is the exact count in
  // the full sidecar report this step reads (measured 229 after task 01a10ce3: 103 table cases
  // in the real-process describe + 101 of them in-process (two cases are process-only) + 3 more
  // in-process tests (deadline timer, stdin read error mapping, stdin past the limit not kept) +
  // 2 entry wiring + 1 hold/cleanup + 12 binding tests + 7 in the transpiled-dist describe
  // (6 launch forms + its table-shape test), all in inv-hook-shim-fail-closed.test.ts).
  // Raise it by hand when cases are added.
  "sidecar-hook-shim": {
    label: "sidecar PreToolUse hook shim (INV-HOOK-SHIM-FAIL-CLOSED)",
    pattern: "INV-HOOK-SHIM-FAIL-CLOSED",
    minTests: 229,
  },
  // QA-DC-3 (SEC-ENV-4 R1): the refused-start cleanup of a dead daemon's wiring. Its in-file
  // afterAll counters catch a single skipped row, but skipping a whole describe also skips that
  // describe's afterAll. Same report and two-layer shape as sidecar-approval-fail-closed.
  // `minTests` is the exact count in the full sidecar report this step reads, measured at SEC-ENV-4
  // R3: 64 = 45 (denial x scope table, stale + alive rows, plus the table-shape test)
  // + 9 (cleanup boundaries) + 3 (entries left on other ports keep the state, SEC-DC-R2-1)
  // + 3 (remaining-entry shapes: marker-less legacy literal / env entries, no recorded-port entry)
  // + 2 (concurrent start races R1 / R2) in inv-attach-deny-cleanup.test.ts, + 2 (single read of
  // the state file / state delete failure) in inv-attach-deny-cleanup-fs.test.ts. At 64, skipping
  // or renaming any one matched describe fails the gate. Raise it by hand when tests are added.
  // What this entry does not catch: an early return at the top of an `it`, a removed `expect`, or a
  // removed afterAll counter check — the gate sees only each test's status.
  "sidecar-attach-deny-cleanup": {
    label: "sidecar attach refused-start cleanup INV (INV-ATTACH-DENY-CLEANUP)",
    pattern: "INV-ATTACH-DENY-CLEANUP",
    minTests: 64,
  },
  // QA-DC-3: the real-process SIGHUP detach of the attach CLI (inv-attach-deny-cleanup.test.ts, its
  // own describe with 1 test). Same limits as above: an early return inside the test is not caught.
  "sidecar-attach-sighup": {
    label: "sidecar attach SIGHUP detach INV (INV-ATTACH-SIGHUP-DETACH)",
    pattern: "INV-ATTACH-SIGHUP-DETACH",
    minTests: 1,
  },
};

function main() {
  const argv = process.argv.slice(2);
  const usage =
    "usage: RC=<rc> node scripts/ci/assert-inv-ran.mjs <report.json> --suite <" +
    Object.keys(SUITES).join("|") +
    ">  (or: <report.json> <label> <pattern>)";
  // `matches` decides which reported tests count as "the invariant". The two argument forms
  // deliberately differ in how the selector is interpreted (CodeQL js/regex-injection):
  //   --suite  -> the selector is a regex source read from the module-local SUITES table, so it
  //               is developer-authored and alternation (`|`) is load-bearing.
  //   raw form -> the selector arrives on argv. Building a RegExp from it would let a caller
  //               inject a catastrophically backtracking pattern, so it is matched as a plain
  //               substring instead. Behaviour-preserving: every raw-form caller (the metatest
  //               in scripts/test-ci-preflight.sh) passes a literal test-name fragment.
  let reportPath, label, patternSource, matches;
  // Optional per-suite floor (task 01a058f0). undefined = no count check (every suite without
  // `minTests`, and the raw 3-arg form, behave exactly as before).
  let minTests;
  if (argv[1] === "--suite") {
    reportPath = argv[0];
    const suite = SUITES[argv[2]];
    if (!reportPath || !suite) {
      console.error(usage);
      if (argv[2] !== undefined && !SUITES[argv[2]]) console.error(`unknown suite: ${argv[2]}`);
      process.exit(1);
    }
    ({ label, pattern: patternSource, minTests } = suite);
    const suiteRe = new RegExp(patternSource);
    matches = (name) => suiteRe.test(name);
  } else {
    [reportPath, label, patternSource] = argv;
    if (!reportPath || !label || !patternSource) {
      console.error(usage);
      process.exit(1);
    }
    const literal = patternSource;
    matches = (name) => name.includes(literal);
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

  const inv = all.filter((t) => matches(t.name));
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
  // minTests (task 01a058f0): a describe renamed out of the pattern leaves the others matching,
  // so "did not appear" never fires. Suites that declare a floor also fail when fewer matched
  // tests ran than the floor. Reached only after the skip check, so every counted test ran.
  const ran = inv.length - skipped.length;
  if (minTests !== undefined && ran < minTests) {
    console.error(
      `${label}: only ${ran} matching test(s) ran, fewer than minTests=${minTests} ` +
        `(a describe renamed out of the pattern, or tests deleted?)`,
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
