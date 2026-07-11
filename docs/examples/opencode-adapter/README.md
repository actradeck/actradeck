# opencode plugin adapter (ActraDeck external adapter #1)

> 日本語版: [README.ja.md](./README.ja.md)

A dependency-zero (Node / Bun built-ins only) single-file plugin that puts
[opencode](https://opencode.ai) work onto the ActraDeck cockpit in **observe-only** mode. It
maps opencode's plugin hooks (event bus + `tool.execute.before` / `tool.execute.after`) into the
`NormalizedEvent` of the
[public ingestion contract](../../ingestion-contract.md) and sends them directly to the
backend's `POST /ingest`.

- `provider = "opencode"` (WHO · open slug)
- `source = "external"` (HOW · third-party direct ingestion)
- **observe-only**: it does not perform approval relay (allow/deny). It does not assert stop
  either.

This is a working demonstration that the public contract is an extension surface where "a third
party normalizes on its own side and POSTs" (Triangle ADR `019f3c3b`).

---

## 1. Installation

Place `adapter.js` into opencode's plugin directory.

- **Per project**: `<project>/.opencode/plugins/adapter.js`
- **Global**: `~/.config/opencode/plugins/adapter.js`

> **Install in exactly ONE location** (either per-project **or** global, never both). opencode
> loads plugins from both directories, so placing the adapter in both makes the factory start
> **twice** and every event is emitted twice under a **different `event_id`** each time. The
> backend's idempotency is keyed on `event_id`, so it cannot absorb this duplication (§8).

Set the environment variables.

```bash
export INGEST_TOKEN=...                          # must match the backend's Bearer (required)
export ACTRADECK_INGEST_URL=http://127.0.0.1:55410   # this default when omitted
```

- **If `INGEST_TOKEN` is unset, the plugin silently disables itself** (it returns no-op hooks
  and does not break opencode at all). This is part of the fail-open design.
- opencode works fine even when the backend is not running (delivery is fail-open · §4 below).

With this, in either `opencode run "..."` or TUI mode, the session appears on the cockpit as
`provider=opencode` / `source=external`.

---

## 2. Try it end-to-end locally (ollama · no external account needed)

A fully local setup that works all the way to real tool execution (established by measurement
with a probe).

1. Start [ollama](https://ollama.com) and create a tool-capable model **derived with num_ctx
   16384**. opencode sends a long prompt with tool schemas, so with the default ctx it gets
   truncated and the tool call misfires (a known opencode-official pitfall).

   ```bash
   ollama pull llama3.1:8b
   # ollama 0.13.1's `ollama create` requires the Modelfile as a **file path**
   # (the `-f -` stdin form fails with "no Modelfile or safetensors files found" · measured).
   printf 'FROM llama3.1:8b\nPARAMETER num_ctx 16384\n' > /tmp/Modelfile
   ollama create llama3.1:8b-16k -f /tmp/Modelfile
   ```

   > Measurement notes: `llama3.2-vision` does not support tools (400). `qwen2.5-coder:3b/7b`
   > sometimes writes the tool call as JSON text without executing it. Real tool execution was
   > confirmed with `llama3.1:8b-16k`.

2. Specify the ollama provider and model in `opencode.json` (the minimal config used by the
   probe).

   ```json
   {
     "$schema": "https://opencode.ai/config.json",
     "provider": {
       "ollama": {
         "npm": "@ai-sdk/openai-compatible",
         "name": "Ollama (local)",
         "options": { "baseURL": "http://127.0.0.1:11434/v1" },
         "models": { "llama3.1:8b-16k": { "tool_call": true } }
       }
     },
     "model": "ollama/llama3.1:8b-16k",
     "permission": { "bash": "allow", "edit": "allow" }
   }
   ```

3. Place the adapter in `.opencode/plugins/`, set the env, and run.

   ```bash
   opencode run "run: echo hello, then read package.json"
   ```

   The session appears on the cockpit, and you can observe `command.started` /
   `command.completed` (with exit code) · the streaming of `agent.message.delta` ·
   `turn.completed(idle)`.

---

## 3. Mapping table (REAL grounded · ADR D2)

opencode's observation surface (plugin hooks) → ActraDeck `NormalizedEvent`. The single source
of the mapping logic is the pure functions in `adapter.js` (`mapEvent` / `mapToolBefore` /
`mapToolAfter`).

| opencode input                      | → NormalizedEvent (`event_type` / `state`)        | Notes                                                                                                                               |
| ----------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `session.created`                   | `session.started` / `starting`                    | `cwd = info.directory`                                                                                                              |
| `message.updated` role=user (first) | `turn.started` / `running.model_wait`             | `turn_id = messageID` · refires are ignored                                                                                         |
| `message.part.delta` (field=text)   | `agent.message.delta` / `running.model_streaming` | Each delta is an independent event. Delivery is **batched into an array in submission order** (below · no per-messageID coalescing) |
| `tool.execute.before` (bash)        | `command.started` / `running.command_executing`   | `request_id = tu:<callID>`                                                                                                          |
| `tool.execute.after` (bash)         | `command.completed` / `running.model_wait`        | `exit_code = metadata.exit` · **non-zero is also completed** · **stdout is not carried** (source minimization · §4)                 |
| `tool.execute.before` (non-bash)    | `tool.started` / `running.tool_preparing`         | read/edit/write/grep/glob/webfetch, etc. **The tool arguments (`args`) are forwarded without minimization** (§4 · QA-5)             |
| `tool.execute.after` (non-bash)     | `tool.completed` / `running.model_wait`           | **Tool output is not carried** (source minimization · §4)                                                                           |
| `session.diff`                      | `diff.updated`                                    | **Counts only** · the raw diff is not sent                                                                                          |
| `session.error`                     | `error`                                           | The payload is `{kind, message, retryable}` only (`kind = "error"` · below · §5)                                                    |
| `session.idle`                      | `turn.completed` / `idle`                         | **session.ended is not fabricated** (ADR D8)                                                                                        |

**Intentional drops** (not mapped): `session.status` / `session.updated` / `message.updated`
role=assistant (metrics harvest) / the tool part of `message.part.updated` (the hook is
authoritative · callID overlap) / text · step-start · step-finish parts / `catalog.updated` /
`integration.updated` / `plugin.added` / `reference.updated`.

### Delivery semantics

- **fail-open**: the hooks only enqueue (they do not await delivery). Every POST is wrapped in a
  try/catch with a fetch timeout.
- **Bounded ring buffer** (cap 1000 · oldest dropped). After the **resend cap + backoff**, it
  drops.
- **at-least-once + idempotent**: resends use the same `event_id` (UUIDv7), and the backend
  absorbs double insertion.
- **Per-session monotonic timestamp floor**: even with resends, reordering, or a time-source
  rollback, the issued timestamps of the same session are kept non-decreasing.
- **Per-session `seq`** (drop-detection counter): every emitted event (heartbeat included) carries a
  per-session `seq` that starts at 0 and increments by 1, so the cockpit can flag a **lower bound** of
  silently-dropped events (`≥N dropped?`). See §4.4 of the ingestion contract — it is a lower bound
  only (head/tail drops are undetectable).

### Heartbeat while a turn is running (issue #8)

While a turn is in flight the adapter emits a periodic **`heartbeat` event**
(`payload: {process_alive: true}`) so the cockpit's liveness synthesis has a process-alive signal
and does **not** misjudge an actively-running turn as stalled/idle.

- **Only while a turn is running**: the heartbeat starts on `turn.started` and stops on
  `turn.completed` / `error` (and, because opencode has no session-termination signal, on the
  `session.idle → turn.completed(idle)` that ends the turn). When no turn is active, nothing is
  emitted.
- **Interval = 20s**: comfortably under the cockpit's `GAP_WARN_MS` (60s — the threshold at which a
  running provider with zero receipts is flagged as "audit is blind"). The 3× margin means that
  even with a single fail-open drop / retry delay, at least one heartbeat lands inside the 60s
  window.
- **fail-open / no leak**: a heartbeat carries only `process_alive: true` (no raw text). Emission
  failures never disrupt opencode. The timer is `unref`'d (it does not keep the opencode process
  alive) and is cleared deterministically when the turn stops; concurrent/overlapping turns share a
  **single** timer (it is never doubled).
