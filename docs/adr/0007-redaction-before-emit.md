# ADR 0007: Redaction before emit — one choke point; diffs are metrics-only or redacted-pull

- Status: Accepted
- Source: decision `019ec666`, `019ec558`, `019ec6e6`, `019ec6a0`

## Context

Secrets can appear in stdout, file diffs, tool payloads, and events. Any secret
reaching the local SQLite log or the transmit path is an incident (`INV-REDACTION`).
Full diffs are the single highest-risk surface.

## Decision

- **One choke point.** `EventSink.emit` applies redaction in the order
  **redact → parse → persist → send**. No code path persists or transmits raw data;
  redaction is not a per-call option that can be forgotten.
- **Diffs.** Continuous diff events are **metrics-only** (changed files, ± lines,
  hash — no body). Detailed diff is a **gated, redacted, pull-only** channel with no
  at-rest copy.
- **Detection.** gitleaks-style rules + custom regexes + a high-entropy detector.
  Per-kind **counts** are surfaced in the UI (e.g. `github-token ×2`); the values
  themselves are never stored. Regexes are bounded to be ReDoS-safe.

## Consequences

- One place to audit, test, and reason about redaction.
- Guarded by `INV-REDACTION` and falsifiable mutation tests (bypass the choke →
  a real secret leaks → test goes red).
- Any new emit path **must** route through the choke; adding a sink that bypasses it
  is a security regression.
