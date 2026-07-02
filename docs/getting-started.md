# Getting started

From a fresh clone to a running cockpit. There are two paths: a one-command
quickstart, and the manual steps it automates (use the manual steps if the
quickstart fails on your machine).

## Prerequisites

- **Node.js** v22.16+ and **pnpm** (`npm i -g pnpm`).
- **No database to install.** ActraDeck uses an embedded PostgreSQL (PGlite) at
  `~/.actradeck/pgdata` by default — no Docker, no separate service. Docker with
  `docker compose` is needed **only** if you opt into an external Postgres (see below).
- **A user-level service supervisor** for the always-on daemon mode: `systemd --user`
  (Linux) or **launchd LaunchAgents** (macOS). `./scripts/actradeck up` detects which is
  present and daemonizes all four tiers accordingly. The macOS LaunchAgents live in your
  login session — always-on while you're logged in, auto-starting on next login (the
  `systemd --user` no-linger equivalent); a survives-logout headless daemon would need a
  root `LaunchDaemon`, which is out of scope. On a host with **neither** supervisor,
  `up` runs all four tiers in the **foreground** instead (keep the terminal open; Ctrl-C
  stops them all).
  > **launchd support is experimental.** The `systemd` path is exercised daily; the launchd
  > path is structurally verified (plist generation, secret hygiene, and XML well-formedness
  > are covered by `scripts/test-actradeck.sh` / `scripts/test-ad-attach.sh`) but has **not
  > yet been run on a Mac** — `launchctl bootstrap`, crash-restart, and cross-login
  > persistence are pending runtime validation. The commands below are correct by
  > construction; please report any macOS runtime surprises.
- At least one agent installed: **Claude Code** (`claude`) and/or **Codex**
  (`codex`).

## One-line install