- **It never asserts death**: the adapter emits `process_alive: true` only — it **never** emits
  `process_alive: false`. Combined with never fabricating `session.ended` (§4), stop is still not
  asserted; the heartbeat only supplies positive liveness, never a termination claim.
- This event is **timer-driven**, so it never appears in the mapping table above (it is not a
  mapping of any opencode input).
- **It only feeds the process/event lanes of liveness synthesis, not the model-delta lane**: a
  heartbeat proves the process is alive and events are arriving, but it does **not** advance the
  model-progress signal. So a genuine stall where the model produces zero delta is still surfaced —
  the heartbeat cannot mask it.
- **Why gemini's adapter has no equivalent**: the gemini example adapter runs as short-lived
  per-event hook invocations (no long-running process to host a timer), so it cannot structurally
  hold a turn-active heartbeat and instead relies on gemini's real `SessionEnd` termination signal.
  This is a deliberate line: opencode has no session-termination signal (hence a heartbeat), gemini
  has one (hence no heartbeat).

---

## 4. Honest disclosure of the security posture (ADR D4)

- **This adapter has no client-side redaction** (because it is dependency-zero). The only
  defense against secrets is ActraDeck's **backend ingress redaction floor**
  ([contract §5](../../ingestion-contract.md#5-ingress-redaction-floor-redaction-before-storage)
  · applied unconditionally before storage).
- **It does NOT claim "nothing leaks before it leaves the machine".** A `tool` argument or
  command string containing a secret is sent raw before it reaches the backend (inside
  loopback). Redaction at rest happens on the backend side.
- Source minimization (discarding the error envelope in §5 · counts only for the diff in §3) is
  **"minimization", not "redaction".** Distinguish these two.
- **Where source minimization is and is not applied** (honest scope disclosure):
  - **Applied**: discarding the `session.error` envelope (§5) / `session.diff` is counts only /
    `command.completed` is exit code only and **does not carry the stdout body** /
    `tool.completed` (non-bash) **does not carry the tool output**.
  - **Not applied (relies on the backend floor)**: **non-bash tools (`read`/`edit`/`write`/
    `grep`/…) forward the `tool.execute.before` arguments (`args`) verbatim without
    minimization** (QA-5). The `content` of `write`/`edit`, the `filePath` of `read`, etc. are
    sent as-is, and secrets are only redacted by the backend floor. **`read`/`write`/`edit`/`webfetch`
    are grounded** (captured from a real opencode run · QA-5 · §6), so their argument shapes are
    measured, not assumed. If you handle edits containing sensitive data, re-read the disclaimer at
    the top of §4.
- **Observation limit (QA-7)**: because opencode **has no session-termination signal**, the
  adapter **never emits `session.ended` at all** (§3's `session.idle` → `turn.completed(idle)`).
  The cockpit's "is it done" judgment is carried by the settling signal of `turn.completed(idle)`
  plus liveness synthesis (process/event/stdout heartbeat), and stop is not asserted. The
  turn-active heartbeat (§3) supplies **only** `process_alive: true` and **never**
  `process_alive: false`, so it strengthens positive liveness during a running turn without ever
  asserting death.
- The trust boundary is **inside single-operator / loopback / `INGEST_TOKEN`**. If you change to
  an operation that uses it across this boundary (a different machine · a shared network), add
  client-side redaction separately.

## 5. Source minimization of `session.error`

opencode's `session.error` contains `responseHeaders` / `responseBody` / `metadata.url` (the
model endpoint URL). The adapter **reads none of these** and structurally extracts only the safe
minimal fields `{error.name, error.data.message, error.data.isRetryable}`. **The emitted payload
is closed to the allowlist `{kind, message, retryable}`** (`name` is folded into the display-only
`summary`, and `statusCode` is not carried); if surplus keys are mixed in,
`INV-OPENCODE-ADAPTER-ERROR-MINIMIZED` goes RED (two-stage verification: positive key-allowlist
plus a deep-walk negative match of the envelope values).

---

## 6. Contract test

`packages/event-model/test/inv-opencode-adapter.test.ts` dynamically imports this `adapter.js`,
maps the REAL captured fixture (`fixtures/opencode-events.sample.jsonl`), and verifies the
invariants: `INV-OPENCODE-ADAPTER-{CONTRACT, PAYLOAD, MONOTONIC, NO-TERMINAL-FABRICATION, DEDUP,
ERROR-MINIMIZED}` plus the delivery layer (bounded-ring oldest drop / retry-cap drop / disabled
when token unset / submission-order preserved) plus the SEC-1 regression (pinning that the
fixture contains no public-mirror-contaminating token). If the mapping, delivery, or event-model
schema breaks, it goes RED.

> **About the fixture**: `fixtures/opencode-events.sample.jsonl` is the probe's **real captured**
> events, trimmed, but with **only the values** such as local paths **neutralized**
> (`/home/user/.claude/jobs/...` → `/tmp/opencode-...`). **The event structure, keys, and types
> remain as REAL captured**, with only the values swapped (R1 ruling 019f3c5e · SEC-1).

## 7. Compatibility

- **Tested with opencode 1.17.14** (verified against the real shapes of the plugin hooks
  `event` / `tool.execute.before` / `tool.execute.after`).
- If opencode **changes the shape of the plugin events**, this adapter, **being fail-open, may
  silently stop emitting** (unknown shapes are dropped and no error is thrown). If opencode
  sessions stop appearing on the cockpit, first suspect the opencode version and a change in the
  event shape (TDA-4a).

## 8. Plugin loader semantics (why a single default export)

The actual behavior of opencode 1.17.14's plugin loader diverges from what the official docs say
(measured · E2E-1 / E2E-1b). **The actual behavior is authoritative**:

- **The loader scans only `.js` / `.ts` and `.mjs` is silently invisible** (no success log and
  no failure log at all · measured on 1.17.14 · E2E-1b). The official docs' "`.mjs` is OK" is
  **wrong**. **A plugin file must always be `.js`** (this adapter is `adapter.js` too). If you
  make the extension `.mjs`, it is **never loaded**, no matter how correct the content is.
- **The loader calls every export (of a scanned file) as a factory** (both named and default).
  If you double-export the same factory as named and default, the hook is **registered twice**.
- **The loader scans both the per-project and global plugin directories.** Placing the adapter in
  **both** (`<project>/.opencode/plugins/` and `~/.config/opencode/plugins/`) starts the factory
  **twice**, so each event is emitted twice with a **distinct `event_id`** per copy. Because the
  backend deduplicates on `event_id` (not on payload content), it cannot collapse these into one —
  **install in exactly one location** (§1).
- **If even one non-function export exists, the whole module is silently rejected** (nothing is
  called). For example, just adding one `export const RING_CAP = 1000;` (a number) causes the
  entire plugin file to be discarded, and no hook is registered at all (no error either).

For this reason, **a plugin file should export exactly one `default` function**. This adapter
exposes pure helpers / constants **as properties of the default function**
(`ActraDeckOpencodeAdapter.mapEvent = …`) and has no named exports at all.
`INV-OPENCODE-ADAPTER-LOADER-SAFE` regression-pins that "the namespace is `default` only and a
function" (re-introducing a named / non-function export goes RED).

> If you write your own plugin, follow the same discipline. Make constants / helpers either
> **non-exported** locals in module scope, or properties of the default function.
