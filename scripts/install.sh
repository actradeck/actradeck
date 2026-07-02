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

  # --- 3. clone or update (idempotent, never clobber a foreign directory) ----
  if [ -e "$ACTRADECK_INSTALL_DIR" ]; then
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

main "$@"
