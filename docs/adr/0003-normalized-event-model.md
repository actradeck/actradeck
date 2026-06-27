# ADR 0003: One normalized event model across Claude Code and Codex

- Status: Accepted
- Source: `plan.md` §1, §4, §6; `packages/event-model`; decision `019ec744`

## Context

Claude Code (via hooks) and Codex (via App Server JSON-RPC) emit different event
shapes. The state engine and UI need a single shape. Model chain-of-thought is
unstable across provider/policy changes, so it is deliberately excluded — ActraDeck
shows **observed work state**, not model internals.

## Decision

Normalize every provider into one event model (`packages/event-model`):

- A closed set of event types (`session.*`, `turn.*`, `tool.*`, `command.*`,
  `file.change.*`, `mcp.call.*`, `web.search.*`, `approval.*`, `heartbeat`,
  `stalled.detected`, `error`, …).
- A normalized state enum (`running.model_wait`, `running.command_executing`,
  `waiting.approval`, `stalled`, …).
- The redaction-kind vocabulary is part of this T1 model as a closed enum.

External interoperability is provided by an **OTLP exporter**, not by depending on
the still-evolving OpenTelemetry GenAI spec; the internal model is stabilized
in-house.

## Consequences

- New providers normalize into the same contract; the UI stays provider-agnostic.
- Cross-vendor features (one approval inbox, one audit trail) are possible because
  both providers land in one model.
- The model is a contract: changes go through the schema + `INV-*` tests, not
  ad-hoc per-provider shapes.
