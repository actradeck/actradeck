# Contributing to ActraDeck

Thanks for your interest in ActraDeck — the local-first audit cockpit for
coding-agent sessions, secrets, and approvals. This guide covers how to set up the
project, what we expect in a pull request, and the few areas that need extra care.

> **You do not need any of the maintainers' internal tooling to contribute.**
> Internal agent rules and dev-only MCP integrations are part of
> the maintainers' own workflow. They are **not** required to build, test, or submit
> changes. The source of truth is the code, the type/schema contracts, and the
> invariant tests (`INV-*`) — everything you need is in this repo.

ActraDeck is in early, active development (pre-1.0). Expect rough edges and breaking
changes. Issues, fixes, and focused improvements are very welcome.

## Prerequisites

- **Node.js** v22.16+ and **pnpm** v10.28+ (`npm i -g pnpm`).
- **No database to install** — the default is an embedded PostgreSQL (PGlite) at
  `~/.actradeck/pgdata` (no Docker, no separate service). Docker with `docker compose`
  is needed **only** if you opt into an external Postgres (`ACTRADECK_DB_MODE=postgres`).
- At least one agent installed to see live data: **Claude Code** (`claude`) and/or
  **Codex** (`codex`).

## Setup

```bash
git clone https://github.com/actradeck/actradeck.git
cd ActraDeck
./scripts/quickstart        # .env + embedded DB + all tiers, one command
```

`quickstart` is idempotent and generates a `.env` with random local secrets on first
run. If it fails on your machine, follow the manual steps and troubleshooting in
[`docs/getting-started.md`](./docs/getting-started.md).

Local development loop (foreground, without systemd):

```bash
pnpm dev                    # backend + web UI in the foreground
```

## Project layout

ActraDeck is a pnpm-workspace monorepo:

- `apps/sidecar` — local daemon: hook receiver, app-server connector, process/stdout
  monitors, git-diff watcher, **secret redactor**, approval bridge, append-only log.
- `apps/backend` — ingestion API, event store + state engine, realtime WS/SSE.
- `apps/webui` — Next.js/React cockpit.
- `packages/*` — shared event model, projection, design tokens.

Architecture and product behavior live in [`README.md`](./README.md) and the
architecture decision records under [`docs/adr/`](./docs/adr/).

## Before you open a pull request

Please make sure the full gate is green locally:

```bash
pnpm type-check     # tsc across the workspace
pnpm lint           # eslint
pnpm format         # prettier --check (use `pnpm format:fix` to apply)
pnpm test           # vitest (unit + integration + invariants)
pnpm build          # production build of all tiers (incl. Next.js web UI)
```

A change is not ready if any of these fail. CI runs the same checks on every PR.

**Real-PostgreSQL invariant tests.** Suites gated on a reachable database (backend
real-PG `INV-*`, `db` integrity, sidecar e2e) skip when no database is configured, and
CI always runs them against a throwaway container. To run them locally, start a
disposable PostgreSQL and pass it via `ACTRADECK_TEST_DATABASE_URL` (preferred) or
`DATABASE_URL`:

```bash
docker run --rm -d -p 127.0.0.1:5455:5432 -e POSTGRES_USER=actradeck \
  -e POSTGRES_PASSWORD=test_local_only -e POSTGRES_DB=actradeck postgres:17-alpine
export PGPASSWORD=test_local_only   # keep credentials out of the URL
DATABASE_URL=postgresql://actradeck@127.0.0.1:5455/actradeck pnpm db:migrate
ACTRADECK_TEST_DATABASE_URL=postgresql://actradeck@127.0.0.1:5455/actradeck pnpm test
```

The test harness never adopts `DATABASE_URL` from your `.env`, and it refuses to run
against the production PostgreSQL port (`55432`, or your `ACTRADECK_PG_PORT`) — tests
must always use a disposable database.

