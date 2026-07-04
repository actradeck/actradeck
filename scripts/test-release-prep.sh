#!/usr/bin/env bash
#
# test-release-prep.sh — falsifiability meta-tests for the release / supply-chain gate
# (ADR 0013 / decision 019f2bc1). Each invariant is asserted GREEN on the real tree,
# then a controlled mutation is injected and the gate is asserted RED. A gate that
# cannot be made to fail is dead.
#
# Conventions (mirrors scripts/test-oss-prep.sh): capture command output with
# out="$(cmd)" and match with printf '%s' "$out" | grep, NEVER `heavy | grep -q` (the
# pipefail x SIGPIPE inversion makes the latter a false PASS on match).
#
# This script SHIPS in the public mirror (release.yml / version.sh / sbom.sh are public
# infra). It self-adapts: the tarball leak test builds a mirror via scripts/prepare-oss.sh
# when that private tooling is present, and otherwise scans `git archive HEAD` directly
# (the mirror tree is already sanitized). Injection vectors use `/home/tester/` — NOT the
# maintainer path — so the shipped file itself carries no coupling/secret literal.
#
# QA-4 caveat: INV-TARBALL-NO-LEAK assumes the git origin is a GitHub remote. With a
# local-path origin (e.g. file:// clone), prepare-oss's private-repo-ref rewrite/scan is a
# no-op, so a would-be private ref would go unrewritten — but the gate errs fail-closed
# (a spurious RED at most, never a spurious PASS), so the assumption is safe-side.
#
# Usage: ./scripts/test-release-prep.sh   (exit 0 = all PASS / exit 1 = a gate is dead)
set -uo pipefail

SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SELF/.." && pwd)"
fail=0
ok() { printf 'PASS  %s\n' "$1"; }
ng() { printf 'FAIL  %s\n' "$1"; fail=1; }

# shellcheck source=lib/sbom.sh
. "$SELF/lib/sbom.sh"

WORK="$(mktemp -d /tmp/release-prep-test-XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

command -v jq >/dev/null 2>&1 || { ng "jq is required for the release-prep tests"; exit 1; }

# ============================================================================
# Checkers under test (pure; operate on a given tree/file)
# ============================================================================

# every workspace package.json version === root version
versions_consistent() {
  local r="$1" rootv f pv
  rootv="$(jq -r '.version' "$r/package.json" 2>/dev/null)"
  for f in "$r/package.json" "$r"/db/package.json "$r"/packages/*/package.json "$r"/apps/*/package.json; do
    [ -f "$f" ] || continue
    pv="$(jq -r '.version' "$f" 2>/dev/null)"
    [ "$pv" = "$rootv" ] || { echo "version mismatch: $f = $pv (root $rootv)"; return 1; }
  done
  return 0
}

# a tag matching the root version exists in repo <r>
tag_matches_version() {
  local r="$1" v
  v="$(jq -r '.version' "$r/package.json" 2>/dev/null)"
  git -C "$r" rev-parse -q --verify "refs/tags/v$v" >/dev/null 2>&1
}

# SBOM component names ⊇ every direct EXTERNAL prod dep of the workspace
sbom_covers_prod_deps() {
  local sbom="$1" r="$2" miss=0 dep comps deps
  comps="$(jq -r '.components[].name' "$sbom" 2>/dev/null | sort -u)"
  deps="$(cat "$r"/package.json "$r"/db/package.json "$r"/packages/*/package.json "$r"/apps/*/package.json 2>/dev/null \
          | jq -rs '[.[].dependencies // {} | keys[]] | unique | .[]' 2>/dev/null | grep -v '^@actradeck/')"
  while IFS= read -r dep; do
    [ -n "$dep" ] || continue
    # QA-3: membership via a captured newline-delimited set (no `heavy | grep -q` pipe —
    # this file's own convention avoids the pipefail x SIGPIPE inversion class). Package
    # names contain no glob metacharacters, so the case-glob match is exact.
    case $'\n'"$comps"$'\n' in
      *$'\n'"$dep"$'\n'*) : ;;
      *) echo "SBOM missing prod dep: $dep"; miss=1 ;;
    esac
  done <<< "$deps"
  return "$miss"
}

