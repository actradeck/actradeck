# Architecture Decision Records

These ADRs capture the load-bearing decisions behind ActraDeck — the "why" a
contributor needs before changing the system. They are exported and condensed from
ActraDeck's internal decision log; each cites its source decision ID(s) where one
exists, or the relevant code.

The **source of truth is always the coded contract** — types, schemas, DB
constraints, and the invariant tests (`INV-*`). When an ADR and the code disagree,
the code wins; fix the ADR.

Status values: **Accepted** (in force) · **Superseded** · **Proposed**.

| #                                              | Title                                                                              | Status   |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- | -------- |
| [0001](0001-product-positioning-and-oss.md)    | Product positioning: vendor-neutral governance control plane; OSS under Apache-2.0 | Accepted |
| [0002](0002-local-sidecar-architecture.md)     | Local sidecar, outbound-only; the UI never connects to a CLI                       | Accepted |
| [0003](0003-normalized-event-model.md)         | One normalized event model across Claude Code and Codex                            | Accepted |
| [0004](0004-liveness-decomposed-heartbeats.md) | Liveness from decomposed heartbeats; "stalled" is shown with evidence              | Accepted |
| [0005](0005-session-identity-model.md)         | Session identity: canonical = Claude hook session_id, learn-once                   | Accepted |
| [0006](0006-cockpit-presence-live-model.md)    | Cockpit "live" = connection presence, not last-event guesswork                     | Accepted |
| [0007](0007-redaction-before-emit.md)          | Redaction before emit: one choke point; diffs are metrics-only or redacted-pull    | Accepted |
| [0008](0008-hook-receiver-auth.md)             | Hook receiver auth: per-launch token + loopback guard                              | Accepted |
| [0009](0009-approval-governance.md)            | Approval governance: fail-safe gate, allow-for-session, persistent allowlist       | Accepted |
| [0010](0010-auto-guard-secret-in-input.md)     | Auto-guard: a secret in tool input escalates to an approval                        | Accepted |
| [0011](0011-attach-mode.md)                    | Attach Mode: non-destructive wiring, observability-first; Codex via rollout tail   | Accepted |
| [0012](0012-threat-model-and-local-fs.md)      | Threat model: single-operator / local-fs / loopback; advisory locks; 0600 writes   | Accepted |

> This export is a curated backbone, not the complete decision history. More ADRs
> will be added as areas stabilize.
