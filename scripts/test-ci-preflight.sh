#!/bin/bash
# Metatest for scripts/ci-preflight.sh + scripts/ci/assert-inv-ran.mjs (decision 019fcdf4).
#
# Proves the two gates are falsifiable (not vacuous):
#   1. drift tripwire PASSES against the real ci.yml (mirror is current),
#      and FAILS against a ci.yml with an injected step / a removed step.
#   2. assert-inv-ran.mjs: ok -> exit 0; pattern-missing / skipped / failed(rc) /
#      unreadable-report -> non-zero with the expected message.
#
# Output capture uses the `out="$(cmd)"; rc=$?` idiom (never `cmd | grep -q` under
# pipefail — see memory bash-gate-pipefail-sigpipe) and asserts POSITIVELY on messages.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
TMPDIR_TCP="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_TCP"' EXIT

PASS=0
FAIL=0
ok()   { PASS=$((PASS + 1)); echo "  PASS: $1"; }
bad()  { FAIL=$((FAIL + 1)); echo "  FAIL: $1" >&2; }

echo "[test-ci-preflight] 1. drift tripwire"

out="$(bash scripts/ci-preflight.sh --drift-check 2>&1)"; rc=$?
if [ $rc -eq 0 ] && printf '%s' "$out" | grep -q "steps match"; then
  ok "tripwire GREEN against the real ci.yml"
else
  bad "tripwire should pass against the real ci.yml (rc=$rc): $out"
fi

# Falsifiability A: inject a new step into the verify job -> tripwire must go RED and name it.
sed '/- name: Lint$/a\      - name: Injected preflight drift probe' \
  .github/workflows/ci.yml > "$TMPDIR_TCP/ci-injected.yml"
out="$(PREFLIGHT_CI_YML="$TMPDIR_TCP/ci-injected.yml" bash scripts/ci-preflight.sh --drift-check 2>&1)"; rc=$?
if [ $rc -ne 0 ] && printf '%s' "$out" | grep -q "Injected preflight drift probe"; then
  ok "tripwire RED on an injected ci.yml step (named in the output)"
else
  bad "tripwire missed an injected step (rc=$rc): $out"
fi

# Falsifiability B: remove a mirrored step -> tripwire must go RED (mirror lists the orphan).
grep -v '^      - name: Format check$' .github/workflows/ci.yml > "$TMPDIR_TCP/ci-removed.yml"
out="$(PREFLIGHT_CI_YML="$TMPDIR_TCP/ci-removed.yml" bash scripts/ci-preflight.sh --drift-check 2>&1)"; rc=$?
if [ $rc -ne 0 ] && printf '%s' "$out" | grep -q "Format check"; then
  ok "tripwire RED on a removed ci.yml step (named in the output)"
else
  bad "tripwire missed a removed step (rc=$rc): $out"
fi

# Falsifiability C (TDA-1): add a whole NEW job -> tripwire must go RED naming the job
# (gates grow job-wise in practice; a new unclassified job must not pass silently).
{ cat .github/workflows/ci.yml; printf '\n  perfprobe:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Injected new-job step\n        run: echo probe\n'; } > "$TMPDIR_TCP/ci-newjob.yml"
out="$(PREFLIGHT_CI_YML="$TMPDIR_TCP/ci-newjob.yml" bash scripts/ci-preflight.sh --drift-check 2>&1)"; rc=$?
if [ $rc -ne 0 ] && printf '%s' "$out" | grep -q "perfprobe"; then
  ok "tripwire RED on an injected new ci.yml job (named in the output)"
else
  bad "tripwire missed an injected new job (rc=$rc): $out"
fi

echo "[test-ci-preflight] 1b. orchestrator-step body parity (QA-5, 2026-08-13 audit)"

# The name-based tripwire cannot see body-only edits. Pin the known body-drift class: every
# `pnpm run test:*` gate that ci.yml runs inside the orchestrator step must also appear in
# ci-preflight.sh, so a root-script gate added to CI cannot silently vanish from local preflight.
CI_GATES="$(grep -oE 'pnpm run test:[a-z-]+' .github/workflows/ci.yml | sort -u)"
if [ -z "$CI_GATES" ]; then
  bad "expected at least one 'pnpm run test:*' gate in ci.yml (extraction went vacuous)"
else
  MISSING=""
  while IFS= read -r gate; do
    if ! grep -qF "$gate" scripts/ci-preflight.sh; then
      MISSING="$MISSING $gate"
    fi
  done <<EOF_GATES
