# ADR 0011: Attach Mode — non-destructive wiring, observability-first; Codex via rollout tail

- Status: Accepted
- Source: decision `019ea476`, `019ed59f`, `019ed8cf`, `019eb94a`, `019eb365`

## Context

Users want to observe an already-running `claude` / `codex` **without changing how
they launch it**. That is the lowest-friction adoption path, but it cannot offer the
same fidelity as launching the agent under ActraDeck's control.

## Decision

- **Claude Code Attach.** A resident daemon wires ActraDeck hooks into the user's
  settings **non-destructively**: merge + backup + self-heal + reverse-on-detach,
  serialized by a file lock so concurrent daemons never corrupt or lose-update the
  settings (`INV-ATTACH-WIRE-LOCK`). Marker entries identify ActraDeck's own hooks
  so detach removes only those.
- **Codex Attach.** Non-invasive: **tail the rollout JSONL** (primary) and read
  `config.toml`. Observability-oriented.
- **Fidelity is explicit.** Attach Mode is observability-first; stdout, stop/
  interrupt, and PID precision are lower than Managed Mode (where the sidecar spawns
  the agent). The product marks Attach as observability-/governance-oriented.

## Consequences

- Zero-change adoption for existing agents.
- The governance/redaction/audit value (which does **not** need high-fidelity
  stdout) works well over Attach — this is why the wedge (ADR 0001) fits the
  low-friction path.
- Settings wiring must never corrupt user hooks; the lock + backup + idempotent
  merge + self-heal are load-bearing. Lower process/stop fidelity is an accepted
  trade-off; Managed Mode is the high-fidelity option.
