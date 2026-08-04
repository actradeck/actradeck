#!/bin/bash
# CI preflight — run the ci.yml gates locally, in the same order, before pushing.
#
# decision 019fcdf4. Faithful local mirror of .github/workflows/ci.yml (jobs: verify, e2e,
# migrations). Every gate command of the mirrored jobs runs here with the same env posture
# (CI=true, ACTRADECK_SKIP_REAL_BIN_E2E=1, DATABASE_URL reaching the real-DB INV tests), so
# a push that would fail CI fails on your machine first. (Install/build steps duplicated
# across CI jobs run once here — same machine — and runner toolchain pins are not mirrored.)
#
# Drift tripwire (fail-loud): before running anything, the step names of the mirrored jobs
# are extracted from ci.yml and compared against the MIRRORED_STEPS list below. A step added
# to ci.yml without updating this script aborts the preflight with instructions — the mirror
# can go stale, but never silently.
#
# HONEST SCOPE: the tripwire pins step *names* of the mirrored jobs plus the ci.yml *job
# set* (an unknown new job aborts — TDA-1), not step *bodies*: if a step's run block
# changes without renaming the step, this mirror can lag until the next reconciliation
# (the inline bodies here are deliberately small; the heavy logic lives in shared scripts —
# scripts/ci/assert-inv-ran.mjs, scripts/test-*.sh, pnpm scripts — which both sides call, so
# body drift is confined to the thin wiring below). Steps written name-second (after
# `uses:`) or unnamed are also invisible to the name extractor (QA-2) — the current ci.yml
# has none in the mirrored jobs; keep new steps name-first. The docker-image-scan and
# changes jobs are known and deliberately not mirrored (conditional, slow); run
# `bash scripts/lib/scan-image-fs.sh` manually for image content changes.
#
# Database: uses ACTRADECK_TEST_DATABASE_URL or DATABASE_URL if set; otherwise provisions a
# disposable Postgres container on 127.0.0.1:5456 (removed on exit; keep with
# PREFLIGHT_KEEP_PG=1). A preset URL is refused BEFORE the first migrate if it targets the
# production Postgres port (55432 / ACTRADECK_PG_PORT) — the check reuses the canonical
# test-harness guard (packages/event-model test-db-guard, SEC-1); the harness guard itself
# then protects the test steps a second time.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
CI_YML=".github/workflows/ci.yml"

export CI=true
export ACTRADECK_SKIP_REAL_BIN_E2E=1

# ---------------------------------------------------------------------------
# Drift tripwire: mirrored jobs' step names must match this list exactly.
# When ci.yml gains/renames/removes a step, update BOTH the list and the runner below.
# ---------------------------------------------------------------------------
MIRRORED_STEPS=$(cat <<'EOF'
verify:Install dependencies
verify:Dependency audit (INV-DEP-AUDIT, fail on High/Critical)
verify:Lint
verify:Format check
verify:Build workspace (provide dist for type-check/test/e2e; topological)
verify:Type check
verify:Orchestrator script smoke (no-secret-in-argv, unit/plist contracts)
verify:Landing gen idempotency + drift gate (docs-lp QA-1)
verify:Verify preinstalled PyYAML (no unpinned install)
verify:Release prep gate (version/SBOM/tarball/perms/install-verify)
verify:Migrate up (provision schema for real-DB INV)
verify:Test
verify:Assert real-DB INV actually RAN (not skipped)
verify:Assert backend real-DB INV actually RAN (not skipped)
verify:Test (backend coverage gate)
verify:Test (redaction coverage gate)
verify:Test (event-model coverage gate)
verify:Build backend (provide dist for sidecar e2e import)
verify:Test (sidecar coverage gate)
verify:Assert egress e2e actually RAN (not skipped)
verify:Test (webui coverage gate)
verify:Test (cli coverage gate)
verify:Build design-tokens (generate --ad-* CSS for webui)
verify:Build (webui production build gate)
verify:Boot smoke (real server bring-up gate)
e2e:Install dependencies
e2e:Build workspace (provide dist for e2e runtime imports; topological)
e2e:E2E hook-replay (REAL HTTP/SQLite/WS, redaction leak = fail)
migrations:Install dependencies
migrations:Migrate up
migrations:Migrate down (rollback verification)
migrations:Migrate up again (idempotent re-apply)
EOF
)