$CI_GATES
EOF_GATES
  if [ -z "$MISSING" ]; then
    ok "every ci.yml 'pnpm run test:*' gate is mirrored in ci-preflight.sh"
  else
    bad "ci.yml gates missing from ci-preflight.sh:$MISSING"
  fi
fi

echo "[test-ci-preflight] 1c. --suite call-set parity (SEC-R3-4, task 01a058f0)"

# The step-name tripwire above cannot see a `--suite` line deleted from one side only (both
# steps keep their names), and nothing tied the SUITES table to its callers: a suite added to
# assert-inv-ran.mjs but never invoked would read as a gate while asserting nothing. One
# extractor serves both files so the two sides cannot be parsed differently. It reads only
# non-comment lines that invoke assert-inv-ran.mjs (prose such as "--suite preset" in comments
# is not a call) and keeps duplicates (multiset), so dropping one of two identical calls on one
# side is also a mismatch.
suite_calls() {
  grep -vE '^[[:space:]]*#' "$1" | grep -F 'assert-inv-ran.mjs' \
    | grep -oE -- '--suite [A-Za-z0-9_-]+' | sed 's/^--suite //' | sort
}
suites_declared() {
  # The module path goes through the environment, not argv: the script's CLI entry guard
  # compares process.argv[1] with its own URL, so passing the path as argv[1] would run the gate.
  SUITES_MODULE="$REPO_ROOT/scripts/ci/assert-inv-ran.mjs" node --input-type=module -e '
    const m = await import(process.env.SUITES_MODULE);
    console.log(Object.keys(m.SUITES).sort().join("\n"));
  '
}
# suite_parity <ci.yml> <preflight.sh> <declared-keys-file>: rc 0 iff
#   (a) the two call multisets are equal and non-empty, and
#   (b) the distinct called keys equal the SUITES keys (every suite is invoked; no unknown call).
suite_parity() {
  local ci pf declared called
  ci="$(suite_calls "$1")"
  pf="$(suite_calls "$2")"
  declared="$(cat "$3")"
  if [ -z "$ci" ]; then
    echo "suite parity: no --suite call extracted from $1 (extraction went vacuous)"
    return 1
  fi
  if [ "$ci" != "$pf" ]; then
    echo "suite parity: --suite calls differ between $1 and $2"
    diff <(printf '%s\n' "$ci") <(printf '%s\n' "$pf") | sed 's/^/  /'
    return 1
  fi
  called="$(printf '%s\n' "$ci" | sort -u)"
  if [ "$called" != "$declared" ]; then
    echo "suite parity: SUITES keys and invoked suites differ (< SUITES / > invoked)"
    diff <(printf '%s\n' "$declared") <(printf '%s\n' "$called") | sed 's/^/  /'
    return 1
  fi
  echo "suite parity: $(printf '%s\n' "$ci" | wc -l) --suite calls match on both sides and cover every SUITES key"
}

suites_declared > "$TMPDIR_TCP/suites.txt"
if [ ! -s "$TMPDIR_TCP/suites.txt" ]; then
  bad "SUITES key extraction from assert-inv-ran.mjs went vacuous"
fi

out="$(suite_parity .github/workflows/ci.yml scripts/ci-preflight.sh "$TMPDIR_TCP/suites.txt" 2>&1)"; rc=$?
if [ $rc -eq 0 ] && printf '%s' "$out" | grep -q "cover every SUITES key"; then
  ok "--suite calls match between ci.yml and ci-preflight.sh and cover every SUITES key"
else
  bad "--suite parity should hold on the real files (rc=$rc): $out"
fi

# Falsifiability A: delete one --suite call from ONE side only -> RED naming the suite.
grep -v -- '--suite sidecar-linear$' scripts/ci-preflight.sh > "$TMPDIR_TCP/preflight-dropped.sh"
out="$(suite_parity .github/workflows/ci.yml "$TMPDIR_TCP/preflight-dropped.sh" "$TMPDIR_TCP/suites.txt" 2>&1)"; rc=$?
if [ $rc -ne 0 ] && printf '%s' "$out" | grep -q "sidecar-linear"; then
  ok "parity RED when one side drops a --suite call (named in the output)"
else
  bad "parity missed a one-sided --suite deletion (rc=$rc): $out"
fi

# Falsifiability B: add a --suite call on ONE side only -> RED.
{ cat .github/workflows/ci.yml; printf '          RC=$rc node scripts/ci/assert-inv-ran.mjs /tmp/x.json --suite db\n'; } > "$TMPDIR_TCP/ci-extra-suite.yml"
out="$(suite_parity "$TMPDIR_TCP/ci-extra-suite.yml" scripts/ci-preflight.sh "$TMPDIR_TCP/suites.txt" 2>&1)"; rc=$?
if [ $rc -ne 0 ] && printf '%s' "$out" | grep -q "differ between"; then
  ok "parity RED when one side gains an extra --suite call"
