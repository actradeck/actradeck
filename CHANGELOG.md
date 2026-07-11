# Changelog

All notable changes to ActraDeck are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

ActraDeck is **early / active development (pre-1.0)**: while below 1.0.0, minor
version bumps may include breaking changes (SemVer §4). The version is applied in
**lockstep** across the root package and every workspace by `scripts/version.sh`.

## [Unreleased]

## [0.4.0] - 2026-07-11

### Added

- **One-command Docker image (cockpit stack).** A signed container image publishes the
  cockpit — backend + webui/BFF + an embedded PostgreSQL (PGlite) — so you can try
  ActraDeck with a single `docker run` and no external database, a lighter on-ramp than
  the clone/quickstart install. The image is the cockpit stack only; agent observation
  (the sidecar) stays on the host and connects over loopback (see
  [`docs/docker.md`](docs/docker.md) for the honest support matrix).
- **GHCR publishing is USER-GATED and supply-chain hardened.** Publishing is off by
  default (opt in via `ENABLE_GHCR_PUBLISH=true` or a manual workflow dispatch against a
  `vX.Y.Z` tag). When it runs, the image is **leak-scanned before push**, signed with
  **cosign keyless** (OIDC → Sigstore/Fulcio → Rekor), and carries a **SLSA build-provenance
  attestation** of the image digest — a different trust root from the product's own
  audit-export signature, never reused. Verify with `cosign verify` +
  `gh attestation verify` (commands in `docs/docker.md`).
