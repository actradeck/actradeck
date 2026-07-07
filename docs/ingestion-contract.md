# ActraDeck Public Ingestion Contract

> 日本語版: [ingestion-contract.ja.md](./ingestion-contract.ja.md)

> Status: T3 (derived). The source of truth is T1 = the zod schema of
> `@actradeck/event-model` and the ingestion route + INV-\* tests of `apps/backend`. If this
> document drifts from the code, **the code wins**. The golden example in this document is
> pinned by contract tests (`packages/event-model/test/inv-contract-golden.test.ts` /
> `apps/backend/test/inv-contract-golden.test.ts`); if the schema changes and the example
> becomes invalid, those tests go RED.

ADR 019f2d2c (#6a Public ingestion contract).

## 1. Overview

**"Any tool can appear in ActraDeck by normalizing its events on its own side and POSTing them
to `/ingest`."**

ActraDeck's ingestion path (the backend's `/ingest` / `/ingest/ws`) is provider-agnostic from
the start. Any coding agent, CLI, or script other than Claude Code / Codex can simply build
JSON that conforms to the [NormalizedEvent schema](#4-normalizedevent-schema) in this document
and POST it, and it lands on the cockpit's live view, audit log, and state machine.

This contract **evolves additively only** (additive-only):

- New optional fields are added as optional (existing adapters need no changes).
- Open dimensions (provider) only grow; the values of closed dimensions (source / event_type)
  are only added.
- No breaking changes. There is no contract version field (unnecessary under the additive
  convention).

## 2. Authentication

Every `/ingest` request requires **Bearer token** authentication.

```
Authorization: Bearer <INGEST_TOKEN>
```

- The token is the `INGEST_TOKEN` environment variable at backend startup (single-operator /
  loopback assumption).
- **The `?token=` query is not accepted** (it is a hotbed of URL / access-log leakage · SEC-1).
  Header only.
- Authentication is verified with `timingSafeEqual` **before** upgrade / body parse, and an
  invalid token returns `401` (WS is not upgraded).
- Trust boundary: an INGEST_TOKEN holder is **inside** the boundary. Ingress redaction (§5) is
  a **floor that stops an honest adapter's accidental secrets**, not a defense against
  adversarial exfil from inside the boundary (a token holder can read the DB directly, so that
  is not treated as a threat).

## 3. Ingestion paths

### 3.1 HTTP POST `/ingest`

Accepts a single event (JSON object) or a **batch** (JSON array).

```
POST /ingest
Authorization: Bearer <INGEST_TOKEN>
Content-Type: application/json

<NormalizedEvent>            # single
or
[<NormalizedEvent>, ...]     # batch
```

Response: `{ "results": [ <IngestAck>, ... ] }`. `results` is in the event order of the request.

- If all acks are `ok:true` the HTTP status is `200`; if even one fails it is `422` (even on
  partial success, per-event acks are returned as an array).
- A single invalid event (schema violation, etc.) only sets that ack to `ok:false`; the other
  events are still ingested.

`IngestAck` (main fields):

| Field                | Type     | Meaning                                                     |
| -------------------- | -------- | ---------------------------------------------------------- |
| `ok`                 | boolean  | Ingestion success/failure                                  |
| `event_id`           | string   | Target event (idempotency key)                             |
| `inserted`           | boolean  | Whether it was newly inserted (false = idempotent dup)     |
| `duplicate`          | boolean  | Whether it was a resend of an existing event_id            |
| `monotonic`          | boolean  | Whether the timestamp was monotonic within the session     |
| `state`              | string?  | The normalized state after projection                      |
| `invalid_transition` | boolean? | Whether an invalid state transition was detected (still ingested) |
| `error`              | string?  | The reason when `ok:false` (contains no raw secret)        |

### 3.2 WebSocket `/ingest/ws`

A bidirectional stream. 1 message = 1 NormalizedEvent (a JSON text frame). One `IngestAck` is
returned for each message. A single invalid event does not drop the connection; it is rejected
with an ack error. It is mainly used by the sidecar for push, but the same shape is usable as
the public contract.

### 3.3 Idempotency

`event_id` is the idempotency key (at-least-once assumption). A resend of the same `event_id`
is not double-inserted and returns an ack with `inserted:false` / `duplicate:true`.
Reprocessing / resending is safe.

## 4. NormalizedEvent schema

The source of truth is `NormalizedEvent` (zod) in `@actradeck/event-model`. Required / optional
fields are as follows.

| Field                                       | Req. | Type / constraint                    | Description                                                             |
| ------------------------------------------- | ---- | ------------------------------------ | ----------------------------------------------------------------------- |
| `event_id`                                  | ✅   | UUIDv7                               | Idempotency key and global ID                                          |
| `provider`                                  | ✅   | slug `^[a-z][a-z0-9_-]{0,31}$`       | Originating agent (WHO). §4.1                                          |
| `source`                                    | ✅   | closed enum                          | Ingestion path (HOW). §4.2                                             |
| `session_id`                                | ✅   | non-empty string                     | Canonical identifier of the observed run (join key)                    |
| `event_type`                                | ✅   | closed enum                          | Event kind (semantics). §4.3                                          |
| `timestamp`                                 | ✅   | ISO8601 (UTC)                        | Time of occurrence                                                     |
| `state`                                     |      | normalized state enum                | `running.*` / `waiting.*` / terminal, etc. Optional for delta/heartbeat |
| `provider_session_id`                       |      | string                               | The raw session id issued by the provider (for correlation · not used as a projection key) |
| `capture_mode`                              |      | `managed`\|`attach`\|`codex_rollout` | Observation mode (display only)                                        |
| `permission_mode`                           |      | string                               | Sandbox / permission mode (display only)                              |
| `thread_id` `turn_id` `agent_id`            |      | string                               | Correlation metadata                                                  |
| `cwd`                                       |      | string                               | Working directory                                                     |
| `summary`                                   |      | string                               | Human-readable one-line summary (for the timeline)                   |
| `payload`                                   |      | object                               | A structured record consistent with `event_type` (`{}` when omitted) |
| `metrics`                                   |      | object                               | `elapsed_ms` / `tokens_in` / `tokens_out` / `cost_usd`, etc. (`{}` when omitted) |
| `redaction_count` `redaction_count_by_kind` |      | non-negative integer / record        | See §5. **The client's declaration is not trusted; the backend authoritatively re-derives it.** |

### 4.1 provider = WHO (open slug)

`provider` represents "which agent CLI" and is **open as a slug**.

- Regex: `^[a-z][a-z0-9_-]{0,31}$` (starts with a lowercase letter · `[a-z0-9_-]` · 1–32 chars
  total).
- The semantics of the known values `claude_code` / `codex` are unchanged. Unknown slugs (e.g.
  `my_tool` / `aider`) are also accepted, pass through the pipeline, and the slug is displayed
  as-is as a label in the cockpit.
- **The regex is charset/length bounding, not secret detection**: it excludes whitespace /
  uppercase / symbols / path separators / quotes and caps length at 32, so **most real secrets,
  raw paths, and raw commands are rejected by length, uppercase, or symbols**. Non-slugs are
  fail-safe rejected and are neither stored nor displayed.
- Honest limitation: this is bounding, not a semantic judgment of "is this a secret". **A
  lowercase alphanumeric token of 32 chars or fewer (e.g. `sk_live_abcdef`) passes as a valid
  slug.** We do not assert "secrets cannot be carried" (judging secret values is the
  responsibility of the §5 redaction layer, not of the provider slug rule).

### 4.2 source = HOW (closed enum)

`source` represents "which ingestion path it entered by" and is a **closed enum**.

| Value        | Meaning                                                          |
| ------------ | --------------------------------------------------------------- |
| `hooks`      | Claude Code hooks (HTTP)                                        |
| `app_server` | Codex App Server (JSON-RPC)                                     |
| `rollout`    | Codex TUI rollout JSONL passive tail                           |
| `sdk`        | SDK streaming connector                                        |
| `external`   | **The path where a third-party adapter POSTs directly to `/ingest` per this contract** |

Direct ingestion from a third-party tool must always use **`source: "external"`**. Because the
set of ingestion paths is finite, a single value (not a slug) semantically and precisely means
"external direct ingestion" (preventing path spoofing / drift).

Note that on direct POST, `source` is a **value the caller declares**, and the backend does not
verify the path actually exists (a closed enum prevents drift in the value set, not spoofing).
For example, if an adapter making a direct POST declares `source: "hooks"`, the backend accepts
it. `source` is display/classification metadata for "which path it claims to be", and is not
used for authentication/authorization decisions (that is the responsibility of INGEST_TOKEN ·
§2).

### 4.3 event_type = semantics (closed enum · not opened)

Because `event_type` carries meaning for the projection state machine (the reducer wires a
state transition to each type), it **stays closed**. Accepting an unknown `event_type` would
silently drop a state transition — a correctness hole — so **normalization is the adapter's
responsibility**. Map your tool's events into one of the following before POSTing (unknown types
are rejected):

