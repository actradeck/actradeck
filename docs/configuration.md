# Configuration reference

All configuration is environment variables, normally kept in `.env` at the repo root.
[`../.env.example`](../.env.example) is the template — `./scripts/quickstart` copies it,
generates the secrets, and sets mode `0600`. This page is the reference for what each
variable does, what reads it, and what is safe to change.

Conventions:

- **Never commit `.env`** (git-ignored). Keep it `0600` — it holds the auth tokens.
- All defaults are chosen so a fresh clone works with **no configuration at all**.
- The daemons read `.env` via their service definition (`EnvironmentFile` / launchd
  equivalent) — after changing a value, restart the affected tier
  (`./scripts/actradeck restart`).

## Database

Default is an **embedded PostgreSQL (PGlite)** — no Docker, no service to run. External
Postgres is opt-in.

| Variable | Default | Read by | Notes |
|---|---|---|---|
| `DATABASE_URL` | _(unset = embedded)_ | backend | Set to a `postgresql://` URL to use an external Postgres instead of the embedded DB. When unset, the backend boots the embedded DB and migrates it in-process. |
| `ACTRADECK_PGDATA` | `~/.actradeck/pgdata` | backend | Where the embedded DB persists its data. Delete the directory (with the backend stopped) to reset. |
| `ACTRADECK_DB_MODE` | `embedded` | quickstart | `postgres` makes quickstart take the Docker path (`docker compose up` + `pnpm db:migrate`). Only this opt-in path needs Docker. |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | _(unset)_ | docker compose | External-Postgres only. Must agree with `DATABASE_URL`. |
| `ACTRADECK_PG_PORT` | `55432` | docker compose | Host port for the external Postgres container (offset to avoid clashing with a system Postgres on 5432). |

## Ports and hosts

ActraDeck consolidates on the `554xx` block to avoid colliding with other local stacks.

| Variable | Default | Read by | Notes |
|---|---|---|---|
| `ACTRADECK_WEBUI_PORT` | `55400` | webui | The cockpit — open `http://localhost:55400`. |
| `ACTRADECK_BACKEND_PORT` | `55410` | backend, sidecar | Ingestion + realtime API. |
| `ACTRADECK_BACKEND_HOST` | `127.0.0.1` | backend | Loopback by default; the trust model assumes it stays local. |
| `ACTRADECK_WEBUI_HOST` | `127.0.0.1` | webui | Bind address for the cockpit (e.g. `0.0.0.0` to expose on a LAN — understand [`../SECURITY.md`](../SECURITY.md) first). |
| `BACKEND_REALTIME_WS_URL` | `ws://127.0.0.1:55410/realtime/ws` | webui (BFF) | Where the webui server relays browser realtime connections. `ws://`/`wss://` only, env-sourced only (clients cannot pick it — SSRF guard). Keep the port consistent with `ACTRADECK_BACKEND_PORT`. |
| `ACTRADECK_WS_URL` | _(unset)_ | sidecar | Explicit backend WS base for the daemons; overrides the port-derived default. |

## Authentication tokens

Two separate tokens for two separate channels; quickstart generates both. Random 32-byte
hex each; rotate by regenerating the value and restarting the affected tiers.

| Variable | Read by | Notes |
|---|---|---|
| `INGEST_TOKEN` | backend, sidecar | Authenticates sidecar → backend ingestion. **Must be the same value on both.** The backend refuses to start without it (no unauthenticated ingest, ever). |
| `REALTIME_TOKEN` | backend, webui (server) | Authenticates the UI realtime channel (`Authorization: Bearer`). Deliberately distinct from `INGEST_TOKEN`; never exposed to the browser (`NEXT_PUBLIC_` is forbidden for it). Unset = the realtime endpoint is not mounted (fail-safe). |

After rotating `INGEST_TOKEN`, restart the daemons so the running processes pick it up:
`./scripts/ad-attach service restart` and `./scripts/ad-attach codex service restart`.

## Approval governance

Detailed in the [approval policy guide](./approval-policy.md).

| Variable | Default | Notes |
|---|---|---|
| `ACTRADECK_BYPASS_CATASTROPHIC_GATE` | _(unset = gate ON)_ | `0`/`false` = kill switch: bypass/YOLO sessions are purely observed, nothing gated. |
| `ACTRADECK_PERSIST_APPROVALS` | _(unset = OFF)_ | `1`/`true` enables the persistent approval allowlist. Unset also stops honoring already-recorded grants. |
| `ACTRADECK_PERSIST_APPROVALS_TTL_MS` | `604800000` (7 days) | TTL for persisted grants; clamped to 1 minute–90 days. |

## Display scope

| Variable | Default | Notes |
|---|---|---|
| `ACTRADECK_PROJECT_SCOPE` | _(unset = show all)_ | Comma-separated cwd prefixes. Narrows the live wall / board / approval inbox / audit **lists** to sessions under those paths (useful when screen-sharing so unrelated project names don't appear), and confines per-repo policy path resolution. Narrows only — unset restores full visibility. |

## Agent daemons (advanced)

Defaults are right for almost everyone; these exist for unusual setups.

| Variable | Default | Notes |
|---|---|---|
| `CODEX_HOME` | `~/.codex` | Where the Codex attach daemon looks for rollout files to tail. |
| `ACTRADECK_CLAUDE_BIN` / `ACTRADECK_CODEX_BIN` | `claude` / `codex` on `PATH` | Binary paths for Managed mode (`agentmon claude` / `agentmon codex`). |
| `ACTRADECK_ATTACH_IDLE_TTL_MS` | _(built-in)_ | How long an attach session may stay silent before being reaped as ended. Raise it if long-idle sessions get marked ended too eagerly. |
| `ACTRADECK_ATTACH_REAPER_INTERVAL_MS` | _(built-in)_ | How often the reaper scans for idle sessions. |

## Not configuration

Variables you may see in the source that are **not** operator settings: `ACTRADECK_HOOK_TOKEN`
(wired automatically into agent hook settings by `ad-attach`), and `ACTRADECK_MARKER` /
`ACTRADECK_SENTINEL` and friends (test fixtures). Leave them alone.
