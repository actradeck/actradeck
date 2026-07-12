# Attach Mode — observe an existing Claude Code "from any directory"

> 日本語版: [attach-mode.ja.md](./attach-mode.ja.md)

ActraDeck's **Attach Mode** observes, after the fact, a Claude Code (CC) whose startup ActraDeck
does not own (i.e. you start it as usual). Unlike **Managed Mode**, where the Sidecar starts CC
as a PTY child process (`agentmon claude`), Attach only **non-destructively wires** a hook into
the settings that CC always reads, and does not change how CC is started at all.

- How it is settled: ADR `019ea476` (design) / `019ea48a` (implementation) / `019ea499` (ruling)
- Everyday packaging: ADR `019eac8a` (`ad-attach` + systemd) / `019ee134` (codex daemon) /
  `019ee25e` (whole-stack `actradeck`)

---

## Run the whole stack as a daemon with one command (recommended) — `actradeck up`

ActraDeck consists of 4 tiers (backend `:55410` / webui `:55400` / attach daemon / codex daemon).
`scripts/actradeck` is a one-command orchestrator that **daemonizes all tiers** (ADR `019ee25e`).
The daemon mechanism is **auto-selected 3-way** (ADR `019ef084`):

- **Linux**: `systemd --user` unit (`actradeck-*.service`)
- **macOS**: **launchd LaunchAgents** (`io.actradeck.*` · `~/Library/LaunchAgents`) — persists
  while logged in + auto-starts on re-login. Persistence that survives logout requires a root
  `LaunchDaemon` and is out of scope.
  The launchd path is experimental (structurally verified · runtime verification on a real Mac
  is wanted).
- **Neither present**: foreground execution (keep the terminal open · Ctrl-C stops everything).

Whereas `ad-attach` handles the observation daemon, `actradeck` manages the **whole stack**
including the cockpit server layer. `down` / `restart` / `status` / `logs` behave the same under
any mechanism.

```bash
cd /path/to/ActraDeck
chmod 600 .env                 # required, since it contains secrets (INGEST_TOKEN/REALTIME_TOKEN, etc.)
./scripts/actradeck up         # build all workspaces → daemonize backend+webui → ad-attach install-all
loginctl enable-linger "$USER" # Linux only: keep running after logout (macOS persists per login session)
```

| Command | Behavior |
|---|---|
| `actradeck up` | Builds all workspace packages (shared packages dist / sidecar dist / webui .next) → daemonizes backend+webui (systemd unit / launchd plist) → daemonizes the observation daemon with `ad-attach install-all`. |
| `actradeck down` | Stops, disables, and removes all 4 tiers. |
| `actradeck restart` | Restarts all 4 tiers (`systemctl restart` / `launchctl kickstart`). |
| `actradeck status` | Supervisor status of all 4 tiers (systemd unit / launchd agent). |
| `actradeck logs <backend\|webui\|attach\|codex>` | `journalctl -f` (systemd) / `tail -f` a log file (launchd). |
| `actradeck doctor` | Checks `.env` permissions / node / linger / the 4-tier units & plists / port reachability (secrets not shown). |
| `actradeck print-unit <backend\|webui>` | Show the generated systemd unit (for verification · single source). |
| `actradeck print-plist <backend\|webui>` | Show the generated launchd LaunchAgent plist (the macOS twin of print-unit). |

> **Handling secrets**: the backend/webui units read `.env` via node's `--env-file-if-exists`.
> Neither the unit body nor the argv carries the token **value** (the argv only has the path of
> `.env`). Same policy as the `ad-attach` daemon unit. After you update node, re-run
> `actradeck up` to update the units (avoids `203/EXEC` from a vanished old node path).

> If you want only the daemon to run (managing backend/webui separately), use `ad-attach`
> directly, below.

---

## The simplest way (daemon only) — always observe from any directory

"From any directory" technically means wiring the hook into the **user-scope
`~/.claude/settings.json`** that CC always reads (project-local wiring covers only 1
repository). This is run as a persistent service — on Linux a systemd `--user` unit, on macOS a
launchd LaunchAgent (`ad-attach` auto-detects. Same 3-way as `actradeck`: if neither is present,
foreground).

### Prerequisites
1. Prepare `.env` (see `.env.example`). At minimum, the `INGEST_TOKEN` with the **same value**
   as the backend. Since it contains secrets, `chmod 600 .env` is recommended.
2. backend / webui are running (defaults `:55410` / `:55400`). If you daemonize the whole stack,
   the `actradeck up` above also handles starting backend/webui.