<!-- EVENT-TYPES:START -->

`session.started` `session.ended` `turn.started` `turn.plan.updated` `turn.completed`
`turn.failed` `agent.message.delta` `agent.reasoning_summary.delta` `tool.started`
`tool.output.delta` `tool.completed` `tool.failed` `tool.permission.requested`
`tool.permission.resolved` `command.started` `command.output.delta` `command.completed`
`file.change.proposed` `file.change.approved` `file.change.applied` `diff.updated`
`mcp.call.started` `mcp.call.completed` `web.search.started` `subagent.started`
`subagent.completed` `context.compacted` `heartbeat` `stalled.detected` `error`

<!-- EVENT-TYPES:END -->

(The contract test `inv-contract-golden.test.ts` pins that this list is a **set match** with
`ALL_EVENT_TYPES` in `@actradeck/event-model` — if the enumeration in the doc adds/removes or
has a typo, it goes RED.)

## 5. Ingress redaction floor (redaction before storage)

The redaction choke point has **2 layers**:

1. The sidecar's `EventSink.emit` (all events via the sidecar).
2. The backend's ingress (all events including direct POST).

**An adapter making a direct POST does not go through the sidecar**, so the backend
unconditionally applies secret redaction to every event received at `/ingest`, **before**
`store.ingest` (the PG write) (shared `@actradeck/redaction`). Therefore:

