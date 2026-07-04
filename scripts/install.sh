#!/bin/sh
# ActraDeck installer — bootstrap from a fresh machine to a running cockpit.
#
#   curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/actradeck/actradeck/main/scripts/install.sh | sh
#
# What it does (idempotent, no root, handles no credentials itself):
#   1. Checks prerequisites: git (to fetch the source), plus node and pnpm
#      (which quickstart needs). It does NOT install them for you — it tells you how.
#   2. Clones ActraDeck to ~/actradeck (override with ACTRADECK_INSTALL_DIR).
#      An existing ActraDeck checkout there is updated with `git pull --ff-only` (or, when
#      ACTRADECK_REF is pinned, re-fetched and checked out at that ref); a non-empty
#      directory that is NOT an ActraDeck checkout is left untouched.
#   3. Hands off to ./scripts/quickstart, which generates a local .env with random
#      secrets (mode 0600), builds the workspace, and brings up the cockpit.
#
# This script downloads and runs code. If you would rather read it first (recommended
# for anything piped into a shell), fetch it, review it, then run it:
#   curl --proto '=https' --tlsv1.2 -fsSL <url> -o install.sh
#   less install.sh
#   sh install.sh
#
# Environment overrides:
#   ACTRADECK_REPO          git URL to clone (default: https://github.com/actradeck/actradeck)
#   ACTRADECK_REF           branch/tag/commit to check out (default: repo default branch)
#   ACTRADECK_INSTALL_DIR   where to put the source (default: $HOME/actradeck)
#   ACTRADECK_VERIFY        when =1, fetch a SIGNED, provenance-attested Release tarball
#                           instead of cloning, and fail closed unless it verifies:
#                           requires ACTRADECK_REF to be a `v*` tag and the `gh` CLI,
#                           verifies SLSA build provenance (`gh attestation verify`)
#                           AND the sha256 digest before extracting anything. Absent
#                           attestation / digest mismatch = non-zero abort (no install).
#                           NOTE: usable only AFTER signed Releases are published — before
#                           the first published tag no attestation exists, so this fails
#                           closed by design; use the default clone path until then.
#                           Unset (default) = the plain clone path below, unchanged.
# Flags:
#   --dry-run / -n          check prerequisites and print the plan, but change nothing
#   --help    / -h          show usage
#
# POSIX sh (works under sh/dash/ash/bash). We intentionally do NOT use `set -o pipefail`
# (not POSIX) or bashisms in the top-level flow. All logic lives in main(), which is only
# invoked on the very last line — so a truncated download (dropped connection mid-transfer)
# leaves a partial script that defines functions but never runs them: a no-op, not a
# half-executed install.
set -eu

# --- config (env-overridable) ------------------------------------------------
ACTRADECK_REPO="${ACTRADECK_REPO:-https://github.com/actradeck/actradeck}"
ACTRADECK_REF="${ACTRADECK_REF:-}"
ACTRADECK_INSTALL_DIR="${ACTRADECK_INSTALL_DIR:-$HOME/actradeck}"

say()  { printf '\033[1;36m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[install]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[install] %s\033[0m\n' "$*" >&2; exit 1; }

# redact_url — strip userinfo (`user[:pass]@`) from a URL before displaying it, so a
# credential embedded in ACTRADECK_REPO never lands in terminal scrollback / CI logs (git
# itself redacts userinfo in its own messages; our own `say` lines must do the same).
# Pure POSIX parameter expansion — no external tools (this runs before anything is fetched).
redact_url() {
  case "$1" in
    *://*)
      _scheme="${1%%://*}"
      _rest="${1#*://}"          # authority[/path...]
      _auth="${_rest%%/*}"       # authority only (up to the first '/')
      _tail="${_rest#"$_auth"}"  # '/path...' (possibly empty)
      case "$_auth" in
        # Fold to the LAST '@': curl/git read userinfo greedily up to the final '@', so a
        # credential whose value contains a raw '@' (e.g. `user:a@b@host`) still has its whole
        # userinfo before that last '@'. `#*@` (first '@') would leave the tail after it in the
        # output (SEC-5 under-redact); `##*@` strips the entire userinfo and keeps only the host.
        *@*) _auth="***@${_auth##*@}" ;;
      esac
      printf '%s://%s%s' "$_scheme" "$_auth" "$_tail" ;;
    *) printf '%s' "$1" ;;
  esac
}