else
  bad "parity missed a one-sided --suite addition (rc=$rc): $out"
fi

# Falsifiability C: a SUITES key that neither side invokes -> RED naming the key.
{ cat "$TMPDIR_TCP/suites.txt"; echo "zz-uncalled-probe"; } | sort > "$TMPDIR_TCP/suites-extra.txt"
out="$(suite_parity .github/workflows/ci.yml scripts/ci-preflight.sh "$TMPDIR_TCP/suites-extra.txt" 2>&1)"; rc=$?
if [ $rc -ne 0 ] && printf '%s' "$out" | grep -q "zz-uncalled-probe"; then
  ok "parity RED when a SUITES key is never invoked (named in the output)"
else
  bad "parity missed an uninvoked SUITES key (rc=$rc): $out"
fi

# Negative control for the comment filter: a commented-out call must not count as a call.
{ cat .github/workflows/ci.yml; printf '          # RC=$rc node scripts/ci/assert-inv-ran.mjs /tmp/x.json --suite db\n'; } > "$TMPDIR_TCP/ci-comment-suite.yml"
out="$(suite_parity "$TMPDIR_TCP/ci-comment-suite.yml" scripts/ci-preflight.sh "$TMPDIR_TCP/suites.txt" 2>&1)"; rc=$?
if [ $rc -eq 0 ]; then
  ok "a commented-out --suite line is not counted as a call"
else
  bad "comment filter counted a commented-out call (rc=$rc): $out"
fi

echo "[test-ci-preflight] 2. assert-inv-ran.mjs fixtures"

fixture() { printf '%s' "$1" > "$TMPDIR_TCP/report.json"; }

# ok: matching assertions, all passed, rc=0 -> exit 0 + "ran for real".
fixture '{"testResults":[{"name":"f.test.ts","assertionResults":[{"fullName":"INV-PROBE-X holds","status":"passed"},{"fullName":"INV-PROBE-X also holds","status":"passed"}]}]}'
out="$(RC=0 node scripts/ci/assert-inv-ran.mjs "$TMPDIR_TCP/report.json" "probe" "INV-PROBE-X" 2>&1)"; rc=$?
if [ $rc -eq 0 ] && printf '%s' "$out" | grep -q "ran for real — 2 assertions"; then
  ok "ok fixture -> exit 0 with ran-for-real count"
else
  bad "ok fixture mishandled (rc=$rc): $out"
fi

# missing: pattern matches nothing -> exit 1 + "did not appear".
out="$(RC=0 node scripts/ci/assert-inv-ran.mjs "$TMPDIR_TCP/report.json" "probe" "INV-ABSENT-Y" 2>&1)"; rc=$?
if [ $rc -ne 0 ] && printf '%s' "$out" | grep -q "did not appear"; then
  ok "missing-pattern fixture -> non-zero + did-not-appear"
else
  bad "missing-pattern fixture mishandled (rc=$rc): $out"
fi

# skipped: a matching assertion is skipped -> exit 1 + "SKIPPED".
fixture '{"testResults":[{"name":"f.test.ts","assertionResults":[{"fullName":"INV-PROBE-X holds","status":"skipped"}]}]}'
out="$(RC=0 node scripts/ci/assert-inv-ran.mjs "$TMPDIR_TCP/report.json" "probe" "INV-PROBE-X" 2>&1)"; rc=$?
if [ $rc -ne 0 ] && printf '%s' "$out" | grep -q "SKIPPED"; then
  ok "skipped fixture -> non-zero + SKIPPED"
else
  bad "skipped fixture mishandled (rc=$rc): $out"
fi

# failed + rc: vitest rc=7 with a failed test -> exit 7 + failed test listed.
fixture '{"testResults":[{"name":"f.test.ts","assertionResults":[{"fullName":"INV-PROBE-X broke","status":"failed"}]}]}'
out="$(RC=7 node scripts/ci/assert-inv-ran.mjs "$TMPDIR_TCP/report.json" "probe" "INV-PROBE-X" 2>&1)"; rc=$?
if [ $rc -eq 7 ] && printf '%s' "$out" | grep -q "INV-PROBE-X broke"; then
  ok "failed+rc fixture -> exit rc (7) + failed test named"
else
  bad "failed+rc fixture mishandled (rc=$rc): $out"
fi

