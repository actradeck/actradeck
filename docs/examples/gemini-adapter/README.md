# Gemini CLI hook adapter (ActraDeck external adapter #2)

> 日本語版: [README.ja.md](./README.ja.md)

A dependency-zero (Node built-ins only) single-file script that puts
[Gemini CLI](https://geminicli.com) work onto the ActraDeck cockpit in **observe-only** mode. It
maps Gemini CLI's hooks into the `NormalizedEvent` of the
[public ingestion contract](../../ingestion-contract.md) and sends them directly to the backend's
`POST /ingest`.

Unlike the opencode adapter (a long-lived plugin), this one is a Gemini **hook `command`** — a
**short-lived process started once per event**. Each invocation reads one hook JSON on stdin,
maps it, best-effort POSTs it, and exits.

- `provider = "gemini"` (WHO · open slug)
- `source = "external"` (HOW · third-party direct ingestion)
- **observe-only**: it never relays approvals (allow/deny) and **never denies** — every run writes
  exactly `{}` to stdout and exits 0.

This is the second demonstration (after opencode) that the public contract is an extension
surface where "a third party normalizes on its own side and POSTs" (ADR `019f426e-a783`).

---

## 1. Installation

`adapter.mjs` is invoked by Gemini as a hook `command`. Register it for the six lifecycle hooks in
your Gemini settings (`~/.gemini/settings.json` for the user scope, or `<project>/.gemini/settings.json`
per project). The **canonical hook shape** (Gemini 0.42.0) is: a top-level `hooks.<EventName>`
array of `{ matcher, hooks: [{ type: "command", command, enabled }] }`, plus a `hooksConfig.enabled`
master switch:

```jsonc
{
  "hooks": {
    "SessionStart": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "node /ABS/PATH/adapter.mjs", "enabled": true }] }
    ],
    "BeforeAgent": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "node /ABS/PATH/adapter.mjs", "enabled": true }] }
    ],
    "BeforeTool": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "node /ABS/PATH/adapter.mjs", "enabled": true }] }
    ],
    "AfterTool": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "node /ABS/PATH/adapter.mjs", "enabled": true }] }
    ],
    "AfterAgent": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "node /ABS/PATH/adapter.mjs", "enabled": true }] }
    ],
    "SessionEnd": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "node /ABS/PATH/adapter.mjs", "enabled": true }] }
    ]
  },
  "hooksConfig": { "enabled": true }
}
```

Replace `/ABS/PATH/adapter.mjs` with the absolute path to this file.

- **Trust the hook.** Gemini only runs hook commands that are trusted. Approve them once
  (`~/.gemini/trusted_hooks.json` records the trusted command entries; Gemini prompts on first use).
- **Coming from Claude Code?** Gemini's hook shape is CC-compatible, and
  `gemini hooks migrate --from-claude` converts a Claude Code hook config (PreToolUse→BeforeTool,
  PostToolUse→AfterTool, UserPromptSubmit→BeforeAgent, Stop→AfterAgent, SessionStart, SessionEnd)
  into Gemini's format.
- **Install in exactly ONE scope** (either user `~/.gemini` **or** the project `.gemini`, not both).
  Registering the adapter in both scopes fires it **twice** per event, and each copy emits under a
  **distinct `event_id`**; the backend deduplicates on `event_id`, so it cannot collapse the
  duplicate.

Set the environment variables (they must be visible to the process Gemini spawns for the hook):

```bash
export INGEST_TOKEN=...                               # must match the backend's Bearer (required)
export ACTRADECK_INGEST_URL=http://127.0.0.1:55410    # this default when omitted
```

- **If `INGEST_TOKEN` is unset, the adapter sends nothing and still writes `{}` / exits 0** — it is
  silently disabled and does not affect Gemini at all (fail-open).
- Gemini works fine even when the backend is down (delivery is best-effort · §3).

### Important real-world behavior (measured · Tested-with 0.42.0)

Gemini fires hooks in the **interactive context where it detects a TTY** — i.e. a real terminal
session (`gemini` in your shell). In a **headless / piped subprocess** (no TTY), the tool hooks
(`BeforeTool` / `AfterTool` / `AfterAgent`) may not fire. Wire this up in a real terminal, not
inside an automated pipe, and confirm sessions show up on the cockpit as `provider=gemini` /
`source=external`.

---

## 2. Mapping table (REAL grounded)

Gemini's hook stdin → ActraDeck `NormalizedEvent`. The single source of the mapping is the pure
`mapHookEvent()` in `adapter.mjs`; the CLI entrypoint and the contract test both go through it.

Every hook shares a base of `{ session_id, transcript_path, cwd, hook_event_name, timestamp }`.

| Gemini hook (stdin)                         | → NormalizedEvent (`event_type` / `state`)     | Notes                                                                                            |
| ------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `SessionStart` (`source:"startup"`)         | `session.started` / `starting`                 | `cwd` carried                                                                                     |
| `BeforeAgent` (`prompt`)                    | `turn.started` / `running.model_wait`          | Carries a request summary `payload.prompt_summary` (`summarize`, **sanity cap only ~512 KiB, NOT ≤200**); raw full text not carried. **Display ≤200 bound is applied by the backend projection, after the floor** (bounded-at-storage) |
| `BeforeTool` — `run_shell_command`          | `command.started` / `running.command_executing`| `command = tool_input.command` · `request_id = tu:<hash>`                                         |
| `BeforeTool` — other tool (e.g. `read_file`)| `tool.started` / `running.tool_preparing`      | `tool_input` is **forwarded verbatim** into `payload.input` (§4)                                  |
| `AfterTool` — `run_shell_command`           | `command.completed` / `running.model_wait`     | `request_id` correlates with the started event · **`tool_response` is not carried** (§4)          |
| `AfterTool` — other tool                    | `tool.completed` / `running.model_wait`        | `{kind, tool_name}` only · **`tool_response` is not carried** (§4)                                |
| `AfterAgent` (`prompt_response`)            | `turn.completed` / `idle`                      | Carries a response summary `payload.response_summary` (`summarize`, **sanity cap only ~512 KiB, NOT ≤200**); raw full text not carried. **Display ≤200 bound is applied by the backend projection, after the floor** (bounded-at-storage) |
| `SessionEnd` (`reason:"exit"`)             | `session.ended` / `completed`                  | Gemini has a **real** terminal signal · `reason` carried                                          |

**Intentional drops** (not mapped): `Notification` / `PreCompress` and any unknown hook.

### Correlating tool calls without a call id

Gemini's `BeforeTool` / `AfterTool` carry `tool_name` + `tool_input` but **no call id**. Because
this adapter is a per-event process (no shared in-memory state across events), the `request_id`
that pairs `command.started` with `command.completed` is a **deterministic function of the hook
input** — `tu:<djb2(tool_name + stable(tool_input))>`. The Before and After of the same shell call
carry the same `tool_name` + `tool_input`, so they hash to the same `request_id`. Limitation
(honest): two **identical** shell calls in the same session collide on `request_id` (indistinguishable
without a call id) — an accepted marginal loss for at-most-once observation. The `tool_input` — which
for `run_shell_command` is `{command, description}` — **is** part of the hash input, so the command
**is** hashed; but the `request_id` **value** does not expose the command (djb2 is one-way, and the
command cannot be recovered from the 8-hex digest). The command itself is already carried verbatim in
`payload.command`, so `request_id` does not open a new disclosure channel.

### Delivery semantics

- **per-event at-most-once, best-effort**: one POST attempt with a ~1500 ms timeout, then **silent
  drop**. There is no ring buffer and no retry (the process is short-lived, unlike the opencode
  plugin).
- **fail-open**: any failure (bad JSON, mapping throw, unreachable backend, timeout) is swallowed;
  the process still writes `{}` and exits 0.
- **never-deny / observe-only**: the stdout is always exactly `{}` — it never contains
  `decision` / `continue` / `stopReason` / `hookSpecificOutput`, and it never exits 2. Gemini's
  behavior is never altered.

---

## 3. Honest disclosure of the security posture

- **This adapter has no client-side redaction** (because it is dependency-zero). The only defense
  against secrets is ActraDeck's **backend ingress redaction floor**
  ([contract §5](../../ingestion-contract.md#5-ingress-redaction-floor-redaction-before-storage) ·
  applied unconditionally before storage).
- **It does NOT claim "nothing leaks before it leaves the machine".** A `read_file` `file_path`, a
  shell `command` string, etc. are sent raw before they reach the backend (inside loopback);
  redaction at rest happens on the backend side.
- **Where source minimization is and is not applied** (honest scope):
  - **Applied**: `AfterTool`'s `tool_response` — for `run_shell_command` the `llmContent` is a
    `<untrusted_context>`-wrapped **full command output plus the process-group PGID**, and
    `returnDisplay` is the echoed output — **none of these are carried**; `tool.completed` carries
    only `{kind, tool_name}`. Gemini shell hooks do not report an exit code, so
    `command.completed` has no `exit_code` (its absence is correct, not a bug).
  - **Sanity-capped, not small-cap truncated (relies on the backend floor)**: the request
    (`BeforeAgent.prompt`) and the response (`AfterAgent.prompt_response`) are carried in
    `payload.prompt_summary` / `payload.response_summary` (`summarize`, whitespace collapsed) with
    **only a sanity cap (`SUMMARY_SANITY_CAP` = 512 KiB), NOT a small ≤200 cap** (ADR 019f47c2 · SEC-1
    `019f47f0`). The adapter must **not** small-cap truncate here: a secret split by a ≤200 cut can
    drop below the floor's redaction-rule minimums and leave a raw fragment at rest
    (truncate-before-redact straddle leak). So the raw text (within the sanity bound) is redacted by
    the **backend ingress floor** exactly like `tool_response`, and the **≤200 display bound is
    applied afterwards by the backend projection** (`SUMMARY_SUBJECT_CAP` — a *different* value that
    slices the already-redacted string · bounded-at-storage). This mirrors Claude Code's
    `依頼: <summary>` (UserPromptSubmit) so the cockpit shows *what the session is doing* (the top
    KPI); display-permitted per plan.md ("user request / agent public message may be shown");
    bounding ≠ redaction.
  - **Not applied (relies on the backend floor)**: non-shell tools (e.g. `read_file`) forward their
    `tool_input` (`file_path`, etc.) **verbatim** into `payload.input`. Secrets there are only
    redacted by the backend floor.
- **No error envelope** (unlike opencode): Gemini has no `session.error` hook, so this adapter emits
  no `error` event. The minimization invariant equivalent to opencode's ERROR-MINIMIZED is the
  `tool_response` minimization above (verified with the same positive key-allowlist + deep-walk
  negative match).
- The trust boundary is **inside single-operator / loopback / `INGEST_TOKEN`**. If you use it across
  that boundary (a different machine · a shared network), add client-side redaction separately.

---

## 4. Contract test

`packages/event-model/test/inv-gemini-adapter.test.ts` dynamically imports this `adapter.mjs`, maps
the REAL captured fixture (`fixtures/gemini-events.sample.jsonl`), and verifies the invariants
`INV-GEMINI-ADAPTER-{CONTRACT, PAYLOAD, MONOTONIC, NEVER-DENY, ENDED-ONLY-FROM-SESSIONEND, DEDUP,
MINIMIZED}` (the last driven through the shipped script as a real subprocess), plus the SEC-1
fixture regression (pinning that the fixture contains no public-mirror-contaminating token). A
backend lifecycle integration test `apps/backend/test/inv-gemini-lifecycle.test.ts` folds the mapped
events through the projection reducer + liveness synthesis (converges to `completed`; liveness does
not over-assert `stalled`). If the mapping, delivery, or event-model schema breaks, they go RED.

> **About the fixture**: `fixtures/gemini-events.sample.jsonl` is a **real capture** from Gemini CLI
> **0.42.0** (all 8 lifecycle hooks of one minimal turn — a `run_shell_command` and a `read_file`),
> with **only local paths neutralized** (`/tmp/gemini-grounding`). The event structure, keys, and
> types remain **as REAL captured**.

## 5. Compatibility

- **Tested with Gemini CLI 0.42.0** (verified against the real shapes of the hook stdin payloads).
- If Gemini **changes its hook shape**, this adapter, **being fail-open, may silently stop emitting**
  (unknown shapes are dropped and no error is thrown). If Gemini sessions stop appearing on the
  cockpit, first suspect the Gemini version and a change in the hook shape. Also recall that hooks
  fire in the interactive TTY context (§1) — a headless run may simply not trigger them.
