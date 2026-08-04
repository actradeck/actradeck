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

# unreadable report -> exit 1 + "missing/unparseable" (a lost report must never pass).
out="$(RC=0 node scripts/ci/assert-inv-ran.mjs "$TMPDIR_TCP/absent.json" "probe" "INV-PROBE-X" 2>&1)"; rc=$?
if [ $rc -ne 0 ] && printf '%s' "$out" | grep -q "missing/unparseable"; then
  ok "unreadable-report fixture -> non-zero + missing/unparseable"
else
  bad "unreadable-report fixture mishandled (rc=$rc): $out"
fi

echo
echo "[test-ci-preflight] $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ]
