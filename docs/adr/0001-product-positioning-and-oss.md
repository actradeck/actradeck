# ADR 0001: Product positioning — vendor-neutral governance control plane; OSS under Apache-2.0

- Status: Accepted
- Source: decision `019ee9c1`, `019ec619`, `019ec632`

## Context

Model vendors ship strong single-vendor multi-session dashboards (e.g. Claude
Code's Agent View, May 2026). Competing on "an overview of my parallel sessions"
for one vendor is a losing race against the vendor's own free, zero-setup tool.
ActraDeck needs a wedge a model vendor will not build.

## Decision

Position ActraDeck as **the vendor-neutral control plane for coding-agent
approvals, secrets, and audit** — the slice a model vendor structurally will not
build, because it requires neutrally governing competitors' agents (Claude Code,
Codex, and more over time). Concede the single-vendor session overview to the
vendors.

Release as open source under **Apache-2.0**, on an **open-core** boundary:

- **OSS core**: sidecar, normalization, redaction, local supervision, single-user
  approval.
- **Commercial/team** (later): multi-user policy, SSO/RBAC, audit retention/export,
  hosted aggregation.

Validate demand on the wedge before deepening (do not harden internals ahead of
proof).

## Consequences

- Build cross-vendor + governance + audit, not a prettier dashboard.
- Slower, more enterprise-leaning adoption; open-core resolves the OSS-vs-moat
  tension.
- Existing security rigor (redaction, structural approval gates, audit) becomes the
  product, not gold-plating — but only pays off once demand is proven.
