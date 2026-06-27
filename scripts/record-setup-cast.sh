#!/usr/bin/env bash
# Record a short, REAL, non-destructive "setup is easy + healthy" terminal cast
# (asciinema) and render it to a GIF (agg).
#
# Safe to run on a live machine: it generates a throwaway .env in a temp dir
# (secrets are masked on screen and the temp dir is deleted), and otherwise only
# runs read-only checks (doctor / curl) against your stack. It never runs
# `quickstart` / `actradeck up` / migrations — those are narrated, not executed.
#
# Requires: asciinema (`pipx install asciinema`) and agg
# (https://github.com/asciinema/agg/releases — musl build for older glibc).
#
# Usage:  scripts/record-setup-cast.sh [output.gif]
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

OUT_GIF="${1:-docs/media/setup.gif}"
OUT_CAST="${OUT_GIF%.gif}.cast"

command -v asciinema >/dev/null 2>&1 || {
  echo "asciinema not found. Install: pipx install asciinema" >&2
  exit 1
}
AGG="$(command -v agg || true)"
[ -n "$AGG" ] || AGG="$HOME/.local/bin/agg"
[ -x "$AGG" ] || {
  echo "agg not found. Get a binary from https://github.com/asciinema/agg/releases" >&2
  exit 1
}
mkdir -p "$(dirname "$OUT_GIF")"

SEQ="$(mktemp /tmp/ad-setup-seq-XXXXXX.sh)"
trap 'rm -f "$SEQ"' EXIT
cat >"$SEQ" <<'SEQEOF'
set -e
title(){ printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; sleep 0.8; }
note(){ printf '\033[0;90m%s\033[0m\n' "$*"; sleep 0.4; }
run(){ printf '\033[1;32m$\033[0m %s\n' "$*"; sleep 0.4; eval "$*"; sleep 0.8; }
ghost(){ printf '\033[1;32m$\033[0m %s\n' "$*"; sleep 0.8; }

title "ActraDeck — set up in one command"
note  "Fresh clone -> running cockpit. (Node 22.16+, pnpm, Docker compose.)"

title "1) prerequisites"
run "node --version"
run "pnpm --version"
run "docker compose version | head -1"

title "2) ./scripts/quickstart writes .env for you (random secrets, mode 0600)"
TMP="$(mktemp -d)"; cp .env.example "$TMP/.env.example"
( cd "$TMP"
  pw=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  sed -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$pw|" \
      -e "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://actradeck:$pw@localhost:55432/actradeck|" \
      .env.example > .env
  printf 'INGEST_TOKEN=%s\nREALTIME_TOKEN=%s\n' \
      "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" >> .env
  chmod 600 .env )
ghost "grep -E '^(POSTGRES_PASSWORD|INGEST_TOKEN|REALTIME_TOKEN)=' .env"
grep -E '^(POSTGRES_PASSWORD|INGEST_TOKEN|REALTIME_TOKEN)=' "$TMP/.env" \
  | sed -E 's/=.*/=*****(generated, 0600)/'
rm -rf "$TMP"; sleep 0.8

title "3) quickstart then starts Postgres, migrates, and brings up all tiers"
ghost "docker compose up -d   #  Postgres :55432"
ghost "pnpm db:migrate        #  schema"
ghost "./scripts/actradeck up #  backend :55410 + web UI :55400 + attach daemons"

title "4) confirm it is healthy (read-only)"
run "./scripts/actradeck doctor 2>&1 | sed -n '1,18p'"
run "curl -s -o /dev/null -w 'cockpit http://localhost:55400 -> HTTP %{http_code}\n' http://localhost:55400"

title "Done — open http://localhost:55400, then run 'claude' or 'codex'"
sleep 1.4
SEQEOF

echo "[record] capturing cast -> $OUT_CAST"
asciinema rec --overwrite -c "bash $SEQ" "$OUT_CAST"
echo "[record] rendering gif -> $OUT_GIF"
"$AGG" --speed 1.4 --font-size 18 --theme asciinema "$OUT_CAST" "$OUT_GIF"
echo "[record] done: $OUT_GIF ($(stat -c%s "$OUT_GIF" 2>/dev/null || echo '?') bytes)"