# failed + rc=1 (QA-1): vitest's REAL failure code is 1 — the boundary a weakened rc guard
# (e.g. rc > 1) would wave through. Must exit 1 and name the failed test.
out="$(RC=1 node scripts/ci/assert-inv-ran.mjs "$TMPDIR_TCP/report.json" "probe" "INV-PROBE-X" 2>&1)"; rc=$?
if [ $rc -eq 1 ] && printf '%s' "$out" | grep -q "INV-PROBE-X broke"; then
  ok "failed+rc=1 fixture -> exit 1 + failed test named (real vitest failure code)"
else
  bad "failed+rc=1 fixture mishandled (rc=$rc): $out"
fi

# todo (SEC-3): an INV demoted to .todo (vitest status "todo") must not count as ran.
fixture '{"testResults":[{"name":"f.test.ts","assertionResults":[{"fullName":"INV-PROBE-X holds","status":"todo"}]}]}'
out="$(RC=0 node scripts/ci/assert-inv-ran.mjs "$TMPDIR_TCP/report.json" "probe" "INV-PROBE-X" 2>&1)"; rc=$?
if [ $rc -ne 0 ] && printf '%s' "$out" | grep -q "SKIPPED"; then
  ok "todo fixture -> non-zero + SKIPPED (demoted INV never reads as ran)"
else
  bad "todo fixture mishandled (rc=$rc): $out"
fi

# --suite form (TDA-2): the gate's semantic core (which INV must run) lives in the script.
fixture '{"testResults":[{"name":"f.test.ts","assertionResults":[{"fullName":"INV-EVENT-DB-INTEGRITY holds","status":"passed"}]}]}'
out="$(RC=0 node scripts/ci/assert-inv-ran.mjs "$TMPDIR_TCP/report.json" --suite db 2>&1)"; rc=$?
if [ $rc -eq 0 ] && printf '%s' "$out" | grep -q "ran for real"; then
  ok "--suite db -> exit 0 against a matching report"
else
  bad "--suite db mishandled (rc=$rc): $out"
fi
out="$(RC=0 node scripts/ci/assert-inv-ran.mjs "$TMPDIR_TCP/report.json" --suite nonsense 2>&1)"; rc=$?
if [ $rc -ne 0 ] && printf '%s' "$out" | grep -q "unknown suite"; then
  ok "--suite nonsense -> non-zero + unknown-suite error"
else
  bad "unknown suite mishandled (rc=$rc): $out"
fi

# unreadable report -> exit 1 + "missing/unparseable" (a lost report must never pass).
out="$(RC=0 node scripts/ci/assert-inv-ran.mjs "$TMPDIR_TCP/absent.json" "probe" "INV-PROBE-X" 2>&1)"; rc=$?
if [ $rc -ne 0 ] && printf '%s' "$out" | grep -q "missing/unparseable"; then
  ok "unreadable-report fixture -> non-zero + missing/unparseable"
else
  bad "unreadable-report fixture mishandled (rc=$rc): $out"
fi

echo "[test-ci-preflight] 3. db guard (SEC-1: refuse production-port DSNs before any migrate)"

# The guard reuses the canonical event-model test-db-guard from its dist; build it if the
# checkout is fresh (cheap, and the metatest must not silently skip a security check).
if [ ! -f packages/event-model/dist/test-db-guard.js ]; then
  pnpm --filter @actradeck/event-model run build >/dev/null
fi

# Hermetic (QA-PF-1, 2026-08-13): the guard honors ACTRADECK_TEST_DATABASE_URL over the argument
# by design, so an ambient test-DB env var would mask the injected production-port fixture and
# flip this metatest to a false FAIL. Strip it for both probes.
out="$(env -u ACTRADECK_TEST_DATABASE_URL bash scripts/ci-preflight.sh --db-guard "postgresql://actradeck@127.0.0.1:55432/actradeck" 2>&1)"; rc=$?
if [ $rc -ne 0 ] && printf '%s' "$out" | grep -qi "refusing"; then
  ok "db guard RED on a production-port (:55432) DSN"
else
  bad "db guard passed a production-port DSN (rc=$rc): $out"
fi

out="$(env -u ACTRADECK_TEST_DATABASE_URL bash scripts/ci-preflight.sh --db-guard "postgresql://actradeck@127.0.0.1:5456/actradeck" 2>&1)"; rc=$?
if [ $rc -eq 0 ] && printf '%s' "$out" | grep -q "not a production-port"; then
  ok "db guard GREEN on a disposable-port (:5456) DSN"
else
  bad "db guard rejected a disposable DSN (rc=$rc): $out"
fi

echo
echo "[test-ci-preflight] $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