usage() {
  cat <<'EOF'
ActraDeck installer — fetch the source and hand off to quickstart.

Usage:
  curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/actradeck/actradeck/main/scripts/install.sh | sh
  sh install.sh [--dry-run] [--help]

Environment overrides:
  ACTRADECK_REPO          git URL to clone (default: https://github.com/actradeck/actradeck)
  ACTRADECK_REF           branch/tag/commit to check out (default: repo default branch)
  ACTRADECK_INSTALL_DIR   source location (default: $HOME/actradeck)

--dry-run prints the plan and checks prerequisites without changing anything. The
installer handles no credentials; quickstart generates a local .env (mode 0600)
after the source is fetched.
EOF
}

# need <cmd> <message> — die with an actionable message if <cmd> is not on PATH.
need() {
  command -v "$1" >/dev/null 2>&1 || die "$2"
}

# clone_into <dir> — clone ACTRADECK_REPO into <dir>, honoring ACTRADECK_REF.
clone_into() {
  _dir="$1"
  say "Cloning $(redact_url "$ACTRADECK_REPO") -> $_dir ..."
  if [ -n "$ACTRADECK_REF" ]; then
    # Full clone so an arbitrary ref (branch, tag, or commit) can be checked out.
    # `--` separates the URL from options so a URL like `--upload-pack=...` can't be an
    # option (ACTRADECK_REF is separately guarded against leading `-` in main).
    git clone -- "$ACTRADECK_REPO" "$_dir"
    git -C "$_dir" checkout "$ACTRADECK_REF"
  else
    # Shallow clone of the default branch — fast; quickstart does not need history.
    git clone --depth 1 -- "$ACTRADECK_REPO" "$_dir"
  fi
}

# =============================================================================
# Verified-release path (ACTRADECK_VERIFY=1). Additive and fail-closed: none of the
# functions below run unless ACTRADECK_VERIFY=1. The default clone path is untouched.
# The pure helpers (repo_slug / sha256_of / verify_sha256 / expected_digest_for) take
# no network and are unit-tested by scripts/test-release-prep.sh.
# =============================================================================

# repo_slug <git-url> — reduce a repo URL to `owner/name` for `gh --repo`. Name-agnostic:
# the owner is whatever ACTRADECK_REPO points at (no org is hardcoded). Strips scheme,
# userinfo, host, a trailing `.git`, and a trailing slash. Empty output on a shape it
# cannot parse (caller validates and fails closed).
repo_slug() {
  _s="$1"
  _s="${_s#*://}"     # drop scheme://
  _s="${_s#*@}"       # drop any user[:pass]@ userinfo
  case "$_s" in */*) _s="${_s#*/}" ;; *) _s="" ;; esac  # drop host -> owner/name[/...]
  _s="${_s%.git}"     # drop trailing .git
  _s="${_s%/}"        # drop trailing slash
  printf '%s' "$_s"
}

# sha256_of <file> — print the lowercase hex sha256 of <file>, or return non-zero if no
# sha256 tool is available (POSIX has none; try the common two).
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    return 3
  fi
}

# verify_sha256 <file> <expected_hex> — 0 iff <file>'s digest equals <expected_hex>.
# FAIL-CLOSED: a missing file, an empty expected digest, or no sha256 tool all return
# non-zero (never a false OK). This is the digest-check unit the tamper test exercises.
verify_sha256() {
  _f="$1"; _expected="$2"
  [ -f "$_f" ]        || { warn "verify: file not found: $_f"; return 2; }
  [ -n "$_expected" ] || { warn "verify: no expected digest (fail-closed)"; return 2; }
  _actual="$(sha256_of "$_f" 2>/dev/null)" || { warn "verify: no sha256 tool available"; return 3; }
  if [ "$_actual" = "$_expected" ]; then
    return 0
  fi
  warn "verify: DIGEST MISMATCH for $_f (expected $_expected, got $_actual)"
  return 1
}

# expected_digest_for <checksums_file> <asset_name> — print the sha256 recorded for
# <asset_name> in a `sha256sum`-format checksums file. Non-zero (empty) if not found,
# so the caller fails closed on a missing/altered checksums.txt.
expected_digest_for() {
  _cs="$1"; _name="$2"
  [ -f "$_cs" ] || return 2
  awk -v n="$_name" '{ f=$2; sub(/^\*/,"",f); if (f==n) { print $1; found=1 } } END { exit(found?0:1) }' "$_cs"
}

