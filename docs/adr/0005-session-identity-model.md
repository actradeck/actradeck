# ADR 0005: Session identity — canonical = Claude hook session_id, learn-once

- Status: Accepted
- Source: decision `019e9462`

## Context

The sidecar, the hooks, and the Codex App Server each carry their own identifiers.
The cockpit needs one stable session identity. The sidecar may also observe early
events before the canonical hook `session_id` is known, and late events after a
session ends.

## Decision

The **canonical session identity is the Claude Code hook `session_id`** (for Codex,
its thread/session id). The sidecar **learns the canonical id once**, then applies
**hold-then-flush**: early events are buffered and flushed under the canonical id
once it is known, so a race never produces two sessions for one real session.

## Consequences

- Exactly one session per real session, unified across event sources.
- Early/late events are attributed to the correct session.
- The sidecar must implement a learn-once + hold-then-flush buffer; identity
  resolution is a contract other components rely on.
