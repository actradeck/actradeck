#!/usr/bin/env bash
# =============================================================================
# scan-image-fs.sh — single source of truth for the CONTAINER-IMAGE filesystem leak scan
# =============================================================================
# Sourced by BOTH .github/workflows/release.yml (before the GHCR push) AND
# .github/workflows/ci.yml (the docker-image-scan job) so the two can never drift
# (R3-L1 — the ~40-line scan block was hand-copied and had already cosmetically diverged).
#
# THIS IS THE AUTHORITATIVE image leak gate (R3 structural remediation): it builds nothing,
# but it EXPORTS a real image's filesystem and fails closed on any leak. The config-checkers
# in scripts/test-release-prep.sh (INV-DOCKER-*) are only SECONDARY — they assert that the
# workflows WIRE this scan in correctly (present, before push, not disabled/no-op). A hole in
# a config-checker cannot ship a leak on its own, because any change to image CONTENT
# (apps/**, packages/**, db/**, root package.json, the Dockerfile) re-fires this real scan in
# CI (see ci.yml's docker-image-scan paths filter).
#
# This lib is PUBLIC-SAFE (it carries no coupling literals — it only *references* the private
# OSS_SECRET_RE / OSS_COUPLING_RE by name), so it SHIPS to the mirror (.ossfilter allowlists
# it alongside sbom.sh). The private oss-patterns.sh does NOT ship; like every other consumer
# we source it only when present and otherwise fall back to the forbidden-file floor.
# =============================================================================

# Forbidden internal files — the SINGLE definition (was duplicated 5x across the workflows).
# These are OUR internal files that must never appear in a shipped image.
SCAN_IMAGE_FORBIDDEN_NAMES=(.env .mcp.json CLAUDE.md AGENTS.md plan.md .claude)

# scan_image_fs <image_ref> [scripts_lib_dir]
#   Export the image filesystem and RETURN NON-ZERO on any leak:
#     (a) a forbidden internal file anywhere in the /app tree (node_modules PRUNED — it is
#         the public dependency closure and some third-party packages legitimately ship a
#         `.claude/` dir, e.g. nanoid / thread-stream), OR
#     (b) a secret / private-coupling literal in the /app layers (node_modules EXCLUDED for
#         the same reason + to avoid false positives from third-party fixtures).
#   node_modules scope matches the release tarball scan (which scans the git tree, sans deps).
#   Returns 0 when the image is clean. The caller's `set -e` turns a non-zero into a job fail.
scan_image_fs() {
  local ref="$1" libdir="${2:-scripts/lib}"
  local fs cid rc
  fs="$(mktemp -d)"
  if ! cid="$(docker create "$ref")"; then
    echo "::error::scan_image_fs: docker create '$ref' failed" >&2
    rm -rf "$fs"
    return 1
  fi
  docker export "$cid" | tar -x -C "$fs"

  # Run the actual checks in a subshell so an `exit 1` unwinds to a captured rc, then clean up
  # the container + extracted tree unconditionally (no leaked tmp dirs, no dangling container).
  (
    set -euo pipefail
    app="$fs/app"

    echo "== (a) no forbidden internal file in the image app tree =="
    # R4-L5: build the find name-predicate FROM the single-source array (no drift trap — the
    # array is now the ONLY place the forbidden set is defined).
    nameargs=()
    for n in "${SCAN_IMAGE_FORBIDDEN_NAMES[@]}"; do nameargs+=(-name "$n" -o); done
    unset 'nameargs[${#nameargs[@]}-1]'   # drop the trailing -o
    if find "$app" -path '*/node_modules/*' -prune -o \( "${nameargs[@]}" \) -print 2>/dev/null | grep -a .; then
      echo "::error::forbidden internal file present in the image filesystem" >&2
      exit 1
    fi
    echo "ok: no forbidden internal files"

    echo "== (b) no secret / private-coupling literal in the image app layers =="
    if [ -f "$libdir/oss-patterns.sh" ]; then
      # shellcheck source=scripts/lib/oss-patterns.sh
      . "$libdir/oss-patterns.sh"
      # Capture (no `heavy | grep -q` pipe) and treat grep rc>=2 as a HARD error — oss-patterns
      # documents that a missing `-e` / broken regex otherwise silently reports "no match".
      set +e
      hits="$(grep -rIEn --exclude-dir=node_modules -e "$OSS_SECRET_RE" -e "$OSS_COUPLING_RE" "$app" 2>/dev/null)"
      grc=$?
      set -e
      if [ "$grc" -ge 2 ]; then
        echo "::error::image leak scan grep errored (rc=$grc)" >&2
        exit 1
      fi
      if [ -n "$hits" ]; then
        echo "::error::secret/coupling literal present in the image app layers" >&2
        printf '%s\n' "$hits" | head -20 >&2
        exit 1
      fi
      echo "ok: image app layers carry no secret/coupling literal (full scan)"
    else
      echo "ok: oss-patterns.sh absent (sanitized mirror) — forbidden-file floor applies; coupling was scanned at prepare-oss"
    fi
  )
  rc=$?

  docker rm -f "$cid" >/dev/null 2>&1 || true
  rm -rf "$fs"
  return "$rc"
}