# verify_and_fetch_release <dest_dir> — fetch the Release assets for ACTRADECK_REF,
# verify provenance + digest, and extract the tarball into <dest_dir>. Aborts (die)
# BEFORE any extraction if the ref is not a tag, gh is missing, the download fails,
# attestation verification fails, the checksum entry is missing, or the digest mismatches.
verify_and_fetch_release() {
  _dest="$1"

  case "$ACTRADECK_REF" in
    v*) : ;;
    "") die "ACTRADECK_VERIFY=1 requires ACTRADECK_REF to be a release tag (e.g. ACTRADECK_REF=v0.1.0)." ;;
    *)  die "ACTRADECK_VERIFY=1 requires a 'v*' release TAG, not '$ACTRADECK_REF' (branches/commits are unsigned)." ;;
  esac

  # gh is MANDATORY here — no silent fallback to an unverified clone (that would defeat
  # the whole point). Fail loudly with install instructions.
  command -v gh >/dev/null 2>&1 || \
    die "ACTRADECK_VERIFY=1 requires the GitHub CLI 'gh' (https://cli.github.com) to verify provenance. Install it and re-run."

  # Require an exact `owner/name` shape: one slash, safe chars, non-empty both sides.
  _slug="$(repo_slug "$ACTRADECK_REPO")"
  _bad="ACTRADECK_REPO does not resolve to an 'owner/name' repo ($(redact_url "$ACTRADECK_REPO"))."
  case "$_slug" in
    */*/*)               die "$_bad" ;;  # more than one slash
    /* | */)             die "$_bad" ;;  # empty owner or empty name
    *[!A-Za-z0-9._/-]*)  die "$_bad" ;;  # illegal characters
    */*)                 : ;;            # good: exactly one slash
    *)                   die "$_bad" ;;  # no slash
  esac

  _ver="${ACTRADECK_REF#v}"
  _tarball="actradeck-${_ver}.tar.gz"

  _work="$(mktemp -d)"
  say "Verified install: downloading Release $ACTRADECK_REF assets from $_slug ..."
  gh release download "$ACTRADECK_REF" --repo "$_slug" --dir "$_work" \
       --pattern "$_tarball" --pattern 'checksums.txt' \
    || { rm -rf "$_work"; die "Could not download Release assets for $ACTRADECK_REF from $_slug (does the tag exist and have signed assets?)."; }

  say "Verifying build provenance (gh attestation verify) ..."
  gh attestation verify "$_work/$_tarball" --repo "$_slug" \
    || { rm -rf "$_work"; die "Provenance verification FAILED for $_tarball — refusing to install (fail-closed)."; }

  _expected="$(expected_digest_for "$_work/checksums.txt" "$_tarball")" || _expected=""
  if ! verify_sha256 "$_work/$_tarball" "$_expected"; then
    rm -rf "$_work"
    die "Digest verification FAILED for $_tarball — refusing to install (fail-closed)."
  fi
  say "Provenance + digest verified. Extracting into $_dest ..."

  mkdir -p "$_dest"
  # Tarball has a top-level `actradeck-<ver>/` prefix (git archive --prefix); strip it.
  tar xzf "$_work/$_tarball" -C "$_dest" --strip-components=1 \
    || { rm -rf "$_work"; die "Failed to extract verified tarball into $_dest."; }
  rm -rf "$_work"
  say "Verified source extracted to $_dest."
}

main() {
  _dry_run=0
  for _arg in "$@"; do
    case "$_arg" in
      -n|--dry-run) _dry_run=1 ;;
      -h|--help) usage; return 0 ;;
      *) warn "Unknown argument: $_arg"; usage; return 2 ;;
    esac
  done

  say "ActraDeck installer"

  # Reject option-looking inputs before they reach git. A value starting with `-` would be
  # parsed as a git option (e.g. ACTRADECK_REF=`-q` silently checks out the wrong ref;
  # `--upload-pack=...` is a classic option-injection vector). This is a structural guard,
  # not a denylist of specific options. Combined with `--` before the URL in clone_into, an
  # env var can never be interpreted as a git flag.
  case "$ACTRADECK_REPO" in -*) die "ACTRADECK_REPO must not start with '-' (got: $(redact_url "$ACTRADECK_REPO"))." ;; esac
  case "$ACTRADECK_REF"  in -*) die "ACTRADECK_REF must not start with '-' (got: $ACTRADECK_REF)." ;; esac

  # --- 1. prerequisites ------------------------------------------------------
  # git is needed here (to fetch source); node and pnpm are needed by quickstart.
  # We check presence only and defer the exact Node version gate to quickstart, which
  # reads the required version from package.json (the single source of truth — no
  # version number is duplicated here, so this can never drift from engines.node).
  need git  "git is required to fetch ActraDeck. Install it (e.g. 'apt install git' or 'brew install git') and re-run."
  need node "node is required. Install Node (see package.json engines, e.g. 'nvm install 22') and re-run."
  need pnpm "pnpm is required. Install it with 'npm i -g pnpm' and re-run."

  # Running as root would make the checkout and ~/.actradeck data dir root-owned. Warn
  # rather than fail — some CI images and containers legitimately run as root — so the
  # operator can decide.
  if [ "$(id -u 2>/dev/null || echo 1)" = 0 ]; then
    warn "Running as root: the checkout and data dir will be root-owned. A normal user account is preferred."
  fi

  # --- 2. report the plan ----------------------------------------------------
  # Never echo credentials that may be embedded in the URL (SEC): redact userinfo.
  if [ -n "$ACTRADECK_REF" ]; then
    say "Repository:   $(redact_url "$ACTRADECK_REPO") (ref: $ACTRADECK_REF)"
  else
    say "Repository:   $(redact_url "$ACTRADECK_REPO")"
  fi
  say "Install dir:  $ACTRADECK_INSTALL_DIR"

  if [ "$_dry_run" = 1 ]; then
    say "Dry run: prerequisites OK. Would clone into '$ACTRADECK_INSTALL_DIR' and run '$ACTRADECK_INSTALL_DIR/scripts/quickstart'. Nothing was changed."
    return 0
  fi

  # --- 3. fetch source: verified Release tarball (opt-in) OR clone (default) --
  if [ "${ACTRADECK_VERIFY:-}" = 1 ]; then
    # Fail-closed verified path. Requires an EMPTY/new install dir — a verified install
    # is a fresh extraction of a signed tarball, not an in-place git update; refuse to
    # extract over an existing tree (foreign or ActraDeck) so nothing is silently mixed.
    if [ -e "$ACTRADECK_INSTALL_DIR" ] && [ -n "$(ls -A "$ACTRADECK_INSTALL_DIR" 2>/dev/null || true)" ]; then
      die "ACTRADECK_VERIFY=1 needs an empty/new install dir. '$ACTRADECK_INSTALL_DIR' is non-empty — set ACTRADECK_INSTALL_DIR to a fresh path and re-run."
    fi
    verify_and_fetch_release "$ACTRADECK_INSTALL_DIR"
    # (fall through to quickstart hand-off)
  elif [ -e "$ACTRADECK_INSTALL_DIR" ]; then
    if [ -d "$ACTRADECK_INSTALL_DIR/.git" ]; then
      # A bare `.git` is not proof this is ActraDeck. Confirm scripts/quickstart is present
      # before we touch it — refuse to `git pull` an unrelated repo the operator happens to
      # keep at this path (SEC: don't act on a misidentified repository).
      [ -e "$ACTRADECK_INSTALL_DIR/scripts/quickstart" ] || \
        die "'$ACTRADECK_INSTALL_DIR' is a git repo but not an ActraDeck checkout (no scripts/quickstart). Set ACTRADECK_INSTALL_DIR elsewhere and re-run."
      if [ -n "$ACTRADECK_REF" ]; then
        # Honor the pinned ref on re-run too, so a ref-pinned install stays idempotent: a
        # bare `pull --ff-only` fails on the detached HEAD a tag/commit checkout leaves, and
        # would silently ignore a changed ref. Fetch, check out the ref, and (only if it is
        # a branch) fast-forward — a detached ref needs no pull and the ff attempt no-ops.
        say "Existing checkout found — fetching and checking out '$ACTRADECK_REF' ..."
        git -C "$ACTRADECK_INSTALL_DIR" fetch --tags origin
        git -C "$ACTRADECK_INSTALL_DIR" checkout "$ACTRADECK_REF"
        git -C "$ACTRADECK_INSTALL_DIR" pull --ff-only 2>/dev/null || true
      else
        say "Existing checkout found — updating (git pull --ff-only) ..."
        # --ff-only refuses to overwrite local commits/changes: safe and non-destructive.
        git -C "$ACTRADECK_INSTALL_DIR" pull --ff-only
      fi
    elif [ -n "$(ls -A "$ACTRADECK_INSTALL_DIR" 2>/dev/null || true)" ]; then
      die "'$ACTRADECK_INSTALL_DIR' exists and is not an ActraDeck checkout. Set ACTRADECK_INSTALL_DIR to a new/empty path (or remove it) and re-run."
    else
      clone_into "$ACTRADECK_INSTALL_DIR"
    fi
  else
    clone_into "$ACTRADECK_INSTALL_DIR"
  fi

  # --- 4. hand off to quickstart ---------------------------------------------
  _qs="$ACTRADECK_INSTALL_DIR/scripts/quickstart"
  [ -x "$_qs" ] || die "quickstart not found or not executable at '$_qs' — the checkout looks incomplete."
  say "Handing off to quickstart ..."
  cd "$ACTRADECK_INSTALL_DIR"
  # exec: the installer's job is done. quickstart (its own #!/usr/bin/env bash) owns the
  # rest — .env generation, build, bring-up — and prints the final instructions. Its exit
  # code becomes ours.
  exec "$_qs"
}

# Run the installer — UNLESS a test sources this file to exercise the pure verify
# helpers in isolation (ACTRADECK_INSTALL_SOURCE_ONLY=1). Unset (the normal curl|sh
# and `sh install.sh` paths) always runs main, so the default behavior is unchanged.
if [ "${ACTRADECK_INSTALL_SOURCE_ONLY:-}" != "1" ]; then
  main "$@"
fi
