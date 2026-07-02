# ActraDeck

**The vendor-neutral control plane for coding-agent approvals, secrets, and audit.**

ActraDeck sits beside your coding agents — Claude Code, Codex, and whatever comes
next — and gives you **one place to approve what they do, stop secrets before they
are stored, and keep an audit trail across vendors**. It is local-first: a sidecar
on your machine collects structured events, redacts secrets _before_ anything is
persisted, and serves a web cockpit you control.

> Status: **early / active development (pre-1.0).** The pieces below work today; the
> declarative policy engine, tamper-evident audit export, and team features are on
> the roadmap. Expect rough edges and breaking changes.

## See it in action

A walkthrough of the cockpit, recorded against a **live stack with real sessions**
(secrets are already masked at the sidecar before anything is shown):

![ActraDeck cockpit walkthrough](docs/media/usage.gif)

▶ **Full walkthrough (~90s):** [`docs/media/usage.mp4`](./docs/media/usage.mp4) —
live wall, liveness-by-evidence, secret redaction with per-kind counts, cross-vendor
audit (Claude Code **and** Codex in one trail), the approval inbox, and session
replay. The 90-second product-story runbook is in
[`docs/demo-90s.md`](./docs/demo-90s.md); regenerate this recording from your own
stack with [`scripts/record-cockpit-cast.mjs`](./scripts/record-cockpit-cast.mjs).

## Why this exists

Vendors are already building great single-vendor dashboards (e.g. Claude Code's
Agent View). ActraDeck deliberately does **not** try to win the "overview of my
parallel sessions" race for a single vendor. Instead it owns the slice a model
vendor structurally will not build: **neutral governance across competing agents.**

- **Approval governance, not just a prompt.** A structural risk classifier gates
  high-risk commands; an opt-in persistent allowlist lets you skip re-approving
  _safe_ operations without ever auto-allowing dangerous ones.
- **Secrets never hit disk.** Redaction runs _before_ persist/transmit — secret
  keys, tokens, `.env` contents are masked at the choke point, with per-kind counts
  shown in the UI (the values themselves are never stored).
- **Audit & replay.** Every session can be replayed after the fact for review,
  incident analysis, or compliance.
- **Cross-vendor.** One event model and one audit trail spanning Claude Code _and_
  Codex, surfaced in one approval inbox (see the support matrix for what each mode
  relays — more agents over time).

## What works today

- Observe **Claude Code** (via hooks) and **Codex** (via rollout tailing in Attach
  Mode, or the App Server in Managed Mode) through a common, normalized event model.
- **Live session state** — running / waiting-approval / waiting-user / stalled /
  failed / completed — derived from decomposed heartbeats (process / event /
  stdout / model-stream), so "stalled" is shown with evidence, not asserted.
- **Approval inbox** across sessions and agents; allow / deny / allow-for-session,
  with an opt-in restart-persistent allowlist for safe operations.
- **Secret redaction before persist**, with per-kind redaction counts in the UI.
- **Session replay** and an append-only local event log.

## Vendor / mode support

What each agent gets depends on the mode you run it in. Attach Mode (the quickstart
default) needs no change to how you launch agents; Managed Mode (ActraDeck spawns the
agent) adds approval relay for Codex.

| Capability                                     | Claude Code (Attach) | Codex (Attach)  | Codex (Managed) |
| ---------------------------------------------- | :------------------: | :-------------: | :-------------: |
| Observe — state, current action, diffs         |          ✅          |       ✅        |       ✅        |
| Redaction before persist                       |          ✅          |       ✅        |       ✅        |
| Audit log + replay                             |          ✅          |       ✅        |       ✅        |
| Approval relay — allow / deny from the cockpit |          ✅          | ⛔ observe-only |       ✅        |

So **observation, redaction, and audit are cross-vendor today** in the default Attach
Mode. **Approval relay** works for Claude Code over Attach; for Codex it requires
Managed Mode (App Server) — over Attach, Codex is observed and its native approvals
still happen in its own TUI. (Claude Code in Managed Mode is all ✅, omitted for brevity.)

## Quickstart

One line — fetch the source and bring up the cockpit (needs `git`, Node 22.16+, and
pnpm; **no Docker**, the database is embedded):

```bash
curl --proto '=https' --tlsv1.2 -fsSL https://raw.githubusercontent.com/actradeck/actradeck/main/scripts/install.sh | sh
```