### One time only
```bash
cd /path/to/ActraDeck
chmod 600 .env                   # required, since it contains secrets (INGEST_TOKEN, etc.)
./scripts/ad-attach install      # sidecar build → place systemd unit / launchd plist → auto-start (attach)
# If you also want to observe the Codex TUI as a daemon (optional):
./scripts/ad-attach codex install   # place & auto-start actradeck-codex-attach.service
# or both at once:
./scripts/ad-attach install-all     # daemonize attach + codex together
# (if you want it to persist even while logged out) loginctl enable-linger "$USER"
```

What `install` does:
- Builds `apps/sidecar` (generating `dist/cli.js`).
- **Linux**: **generates `~/.config/systemd/user/actradeck-attach.service` with real paths**
  (resolving the absolute `node` path and the absolute repository path). Secrets are read via
  `EnvironmentFile=-<repo>/.env`, so they are **not written into the unit body**. You can check
  the generated unit's content with `./scripts/ad-attach print-unit` (there is no hand-written
  definition; this is the single source). The unit is given `TimeoutStopSec=30` (a graceful
  flush grace period after `SIGTERM`) and `NoNewPrivileges=yes` (the observation daemon needs no
  privilege escalation).
- **macOS**: generates a reverse-DNS label (`io.actradeck.*`) LaunchAgent plist under
  `~/Library/LaunchAgents/` with the same policy (real path resolution · secret values not
  written into the plist body). `./scripts/ad-attach print-plist` is the twin of print-unit.
- Enables startup + auto-start at login (`systemctl --user enable --now` / `launchctl
  bootstrap`).

> **`.env` permissions**: since it contains secrets (`INGEST_TOKEN`, etc.), `chmod 600 .env` is
> recommended. `./scripts/ad-attach doctor` checks for loose permissions · unset `INGEST_TOKEN`
> · an unplaced unit (it does not display values).

> **Codex daemon (optional)**: `ad-attach codex install` places the
> `actradeck-codex-attach.service` that observes the bare Codex TUI via a passive tail of the
> rollout JSONL (pure observation without spawning/killing codex). `CODEX_HOME` and the poll
> interval are passed via `.env` or a drop-in (`override.conf`) (the unit body is the default
> `codex attach`). Check the generated content with `ad-attach codex print-unit`, and follow the
> log with `ad-attach codex service logs`.

> **Re-install after updating node**: the unit / plist bakes in the absolute `node` path (neither
> systemd `--user` nor launchd inherits the interactive shell's PATH/nvm). If the node path
> changes via `nvm install`, etc., re-run `./scripts/ad-attach install` to update the unit /
> plist (so it does not stop silently on a vanished old path).

### From then on
```bash
cd ~/any/project
claude            # just start it as usual → it appears in ActraDeck's list with capture_mode=attach
```

### Status / stop
```bash
./scripts/ad-attach service status   # systemctl --user status (attach)
./scripts/ad-attach service stop     # use this to stop when running as a service (systemctl --user stop)
./scripts/ad-attach service logs     # journalctl -f
./scripts/ad-attach uninstall        # stop, disable, remove the unit (also detaches hooks from settings)

# Codex side / all-at-once (optional)
./scripts/ad-attach codex service status   # status of the codex service
./scripts/ad-attach codex service logs     # follow the codex service logs
./scripts/ad-attach codex uninstall        # stop, disable, remove only the codex service
./scripts/ad-attach status-all             # show attach + codex status together
./scripts/ad-attach uninstall-all          # stop, disable, remove both services
./scripts/ad-attach doctor                 # check .env permissions / node path / unit placement (secrets not shown)
```

> **After you rotate INGEST_TOKEN**: both services read the same `<repo>/.env` via
> `EnvironmentFile`. After updating the token, run `./scripts/ad-attach service restart` and
> `./scripts/ad-attach codex service restart` (or `uninstall-all`→`install-all`) to reflect it
> in the env of the running processes.

> To temporarily pause while running as a service, use `ad-attach service stop`. `ad-attach stop`
> (= `daemon stop`) is for foreground / one-shot startup and directly kills the service's PID, so
> it can disagree with `systemctl`'s status display (the detach itself is done correctly either
> way).

On `SIGTERM` at `stop`/`uninstall`, the CLI's shutdown handler reversibly detaches **only
ActraDeck's hook entries** from `~/.claude/settings.json` (the hooks you added are preserved).

---

## Try it once without a service

