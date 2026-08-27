#!/usr/bin/env bash
# =============================================================================
# scripts/gen-thirdparty-licenses.sh — (re)generate THIRDPARTY_LICENSES.md
# =============================================================================
# Writes the third-party attribution inventory from `pnpm licenses list --json`
# (the FULL workspace dependency graph, development tooling included — this is
# the attribution list, not the shipped closure; the production-only closure is
# the CycloneDX SBOM from scripts/lib/sbom.sh attached to every release).
#
# It replaces the generator that lived in the retired private mirror tooling
# (scripts/prepare-oss.sh, gone at the canonical cutover), so the file has a
# regeneration path inside the public tree again. scripts/test-release-prep.sh
# runs `--check` as a drift tripwire (INV-THIRDPARTY-LICENSES-CURRENT).
#
# NO-RAW by construction: only {license, name, versions} are projected out of
# the pnpm output. `paths` (absolute node_modules locations), homepage, author
# and description are never propagated (same rule as scripts/lib/sbom.sh).
#
# Determinism: `pnpm licenses` enumerates the INSTALLED store, so packages with
# `os`/`cpu` constraints appear for the install platform only. The committed
# file is the linux-x64 view (the CI regime); the drift check is therefore only
# meaningful on linux-x64 — test-release-prep.sh skips it elsewhere.
#
# Usage:
#   scripts/gen-thirdparty-licenses.sh            # rewrite THIRDPARTY_LICENSES.md
#   scripts/gen-thirdparty-licenses.sh --check    # exit 1 if the file is stale
#   scripts/gen-thirdparty-licenses.sh --stdout   # print the would-be content
#
# Requires jq + pnpm and an installed workspace (`pnpm install`). Exit codes:
#   0 written / current, 1 stale (--check), 2 usage, 3 toolchain missing,
#   4 pnpm licenses failed (deps not installed?), 5 projection failed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${THIRDPARTY_LICENSES_FILE:-$ROOT/THIRDPARTY_LICENSES.md}"   # override is for test-release-prep.sh probes only
MODE="write"
case "${1:-}" in
  "") ;;
  --check)  MODE="check" ;;
  --stdout) MODE="stdout" ;;
  -h|--help) sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "gen-thirdparty-licenses: unknown option: $1" >&2; exit 2 ;;
esac

command -v jq   >/dev/null 2>&1 || { echo "gen-thirdparty-licenses: jq is required" >&2; exit 3; }
command -v pnpm >/dev/null 2>&1 || { echo "gen-thirdparty-licenses: pnpm is required" >&2; exit 3; }
[ -f "$ROOT/package.json" ] || { echo "gen-thirdparty-licenses: no package.json at $ROOT" >&2; exit 3; }

raw="$(pnpm -C "$ROOT" licenses list --json 2>/dev/null)" || {
  echo "gen-thirdparty-licenses: 'pnpm licenses list --json' failed (deps not installed? run 'pnpm install')" >&2
  exit 4
}
[ -n "$raw" ] || { echo "gen-thirdparty-licenses: empty license output" >&2; exit 4; }

# One row per package: "| <license> | <name> | <v1, v2, ...> |", sorted by license
# expression then package name (byte order — the historical table order).
rows="$(printf '%s' "$raw" | jq -r '
  [ to_entries[] as $e
    | $e.value[]
    | { l: (.license // "NOASSERTION"),
        n: .name,
        v: ((.versions // ([.version] | map(select(. != null)))) | join(", ")) }
  ] | sort_by(.l, .n) | .[]
  | "| \(.l) | \(.n) | \(.v) |"
')" || { echo "gen-thirdparty-licenses: jq projection failed" >&2; exit 5; }
[ -n "$rows" ] || { echo "gen-thirdparty-licenses: projection produced no rows" >&2; exit 5; }

content="$(cat <<HEADER
# Third-Party Licenses

ActraDeck depends on the open-source packages below. This file is generated
by \`scripts/gen-thirdparty-licenses.sh\` from \`pnpm licenses list --json\` (the
full workspace dependency inventory, development tooling included, as installed
on linux-x64). Regenerate after any dependency change — \`scripts/test-release-prep.sh\`
fails when it drifts from the lockfile. The production-only closure that ships is
the CycloneDX SBOM attached to each release (\`scripts/lib/sbom.sh\`).

| License | Package | Version |
|---|---|---|
$rows
HEADER
)"

case "$MODE" in
  stdout)
    printf '%s\n' "$content"
    ;;
  check)
    if [ ! -f "$OUT" ]; then
      echo "gen-thirdparty-licenses: $OUT is missing — run scripts/gen-thirdparty-licenses.sh" >&2
      exit 1
    fi
    if diff -u "$OUT" <(printf '%s\n' "$content") >&2; then
      echo "gen-thirdparty-licenses: THIRDPARTY_LICENSES.md is current ($(printf '%s\n' "$rows" | wc -l | tr -d ' ') packages)"
    else
      echo "gen-thirdparty-licenses: THIRDPARTY_LICENSES.md is STALE — run scripts/gen-thirdparty-licenses.sh and commit the result" >&2
      exit 1
    fi
    ;;
  write)
    printf '%s\n' "$content" > "$OUT"
    echo "gen-thirdparty-licenses: wrote $(printf '%s\n' "$rows" | wc -l | tr -d ' ') packages -> $OUT"
    ;;
esac