**One-command CI mirror.** `./scripts/ci-preflight.sh` runs the CI jobs (`verify`,
`e2e`, `migrations`) locally, in the same order and with the same env posture — audit,
lint, format, build, type-check, every coverage gate, the real-DB invariant "actually
ran" assertions, the hook-replay e2e, and migration up/down/up. It provisions its own
disposable Postgres on `127.0.0.1:5456` — which needs Docker unless you point
`ACTRADECK_TEST_DATABASE_URL` / `DATABASE_URL` at a disposable database yourself — and
removes it on exit; a production-port DSN is refused before the first migrate. A drift
tripwire aborts loudly if the mirrored jobs gained a step or `ci.yml` gained a new job
this mirror doesn't know about (it pins step names and the job set, not step bodies —
those are thin wiring around scripts both sides share). The conditional
`docker-image-scan` job is not mirrored; for image-content changes run
`bash scripts/lib/scan-image-fs.sh` yourself. Expect a full run to take on the order of
15–30 minutes; it is the closest local answer to "will CI be green?".

## Pull request guidelines

- **Conventional Commits.** Subject in English (e.g. `fix(sidecar): …`). A short
  body describing motivation and a "Testing notes" line is appreciated.
- **Keep PRs focused.** Aim for roughly ≤800 lines of diff. Split unrelated changes.
- **Describe** the motivation, what changed, and how you verified it.
- **Tests with behavior changes.** Bug fixes and features should come with tests. If
  you fix a flaky or timing-sensitive test, explain the root cause — don't just bump
  a threshold without justification (see "Security-sensitive areas" below).

## How your PR lands

As of **2026-07-18** this repository is the **canonical source of truth** — accepted
pull requests are **merged normally**, your commits (author identity and SHAs) become
part of this repository's history, and GitHub shows your PR as **Merged**. Branch
protection requires the CI gate to pass before merge, and security-sensitive changes
additionally go through the independent audit described in
[`GOVERNANCE.md`](./GOVERNANCE.md) §3. One rule of that audit is worth stating here
because it shapes how fixes are reviewed: **a test that lands an audit finding must pin the
finding's evidence verbatim.** Matching the finding's count with a different vector, or
listing the shapes the implementation happens to catch, is not a landing — where the input
space is a grammar (shell spellings, escape forms), derive the vectors from the real
interpreter instead of by hand.

**Credit.** Your merged commits are the primary, durable record.
[`CONTRIBUTORS.md`](./CONTRIBUTORS.md) additionally credits contributors.

**History note (pre-cutover PRs).** Before the cutover this repository was a one-way
curated mirror of a private repo: its history was synthetic (one snapshot commit per
sync) and accepted PRs were imported maintainer-side via `git am` (authorship
preserved), then closed with an explanatory comment — which is why older accepted PRs
show as **Closed** rather than Merged. _Closed with an import comment_ from that era
means **imported and shipped**, not rejected; those contributors are credited in
[`CONTRIBUTORS.md`](./CONTRIBUTORS.md).

For how decisions are made and the intended path toward external maintainers, see
[`GOVERNANCE.md`](./GOVERNANCE.md).

## Where to start (good first contributions)