# Jobs this mirror knows about: mirrored ones run here; the rest are deliberately not
# mirrored (documented in the header). Any job outside BOTH sets trips the drift check.
MIRRORED_JOBS="verify e2e migrations"
KNOWN_NOT_MIRRORED_JOBS="changes docker-image-scan"

extract_ci_steps() {
  # Print "job:step name" for every named step of the mirrored jobs, in file order.
  # ci.yml layout contract: job keys are 2-space-indented under the top-level `jobs:` map
  # (the in_jobs gate keeps 2-space keys under `on:` etc. from being taken for jobs); step
  # names are `- name:` at 6-space indent. `name: CI` (column 0) never matches.
  awk '
    /^jobs:[[:space:]]*$/ { in_jobs = 1; next }
    /^[A-Za-z0-9_-]+:/    { in_jobs = 0 }
    in_jobs && /^  [A-Za-z0-9_-]+:[[:space:]]*$/ {
      job = $1; sub(/:$/, "", job); next
    }
    in_jobs && /^      - name: / {
      if (job == "verify" || job == "e2e" || job == "migrations") {
        line = $0; sub(/^      - name: /, "", line); print job ":" line
      }
    }
  ' "$CI_YML"
}

extract_ci_jobs() {
  # Print every job key of the top-level `jobs:` map, in file order (TDA-1: a NEW job is
  # how gates actually grow — docker-image-scan was one — so the job set is pinned too).
  awk '
    /^jobs:[[:space:]]*$/ { in_jobs = 1; next }
    /^[A-Za-z0-9_-]+:/    { in_jobs = 0 }
    in_jobs && /^  [A-Za-z0-9_-]+:[[:space:]]*$/ {
      job = $1; sub(/:$/, "", job); print job
    }
  ' "$CI_YML"
}

drift_check() {
  # 1. Job-set pin (TDA-1): every ci.yml job must be either mirrored or known-not-mirrored.
  local job known unknown=""
  for job in $(extract_ci_jobs); do
    known=0
    for k in $MIRRORED_JOBS $KNOWN_NOT_MIRRORED_JOBS; do
      [ "$job" = "$k" ] && known=1 && break
    done
    [ $known -eq 0 ] && unknown="$unknown $job"
  done
  if [ -n "$unknown" ]; then
    echo "DRIFT TRIPWIRE: new CI job(s) not classified by scripts/ci-preflight.sh:$unknown" >&2
    echo "Mirror each new job here (MIRRORED_JOBS + MIRRORED_STEPS + a runner) or, if it is" >&2
    echo "deliberately local-unmirrorable, add it to KNOWN_NOT_MIRRORED_JOBS with a header note." >&2
    exit 1
  fi

  # 2. Step-name pin for the mirrored jobs (order-sensitive full match).
  local actual expected
  actual="$(extract_ci_steps)"
  expected="$MIRRORED_STEPS"
  if [ "$actual" != "$expected" ]; then
    echo "DRIFT TRIPWIRE: ci.yml mirrored-job steps differ from scripts/ci-preflight.sh." >&2
    echo "--- steps in ci.yml but not mirrored here:" >&2
    comm -23 <(printf '%s\n' "$actual" | sort) <(printf '%s\n' "$expected" | sort) | sed 's/^/  + /' >&2
    echo "--- steps mirrored here but gone from ci.yml:" >&2
    comm -13 <(printf '%s\n' "$actual" | sort) <(printf '%s\n' "$expected" | sort) | sed 's/^/  - /' >&2
    echo "Update MIRRORED_STEPS and the runner in scripts/ci-preflight.sh to match ci.yml." >&2
    exit 1
  fi
  echo "drift tripwire: ci.yml job set + mirrored-job steps match ($(printf '%s\n' "$expected" | wc -l) steps)."
}

