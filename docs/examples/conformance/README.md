# Conformance examples

Runnable inputs for the adapter **conformance checker** — see
[ingestion contract §8](../../ingestion-contract.md#8-verify-your-adapter-conformance-checker).

The checker validates that a stream of `NormalizedEvent`s (JSONL, one event per line, in
emission order) satisfies the stream-level, cross-field, and lifecycle invariants a single-event
schema parse cannot see: a non-empty stream, `payload.kind` present and `=== event_type`,
per-session non-decreasing `timestamp`, per-session dense 0-based `seq` (drop detection), and the
ADR 0014 lifecycle rules (no event after a terminal state; an approval requested before it is
resolved). A repeated `event_id` (or `seq`) with **identical content** is a **warning** — a
legitimate at-least-once retry (the backend dedupes on `event_id` and collapses duplicate `seq`,
contract §3.3 / §4.4) — but a repeat with **different content** (a distinct event reusing an id, or
the same `seq` on a different `event_id`) is a **collision error**. Redaction is **not** checked —
the backend ingress redaction floor is the sole redaction point, so an adapter neither can nor needs
to prove it — and restart-recovery is out of scope (a separate integration harness covers it).

```bash
pnpm --filter @actradeck/event-model build           # once

node ../../../scripts/check-conformance.mjs valid.jsonl     # PASS (exit 0)
node ../../../scripts/check-conformance.mjs invalid.jsonl   # FAIL (exit 1)
```

- **`valid.jsonl`** — a well-formed single-session stream (`session.started` → `turn.started`
  → `command.started` → `command.completed` → `turn.completed`) that conforms.
- **`invalid.jsonl`** — deliberately broken, demonstrating the **error** classes across a few
  sessions: `payload-kind-mismatch`, `event-id-collision` (a distinct event reusing an id),
  `timestamp-regression`, `seq-not-contiguous`, `event-after-terminal` (a new event after the
  session ended), `approval-resolved-unrequested` (a resolution with no prior request), and a schema
  failure (bad `event_id`).

Both fixtures are pinned by `INV-CONFORMANCE`
(`packages/event-model/test/inv-conformance.test.ts`) so they stay accurate as the schema
evolves. All ids/timestamps are synthetic — no secrets.
