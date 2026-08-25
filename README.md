# ActraDeck

[![CI](https://github.com/actradeck/actradeck/actions/workflows/ci.yml/badge.svg)](https://github.com/actradeck/actradeck/actions/workflows/ci.yml)
[![GitHub release](https://img.shields.io/github/v/release/actradeck/actradeck)](https://github.com/actradeck/actradeck/releases/latest)
[![npm](https://img.shields.io/npm/v/actradeck?logo=npm)](https://www.npmjs.com/package/actradeck)
[![GHCR](https://img.shields.io/badge/GHCR-multi--arch%20image-2496ED?logo=docker&logoColor=white)](https://github.com/actradeck/actradeck/pkgs/container/actradeck)
[![License](https://img.shields.io/github/license/actradeck/actradeck)](LICENSE)

**Put risky coding-agent actions back in front of a human.**

ActraDeck is a local cockpit for Claude Code and Codex. It surfaces detected high-risk
actions for review where the agent mode supports approval relay, masks detected secrets
before ActraDeck stores them, and keeps each session replayable across agents.

```text
Claude Code requests:
  rm -rf ./important-directory

[HIGH RISK] recursive filesystem delete detected
[HELD]      waiting for your decision
[DENIED]    no approval received; safe-side timeout
```

No cloud account is required. ActraDeck runs on your machine and binds to loopback by
default.

> **Status:** early, active development (pre-1.0). Detection is best-effort, not a
> sandbox or an absolute security boundary. Read the [honest limits](#honest-limits)
> before relying on approval or redaction behavior.

## See the outcome, not the feature list

The first job is simple: **stop approving agent actions blindly**. When ActraDeck
recognizes a risky request, it puts the decision and its context in one approval inbox.
From there the same event becomes useful for more than the immediate decision:

1. **Review** — allow, deny, or allow-for-session where approval relay is supported.
2. **Redact** — mask recognized credentials before ActraDeck persists observed events.
3. **Replay** — inspect what the agent attempted and how the operator responded.
4. **Unify** — keep Claude Code and Codex sessions in one local audit trail.

![ActraDeck cockpit walkthrough](docs/media/usage.gif)

▶ [Full walkthrough (~90s)](./docs/media/usage.mp4) shows live sessions, the approval
inbox, redaction counts, and replay using a live stack.

## See the decision flow in five seconds

```bash
npx actradeck@latest demo
```

This prints a clearly labelled, synthetic preview of detect → hold → deny → redact →
record. It has no network, filesystem, subprocess, install, or agent side effects. Use
the cockpit demo below when you want to exercise the real application pipeline.

## Try the built-in 30-second demo

Run the cockpit without installing Node, pnpm, or a database:

```bash
docker run --rm \
  -p 127.0.0.1:55400:55400 \
  -v actradeck_pgdata:/data \
  ghcr.io/actradeck/actradeck:latest
```

Open <http://localhost:55400>, then click **Run the 30-second safety demo**. A
throwaway session drives the real ingestion → approval card → redaction → audit pipeline:

- a synthetic destructive command is held for review and never executed;
- dummy credentials pass through the production redaction floor before storage;
- the final decision and redacted events appear in replay.

The demo proves ActraDeck's event path, UI, and storage behavior. It does not claim to
halt a real process; the command is intentionally synthetic and never runs. See the
[full demo scope](./docs/docker.md#run-the-30-second-safety-demo-no-host-wiring).

## Put it beside your real agents

The native quickstart installs the host-side observer and starts the local cockpit. It
needs `git`, Node 22.16+, and pnpm; the database is embedded and Docker is not required.

```bash
curl --proto '=https' --tlsv1.2 -fsSL \
  https://raw.githubusercontent.com/actradeck/actradeck/main/scripts/install.sh | sh
```

Then launch agents as usual:

```bash
cd ~/any/project
claude     # approval relay + observation in Attach Mode
codex      # observation in Attach Mode; native approvals remain in the Codex TUI
```

For Codex approval relay, use Managed Mode:

```bash
./scripts/actradeck codex "refactor the payment module"
```

Inspect privacy-preserving local usage totals without exporting audit contents:

```bash
./scripts/actradeck usage --since 30d
./scripts/actradeck usage --since 30d --json
```

Only UTC daily aggregates are returned. The definitions and public npm/GitHub snapshot workflow
are documented in [Usage metrics](./docs/usage-metrics.md).

Optional central product telemetry is **off by default**. Every user can inspect the complete
outgoing daily-counter batch, opt in, stop and delete the random identifier from
**Settings → Privacy** in the Cockpit or the CLI:

```bash
./scripts/actradeck telemetry status
./scripts/actradeck telemetry preview
```

Each row is an event name, UTC day, count, ActraDeck version, and coarse OS; it cannot represent
prompts, commands, paths, repository names, session/event IDs, secrets, or audit bodies. Received
rows are purged after 24 months; deleting your own rows earlier requires emailing your
installation ID to privacy@actradeck.io before you delete it locally — see the
[anonymous telemetry contract, collector, and retention notes](./docs/anonymous-telemetry.md).

Prefer to inspect scripts before running them? Use the
[manual and verified installation paths](./docs/getting-started.md), or diagnose the
machine first with `npx actradeck@latest doctor`.

## What works today

| Capability                                             | Claude Code Attach | Codex Attach | Codex Managed |
| ------------------------------------------------------ | :----------------: | :----------: | :-----------: |
| Live state, actions, and diffs                         |         ✅         |      ✅      |      ✅       |
| Detected-secret redaction before ActraDeck persistence |         ✅         |      ✅      |      ✅       |
| Audit log and replay                                   |         ✅         |      ✅      |      ✅       |
| Approval relay from the cockpit                        |         ✅         | observe-only |      ✅       |

Attach Mode does not change how you launch an agent. Managed Mode lets ActraDeck spawn
the agent and participate in its approval flow. The precise lifecycle and capability
limits are documented in [Attach Mode](./docs/attach-mode.md).

Other CLIs can send normalized events through the public ingestion contract. Dependency-
free example adapters for **opencode** and **Gemini CLI** are included, currently as
observe-only integrations. Start with the
[ingestion contract](./docs/ingestion-contract.md) and validate an adapter stream with:

```bash
npx actradeck@latest conformance < events.jsonl
```

## Why use a separate cockpit?

Vendor dashboards are the natural place to optimize one agent. ActraDeck is useful when
you want the same review vocabulary and history while switching between agents, or when
the person reviewing a session is not living inside that agent's terminal.

It is aimed at:

- developers using permissive/YOLO modes who still want a catastrophic-action floor;
- people running Claude Code and Codex side by side;
- teams evaluating which agent attempted what, and how a human responded;
- platform or security engineers prototyping local coding-agent governance.

It is not yet a multi-user enterprise control plane, a complete shell sandbox, or proof
that every possible secret and dangerous command will be recognized.

## What is under the hood

- A structural command-risk classifier and configurable approval categories.
- A two-layer secret redactor: sidecar before local persistence/transmission, plus an
  unconditional backend floor before backend persistence.
- Live state derived from process, event, output, and model-stream evidence.
- An append-only local event history with session replay.
- HTML, Markdown, and JSON audit exports with a SHA-256 integrity manifest; optional
  Ed25519 signing has a deliberately documented binding scope.
- An open provider slug and closed event vocabulary for third-party adapters.

These mechanisms are documented and benchmarked, but the benchmarks use synthetic
corpora. They measure the shipped detector; they do not turn pattern matching into a
guarantee.

## Installation choices

The shortest path is the native installer above. These alternatives are available when
you need a different trust or runtime model:

<details>
<summary><strong>Verified signed release</strong></summary>

Requires the GitHub CLI and verifies the release checksum and provenance before
extraction:

```bash
curl --proto '=https' --tlsv1.2 -fsSL \
  https://raw.githubusercontent.com/actradeck/actradeck/main/scripts/install.sh -o install.sh
ACTRADECK_VERIFY=1 ACTRADECK_REF=v0.7.0 sh install.sh
```

The npm bootstrapper exposes the same verified path:

```bash
npx actradeck@latest install
```

</details>

<details>
<summary><strong>Already cloned</strong></summary>

```bash
./scripts/quickstart
```

The command creates a mode-`0600` `.env`, installs missing dependencies, builds the
workspace, starts the embedded database, and wires supported host agents. It is
idempotent. See [Getting started](./docs/getting-started.md) for macOS launchd and
manual setup details.

</details>

<details>
<summary><strong>Docker cockpit plus host observer</strong></summary>

The image contains the cockpit and embedded database. A sidecar that observes real
agents must run on the host because agent processes, hooks, and rollout files are on the
host. Follow [Running ActraDeck in Docker](./docs/docker.md#observing-a-host-agent-wire-the-sidecar)
to connect them without exposing ingestion beyond loopback.

</details>

## Honest limits

- Risk classification and redaction are best-effort pattern/structure matching. Novel,
  obfuscated, or interpreter-mediated forms can be missed.
- Approval relay depends on agent and launch mode; Codex Attach remains observe-only.
- External adapters reach the backend redaction floor only after their first network hop.
- The default threat model is one operator, local filesystem, and loopback networking.
- Audit signatures have a documented binding scope, and pre-export database tampering is
  outside the current model.

Read [SECURITY.md](./SECURITY.md), the
[approval policy guide](./docs/approval-policy.md), and the reproducible
[redaction/classifier benchmark](./docs/benchmarks/redaction-and-risk-classifier.md)
for the exact boundaries.

## Architecture

```text
[Claude Code / Codex CLI / Codex App Server]
        │  hooks / rollout files / JSON-RPC events
        ▼
[Local Sidecar]  process evidence · diffs · redaction · approval bridge
        │  redact-before-emit → append-only local log
        ▼
[Ingestion API] → [Event Store + State Engine] → [Realtime] → [Web Cockpit]
```

The browser never connects directly to a local agent process. The local sidecar observes
host agents and emits normalized, redacted events; backend ingestion applies its own
redaction floor before storing anything received through the public contract.

- Development and contribution guide: [CONTRIBUTING.md](./CONTRIBUTING.md)
- Public ingestion contract: [docs/ingestion-contract.md](./docs/ingestion-contract.md)
- Architecture decisions: [docs/adr/](./docs/adr/)
- Demo recording runbook: [docs/demo-90s.md](./docs/demo-90s.md)

## Security

If you find a redaction bypass, approval-gate bypass, credential exposure, or unintended
network access, do not open a public exploit report. Follow the private reporting process
in [SECURITY.md](./SECURITY.md).

## Help shape it

ActraDeck is early enough that concrete workflows matter more than abstract feature
requests. If you try the demo, tell us which agent, mode, and risky action you most want
reviewed: [open a focused feature request](https://github.com/actradeck/actradeck/issues/new?template=feature_request.yml).
If this is a problem you want solved, a GitHub star helps other early adopters find the
project.

## Contributing

ActraDeck is a TypeScript pnpm monorepo with shared event, projection, redaction, backend,
sidecar, and web packages. CI runs on every PR. Issues and pull requests are welcome; see
[CONTRIBUTING.md](./CONTRIBUTING.md), [GOVERNANCE.md](./GOVERNANCE.md), and the
[Code of Conduct](./CODE_OF_CONDUCT.md).

## License

[Apache License 2.0](./LICENSE).