- **External adapters via the public ingestion contract.** Two dependency-zero,
  observe-only example adapters ship: an **opencode** plugin and a **Gemini CLI** hook
  adapter (`docs/examples/`). Any tool can map its events to `provider=<slug>` /
  `source=external` and `POST /ingest`; the backend ingress redaction floor applies to
  them like any other event. External adapters carry no client-side redaction — the
  backend floor is the only redaction defense (disclosed in each adapter's README).
- **External-adapter sessions on the Live Wall.** `source=external` sessions surface on
  the wall/board via a recency proxy; terminal (ended) sessions are excluded from the
  live indicator so a completed run no longer shows as “LIVE”.
- **Managed Codex spawn from the cockpit** (opt-in, default off). Launch an in-process
  Managed Codex session over the attach daemon's control channel, with cwd containment
  and the same approval supervision as any Managed session (ADR 019f4206).
- **Public-mirror PR import flow.** `scripts/import-oss-pr.sh` imports a community pull
  request into the canonical repo with your authorship preserved (`git am`), recording
  you in `CONTRIBUTORS.md`; CONTRIBUTING documents how the one-way mirror keeps
  contributions from being lost.

### Changed

- **Headline claims scoped to what is actually enforced.** README, docs, and the
  landing page now present cross-vendor secret redaction and audit as unconditional,
  with **selective** approval governance — relayed to the cockpit for Claude Code over
  Attach and for Codex in Managed Mode; external adapters are observe-only. This matches
  the vendor/mode support matrix (no over-claiming).
- **Shipped docs are English-canonical with Japanese companions** (`*.ja.md`).
- **`capture_mode` is shown at the session-list level** for an honest per-session view
  of how each agent is being observed.

### Security

- **Redaction floor: two straddle-leak classes bounded.** Secrets that straddled the
  redaction window could previously leave a raw prefix at rest below a rule's minimum
  match length. Both the PEM private-key class (SEC-2) and the JWT class (SEC-1) are now
  bounded, pinned by falsifiable real-PostgreSQL invariants (redact-before-truncate).

### Fixed

- Closed CodeQL true-positives (prototype-pollution, ReDoS) and a dead store; eliminated
  polynomial ReDoS in the ingestion-contract doc extractors.

## [0.3.0] - 2026-07-05

The first release produced by the signed pipeline (versioned tarball + CycloneDX
SBOM + SLSA build provenance). Prior public releases v0.1.0 (2026-06-27) and v0.2.0
(2026-06-30) were early manually-cut previews without signing; their notes live on the
GitHub Releases page. Everything below already works today against a live stack
with real sessions (no mocks); see the README support matrix for what each vendor mode
relays.

### Added

- **Secret redaction before persist or transmit (INV-REDACTION).** A single
  choke-point redactor masks detected secret keys, tokens, and `.env` contents
  _before_ any event reaches disk or the network, with per-kind counts surfaced in
  the cockpit. Detection is best-effort pattern matching (gitleaks-style rules plus
  custom regexes) — a strong safety net, not an absolute guarantee.
- **Approval governance (selective by mode).** A structural risk classifier gates
  high-risk commands and relays approval cards to the cockpit — for Claude Code over
  Attach and for Codex in Managed Mode; external adapters are observe-only. An opt-in
  persistent allowlist skips re-approving _safe_ operations without ever auto-allowing
  dangerous ones. Per-repo approval policy and a default-on catastrophic-operation gate
  for bypass/YOLO modes.
- **Cross-vendor observation.** Claude Code (via hooks) and Codex (via rollout
  tailing in Attach Mode, or the App Server in Managed Mode) are normalized into one
  common event model, surfaced in one approval inbox.
- **Live session state by evidence.** running / waiting-approval / waiting-user /
  stalled derived from decomposed liveness heartbeats, not a single signal.
- **Audit & replay.** Every session can be replayed after the fact. Session reports
  export to HTML/Markdown with an embedded integrity manifest (SHA-256 hash chain).
  Setting `ACTRADECK_AUDIT_SIGNING_KEY` (Ed25519) produces a signed, tamper-evident
  report that a recipient can independently verify was not altered after export.
- **Tamper-evident review packet.** Multiple sessions bundle into a single shareable,
  independently verifiable review packet with cross-session governance aggregation
  (hard / soft / auto gate classification) for review, incident analysis, and
  compliance workflows.
- **Local-first cockpit.** A sidecar on your machine collects structured events and
  serves a web cockpit you control (single-operator / loopback / local-fs trust
  boundary). Attach Mode observes an existing Claude Code install with minimal friction.
- **Supply-chain provenance (infrastructure).** Signed GitHub Release tooling: a
  lockstep version stamper, a CycloneDX SBOM generated from the production dependency
  closure, a release workflow that attests the release tarball with SLSA build
  provenance, and an opt-in `ACTRADECK_VERIFY=1` install path that fails closed if
  provenance is absent or the download digest does not match.
- **Public ingestion contract.** Any tool can normalize its own events and `POST /ingest`
  them into the cockpit ([docs/ingestion-contract.md](docs/ingestion-contract.md)):
  `provider` is an open slug dimension (`^[a-z][a-z0-9_-]{0,31}$` — a charset/length
  bound, not secret detection), `source` gains `"external"`, and `event_type` stays a
  closed enum (the state machine gives each type meaning; normalization is the
  adapter's job). The doc's golden example and event-type list are pinned by contract
  tests, so the published contract cannot silently drift from the schema. Ships with a
  zero-dependency example adapter (`docs/examples/ingest-adapter`).
- **Ingress redaction floor.** Direct `/ingest` POSTs that bypass the sidecar are now
  unconditionally redacted _before_ persist (shared `@actradeck/redaction` single
  source), and redaction counts are re-derived server-side from actual markers —
  client-declared counts are never trusted. This is an accident-prevention floor for
  honest adapters, not a defense against adversarial `INGEST_TOKEN` holders (they are
  inside the trust boundary).

### Fixed

- **File-lock lost-update race (found while de-flaking its own test).** The advisory
  file lock that serializes approval-allowlist, approval-policy, and attach-settings
  persistence had an empty-file window between exclusive create and pid write
  (create-then-fill TOCTOU): under CPU pressure a second process could misread the
  brand-new lock as stale, take it over, and enter the critical section concurrently —
  losing updates. Acquisition now publishes the lock file atomically _with_ its holder
  pid (hardlink from a pid-bearing temp), structurally removing the window. Pinned by a
  real multi-process invariant test (`INV-FILELOCK-NO-EMPTY-WINDOW`).

[Unreleased]: https://github.com/actradeck/actradeck/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/actradeck/actradeck/releases/tag/v0.4.0
[0.3.0]: https://github.com/actradeck/actradeck/releases/tag/v0.3.0
