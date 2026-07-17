# Conformance examples

Runnable inputs for the adapter **conformance checker** — see
[ingestion contract §8](../../ingestion-contract.md#8-verify-your-adapter-conformance-checker).

The checker validates that a stream of `NormalizedEvent`s (JSONL, one event per line, in
emission order) satisfies the stream-level and cross-field invariants a single-event schema
parse cannot see: `payload.kind === event_type`, unique `event_id`, per-session non-decreasing
`timestamp`, and per-session 0-based contiguous `seq` (drop detection). Redaction is **not**
checked — the backend ingress redaction floor is the sole redaction point, so an adapter
neither can nor needs to prove it.

```bash
pnpm --filter @actradeck/event-model build           # once

node ../../../scripts/check-conformance.mjs valid.jsonl     # PASS (exit 0)
node ../../../scripts/check-conformance.mjs invalid.jsonl   # FAIL (exit 1)
```

- **`valid.jsonl`** — a well-formed single-session stream (`session.started` → `turn.started`
  → `command.started` → `command.completed` → `turn.completed`) that conforms.
- **`invalid.jsonl`** — deliberately broken, one line demonstrating each error class:
  `payload-kind-mismatch`, `event-id-duplicate`, `timestamp-regression`, a schema failure
  (bad `event_id`), and `seq-not-contiguous`.

Both fixtures are pinned by `INV-CONFORMANCE`
(`packages/event-model/test/inv-conformance.test.ts`) so they stay accurate as the schema
evolves. All ids/timestamps are synthetic — no secrets.