# ---------------------------------------------------------------------------
# Database provisioning
# ---------------------------------------------------------------------------
PREFLIGHT_PG_CONTAINER="actradeck-preflight-pg"
STARTED_PG=0
cleanup() {
  if [ "$STARTED_PG" = 1 ] && [ "${PREFLIGHT_KEEP_PG:-0}" != 1 ]; then
    docker rm -f "$PREFLIGHT_PG_CONTAINER" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# SEC-1: refuse a production-port DSN BEFORE anything (the first migrate above all) touches
# the database. Reuses the canonical test-harness guard from the event-model dist — a second
# hand-written port parser here would be exactly the drift the canonical one exists to
# prevent. Called after the workspace build (dist present); a missing/broken dist fails
# CLOSED (a guard that cannot load must not wave traffic through).
preflight_db_guard() {
  local url="$1"
  node -e '
    const url = process.argv[1];
    import("./packages/event-model/dist/test-db-guard.js")
      .then((g) => {
        g.applyTestDatabaseGuard({ ...process.env, DATABASE_URL: url });
        console.log("db guard: DATABASE_URL is not a production-port DSN.");
      })
      .catch((e) => {
        console.error("preflight db guard: " + e.message);
        process.exit(1);
      });
  ' "$url"
}

provision_db() {
  if [ -n "${ACTRADECK_TEST_DATABASE_URL:-}" ]; then
    export DATABASE_URL="$ACTRADECK_TEST_DATABASE_URL"
    echo "db: using ACTRADECK_TEST_DATABASE_URL"
    preflight_db_guard "$DATABASE_URL"
    return
  fi
  if [ -n "${DATABASE_URL:-}" ]; then
    echo "db: using preset DATABASE_URL"
    preflight_db_guard "$DATABASE_URL"
    return
  fi
  echo "db: starting disposable Postgres container on 127.0.0.1:5456 ($PREFLIGHT_PG_CONTAINER)"
  docker rm -f "$PREFLIGHT_PG_CONTAINER" >/dev/null 2>&1 || true
  # Throwaway credential, kept out of the URL (PGPASSWORD is the libpq-compatible channel
  # node-pg honors) so no user:pass@ DSN shape ever appears here — same posture as
  # CONTRIBUTING's disposable-DB recipe, and the commit-time leak gate stays strict.
  local pw="preflight_local_only"
  docker run -d --name "$PREFLIGHT_PG_CONTAINER" \
    -e POSTGRES_USER=actradeck -e POSTGRES_PASSWORD="$pw" -e POSTGRES_DB=actradeck \
    -p 127.0.0.1:5456:5432 postgres:17.5-alpine >/dev/null
  STARTED_PG=1
  local i
  for i in $(seq 1 30); do
    docker exec "$PREFLIGHT_PG_CONTAINER" pg_isready -U actradeck -d actradeck >/dev/null 2>&1 && break
    sleep 1
  done
  docker exec "$PREFLIGHT_PG_CONTAINER" pg_isready -U actradeck -d actradeck >/dev/null
  export PGPASSWORD="$pw"
  export DATABASE_URL="postgresql://actradeck@127.0.0.1:5456/actradeck"
}

# ---------------------------------------------------------------------------
# Step runner (same order as ci.yml)
# ---------------------------------------------------------------------------
step() { echo; echo "=== [$(date +%H:%M:%S)] $1 ==="; }

run_verify_job() {
  step "verify: Install dependencies"
  pnpm install --frozen-lockfile

  step "verify: Dependency audit"
  pnpm audit --audit-level=high

  step "verify: Lint"
  pnpm run lint

  step "verify: Format check"
  pnpm run format

  step "verify: Build workspace"
  pnpm run build

  step "verify: Type check"
  pnpm run type-check

  step "verify: Orchestrator script smoke"
  bash scripts/test-actradeck.sh
  bash scripts/test-ad-attach.sh
  bash scripts/test-install.sh
  bash scripts/test-install-e2e.sh
  if [ -f scripts/test-import-oss-pr.sh ]; then
    bash scripts/test-import-oss-pr.sh
  else
    echo "test-import-oss-pr.sh absent (retired at the canonical cutover) — import-flow gate skipped"
  fi
  bash scripts/test-ci-preflight.sh

  step "verify: Landing gen idempotency + drift gate"
  if [ ! -d landing ]; then
    echo "landing/ absent (maintainer-overlay surface) — landing gate is overlay-only; skipping."
  else
    node scripts/gen-ja-topic-pages.mjs
    node scripts/gen-ja-topic-pages.mjs
    node scripts/verify-en-landing.mjs
    if ! git diff --exit-code -- landing/; then
      echo "landing/ drifted — committed generated pages differ from regeneration." >&2
      exit 1
    fi
  fi

  step "verify: Verify preinstalled PyYAML"
  python3 -c "import yaml"

  step "verify: Release prep gate"
  bash scripts/test-release-prep.sh

  # DB comes online only now: the guard needs the event-model dist (built above), and no
  # earlier step touches a database. provision_db refuses production-port preset DSNs
  # (SEC-1) before the migrate below can apply branch migrations anywhere real.
  provision_db

  step "verify: Migrate up"
  pnpm --filter @actradeck/db run migrate:up

  step "verify: Test"
  pnpm run test

  step "verify: Assert real-DB INV actually RAN"
  rm -f /tmp/db-test.json
  rc=0
  pnpm --filter @actradeck/db exec vitest run --reporter=json --outputFile=/tmp/db-test.json || rc=$?
  RC=$rc node scripts/ci/assert-inv-ran.mjs /tmp/db-test.json --suite db

  step "verify: Assert backend real-DB INV actually RAN"
  rm -f /tmp/backend-test.json
  rc=0
  pnpm --filter @actradeck/backend exec vitest run --reporter=json --outputFile=/tmp/backend-test.json || rc=$?
  RC=$rc node scripts/ci/assert-inv-ran.mjs /tmp/backend-test.json --suite backend

  step "verify: Test (backend coverage gate)"
  pnpm --filter @actradeck/backend run test:coverage

  step "verify: Test (redaction coverage gate)"
  pnpm --filter @actradeck/redaction run test:coverage

  step "verify: Test (event-model coverage gate)"
  pnpm --filter @actradeck/event-model run test:coverage

  step "verify: Build backend (dist for sidecar e2e)"
  pnpm --filter @actradeck/backend run build

  step "verify: Test (sidecar coverage gate)"
  pnpm --filter @actradeck/sidecar run test:coverage

  step "verify: Assert egress e2e actually RAN"
  rm -f /tmp/sidecar-e2e.json
  rc=0
  pnpm --filter @actradeck/sidecar exec vitest run --reporter=json --outputFile=/tmp/sidecar-e2e.json || rc=$?
  RC=$rc node scripts/ci/assert-inv-ran.mjs /tmp/sidecar-e2e.json --suite sidecar-egress

  step "verify: Test (webui coverage gate)"
  pnpm --filter @actradeck/webui run test:coverage

  step "verify: Test (cli coverage gate)"
  pnpm --filter ./packages/cli run test:coverage

  step "verify: Build design-tokens"
  pnpm --filter @actradeck/design-tokens run build

  step "verify: Build (webui production build gate)"
  pnpm --filter @actradeck/webui run build

  step "verify: Boot smoke"
  ACTRADECK_WEBUI_DIST_DIR=.next pnpm --filter @actradeck/webui run smoke:boot
}

run_e2e_job() {
  # Install + workspace build already done by the verify job on this machine.
  step "e2e: E2E hook-replay"
  pnpm --filter @actradeck/sidecar run e2e:replay
}

run_migrations_job() {
  # up was already applied by verify; exercise rollback + idempotent re-apply like CI.
  step "migrations: Migrate down (rollback verification)"
  pnpm --filter @actradeck/db run migrate:down
  step "migrations: Migrate up again (idempotent re-apply)"
  pnpm --filter @actradeck/db run migrate:up
}

# --drift-check: run only the tripwire (used by scripts/test-ci-preflight.sh, which points
# PREFLIGHT_CI_YML at mutated copies of ci.yml to prove the tripwire is falsifiable).
if [ "${1:-}" = "--drift-check" ]; then
  CI_YML="${PREFLIGHT_CI_YML:-$CI_YML}"
  drift_check
  exit 0
fi

# --db-guard <url>: run only the SEC-1 production-port refusal (used by the metatest to
# prove the guard is falsifiable without running a full preflight). Needs the event-model
# dist, like the in-flow call.
if [ "${1:-}" = "--db-guard" ]; then
  preflight_db_guard "${2:?usage: ci-preflight.sh --db-guard <url>}"
  exit 0
fi

step "drift tripwire (ci.yml step-name parity)"
drift_check
# provision_db is NOT called here (SEC-R1-1): it runs inside run_verify_job, after the
# workspace build and right before the first DB touch (Migrate up), so the canonical db
# guard always has its dist — an early call would fail-closed on preset URLs in a fresh
# clone and start the container long before anything needs it.
run_verify_job
run_e2e_job
run_migrations_job

echo
echo "=== CI PREFLIGHT: ALL GREEN ==="
