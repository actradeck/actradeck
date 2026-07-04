#!/usr/bin/env bash
# =============================================================================
# scripts/version.sh — lockstep version stamper for the ActraDeck monorepo.
# =============================================================================
# Sets ONE version across the root package and every workspace (db / packages/* /
# apps/*), rolls the CHANGELOG's [Unreleased] section into a dated release section,
# and (optionally) creates a LOCAL annotated tag `vX.Y.Z`. It NEVER pushes anything
# — publishing is a separate, explicit step (git push / GitHub Release).
#
# Usage:
#   scripts/version.sh <X.Y.Z> [--no-tag] [--dry-run]
#
#   <X.Y.Z>      target semantic version (e.g. 0.1.0). Required.
#   --no-tag     stamp files + CHANGELOG but do NOT create the git tag.
#   --dry-run    print the plan and change NOTHING (no files, no tag).
#
# Why lockstep (ADR 0013 / decision 019f2bc1): ActraDeck ships as ONE unit (4 tiers
# + embedded PG); a single version across every package.json keeps the release
# tarball, SBOM, and tag mutually consistent. INV-RELEASE-VERSION-SINGLE-SOURCE and
# INV-RELEASE-TAG-MATCHES-VERSION enforce this.
#
# The public repo used only for CHANGELOG link refs is name-agnostic (env override).
set -euo pipefail

# TDA-3 sync point: the canonical default is OSS_DEFAULT_REPO in scripts/lib/oss-patterns.sh.
# version.sh SHIPS to the public mirror where that lib is NOT present, so it cannot source it;
# the literal "actradeck/actradeck" is duplicated here as a last-resort fallback. If the
# canonical default changes, update BOTH oss-patterns.sh AND this literal (or set the env).
RELEASE_REPO="${ACTRADECK_RELEASE_REPO:-${OSS_DEFAULT_REPO:-actradeck/actradeck}}"

say()  { printf '\033[0;34m[version]\033[0m %s\n' "$*"; }
ok()   { printf '\033[0;32m[version]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[version]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[0;31m[version] %s\033[0m\n' "$*" >&2; exit 1; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- args --------------------------------------------------------------------
VERSION=""
NO_TAG=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --no-tag)  NO_TAG=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*)        die "Unknown option: $arg" ;;
    *)         [ -z "$VERSION" ] || die "Unexpected extra argument: $arg"; VERSION="$arg" ;;
  esac
done

[ -n "$VERSION" ] || die "Version argument required. Usage: scripts/version.sh <X.Y.Z> [--no-tag] [--dry-run]"

# --- semver validate (X.Y.Z core; optional -prerelease / +build per SemVer) ---
SEMVER_RE='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'
[[ "$VERSION" =~ $SEMVER_RE ]] || die "'$VERSION' is not a valid semantic version (expected X.Y.Z, e.g. 0.1.0)."

TAG="v$VERSION"

command -v jq >/dev/null 2>&1 || die "jq is required."

# --- collect every workspace package.json (root + db + packages/* + apps/*) ---
PKGS=("$ROOT/package.json")
for d in "$ROOT/db" "$ROOT"/packages/* "$ROOT"/apps/*; do
  [ -f "$d/package.json" ] && PKGS+=("$d/package.json")
done

CURRENT="$(jq -r '.version // "0.0.0"' "$ROOT/package.json")"
say "Current root version: $CURRENT  ->  target: $VERSION  (tag: $TAG, packages: ${#PKGS[@]})"

# Idempotency: re-stamping the SAME version is a hard error (a second run would roll
# the CHANGELOG a second time). Bumping to a NEW version is always allowed.
if [ "$CURRENT" = "$VERSION" ]; then
  die "Root is already at $VERSION — refusing to re-stamp (would double-roll CHANGELOG). Nothing to do."
fi

# Tag must not already exist (would be a no-op / confusing). Only checked when tagging.
if [ "$NO_TAG" = 0 ] && git -C "$ROOT" rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1; then
  die "Tag $TAG already exists. Delete it first or pass --no-tag."
fi

CHANGELOG="$ROOT/CHANGELOG.md"
[ -f "$CHANGELOG" ] || die "CHANGELOG.md not found at repo root."
grep -q '^## \[Unreleased\]' "$CHANGELOG" || die "CHANGELOG.md has no '## [Unreleased]' section to roll."

DATE="$(date -u +%Y-%m-%d)"

if [ "$DRY_RUN" = 1 ]; then
  say "DRY RUN — no files changed, no tag created. Would:"
  for pj in "${PKGS[@]}"; do say "  set version -> $VERSION in ${pj#"$ROOT"/}"; done
  say "  roll CHANGELOG '[Unreleased]' -> '## [$VERSION] - $DATE'"
  [ "$NO_TAG" = 0 ] && say "  create local annotated tag $TAG (no push)" || say "  (skip tag: --no-tag)"
  exit 0
fi

# --- 1. stamp every package.json (surgical: only the top-level version value) ---
# A line-anchored perl replace changes ONLY the version STRING, preserving every
# other byte of formatting (so `prettier --check` still passes). `^\s*"version":`
# matches the indented top-level key; the $done guard replaces the FIRST match only,
# so a nested "version": inside some object could never be touched.
for pj in "${PKGS[@]}"; do
  perl -i -pe 'if(!$d && s/^(\s*"version":\s*")[^"]*(")/${1}'"$VERSION"'${2}/){$d=1}' "$pj"
  got="$(jq -r '.version' "$pj")"
  [ "$got" = "$VERSION" ] || die "Failed to stamp $pj (got '$got', wanted '$VERSION')."
done
ok "Stamped $VERSION across ${#PKGS[@]} package.json files."

# --- 2. roll the CHANGELOG ----------------------------------------------------
# One awk pass: (a) insert a dated release header right after '## [Unreleased]'
# (keeping the Unreleased header for the next cycle — everything that was under it
# now lives under the new version header); (b) rewrite the '[Unreleased]:' link ref
# to compare-since-tag and append a '[X.Y.Z]:' release link right after it. The
# CURRENT==VERSION die above guarantees this version is new, so the link is added once.
tmp="$(mktemp)"
repo_url="https://github.com/${RELEASE_REPO}"
awk -v ver="$VERSION" -v date="$DATE" -v tag="$TAG" -v url="$repo_url" '
  /^## \[Unreleased\]/ && !hdr {
    print; print ""; print "## [" ver "] - " date
    hdr=1; next
  }
  /^\[Unreleased\]:/ && !lnk {
    print "[Unreleased]: " url "/compare/" tag "...HEAD"
    print "[" ver "]: " url "/releases/tag/" tag
    lnk=1; next
  }
  { print }
  END {
    if (!lnk) {
      print ""
      print "[Unreleased]: " url "/compare/" tag "...HEAD"
      print "[" ver "]: " url "/releases/tag/" tag
    }
  }
' "$CHANGELOG" > "$tmp"

mv "$tmp" "$CHANGELOG"
ok "Rolled CHANGELOG: '[Unreleased]' -> '[$VERSION] - $DATE'."

# --- 3. local annotated tag (never pushed) -----------------------------------
if [ "$NO_TAG" = 0 ]; then
  git -C "$ROOT" tag -a "$TAG" -m "ActraDeck $TAG"
  ok "Created local annotated tag $TAG (NOT pushed)."
  say "Publish it deliberately when ready:  git push origin $TAG   (or via scripts/sync-oss.sh OSS_SYNC_TAGS=1)"
else
  say "Skipped tag creation (--no-tag). Files + CHANGELOG stamped to $VERSION."
fi

ok "Done. Review 'git diff', commit, then tag/publish as a separate step."
