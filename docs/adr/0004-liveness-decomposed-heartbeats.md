# ADR 0004: Liveness from decomposed heartbeats; "stalled" is shown with evidence

- Status: Accepted
- Source: `plan.md` §5, §17

## Context

"Is this agent running?" cannot be answered from a single log signal. A quiet
model-wait looks identical to a hang. Asserting "stopped" when the agent is merely
waiting on the model/API destroys trust.

## Decision

Compose **multiple independent heartbeats** rather than one:

- process heartbeat (CLI alive)
- event heartbeat (events flowing)
- stdout/stderr heartbeat (command progressing)
- file heartbeat (fs watcher / git diff)
- model-stream heartbeat (message/reasoning/plan deltas)
- approval / network-MCP state

Never assert a stop. When a running session has no events for ≥ 60s, show
**"stalled suspected"** together with the per-signal breakdown (process alive?
last stdout? last event? last model delta?) and an inferred cause, so the operator
decides.

## Consequences

- Far fewer false "dead" calls; the user always sees _why_.
- The state engine must track several timers per session.
- This is a core trust feature — its accuracy directly determines whether the
  product is believed. It is covered by `INV-STALLED`.
