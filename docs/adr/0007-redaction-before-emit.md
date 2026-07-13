# ADR 0007: Redaction before emit — one choke point; diffs are metrics-only or redacted-pull

- Status: Accepted (amended 2026-07-07 — second floor at backend ingress; amended
  2026-07-13 — detection scope clarified against the benchmark, see Amendments)
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

## Amendment (2026-07-07): a second, unconditional floor at backend ingress

The public ingestion contract (`docs/ingestion-contract.md`, §5) later added a
path where external adapters POST normalized events directly to the backend,
bypassing the sidecar. The sidecar choke point above therefore governs the
agent-attach path and is no longer the *only* redaction layer in the system:
backend ingress applies an unconditional redaction floor
(`redactEventWithAuthoritativeCounts`, applied ahead of the single
`store.ingest` call site) to **every** event — whichever transport or source —
and re-derives redaction counts authoritatively, ignoring client-declared
counts. The consequence above still holds for sidecar-collected data (a sink
that bypasses the sidecar choke is a security regression); direct-POST adapters
are covered by the backend floor.

## Amendment (2026-07-13): detection is best-effort — scope of "never stored"

"The values themselves are never stored" (Detection, above) holds at
**rule-captured-span** semantics: the span a rule captures is replaced by a marker
and never persisted. The pipeline-order guarantee (redact → parse → persist → send)
is structural and unchanged, but two best-effort limits bound what that means:
(a) detection recall is best-effort pattern matching, and (b) a rule's capture is
**bounded**, so a very long credential value can be counted as detected (marker +
count emitted for the captured span) while the portion beyond the bounded capture
survives at rest — the benchmark's fragment-survival measurement documents exactly
this. Measured limits, including partial fragment survival and cross-eval coverage
against gitleaks rules, are in
[`docs/benchmarks/redaction-and-risk-classifier.md`](../benchmarks/redaction-and-risk-classifier.md).
Public copy must not make value-completeness claims — describe masking as applied
to detected patterns / masked spans, not as "the (detected) secret never remains".