If you have `git`, Node, and pnpm, a single command fetches the source and hands off to
`quickstart`:

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/actradeck/actradeck/main/scripts/install.sh | sh
```

This is a thin bootstrap: it checks prerequisites, clones ActraDeck (to `~/actradeck`, or
`ACTRADECK_INSTALL_DIR`), and runs `./scripts/quickstart` — it does not reimplement any of
the setup, and it handles no credentials (quickstart still generates the `0600` `.env`).

- **It downloads and runs code.** For anything piped into a shell, reading it first is a
  good habit — fetch it, review it, then run it:
  ```bash
  curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/actradeck/actradeck/main/scripts/install.sh -o install.sh
  less install.sh && sh install.sh
  ```
- **See the plan without changing anything** with `--dry-run` (checks prerequisites and
  prints where it would clone).
- **Overrides:** `ACTRADECK_REPO` (fork URL), `ACTRADECK_REF` (branch/tag/commit),
  `ACTRADECK_INSTALL_DIR` (source location). It never runs as root and refuses to clobber
  a non-empty directory that is not an existing ActraDeck checkout.

> The one-liner works once the repository is public (OSS release pending). Until then,
> clone the repo and run `./scripts/quickstart` inside it. (Running `install.sh` on an
> existing clone just makes a second checkout under `ACTRADECK_INSTALL_DIR` — it is the
> remote-bootstrap entry point, not an in-place setup for a clone you already have.)

## Fast path — one command

```bash
./scripts/quickstart
```

![ActraDeck first-run: fresh clone → running cockpit, recorded on a clean machine](media/first-run.gif)

It is idempotent and does the following:

1. Checks prerequisites.
2. Creates `.env` from `.env.example` with **randomly generated secrets** (mode
   `0600`) — an existing `.env` is never overwritten.
3. `pnpm install` (only if needed), then builds the workspace (`pnpm -r build`) so the
   backend and web UI can import the compiled dist of the shared `@actradeck/*` packages.
4. Database — **embedded by default**: nothing to start. The backend brings up an
   embedded PostgreSQL (PGlite) at `~/.actradeck/pgdata` and applies migrations
   in-process on boot. (External Postgres is opt-in — see below.)
5. Brings up all tiers (`scripts/actradeck up` = backend + web UI + Claude Code
   attach + Codex attach).
6. Runs `scripts/actradeck doctor`.

When it finishes, open the cockpit at **http://localhost:55400**.

> **macOS (launchd).** quickstart does everything _except_ the final `up` — it prints
> the one command to run:
>
> ```bash
> ./scripts/actradeck up   # daemonizes all four tiers via launchd LaunchAgents
> ```
>
> On macOS this installs a LaunchAgent per tier (`io.actradeck.*`) under
> `~/Library/LaunchAgents` and bootstraps them into your GUI login domain, so they stay
> up while you're logged in and auto-start on next login. `down` / `restart` / `status`
> / `logs` work the same as on Linux. (A fully headless, survives-logout daemon would
> need a root `LaunchDaemon` — out of scope.)
>
> **Neither supervisor.** If there's no systemd _and_ no launchctl, `up` runs the four
> tiers in the **foreground** instead — it has to stay attached to a terminal, so keep
> that terminal open, then open the cockpit; Ctrl-C stops them all.

## Manual steps (what quickstart automates)

```bash
# 1. Config. Copy the template and fill in secrets (or let quickstart generate them).
cp .env.example .env
chmod 600 .env       # do this before writing real secrets
#    Uncomment and set INGEST_TOKEN and REALTIME_TOKEN (random 32-byte hex each).
#    Leave DATABASE_URL commented for the embedded DB.

# 2. Dependencies + build. Install, then build the workspace so the backend and web UI
#    can import the compiled dist of the shared @actradeck/* packages (event-model,
#    projection, design-tokens). Skipping this makes `actradeck up` fail on a fresh clone.
pnpm install
pnpm -r build

# 3. Database — embedded by default: nothing to do here. The backend starts an embedded
#    PostgreSQL (PGlite) at ~/.actradeck/pgdata and migrates it in-process on boot.
#
#    External Postgres (opt-in): uncomment POSTGRES_* + DATABASE_URL in .env, then:
#      docker compose up -d               # Postgres on :55432 (offset to avoid clashes)
#      pnpm db:migrate

# 4. Tiers (backend :55410 + web UI :55400 + attach daemons).
./scripts/actradeck up

# 5. (or, granular) attach daemons only:
./scripts/ad-attach install-all      # Claude Code + Codex attach (systemd units / launchd agents)
```

## Verify

```bash
./scripts/actradeck doctor           # node / .env / linger / units / port listeners
./scripts/ad-attach status-all       # attach + codex-attach daemons
```

Then open **http://localhost:55400** — you should see the (empty) live session list.

## See your first session

Attach Mode requires no change to how you launch agents:

```bash
cd ~/any/project && claude           # or: codex
```

The session appears in the cockpit live list within a second or two, showing its
state, current action, repo/branch, and any pending approval.

Here is what the cockpit looks like in use — live wall, liveness-by-evidence,
secret redaction, cross-vendor audit, approval inbox, and replay:

![ActraDeck cockpit walkthrough](media/usage.gif)

Full walkthrough (~90s): [`media/usage.mp4`](./media/usage.mp4).

## Stopping / uninstalling

```bash
./scripts/actradeck down             # stop backend + webui + attach tiers (systemd / launchd)
./scripts/ad-attach uninstall-all    # remove attach daemons + un-wire settings
docker compose down                  # external Postgres only (add -v to drop the volume)
```

The embedded database lives in `~/.actradeck/pgdata` — delete that directory to drop it
(when no ActraDeck backend is running).

> On macOS the tiers daemonize via launchd LaunchAgents (`down` / `restart` / `status` /
> `logs` all work); only on a host with neither systemd nor launchctl do they run in the
> foreground, where **Ctrl-C** in the `./scripts/actradeck up` terminal stops them all.

## Record the demo

- **Product demo (90s).** The cross-vendor governance / secret / audit story is in
  [`demo-90s.md`](./demo-90s.md). With the stack already up, that runbook is all you
  need (screen-record the cockpit while driving real `claude` / `codex` sessions).
- **First-run recording (the GIF above).** `media/first-run.gif` is a _real_
  clean-machine capture — a fresh clone driven through `./scripts/quickstart` to a
  running cockpit (Docker-isolated, default ports, secrets masked), recorded with
  [`asciinema`](https://docs.asciinema.org) + [`agg`](https://github.com/asciinema/agg);
  reproduce it on a throwaway
  container/VM so your live stack and shell state can't mask first-run friction.
- **Lighter read-only variant.** If you just want a quick narrated walkthrough on
  your own machine, [`../scripts/record-setup-cast.sh`](../scripts/record-setup-cast.sh)
  is non-destructive — it generates a throwaway `.env` with masked secrets and runs
  only read-only checks against your stack — writing `media/setup.cast` (source) and
  `media/setup.gif`.

## Troubleshooting

> **Embedded vs external Postgres.** The default setup uses the **embedded** database —
> there is no Docker container and no Postgres service to troubleshoot. Rows marked
> **(external Postgres only)** apply **only** if you opted in via `ACTRADECK_DB_MODE=postgres`
> or an uncommented `DATABASE_URL` in `.env`; on the embedded default they cannot occur.

| Symptom                                                                  | Fix                                                                                                                                                       |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `doctor`: `:55400`/`:55410` not listening                                | A tier failed to start. Check `./scripts/actradeck logs backend` / `logs webui`.                                                                          |
| Postgres never becomes healthy **(external Postgres only)**              | `docker compose ps` / `docker compose logs postgres`. Ensure `POSTGRES_PASSWORD` is set in `.env`.                                                        |
| `pnpm db:migrate` fails to connect **(external Postgres only)**          | `DATABASE_URL` must match `POSTGRES_PASSWORD` and `ACTRADECK_PG_PORT` (default `55432`).                                                                  |
| Port already in use (`:55400` / `:55410`; `:55432` external PG only)     | Change `ACTRADECK_WEBUI_PORT` / `ACTRADECK_BACKEND_PORT` / `ACTRADECK_PG_PORT` in `.env`, then re-run.                                                    |
| Sessions never appear in the cockpit                                     | `./scripts/ad-attach status-all`; ensure the daemon is active and you started `claude`/`codex` after install.                                             |
| `203/EXEC` after a Node upgrade (nvm)                                    | `node` path changed; re-run `./scripts/actradeck up` to regenerate the unit files.                                                                        |
| Want it to survive logout                                                | `loginctl enable-linger "$USER"`.                                                                                                                         |
| `quickstart` aborts: Node too old                                        | It enforces `package.json` `engines.node` (≥ 22.16). `nvm install 22 && nvm use 22`, then re-run.                                                         |
| `quickstart` aborts: Docker daemon not reachable **(external Postgres only)** | Only the opt-in Docker path checks Docker. Start Docker (Docker Desktop / `sudo systemctl start docker`) and ensure your user can run `docker` — or drop the opt-in and use the embedded default. |
| macOS: tiers don't survive logout                       | LaunchAgents run in your login session (auto-start on next login). A survives-logout headless daemon needs a root `LaunchDaemon` (out of scope).          |
| macOS: `203/EXEC` / tier won't start after Node upgrade | `node` path changed; re-run `./scripts/actradeck up` to regenerate the LaunchAgent plists, or inspect one with `./scripts/actradeck print-plist backend`. |
| Neither systemd nor launchctl: `up` stays attached      | `up` runs the tiers in the foreground (Ctrl-C stops them); `down`/`status` need a supervisor.                                                             |

## Security note

`.env` holds local secrets (Postgres password, ingest/realtime tokens). It is
`git`-ignored, should be `0600`, and must never be committed. See
[`../SECURITY.md`](../SECURITY.md) and ADR
[0012](./adr/0012-threat-model-and-local-fs.md) for the threat model.
