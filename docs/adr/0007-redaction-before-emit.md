# ADR 0007: Redaction before emit — one choke point; diffs are metrics-only or redacted-pull

- Status: Accepted (amended 2026-07-07 — second floor at backend ingress; amended
  2026-07-13 — detection scope clarified against the benchmark; amended 2026-07-14 —
  bounded-capture tail survival closed by unbounding value captures, see Amendments)
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
agent-attach path and is no longer the _only_ redaction layer in the system:
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

## Amendment (2026-07-14): bounded-capture tail survival closed (unbounded value captures)

`INV-REDACTION-TAIL-SURVIVAL` (task `019f5b5e-f9e9`) unbounded every arbitrary-length
**value** capture — credential-assignment (bare/quoted), `auth-header-scheme`,
`auth-scheme-value`, `AUTH_HEADER_VALUE_RE`, `npm-auth-token`, `url-credential`
(user + pass), and `high-entropy-secret` — from `{N,MAX_VALUE_LEN}` to a single
character-class **unbounded** quantifier (`{N,}`). This structurally closes the
bounded-capture **tail survival** that the 2026-07-13 amendment described: a detected
credential value no longer leaves a raw tail (or, for quoted/url values whose closing
delimiter sat beyond the cap, a full raw value). The benchmark's fragment-survival
count went **1 → 0**, and the fix is pinned per-capture (reverting any single capture
to bounded turns exactly its own INV case RED). This is **append-only**: the pipeline
order (redact → parse → persist → send) and both floors are unchanged.

Scope of this amendment (what it does **not** claim):

- **2026-07-13 point (b) no longer applies to these value captures.** A rule's value
  capture is no longer bounded, so "the portion beyond the bounded capture survives" is
  closed for the unbounded value rules. Point (b) is superseded **only for those rules**.
- **Point (a) is unchanged.** Detection **recall** is still best-effort pattern
  matching — an undetected pattern is still not masked.
- **Deliberately still bounded.** Fixed-format vendor tokens, `jwt` segments, and
  key/scheme/host tokens remain `{N,MAX_VALUE_LEN}` / `{N,MAX_KEY_TOKEN}` by design
  (their real values are bounded; bounding limits false positives and ReDoS surface).
- **Terminator-bearing value captures** (quoted credential-assignment, `url-credential`
  pass, quoted `npm-auth-token`) are unbounded but require an in-window closing
  delimiter (`"` / `'` / `@`); their realistic values are sub-KB so window-external
  straddle is practically unreachable, and PEM/JWT keep their dedicated fallback
  branches for genuinely KB-scale bodies (redactor `PRE_REDACT_SLICE` census).
- **String-path unterminated / newline-split gap closed for credential-assignment
  (SEC-1, landed 2026-07 via full re-audit).** An **unterminated** (no closing quote)
  or **newline-split** quoted credential in raw text previously failed all three
  quoted/bare rules and stayed raw. A 4th `credential-assignment` fallback now detects
  keyword + `[:=]` + opening quote and masks the value via branch1 (cross-newline lazy
  to the closing quote within the pre-redact window) / branch2 (unterminated → EOL);
  `_authToken` masks unterminated quoted npm tokens by keyword overlap. Pinned by
  `INV-REDACTION-QUOTED-CRED-UNTERMINATED` (falsifiable: reverting the rule reddens the
  leak-closure cases). The credential-**key** object path was already safe via
  `isCredentialKey`.
- **Anchor-independent closure (task `019f5ca4`, this release).** A structural scanner
  (`maskMultilineQuotedCredentials`) now runs before the regex rules: single-line
  terminated values are untouched; a closing-quote candidate immediately preceded by
  another credential opener is rejected as a terminator (suspicious-close chain, closing
  the merge/A1 class on single-line and multi-line inputs alike); truly unterminated
  values are greedily masked to the window end with a ` [REDACT-SWALLOWED:n]` length
  hint (same missing-terminator semantics as the private-key/JWT fallbacks). The
  `url-credential` missing-`@host` class is closed by an @-less rule with a port-shape
  gate (1-5 digits followed by a URL authority terminator is kept as a port) and
  RFC-3986 userinfo capture charsets.
- **Disclosed residuals after closure (accepted, pinned by
  `INV-REDACTION-QUOTED-CRED-UNTERMINATED` / `INV-REDACTION-URLCRED-ANCHORLESS`).**
  (a) The scanner is quote-anchored: non-quoted multi-line credentials (YAML block
  scalars `password: |`, backticks, bare newline-split values, heredocs) remain out of
  scope. (b) A multi-line value is closed at the first non-suspicious same-type quote;
  content after that structural close is outside the string by definition. (c) @-less
  URL passwords that are 1-5 pure digits (indistinguishable from a port), or digits
  followed by a structural delimiter (`svc:99#frag` ≡ port+fragment), are kept; a pass
  containing URL-illegal characters is masked only up to the first structural
  terminator (`/`-containing passwords tracked separately). All residuals are
  single-operator/local-fs bounded.
- **Public copy value-completeness prohibition is retained** (2026-07-13): describe
  masking as applied to detected patterns / masked spans, not as blanket completeness.

Cross-ref: [`docs/benchmarks/redaction-and-risk-classifier.md`](../benchmarks/redaction-and-risk-classifier.md)
(Fragment survival + Honest limitations) and `packages/redaction/test/inv-redaction-tail-survival.test.ts`.
