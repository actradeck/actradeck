# ADR 0009: Approval governance — fail-safe gate, allow-for-session, persistent allowlist via a structural gate

- Status: Accepted
- Source: decision `019ee0c0`, `019ee147`, `019ee5a9`; `allow_for_session` (`019e9b7a`)

## Context

High-risk agent operations must not auto-execute. Remote approval depends on a
hook / JSON-RPC wait, so timeouts must be safe. Re-approving the same _safe_
operation every time is friction — but auto-allowing a _dangerous_ one is
unacceptable. Approval spans vendors (Claude Code permission flow + Codex App
Server decisions).

## Decision

- **Fail-safe gate.** The approval bridge gates on a structural risk classifier.
  Timeout → ask/deny; high-risk → always UI approval; `.env`/secret/prod → deny or
  strong approval.
- **allow_for_session.** An in-memory signature cache skips re-approval of the same
  operation for the process lifetime only.
- **Persistent allowlist** (opt-in, off by default, TTL). Survives restart for
  **medium-risk only**, decided by a **structural predicate that shares the
  classifier's tokenizer/normalization** — never a hand-written parser (parser
  drift is a repeated bypass source). It denies anything with shell metacharacters,
  dangerous programs, or destructive disk/FS tools, using a **read-only allowlist
  inversion** so future destructive subcommands are closed by default. Only a
  `sha256` signature is stored — never the raw command.
- **Revocation.** In-UI panel or CLI (`approvals list|revoke|clear`), plus TTL
  auto-expiry.

## Consequences

- Dangerous operations stay gated across restarts; only structurally-simple safe
  operations can ever auto-allow.
- The persist gate **must** reuse the canonical classifier (shared
  tokenize/normalize) — this is the contract that closes whole classes of bypass.
- Cross-vendor approvals land in one inbox (a key differentiator vs single-vendor
  dashboards).