New here? These four areas are **safe, self-contained, and well-scoped for a first
PR** — they don't touch the security/correctness invariants in the next section, so you
can add real value without deep knowledge of the event pipeline. Look for issues
labelled
[`good first issue`](https://github.com/actradeck/actradeck/labels/good%20first%20issue),
or just open one of these:

- **Docs.** Fix typos, clarify the quickstart / manual steps, add a troubleshooting
  row, improve the support-matrix wording. Files: `README.md`, `docs/*.md`
  (`getting-started.md`, `attach-mode.md`, `demo-90s.md`). _Great first PR:_ run the
  quickstart on your OS and fix any step that didn't match what you saw.
- **Demo & fixtures.** The recording runbook and assets: `docs/demo-90s.md`,
  `scripts/record-setup-cast.sh`, `scripts/record-cockpit-cast.mjs`. Use **synthetic**
  secrets only (`AKIA…`, `ghp_…`), never real ones. _Great first PR:_ tighten the
  90-second script, or add a synthetic fixture for a new redaction kind's _display_.
- **Diagnostics.** Make failures easier to self-diagnose: preflight checks and error
  messages in `scripts/quickstart`, and the health checks in `scripts/actradeck doctor`
  / `scripts/ad-attach doctor`. _Great first PR:_ add a `doctor` check with a clear
  remediation hint, and pin it with a regression in `scripts/test-actradeck.sh`.
- **UI copy & i18n.** Cockpit labels, empty states, tooltips, and locale strings in the
  display layer under `apps/webui/src/ui/` (e.g. `redaction-display.ts` /
  `approval-display.ts` render _copy_, not the redaction/approval logic; `ui/i18n/` holds
  translations). _Great first PR:_ improve an empty-state message, or fill in a missing
  translation. (The BFF / realtime transport under `apps/webui/src/server/` and
  `src/realtime/` is the token/SSRF boundary — owned, not a first PR.)

**Open `good first issue`s are reserved for you.** Many of them are carved out of the
maintainers' internal backlog and deliberately delegated to the community: we do **not**
silently implement an open `good first issue` internally (this repository is the public
canonical; maintainer-only work lives in a private overlay). If we ever need to reclaim one
(for example it blocks a release, or it has sat unclaimed for a long time), we comment on the
issue first — so an open issue here means the work is genuinely available. Each curated issue states its target files, how to test, and acceptance
criteria, so you can start without asking for context.

> These are the areas the maintainers actively triage for newcomers. The areas in the
> next section — **redaction, approval, event ordering** — are deliberately **not** good
> first issues: they carry invariants, get extra review, and are gated by
> [`CODEOWNERS`](.github/CODEOWNERS). Please don't make them your first PR.

## Security-sensitive areas (please read)

ActraDeck's core promise is that **secrets are redacted before anything is stored or
transmitted**, and that **high-risk operations are not auto-executed without
approval**. These are invariants, not features. Changes that touch them get extra
scrutiny:

| Area                         | Invariant         | What we expect in a PR                                                                                                        |
| ---------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Secret redaction             | `INV-REDACTION`   | Redaction stays at the choke point (before persist/send); add/keep tests that prove no raw secret reaches SQLite or the wire. |
| Approval gates               | `INV-APPROVAL`    | High-risk commands stay gated; no path auto-allows dangerous operations.                                                      |
| Event ordering / idempotency | `INV-EVENT-ORDER` | Same `event_id` stays idempotent; per-session order preserved.                                                                |
| Liveness / "stalled"         | `INV-STALLED`     | Stop is shown with evidence, never asserted from a single signal.                                                             |

Rules of thumb:

- **Never weaken a security/invariant test** (e.g. relax a threshold) without a clear
  written rationale and a demonstration that the test still fails on the regression
  it is meant to catch (falsifiability preserved).
- **Never include real secrets** anywhere — in code, tests, fixtures, issues, or PRs.
  Use synthetic dummies (`ghp_…`, `AKIA…`-style), exactly as the test suite does.
- **Found a vulnerability?** Do **not** open a public issue. Follow
  [`SECURITY.md`](./SECURITY.md) (GitHub private vulnerability reporting).

## Docs and the support matrix

ActraDeck is cross-vendor, and capabilities differ by **mode**. If your change alters
what a vendor/mode supports (observe / redaction / audit / approval relay), update the
[support matrix](./README.md#vendor--mode-support) in the README. Keep public claims
matching the **default (Attach) mode** behavior — if something only works in Managed
Mode, say so.

## Code of Conduct

By participating, you agree to abide by our
[Code of Conduct](./CODE_OF_CONDUCT.md).
