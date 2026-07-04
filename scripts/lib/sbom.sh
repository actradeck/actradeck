#!/usr/bin/env bash
# =============================================================================
# scripts/lib/sbom.sh — single source of truth for CycloneDX SBOM generation.
# =============================================================================
# Shared by scripts/prepare-oss.sh (writes ./oss/sbom.cdx.json into the curated
# mirror) AND .github/workflows/release.yml (regenerates + attaches it to a signed
# GitHub Release). Keeping generation in ONE function prevents the two call sites
# from drifting (security-gate-reuse-canonical-parser). Because release.yml runs
# INSIDE the published mirror, this lib is PUBLIC-SAFE by construction and DOES ship
# to the mirror (unlike oss-patterns.sh, which carries private coupling literals and
# is intentionally excluded) — see .ossfilter.
#
# Design constraints (ADR 0013 / decision 019f2bc1):
#   - PRODUCTION dependencies only (dev deps excluded): `pnpm licenses --prod`.
#   - NO-RAW by construction: only {name, version, license} are copied out of the
#     pnpm output. Absolute node_modules `paths`, homepage/author/description (which
#     could carry URLs) are NEVER propagated into the SBOM. A generic self-scan
#     (sbom_scan_noraw) is a second, defense-in-depth net.
#
# This file uses bash (arrays / process substitution) — it is a build/release tool,
# not runtime code. jq is required (already a prepare-oss / CI prerequisite).
# =============================================================================

# sbom_generate <project_root> <out_file>
#   Generate a CycloneDX 1.5 JSON SBOM of the PRODUCTION dependency closure of the
#   pnpm workspace rooted at <project_root>, writing it to <out_file>.
#   Returns non-zero (and writes nothing) if the toolchain is unavailable or the
#   dependency scan fails — a stub/empty SBOM is worse than none for a security
#   artifact, so callers should treat failure as fatal.
sbom_generate() {
  local root="$1" out="$2"
  command -v jq >/dev/null 2>&1   || { echo "sbom: jq is required" >&2; return 3; }
  command -v pnpm >/dev/null 2>&1 || { echo "sbom: pnpm is required" >&2; return 3; }
  [ -f "$root/package.json" ]     || { echo "sbom: no package.json at $root" >&2; return 3; }

  local rootname rootver
  rootname="$(jq -r '.name // "actradeck"' "$root/package.json")"
  rootver="$(jq -r '.version // "0.0.0"' "$root/package.json")"

  # Raw production license inventory. `--prod` restricts to the production graph
  # (dev tooling — vitest/eslint/typescript/prettier — is excluded). Requires an
  # installed store (node_modules/.pnpm); callers install first.
  local raw
  if ! raw="$(pnpm -C "$root" licenses list --prod --json 2>/dev/null)"; then
    echo "sbom: 'pnpm licenses list --prod --json' failed (deps not installed?)" >&2
    return 4
  fi
  [ -n "$raw" ] || { echo "sbom: empty license output" >&2; return 4; }

  local ts; ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  # Project ONLY name/version/license into components; one component per (name,version).
  # purl percent-encodes the scope '@' per the purl spec (pkg:npm/%40scope/name@ver).
  # license goes into `name` (free text) so non-SPDX expressions never fail validation.
  local components
  components="$(printf '%s' "$raw" | jq '
    [ to_entries[] as $e
      | $e.value[]
      | . as $p
      | ( ($p.versions // ([$p.version] | map(select(. != null))) // ["unknown"]) )[]
      | { "type": "library",
          "name": $p.name,
          "version": .,
          "purl": ("pkg:npm/" + ($p.name | gsub("@"; "%40")) + "@" + .),
          "licenses": [ { "license": { "name": ($p.license // "NOASSERTION") } } ] }
    ] | sort_by(.name, .version)
  ')" || { echo "sbom: jq projection failed" >&2; return 5; }

  jq -n \
    --arg ts "$ts" --arg rn "$rootname" --arg rv "$rootver" \
    --argjson comps "$components" '
    {
      "bomFormat": "CycloneDX",
      "specVersion": "1.5",
      "version": 1,
      "metadata": {
        "timestamp": $ts,
        "tools": [ { "vendor": "ActraDeck", "name": "scripts/lib/sbom.sh" } ],
        "component": {
          "type": "application",
          "bom-ref": ($rn + "@" + $rv),
          "name": $rn,
          "version": $rv
        }
      },
      "components": $comps
    }' > "$out" || { echo "sbom: failed to assemble BOM" >&2; return 5; }

  echo "sbom: wrote $(printf '%s' "$components" | jq 'length') production components -> $out" >&2
  return 0
}

# sbom_scan_noraw <file>
#   Generic, PUBLIC-SAFE defense-in-depth scan of a generated artifact (SBOM or any
#   text file) for raw content that must never ship: absolute home/user paths, pnpm
#   store paths, and generic secret shapes. Returns non-zero (printing matches) if
#   anything is found. This carries NO private-specific literals — prepare-oss ALSO
#   applies the canonical private coupling scan (from the unshipped oss-patterns lib)
#   in the private build context, which is intentionally not shipped to the mirror.
sbom_scan_noraw() {
  local file="$1"
  [ -f "$file" ] || { echo "sbom-scan: no such file: $file" >&2; return 2; }
  # Absolute filesystem paths that would leak the build machine's layout.
  local path_re='(/home/[A-Za-z0-9._-]+/|/Users/[A-Za-z0-9._-]+/|/root/|node_modules/\.pnpm/)'
  # Generic secret shapes (public-safe — same families as gitleaks / oss-patterns.sh's
  # OSS_SECRET_RE). No private-coupling literals. Kept at PARITY with the canonical lib so
  # the mirror-side SBOM scan is not weaker than the private prepare-oss scan (SEC-2).
  local secret_re='-----BEGIN [A-Z ]*PRIVATE KEY-----'
  secret_re="$secret_re"'|ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|ghs_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50,}'
  secret_re="$secret_re"'|AKIA[0-9A-Z]{16}|sk-ant-[A-Za-z0-9-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}'
  secret_re="$secret_re"'|AIza[0-9A-Za-z_-]{35}'
  secret_re="$secret_re"'|hooks\.slack\.com/services/[A-Za-z0-9]+/[A-Za-z0-9]+/[A-Za-z0-9]+'
  secret_re="$secret_re"'|discord(app)?\.com/api/webhooks/[0-9]+/[A-Za-z0-9_-]+'
  secret_re="$secret_re"'|"type"[[:space:]]*:[[:space:]]*"service_account"|"private_key_id"[[:space:]]*:'
  secret_re="$secret_re"'|(postgres|postgresql|mysql|mongodb|redis|amqp)://[^:@/[:space:]]+:[^@/[:space:]]+@'

  local out rc=0
  out="$(grep -IEn -e "$path_re" -e "$secret_re" "$file" 2>&1)" || rc=$?
  # grep rc: 0=match(leak), 1=clean, >=2=error (treat as HARD FAIL so a broken scan
  # can never silently report clean — mirrors prepare-oss dead-gate guard).
  if [ "$rc" -ge 2 ]; then
    echo "sbom-scan: grep error (rc=$rc) — gate inconclusive: $(printf '%s' "$out" | head -1)" >&2
    return 2
  fi
  if [ -n "$out" ]; then
    echo "sbom-scan: raw content detected in $file:" >&2
    printf '%s\n' "$out" | head -10 >&2
    return 1
  fi
  return 0
}