# no forbidden internal file, and no MAINTAINER coupling string, in an extracted tree <d>.
# NOTE: a generic '/home/<user>/' scan is deliberately NOT used — the mirror legitimately
# ships many SYNTHETIC example paths (/home/user, /home/me, /home/x) in test fixtures and
# the demo cast. The real leak concern is the maintainer's own path/handle, caught by the
# canonical maintainer-coupling scan (maintainer home path, project id, handle, …). That
# lib is private (unshipped); in the mirror the tree is already sanitized by prepare-oss and the
# forbidden-files check remains the last line of defense.
tarball_no_leak() {
  local d="$1" bad=0 out
  out="$(cd "$d" && find . \( -name '.env' -o -name '.mcp.json' -o -name 'CLAUDE.md' \
           -o -name 'AGENTS.md' -o -name 'plan.md' -o -name '.claude' \) -print 2>/dev/null)"
  [ -n "$out" ] && { echo "forbidden internal path(s): $out"; bad=1; }
  if [ -f "$SELF/lib/oss-patterns.sh" ]; then
    # shellcheck source=lib/oss-patterns.sh
    . "$SELF/lib/oss-patterns.sh"
    out="$(grep -rIEn -e "$OSS_COUPLING_RE" "$d" 2>/dev/null)" || true
    [ -n "$out" ] && { echo "maintainer coupling string leaked: $(printf '%s' "$out" | head -1)"; bad=1; }
  fi
  return "$bad"
}

# release.yml has top-level permissions == {contents: read}; write is job-scoped only
perms_minimal() {
  python3 - "$1" <<'PY'
import sys, yaml
d = yaml.safe_load(open(sys.argv[1]))
top = d.get("permissions")
if top != {"contents": "read"}:
    print("top-level permissions not minimal:", top); sys.exit(1)
# QA-2: a job may hold WRITE only if it is the signing/release job, identified
# structurally by declaring id-token:write AND attestations:write (name-agnostic). Any
# OTHER job carrying a write scope (e.g. an injected `packages: write` on verify) FAILS.
for name, job in (d.get("jobs") or {}).items():
    jp = job.get("permissions") or {}
    writes = [k for k, v in jp.items() if v == "write"]
    if writes:
        is_signing = jp.get("id-token") == "write" and jp.get("attestations") == "write"
        if not is_signing:
            print(f"job '{name}' holds write {writes} but is not the signing job"); sys.exit(1)
sys.exit(0)
PY
}

# invoke install.sh's pure verify helpers in an isolated subshell (no network)
inst() { ( ACTRADECK_INSTALL_SOURCE_ONLY=1 . "$SELF/install.sh"; "$@" ); }

# ============================================================================
# INV-RELEASE-VERSION-SINGLE-SOURCE
# ============================================================================
if versions_consistent "$ROOT" >/dev/null 2>&1; then
  ok "INV-VERSION-SINGLE-SOURCE: all workspace package.json versions match root"
else
  ng "INV-VERSION-SINGLE-SOURCE: live tree versions already inconsistent"
fi
# RED: copy the package.json set, flip ONE, assert the checker fails.
VT="$WORK/vtree"; mkdir -p "$VT"
( cd "$ROOT" && find . -maxdepth 3 -name package.json \
    -not -path './node_modules/*' -not -path '*/node_modules/*' \
    -exec cp --parents {} "$VT/" \; ) 2>/dev/null
tmp="$(jq '.version="9.9.9"' "$VT/apps/backend/package.json")"; printf '%s\n' "$tmp" > "$VT/apps/backend/package.json"
if versions_consistent "$VT" >/dev/null 2>&1; then
  ng "INV-VERSION-SINGLE-SOURCE: DEAD GATE — mismatched version still passed"
else
  ok "INV-VERSION-SINGLE-SOURCE: gate FAILS when one package.json diverges (falsifiable)"
fi

# ============================================================================
# INV-RELEASE-TAG-MATCHES-VERSION  (run version.sh in an isolated throwaway repo)
# ============================================================================
VR="$WORK/vrepo"
mkdir -p "$VR/scripts/lib" "$VR/db" "$VR/packages/p1" "$VR/apps/a1"
cp "$SELF/version.sh" "$VR/scripts/version.sh"
for d in . db packages/p1 apps/a1; do
  printf '{\n  "name": "x",\n  "version": "0.0.0",\n  "private": true\n}\n' > "$VR/$d/package.json"
