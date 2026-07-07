# ingest-adapter — a minimal ActraDeck ingestion adapter example

> 日本語版: [README.ja.md](./README.ja.md)

A **dependency-zero (Node built-ins only)** single-file implementation (`adapter.mjs`) that
maps the stdout of any external tool/CLI into the NormalizedEvent of the
[ActraDeck public ingestion contract](../../ingestion-contract.md) and POSTs it directly to
the backend's `POST /ingest`.

Use it as a minimal template for putting your own tool onto ActraDeck.

## What it does

It maps each line of an external tool's stdout into ActraDeck events as follows:

| Timing | Event(s) sent |
|---|---|
| On startup | `session.started` + `command.started` |
| Per stdout line | `command.output.delta` |
| On EOF (process exit) | `command.completed` + `session.ended` |

- `provider` is your tool's **slug** (WHO · `^[a-z][a-z0-9_-]{0,31}$`).
- `source` is always **`external`** (HOW · third-party direct ingestion).
- `event_id` is a UUIDv7 you mint yourself (ActraDeck only accepts UUIDv7).
- Input lines are also passed through to the terminal verbatim, so display is preserved even
  when you splice the adapter into an existing pipe.

## Prerequisites

- Node.js 20+ (uses the global `fetch` and `node:crypto` / `node:readline`).
- A running ActraDeck backend (for local development, `apps/backend`). Keep its `INGEST_TOKEN`
  handy.

## How to run

```bash
# 1) Set the ingestion token and URL of the backend
export INGEST_TOKEN="<same value as the backend's INGEST_TOKEN>"
export ACTRADECK_INGEST_URL="http://127.0.0.1:55410"   # the backend's HTTP port

# 2) Your tool's provider slug (defaults to example_tool)
export ACTRADECK_PROVIDER="my_tool"

# 3) Pipe the output of any command into it (the 1st argument is the display label)
my-cli --do-stuff | node adapter.mjs "my-cli --do-stuff"
```

Open the cockpit and a session with `provider=my_tool` / `source=external` appears live, the
command output flows as deltas, and it terminates on completion.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `INGEST_TOKEN` | (required) | The backend's Bearer token. Exits 2 if unset. |
| `ACTRADECK_INGEST_URL` | `http://127.0.0.1:55410` | The backend's base URL (`/ingest` is appended for the POST). |
| `ACTRADECK_PROVIDER` | `example_tool` | Your tool's provider slug. Exits 2 if not a valid slug. |
| `ACTRADECK_SESSION` | auto-minted | Specify to pin the canonical session_id. |

The 1st command-line argument becomes the display label for `command.started` / `command.completed`.

## Verifying it works (that this example actually goes through)

This adapter has been verified end-to-end against an isolated backend (spare port + real
PostgreSQL):

```bash
# e.g. stream the output of a real command
git log --oneline -3 | node adapter.mjs "git log --oneline -3"
# => events land as session.started / command.started / command.output.delta×3 /
#    command.completed / session.ended with provider=my_tool · source=external
```

Even if you stream lines containing secrets, the **backend's ingress redaction floor** masks
them before storage (contract §5). For example, a line containing a `ghp_...` token lands in
PG as `[REDACTED:github-token]` and the raw value is not stored (no extra work on the adapter
side is required). That said, it is safest not to send unnecessary sensitive information from
the adapter in the first place.

## Notes (to make it production quality)

This example is **minimal**. For a production adapter, consider the following:

- **Batch sending**: instead of 1 line = 1 POST, send `command.output.delta` batched as an
  array to `POST /ingest` (which accepts batches) to raise throughput.
- **Retry/backoff**: retry on `fetch` failure (the idempotency key = `event_id`, so re-sending
  is safe).
- **Richer mapping**: map tool-specific events (file diffs, approval requests, tool calls) to
  the corresponding `event_type` (`file.change.proposed` / `tool.permission.requested`, etc.).
  Because `event_type` is a closed enum, normalize unknown kinds before sending (contract §4.3).
