# Approval policy — operations guide

One page on everything approval-related: the approval flow, the bypass/YOLO gate and its
category list, per-repo policies, the persistent allowlist, and the kill switches. For the
threat model behind these controls see [`../SECURITY.md`](../SECURITY.md).

## The approval flow in one paragraph

When an agent requests a high-risk operation, ActraDeck surfaces it as an **approval card**
in the cockpit (Approval Inbox / session detail). You allow or deny from the Web UI; the
decision is relayed back to the agent. **No response fails safe**: a timeout resolves to
**deny**, never to silent allow. Approval relay is supported for Claude Code (Managed and
Attach); plain Codex TUI sessions are observe-only (see "Honest limits" below).

## Bypass / YOLO gate (default ON)

Normally `claude --dangerously-skip-permissions` / `codex --yolo` means the agent
self-approves everything. ActraDeck's bypass gate intercepts **operator-selected high-risk
categories even in that mode** and routes them through the same approval card flow
(emit → hold → allow/deny; timeout → deny). Claude Code honors hook denies even under
`bypassPermissions`, so this is real prevention, not just an alert — an unattended YOLO
session degrades safely to timeout → deny.

- **Out-of-box safe**: works with no configuration; the default preset (below) applies
  even when no policy file exists.
- **Kill switch**: `ACTRADECK_BYPASS_CATASTROPHIC_GATE=0` (or `false`) restores pure
  pass-through observation (no gating at all).

### Category list

Categories are a closed, public enum — policies never contain raw commands. The classifier
assigns categories to each operation; the gate fires when an operation's categories
intersect your enabled set.

| Category | Matches | Default |
|---|---|---|
| `recursive-rm` | `rm -rf`, `find -delete`/`-exec`, mass file deletion | **ON** |
| `disk-destroy` | `mkfs`, `dd`, `shred`, `wipefs`, `parted`, block-device writes | **ON** |
| `history-rewrite` | `git push --force`, `git reset --hard`, `git clean -f` | **ON** |
| `db-drop` | `DROP TABLE` / `DROP DATABASE` / `TRUNCATE TABLE` | **ON** |
| `fork-bomb` | self-replicating shell patterns | **ON** |
| `secret-egress` | network-egress program (`curl`/`wget`/`nc`/`scp`…) with an **inline** secret in the command | **ON** |
| `high-risk-other` | anything classified high-risk that no named category covers (backstop against silent holes) | **ON** |
| `perm-change` | `chmod -R`, world-writable chmod, recursive chown | off |
| `inline-code` | `sh -c`, `python -c`, `eval`, `curl \| sh`, command substitution | off |
| `secret-file-edit` | edits to `.env`, `*.pem`, `id_rsa`, kubeconfig and similar | off |
| `external-tool` | MCP calls / WebFetch | off |
| `migrate-prod` | DB migrations / "production" mentions (ambiguous by nature) | off |

The seven **ON** rows are the default preset (`DEFAULT_GATED_CATEGORIES`): irreversible,
large-blast-radius operations only. The five **off** rows lean toward false positives, so
they stay off until you enable them. An empty or malformed policy file **fails safe to the
default preset** — misconfiguration can never silently disable the gate.

## Per-repo policy

The **Approval policy** view in the cockpit lets you set a machine-wide default and
**per-repository overrides** — e.g. gate `migrate-prod` only in your production repo, or
disable gating entirely for a scratch repo (an explicit per-repo empty category set means
"do not gate this repo").

- Add a repo by absolute path (the backend resolves it to its git root), or click one of
  the **observed** suggestions (working directories of sessions ActraDeck has seen).
- Changes apply **live** to connected daemons and are persisted to
  `~/.actradeck/approvals/policy.json` (`0600`).
- The policy store is **memory-authoritative**: daemons read the file once at startup and
  never hot-reload it, so an agent editing `policy.json` mid-session cannot weaken the
  live gate. Consequence: **manual file edits need a daemon restart**; changes made
  through the UI do not.
- With no agent session running, the view can still manage policies through any connected
  attach daemon, and shows a read-only last-known snapshot when nothing is connected.
- Optional: set `ACTRADECK_PROJECT_SCOPE` (a path prefix) to confine path resolution to
  your project area.

## Persistent approval allowlist (opt-in, default OFF)

Answering the same approval card on every restart gets old. With
`ACTRADECK_PERSIST_APPROVALS=1`, choosing **"allow across restarts"** on a card records a
signature (`sha256` — never the raw command) in `~/.actradeck/approvals/allowlist.json`
(`0600`); the same command in the same repo is then auto-allowed across restarts until the
TTL expires (`ACTRADECK_PERSIST_APPROVALS_TTL_MS`, default 7 days, clamped to 1 min–90 days).

A structural gate keeps dangerous things out of the allowlist — these **never** get the
persist option, no matter how often you approve them:

- high-risk commands, secrets in the command, `.env`/credential edits, MCP, WebFetch
- any compositing metacharacter: pipes, command/process substitution, `&&`/`;`, redirects,
  subshells (so `curl … | sh` can never become permanent)
- dangerous leading programs: `sudo`/`su`, shell/interpreter inline execution
  (`sh -c`, `node -e`, `python3 -c`, …), publishing (`npm publish`), network-exec
  (`curl`/`wget`/`ssh`), wrappers (`env`, `xargs`), destructive fs/system commands
  (`chmod`, `chown -R`, `rm`, `dd`, `mv`, `ln`, `kill`), `find -exec`

Review and revoke any time — in the cockpit (session detail → persistent approvals panel)
or via CLI:

```bash
node apps/sidecar/dist/cli.js approvals list
node apps/sidecar/dist/cli.js approvals revoke <sig|prefix>
node apps/sidecar/dist/cli.js approvals clear
```

Unsetting `ACTRADECK_PERSIST_APPROVALS` is itself a kill switch: recorded entries stop
being honored immediately.

## Kill switches, summarized

| Switch | Effect |
|---|---|
| `ACTRADECK_BYPASS_CATASTROPHIC_GATE=0` | Bypass/YOLO gate off — pure observation, nothing gated. |
| `ACTRADECK_PERSIST_APPROVALS` unset/`0` | Persistent allowlist off — recorded grants are not honored. |
| Per-repo empty category set | That repo is not gated (explicit, visible in the UI). |
| Deny on the approval card / let it time out | Single operation blocked (timeout = deny). |

## Honest limits

These controls are a **floor against accidents and runaway sessions**, not a sandbox
against a malicious local process:

- **`secret-egress` is inline-only.** It detects secrets present in the command string
  itself. File-reference exfiltration (`curl --data @.env`, `scp .env host:`) is not
  matched — the same inline limitation as redaction. Gating `secret-file-edit` and
  `inline-code` narrows (but does not close) that gap.
- **Memory-authoritative is a floor, not adversary-proof.** Agents can execute outside the
  sidecar entirely; the gate governs what flows through ActraDeck's hooks.
- **Codex**: prevention works in Managed mode only; plain Codex TUI (Attach) is
  observe-only — rollout observation detects, it cannot block.
- **Trust boundary**: single operator, local filesystem, loopback (see
  [`../SECURITY.md`](../SECURITY.md)). Anyone with your OS user's write access can already
  run commands directly.