done
printf '# Changelog\n\n## [Unreleased]\n\n- seed\n\n[Unreleased]: https://example/commits/main\n' > "$VR/CHANGELOG.md"
git -C "$VR" init -q
git -C "$VR" config user.email test@example.invalid
git -C "$VR" config user.name  test
git -C "$VR" add -A && git -C "$VR" commit -qm init
if "$VR/scripts/version.sh" 0.2.0 >"$WORK/version.log" 2>&1; then
  if versions_consistent "$VR" >/dev/null 2>&1 && tag_matches_version "$VR"; then
    ok "INV-TAG-MATCHES-VERSION: version.sh stamped 0.2.0 lockstep AND created tag v0.2.0"
  else
    ng "INV-TAG-MATCHES-VERSION: version.sh ran but tag/version disagree (see $WORK/version.log)"
  fi
else
  ng "INV-TAG-MATCHES-VERSION: version.sh failed in isolated repo (see $WORK/version.log)"
fi
# RED: bump the version WITHOUT a matching tag -> the checker must fail.
tmp="$(jq '.version="0.3.0"' "$VR/package.json")"; printf '%s\n' "$tmp" > "$VR/package.json"
if tag_matches_version "$VR"; then
  ng "INV-TAG-MATCHES-VERSION: DEAD GATE — no v0.3.0 tag yet still matched"
else
  ok "INV-TAG-MATCHES-VERSION: gate FAILS when version has no matching tag (falsifiable)"
fi

# ============================================================================
# INV-SBOM-COVERS-PROD-DEPS  +  INV-SBOM-NO-RAW
# ============================================================================
SBOM="$WORK/sbom.cdx.json"
if sbom_generate "$ROOT" "$SBOM" 2>/dev/null && [ -s "$SBOM" ]; then
  ok "SBOM generated ($(jq '.components|length' "$SBOM") components) for coverage/no-raw checks"

  if sbom_covers_prod_deps "$SBOM" "$ROOT" >/dev/null 2>&1; then
    ok "INV-SBOM-COVERS-PROD-DEPS: SBOM covers every direct external prod dependency"
  else
    ng "INV-SBOM-COVERS-PROD-DEPS: SBOM is missing a prod dependency"
  fi
  # RED: drop a known prod dep (fastify) from the SBOM -> coverage must fail.
  jq '(.components) |= map(select(.name != "fastify"))' "$SBOM" > "$WORK/sbom.mut.json"
  if sbom_covers_prod_deps "$WORK/sbom.mut.json" "$ROOT" >/dev/null 2>&1; then
    ng "INV-SBOM-COVERS-PROD-DEPS: DEAD GATE — dropping fastify still passed"
  else
    ok "INV-SBOM-COVERS-PROD-DEPS: gate FAILS when a prod dep is dropped (falsifiable)"
  fi

  if sbom_scan_noraw "$SBOM" >/dev/null 2>&1; then
    ok "INV-SBOM-NO-RAW: generated SBOM carries no absolute path / secret shape"
  else
    ng "INV-SBOM-NO-RAW: generated SBOM tripped the NO-RAW scan"
  fi
  # RED: inject an absolute machine path into a component (not the maintainer path).
  jq '.components += [{"type":"library","name":"planted","version":"0","evidence":"/home/tester/leak/x"}]' \
     "$SBOM" > "$WORK/sbom.raw.json"
  if sbom_scan_noraw "$WORK/sbom.raw.json" >/dev/null 2>&1; then
    ng "INV-SBOM-NO-RAW: DEAD GATE — injected absolute path still passed"
  else
    ok "INV-SBOM-NO-RAW: gate FAILS on an injected absolute path (falsifiable)"
  fi
else
  ng "SBOM generation failed (need installed prod deps: run 'pnpm install') — coverage/no-raw untested"
fi