```bash
./scripts/ad-attach            # read .env, run in the foreground with user scope (Ctrl-C to detach)
./scripts/ad-attach stop       # stop + detach from another terminal
./scripts/ad-attach status     # running status · endpoint · wiring target
./scripts/ad-attach build      # rebuild the sidecar
```

`ad-attach -h` shows all subcommands.

---

## Fine-grained control with the bare CLI (`agentmon`)

`ad-attach` is a thin wrapper over `agentmon attach` (= `apps/sidecar/dist/cli.js`) below.

```bash
node apps/sidecar/dist/cli.js attach --scope user --yes      # user scope (anywhere)
node apps/sidecar/dist/cli.js attach --dry-run               # check the wiring content (does not write)
node apps/sidecar/dist/cli.js attach                         # default project-local (this repository only)
node apps/sidecar/dist/cli.js daemon stop --scope user
node apps/sidecar/dist/cli.js daemon status --scope user
```

Scope and safety guards:

| scope | Wiring target | Notes |
|---|---|---|
| `project-local` (default) | `<cwd>/.claude/settings.local.json` | gitignored. One repository only. |
| `project` | `<cwd>/.claude/settings.json` | Shared. `--yes` required. literal token-mode is **rejected** (a nonce would leak into a tracked file) → use `--token-mode env` or project-local. |
| `user` | `~/.claude/settings.json` | Global = "anywhere". `--yes` required. `ad-attach` uses this. |

- `user`/`project` scope rewrites shared/global settings, so without `--yes` (or a confirmation
  response) it **aborts with a safe-side deny**. `ad-attach` starts with `--yes` for user scope.
