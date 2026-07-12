# ADR 0002: Local sidecar, outbound-only; the UI never connects to a CLI

- Status: Accepted
- Source: maintainers' internal product spec (not shipped in this repo)

## Context

ActraDeck must observe local CLIs (Claude Code, Codex) reliably across corporate
networks, NAT, and firewalls — without scraping terminal screens and without
exposing the Web UI to arbitrary local processes.

## Decision

A **local sidecar daemon** is the integration point. It collects structured
signals (hooks / Codex App Server / process liveness / stdout-stderr / git diff),
**redacts secrets**, keeps an **append-only local log**, and connects **outbound**
to the ingestion API. The Web UI never connects directly to a local CLI.

Pipeline:

```
Sidecar → Ingestion API → Event Store + State Engine → Realtime (WS/SSE) → Web Cockpit
```

The sidecar is the single egress and redaction choke point for agent-collected
data. (External adapters that POST directly to the ingestion API bypass the
sidecar and are covered by an unconditional backend ingress redaction floor —
see ADR 0007, Amendment.)

## Consequences

- Redaction and auth are enforced at defined choke points — the sidecar for
  agent-collected data, plus the unconditional backend ingress floor for
  everything else (see ADR 0007 incl. Amendment, 0008).
- Works behind NAT/firewalls (outbound connections only).
- Structured events only — no terminal scraping, so the data is stable against
  cosmetic CLI changes.
- The sidecar owns the highest-risk surface; it must fail safe and never persist or
  transmit raw data.