# ============================================================================
# INV-RELEASE-TARBALL-NO-LEAK
# ============================================================================
REL_TREE="$WORK/reltree"; mkdir -p "$REL_TREE"
if [ -f "$ROOT/scripts/prepare-oss.sh" ]; then
  # Private context: build the curated mirror from the CURRENT working tree (staged into
  # a throwaway index so uncommitted release changes are included), then scan it.
  IDX="$WORK/idx"; rm -f "$IDX"
  GIT_INDEX_FILE="$IDX" git -C "$ROOT" read-tree HEAD 2>/dev/null
  GIT_INDEX_FILE="$IDX" git -C "$ROOT" add -A 2>/dev/null
  TREE="$(GIT_INDEX_FILE="$IDX" git -C "$ROOT" write-tree 2>/dev/null)"
  if OSS_DIR="$REL_TREE" OSS_SOURCE_REF="$TREE" bash "$ROOT/scripts/prepare-oss.sh" >"$WORK/mirror.log" 2>&1; then
    : # mirror built
  else
    ng "INV-TARBALL-NO-LEAK: prepare-oss.sh failed to build a clean mirror (see $WORK/mirror.log)"
  fi
  SRC_DESC="curated mirror (prepare-oss.sh)"
else
  # Mirror context: the tree itself is sanitized; the release tarball is git archive HEAD.
  git -C "$ROOT" archive HEAD | tar -x -C "$REL_TREE"
  SRC_DESC="git archive HEAD (already-sanitized mirror)"
fi

if [ -n "$(ls -A "$REL_TREE" 2>/dev/null)" ]; then
  if tarball_no_leak "$REL_TREE" >/dev/null 2>&1; then
    ok "INV-TARBALL-NO-LEAK: release tree clean — $SRC_DESC"
  else
    ng "INV-TARBALL-NO-LEAK: release tree has a leak — $SRC_DESC"
  fi
  # TDA-1: the single-source SBOM lib MUST ship in the release tree (release.yml, which
  # runs inside the mirror, sources scripts/lib/sbom.sh to regenerate the SBOM). If it is
  # dropped by an .ossfilter regression, the mirror's release job breaks — pin it here.
  if [ -f "$REL_TREE/scripts/lib/sbom.sh" ]; then
    ok "INV-TARBALL-NO-LEAK: scripts/lib/sbom.sh ships in the release tree (release.yml can source it)"
  else
    ng "INV-TARBALL-NO-LEAK: scripts/lib/sbom.sh MISSING from release tree (.ossfilter regression — release.yml would break)"
  fi
  # RED (a): plant a forbidden internal file (works in both private and mirror mode).
  LK1="$WORK/leak1"; rm -rf "$LK1"; cp -a "$REL_TREE" "$LK1"; : > "$LK1/.env"
  if tarball_no_leak "$LK1" >/dev/null 2>&1; then
    ng "INV-TARBALL-NO-LEAK: DEAD GATE — planted .env still passed"
  else
    ok "INV-TARBALL-NO-LEAK: gate FAILS on a planted .env (falsifiable)"
  fi
  # RED (b): plant the MAINTAINER coupling path — only meaningful where the canonical
  # coupling lib is present (private). The vector is BUILT AT RUNTIME so this shipped
  # file carries no literal maintainer path. `H` holds "/home"; concatenation yields the
  # real coupling string only at execution time.
  if [ -f "$SELF/lib/oss-patterns.sh" ]; then
    LK2="$WORK/leak2"; rm -rf "$LK2"; cp -a "$REL_TREE" "$LK2"
    H="/home"; printf 'built at %s/%s/x\n' "$H" "owner" > "$LK2/README.leak.md"
    if tarball_no_leak "$LK2" >/dev/null 2>&1; then
      ng "INV-TARBALL-NO-LEAK: DEAD GATE — planted maintainer coupling path still passed"
    else
      ok "INV-TARBALL-NO-LEAK: gate FAILS on a planted maintainer coupling path (falsifiable)"
    fi
  fi
else
  ng "INV-TARBALL-NO-LEAK: could not materialize a release tree to scan"
fi

# ============================================================================
# INV-RELEASE-WORKFLOW-PERMS-MINIMAL
# ============================================================================
REL_YML="$ROOT/.github/workflows/release.yml"
if [ ! -f "$REL_YML" ]; then
  ng "INV-PERMS-MINIMAL: release.yml not found at $REL_YML"
elif ! command -v python3 >/dev/null 2>&1; then
  ng "INV-PERMS-MINIMAL: python3 required to parse the workflow"
else
  if perms_minimal "$REL_YML" >/dev/null 2>&1; then
    ok "INV-PERMS-MINIMAL: release.yml top-level permissions == {contents: read}"
  else
    ng "INV-PERMS-MINIMAL: release.yml top-level permissions are not minimal"
  fi
  # RED: promote a broad write to top-level -> the checker must fail.
  python3 - "$REL_YML" "$WORK/rel.mut.yml" <<'PY'
