# ADR 0010: Auto-guard — a secret in tool input escalates to an approval

- Status: Accepted
- Source: decision `019ecc70`, `019ecc85`

## Context

A tool input may itself contain a secret — e.g. a Bash command embedding a token,
or a file edit pasting a credential. Executing it both leaks the secret and is
often risky in its own right. The normal risk classifier looks at the operation
shape, not at whether the payload carries a secret.

## Decision

Detect secrets **in tool input** and escalate that operation to an approval
("auto-guard"), independent of its base risk level. The approval card surfaces the
**trigger** and the **redaction-kind names** only (NO-RAW — never the secret value).

A **secret-triggered** approval is **not eligible** for `allow_for_session`
auto-allow: the same signature re-cards on the next request (the "D5" rule), so a
secret-bearing operation is never silently auto-approved later.

## Consequences

- Secret-bearing operations always get human review, on both Claude Code and Codex
  paths.
- Detection reuses the redactor's kind vocabulary (consistent with ADR 0007).
- Adds an approval path keyed on input inspection; it composes with, and never
  weakens, the structural gate of ADR 0009.
