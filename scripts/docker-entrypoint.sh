#!/usr/bin/env bash
#
# ActraDeck container entrypoint — brings up the cockpit stack (backend + webui) with
# an embedded PostgreSQL (PGlite). The sidecar is intentionally NOT started here: it
# observes the HOST's agent CLIs and cannot do so from inside a container (docs/docker.md).
#
# Secret discipline:
#   - INGEST_TOKEN / REALTIME_TOKEN are taken from the environment if provided, else a
#     random one is generated at boot. Token VALUES are never printed (only the fact
#     that one was provided vs generated). They are exported to both tiers as env — never
#     placed on any process argv.
#   - Nothing here bakes a secret into the image; the image ships tokenless.
#
# NOTE (honest — this is NOT full parity with scripts/actradeck): the native supervisor
# scripts/actradeck REQUIRES the tokens to be present in <repo>/.env (it errors out when
# .env is absent) and does NOT generate them. This container entrypoint instead GENERATES
# an ephemeral token when none is injected, so a one-command `docker run` comes up without
# any setup. The shared discipline is only "never bake a secret into the image, never print
# a token value, never put a token on argv" — the token *sourcing* differs (env-or-generate
# here vs env-file-required there).
#
set -euo pipefail

log() { printf '[actradeck-docker] %s\n' "$*"; }

# --- ports / hosts (container-internal defaults; override via -e / -p) --------
# Bind 0.0.0.0 INSIDE the container so published ports (-p) reach the processes. The
# container network namespace isolates this; only ports the operator publishes are
# reachable, and docs/docker.md recommends publishing to 127.0.0.1 on the host.
export ACTRADECK_BACKEND_PORT="${ACTRADECK_BACKEND_PORT:-55410}"
export ACTRADECK_WEBUI_PORT="${ACTRADECK_WEBUI_PORT:-55400}"
export ACTRADECK_BACKEND_HOST="${ACTRADECK_BACKEND_HOST:-0.0.0.0}"
export ACTRADECK_WEBUI_HOST="${ACTRADECK_WEBUI_HOST:-0.0.0.0}"
# The webui BFF reaches the backend over container-internal loopback (same netns).
export BACKEND_REALTIME_WS_URL="${BACKEND_REALTIME_WS_URL:-ws://127.0.0.1:${ACTRADECK_BACKEND_PORT}/realtime/ws}"
# Embedded PGlite data dir → the /data volume (persists across container restarts).
export ACTRADECK_PGDATA="${ACTRADECK_PGDATA:-/data/pgdata}"

# --- secrets: prefer injected env; else generate. NEVER print the values. -----
gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}
if [ -z "${INGEST_TOKEN:-}" ]; then
  INGEST_TOKEN="$(gen_secret)"
  export INGEST_TOKEN
  log "INGEST_TOKEN not provided — generated an ephemeral one for this run (value not logged)."
else
  log "INGEST_TOKEN taken from the environment."
fi
if [ -z "${REALTIME_TOKEN:-}" ]; then
  REALTIME_TOKEN="$(gen_secret)"
  export REALTIME_TOKEN
  log "REALTIME_TOKEN not provided — generated an ephemeral one for this run (value not logged)."
else
  log "REALTIME_TOKEN taken from the environment."
fi

NODE_BIN="$(command -v node)"
[ -n "$NODE_BIN" ] || { log "node not found on PATH"; exit 1; }

# --- supervise backend + webui; exit the container if either tier dies --------
pids=""
stopping=0
stop_all() {
  [ "${stopping:-0}" = 1 ] && return 0
  stopping=1
  log "stopping — SIGTERM to all tiers…"
  # shellcheck disable=SC2086
  { [ -n "${pids:-}" ] && kill $pids 2>/dev/null; } || true
}
trap 'stop_all' INT TERM

log "starting backend on :${ACTRADECK_BACKEND_PORT} (embedded PGlite at ${ACTRADECK_PGDATA})…"
( cd /app/apps/backend && exec "$NODE_BIN" --import tsx src/index.ts ) &
pids="$pids $!"

# Wait for the backend to answer /health before starting the webui BFF (which relays
# to it). Uses node's global fetch (no curl/wget in the slim base).
log "waiting for backend health…"
ok=0
for _ in $(seq 1 90); do
  if "$NODE_BIN" -e "fetch('http://127.0.0.1:'+(process.env.ACTRADECK_BACKEND_PORT||55410)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    ok=1
    break
  fi
  sleep 1
done
if [ "$ok" != 1 ]; then
  log "backend did not become healthy in time — shutting down."
  stop_all
  exit 1
fi
log "backend healthy."

log "starting webui on :${ACTRADECK_WEBUI_PORT}…"
( cd /app/apps/webui && exec "$NODE_BIN" --import tsx server.ts ) &
pids="$pids $!"

log "cockpit up — open http://localhost:${ACTRADECK_WEBUI_PORT} (publish it with -p)."
log "to observe host agents, run the sidecar on the HOST and point it at the ingestion port (docs/docker.md)."

# Wait for the first tier to exit, then tear down the rest and propagate a failure so
# the container (and any restart policy) reacts. `wait -n` needs bash 4+ (present).
set +e
wait -n
rc=$?
set -e
if [ "${stopping:-0}" != 1 ]; then
  log "a tier exited (rc=${rc}) — stopping the other and exiting."
  stop_all
fi
wait 2>/dev/null || true
exit "${rc}"