import sys, yaml
d = yaml.safe_load(open(sys.argv[1]))
d["permissions"] = {"contents": "write"}
yaml.safe_dump(d, open(sys.argv[2], "w"))
PY
  if perms_minimal "$WORK/rel.mut.yml" >/dev/null 2>&1; then
    ng "INV-PERMS-MINIMAL: DEAD GATE — top-level contents:write still passed"
  else
    ok "INV-PERMS-MINIMAL: gate FAILS on top-level write (falsifiable)"
  fi
  # RED (QA-2): grant write to a NON-signing job (inject `packages: write` on verify) ->
  # the negative assert must fail (only the id-token+attestations job may hold write).
  python3 - "$REL_YML" "$WORK/rel.job.mut.yml" <<'PY'
import sys, yaml
d = yaml.safe_load(open(sys.argv[1]))
jobs = d.get("jobs") or {}
# pick a non-release job (the first that isn't the signing job)
victim = next((n for n in jobs if n != "release"), None)
if victim is None:
    # no distinct job to mutate; write an obviously-bad file so the checker fails
    d["jobs"] = {"release": {}, "verify": {"permissions": {"packages": "write"}}}
else:
    jobs[victim]["permissions"] = {"packages": "write"}
yaml.safe_dump(d, open(sys.argv[2], "w"))
PY
  if perms_minimal "$WORK/rel.job.mut.yml" >/dev/null 2>&1; then
    ng "INV-PERMS-MINIMAL: DEAD GATE — write on a non-signing job still passed"
  else
    ok "INV-PERMS-MINIMAL: gate FAILS when a non-signing job holds write (falsifiable)"
  fi
fi

# ============================================================================
# INV-INSTALL-VERIFY-REJECTS-TAMPER  (pure digest path; gh not invoked)
# ============================================================================
ASSET="$WORK/asset.tar.gz"; printf 'verified actradeck payload\n' > "$ASSET"
GOOD="$(sha256sum "$ASSET" | cut -d' ' -f1)"
printf '%s  actradeck-0.1.0.tar.gz\n' "$GOOD" > "$WORK/checksums.txt"

# correct digest -> accept
if inst verify_sha256 "$ASSET" "$GOOD" >/dev/null 2>&1; then
  ok "INV-INSTALL-VERIFY: correct digest accepted"
else
  ng "INV-INSTALL-VERIFY: correct digest was rejected"
fi
# checksums lookup resolves
got="$(inst expected_digest_for "$WORK/checksums.txt" actradeck-0.1.0.tar.gz 2>/dev/null)"
[ "$got" = "$GOOD" ] && ok "INV-INSTALL-VERIFY: expected_digest_for resolves the asset digest" \
                      || ng "INV-INSTALL-VERIFY: expected_digest_for did not resolve the digest"
# 1-byte flip -> reject
printf 'verified actradeck payloadX\n' > "$ASSET"
if inst verify_sha256 "$ASSET" "$GOOD" >/dev/null 2>&1; then
  ng "INV-INSTALL-VERIFY: DEAD GATE — tampered (1-byte) asset accepted"
else
  ok "INV-INSTALL-VERIFY: tampered asset rejected (fail-closed)"
fi
# empty expected digest (attestation/checksum absent) -> reject
if inst verify_sha256 "$ASSET" "" >/dev/null 2>&1; then
  ng "INV-INSTALL-VERIFY: DEAD GATE — empty expected digest accepted"
else
  ok "INV-INSTALL-VERIFY: missing/empty expected digest rejected (fail-closed)"
fi
# missing asset in checksums.txt -> non-zero
if inst expected_digest_for "$WORK/checksums.txt" not-present.tar.gz >/dev/null 2>&1; then
  ng "INV-INSTALL-VERIFY: DEAD GATE — missing asset resolved a digest"
else
  ok "INV-INSTALL-VERIFY: absent asset yields no digest (fail-closed)"
fi

# ============================================================================
echo
if [ "$fail" = 0 ]; then
  echo "ALL release-prep invariants PASS."
else
  echo "One or more release-prep invariants are DEAD — see FAIL lines above."
fi
exit "$fail"