- token-mode is **literal by default**. Because user scope is not git-tracked, placing a nonce in
  plaintext is not a leak target, and it guarantees "just wiring makes it work" (`env` mode
  requires exporting `ACTRADECK_HOOK_TOKEN` in CC's startup shell, which breaks the "from
  anywhere" requirement).

---

## Persistent approval allowlist across restarts (Persistent Approval Allowlist · ADR 019ee0c0)

An opt-in feature that reduces the hassle of being asked for approval of the same command every
time, **only for non-dangerous operations**. When you choose "allow after restart" on a UI
approval card, that operation's signature (`sha256` · the raw command is not stored) is recorded
into `~/.actradeck/approvals/allowlist.json` (`0600`), and the same command · same repo is
auto-allowed across restarts without going through the UI.

**Default OFF**. Enabling and tuning are done via environment variables:

| Environment variable | Default | Role |
|---|---|---|
| `ACTRADECK_PERSIST_APPROVALS` | (unset=OFF) | `1` / `true` enables persistence. When OFF, even recorded entries are not honored (kill-switch). |
| `ACTRADECK_PERSIST_APPROVALS_TTL_MS` | `604800000` (7 days) | The TTL of a persistent grant (auto-expiry). Clamped to `[60000, 7776000000]` (1 minute–90 days). |

**The persistence target is only medium-risk bash commands that are "structurally simple and
contain no dangerous program".** The following do not get "allow after restart" and remain a
per-time (or per-session) confirmation (to prevent a permanent bypass):

- high-risk (`rm -rf`, etc.) / secret-laden / `.env`·credential edits / MCP / WebFetch
- commands containing composite metacharacters (pipe `|`, command substitution `$(…)`/`` `…` ``,
  process substitution `<(…)`, concatenation `&&`/`;`, redirection `>`/`<`, subshells) →
  structurally excluding `curl … | sh` / `. <(curl …)`, etc.
- the leading program being in the dangerous set: privilege escalation (`sudo`/`su`/`doas`/
  `pkexec`) / shell invocation (`sh -c`, etc.) / language interpreter inline (`node -e`/`python3
  -c`/`perl -e`/`ruby -e`/`php -r`, etc. arbitrary code execution) / publishing (`npm`/`pnpm`/
  `yarn publish`) / network-exec (`curl`/`wget`/`ssh`, etc.) / wrappers (`env`/`xargs`, etc.) /
  destructive filesystem·system changes (`chown -R`/`chgrp -R` (irreversible) / `chmod`/`rm`/
  `dd`/`mv`/`ln`/`kill`, etc.)
- `find … -exec`/`-execdir`/`-ok` (arbitrary command execution underneath)

(Example: `find /tmp/build -delete` can be persisted. `sudo systemctl restart x` / `node -e
"…"` / `curl … | sh` / `chown -R me /srv` cannot be persisted = confirm every time. In
practice, only a limited set of medium commands like `find … -delete` become persistable.
Everyday low-risk operations do not raise an approval card in the first place.)

Revocation · review can be done via two paths, an **in-UI panel** or the **CLI** (PAL-v2 · ADR
019ee147):

- **in-UI**: list and revoke in the "Persistent approvals (this machine)" panel in the cockpit's
  Session detail (machine-global. The list is a lazy pull, revoke is a POST removal. When
  persistence is OFF, even dormant entries can be swept).
- **CLI**:

```bash
node apps/sidecar/dist/cli.js approvals list                 # list persistent approvals (signature · repo · remaining TTL)
node apps/sidecar/dist/cli.js approvals revoke <sig|prefix>  # revoke a signature (exact match or unique prefix)
node apps/sidecar/dist/cli.js approvals clear                # delete all persistent approvals
```

Security assumption: the store is, like `file-lock`, a **single-operator / local-fs** assumption
(`~/.actradeck` · `0600`). Write access is the same trust boundary as the user's own privilege
(an attacker with the same privilege could already execute commands).

---

## Constraints (Attach does not own startup · control is limited)

- **Stop control is unsupported**: because the Attach-target CC is not the daemon's child
  process, interrupt does not kill a non-owned PID and is a **no-op** (safe side).
- **Claude Code's approval relay is supported**: Claude Code Attach can return allow / deny from
  the cockpit via the hooks' response path. Meanwhile, because ActraDeck does not own startup,
  this is separate from stop control.
- **codex is observation-only**: the bare Codex TUI is observed by Codex Attach (`agentmon codex
  attach` / `ad-attach codex install`) passively tailing the rollout JSONL (without
  spawning/killing codex). The write-back of approvals (interrupt/approval relay) is CC-path only
  and does not apply to codex (observe-only). This is **not unimplemented but a structural
  constraint** — the rollout JSONL is an append-only after-the-fact log, the tailer is
  read-only, and no channel exists to push decisions back into the codex TUI.
- **To relay codex approvals from the cockpit, use Managed Mode**: if you start with
  `./scripts/actradeck codex "<task>"` (a one-command thin wrapper = internally `agentmon codex
  -- "<prompt>"` = `node apps/sidecar/dist/cli.js codex -- "<prompt>"`) in a repository, ActraDeck
  spawns Codex via the App Server, relays its approval flow to cockpit cards, and can return allow
  / deny / allow-for-session (command / file / legacy-exec / legacy-patch are allow · deny both
  directions. On timeout · child loss it falls to a safe-side deny). **MVP limitation (honest
  disclosure)**: the profile grant of `item/permissions` is currently **deny-equivalent (empty
  grant) only**, and an "allow" from the cockpit does not grant additional permissions (safe side
  · does not over-permit). Advanced variants like `acceptWithExecpolicyAmendment` /
  `applyNetworkPolicyAmendment` are also not sent in the MVP.
- **The startup surface of Managed Mode (honest disclosure)**: `./scripts/actradeck codex` starts
  a headless Codex **App Server** (not the bare Codex **TUI**). The prompt is a **single
  passthrough** (multi-turn is not wired), and it **occupies the foreground** for the duration of
  that session (a separate process from the daemonized 4 tiers of `up` · Ctrl-C ends it). It
  requires the cockpit stack (`./scripts/actradeck up` = backend/webui) to be running, and if the
  sidecar dist is not built it stops prompting you to `build`. **A retrofit that later switches an
  existing Attach session to Managed is not possible** (because Managed is a path that spawns via
  the App Server at startup). Approval relay + prevention are effective only with this Managed
  startup; the bare Codex TUI (Attach observation) is detection only.
- Complete synchronization is not guaranteed (hook-driven. Details in
  [`docs/adr/0011-attach-mode.md`](./adr/0011-attach-mode.md)).

---

## Troubleshooting

| Symptom | Cause/remedy |
|---|---|
| Not in the list | backend/webui not started, or `INGEST_TOKEN` mismatched with the backend (check for 401 in `ad-attach service logs`). |
| `dist/cli.js not present` | `./scripts/ad-attach build` (`ad-attach` also attempts an auto-build). |
| Service does not start after node update (`203/EXEC`, etc.) | The old node absolute path lingers in the unit / plist. Re-run `./scripts/ad-attach install` to update. |
| Stops on logout (Linux) | `loginctl enable-linger "$USER"`. |
| Stops on logout (macOS) | A LaunchAgent persists per login session (auto-recovers on re-login). Persistence that survives logout requires a root `LaunchDaemon` and is out of scope. |
| Want to revert the settings | `./scripts/ad-attach uninstall` (detaches ActraDeck hooks from `~/.claude/settings.json`). |