> This downloads a script and runs it. Prefer to read it first (a good habit for anything
> piped into a shell)? Fetch it, `less` it, then run it — or skip it and use the manual
> clone below. The installer handles no secrets (quickstart generates a local `.env` at
> mode `0600`), needs no root, and clones to `~/actradeck` (override with
> `ACTRADECK_INSTALL_DIR`; pin a ref with `ACTRADECK_REF`). It becomes live once the
> repository is public — until the OSS release, use the manual steps.

Already cloned, or prefer to do it by hand (needs Node 22.16+ and pnpm — **no Docker**):

```bash
./scripts/quickstart      # .env + embedded DB + all tiers, one command
```

The database is an embedded PostgreSQL (PGlite) at `~/.actradeck/pgdata` — no Docker, no
separate service. To use an external Postgres instead (production or an existing DB), set
`DATABASE_URL` in `.env`, or run `ACTRADECK_DB_MODE=postgres ./scripts/quickstart` to bring
one up via `docker compose`.

![ActraDeck first-run: fresh clone → running cockpit, recorded on a clean machine](docs/media/first-run.gif)

Then open the cockpit at **http://localhost:55400** and run your agents normally —
no change to how you start them:

```bash
cd ~/any/project && claude     # or: codex  → shows up in the cockpit
```

> Both agents appear immediately. Over Attach (the default), **Codex is observed** —
> its approvals stay in its own TUI; cockpit **approval relay for Codex needs Managed
> Mode** (see the [support matrix](#vendor--mode-support)). Claude Code approvals
> relay over Attach.

`quickstart` is idempotent and generates a `.env` with random local secrets on first
run. It daemonizes the four tiers via `systemd --user` (Linux) or **launchd
LaunchAgents** (macOS) — `./scripts/actradeck up` picks the supervisor automatically.
The macOS LaunchAgents run in your login session (always-on while logged in, and they
auto-start on next login); a fully headless, survives-logout daemon would need a root
`LaunchDaemon`, which is out of scope. On a host with neither systemd nor launchd,
`up` falls back to a foreground supervisor (keep the terminal open; Ctrl-C stops it).

> **macOS launchd is experimental.** The Linux `systemd` path is used daily; the launchd
> path is structurally verified (plist generation, secret hygiene, XML well-formedness are
> covered by the smoke tests) but its runtime — `launchctl bootstrap`, restart-on-crash,
> and persistence across login — has not yet been exercised on a Mac. Report anything odd.

Prefer to do it by hand, or hit a snag? See
[`docs/getting-started.md`](./docs/getting-started.md) (manual steps +
troubleshooting). The precision/limits of Attach Mode are in
[`docs/attach-mode.md`](./docs/attach-mode.md).

> Attach Mode is observability + approval/redaction/audit oriented and does not
> require launching agents through ActraDeck. A higher-fidelity Managed Mode
> (ActraDeck spawns the agent) is also planned/partially available.

## Architecture

```
[Claude Code / Codex CLI / Codex App Server]
        │  hooks / JSON-RPC events
        ▼
[Local Sidecar]  process monitor · stdout/stderr · git diff · secret redactor · approval bridge
        │  redact-before-emit → append-only local log
        ▼
[Ingestion API] → [Event Store + State Engine] → [Realtime WS/SSE] → [Web Cockpit]
```

Design principle: the Web UI never connects directly to local CLIs. The sidecar is
the single choke point where redaction is applied before anything is stored or sent.

- Architecture decision records: [`docs/adr/`](./docs/adr/)
- 90-second demo runbook: [`docs/demo-90s.md`](./docs/demo-90s.md)

## Security

Secret redaction before persist is a core invariant, not a feature flag. If you
believe you have found a vulnerability (a redaction bypass, an approval-gate
bypass, an SSRF in a connector, etc.), please **do not open a public issue** —
see [`SECURITY.md`](./SECURITY.md) for responsible disclosure.

## Contributing

ActraDeck is a monorepo (pnpm workspaces): `apps/sidecar`, `apps/backend`,
`apps/webui`, and shared `packages/`. TypeScript strict, conventional commits,
CI on every PR. See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for setup, the local
verification gate, PR guidelines, and the security-sensitive areas that need extra
care; all participants are expected to follow our
[`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md). For deeper context, the ADRs under `docs/adr/`
describe how the system is meant to
behave. Issues and pull requests are welcome.

## License

[Apache License 2.0](./LICENSE).