- Even if your adapter accidentally sends an event containing a secret, the raw secret does not
  land in PG (it is replaced with a `[REDACTED:<kind>]` marker before storage).
- `redaction_count` / `redaction_count_by_kind` are **authoritatively re-derived by the backend
  from the actual marker count**. **The count values declared by the client are not trusted and
  are overwritten** (blocking count spoofing). These are only redaction counts (non-negative
  integers, by kind), and **contain no secret value whatsoever**.
- Re-sending an event that already contains `[REDACTED:*]` markers does not double-mask them,
  because the markers are low-entropy and do not re-match the secret rules (idempotent).

This is a "floor that stops an honest adapter's accidental secrets", and a restoration of
redaction symmetry with the sidecar path. As with the trust boundary in §2, we do not claim
resistance to intentional exfil from inside the boundary.

## 6. Golden example

The following is a minimal event that actually goes through `/ingest`, using an unknown slug
(`my_tool`) for `provider` and `source: "external"`. This JSON is passed through `parseEvent`
in the contract test and is verified all the way to being POSTed to a real PG `/ingest` and
inserted (if a schema change invalidates it, CI goes RED).

<!-- GOLDEN-EVENT:START -->

```json
{
  "event_id": "0192f8a0-1234-7abc-89de-f01234567890",
  "provider": "my_tool",
  "source": "external",
  "session_id": "my-tool-run-2026-07-04-abc123",
  "event_type": "command.started",
  "state": "running.command_executing",
  "timestamp": "2026-07-04T12:34:56.789Z",
  "cwd": "/home/dev/project",
  "summary": "Running build for my_tool",
  "payload": {
    "kind": "command.started",
    "command": "npm run build",
    "cwd": "/home/dev/project",
    "risk_level": "low"
  },
  "metrics": { "elapsed_ms": 0 }
}
```

<!-- GOLDEN-EVENT:END -->

Example send with `curl`:

```bash
curl -sS -X POST "$ACTRADECK_INGEST_URL/ingest" \
  -H "Authorization: Bearer $INGEST_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @golden-event.json
# => {"results":[{"type":"ack","ok":true,"event_id":"0192f8a0-...","inserted":true,...}]}
```

## 7. Working adapter examples

`docs/examples/ingest-adapter/` contains a minimal Node adapter (single file) that maps an
external tool's line events into NormalizedEvent and POSTs them directly. It uses a slug for
`provider` and `source: "external"`. See the `README.md` in that directory for how to run it.

`docs/examples/opencode-adapter/` is the **first external adapter for a real product
(opencode)**. It maps opencode's plugin hooks (event bus + `tool.execute.before/after`) into a
per-lifecycle NormalizedEvent (`session.started` / `turn.started` / bash becomes
`command.started` · `command.completed`(exit code) · non-bash tools become `tool.started` ·
`tool.completed` / `agent.message.delta` / `diff.updated`(counts only) / `error`(envelope
minimized) / `turn.completed(idle)`) (`provider=opencode` / `source=external` / observe-only).
See §3 of the `README.md` in that directory for the full mapping table. It comes with a contract
test `INV-OPENCODE-ADAPTER-*` (`packages/event-model/test/inv-opencode-adapter.test.ts`) driven
by REAL captured fixtures. See the `README.md` in that directory for the mapping table, the
local run steps, and the **honest disclosure that the backend floor is the only redaction
defense**.
