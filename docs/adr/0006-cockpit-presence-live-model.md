# ADR 0006: Cockpit "live" = connection presence, not last-event guesswork

- Status: Accepted
- Source: decision `019ea2bf`, `019eb365`

## Context

The cockpit's headline KPI is "which sessions are live, and which need me." Deriving
"live" from last-event timing is unreliable — a genuinely live session can be quiet
(model wait), and a dead one can have a recent trailing event.

## Decision

"Live" is **connection presence**, not an event-timing heuristic. The sidecar holds
an authoritative connection per session in the `SidecarRegistry`; the cockpit's
live model reflects that presence. Presence expires on **explicit `SessionEnd` +
idle TTL** (sidecar reap), with the **backend as the authoritative source** (hello /
reap lifecycle).

This is orthogonal to liveness (ADR 0004): presence answers "is the session
connected," liveness answers "is the connected session making progress."

## Consequences

- The session list reflects real connection state, decoupled from event noise.
- Requires a presence lifecycle (hello / reap / TTL) and a backend-authoritative
  registry.
- Disconnects/crashes surface promptly via presence expiry rather than being
  inferred from silence.
