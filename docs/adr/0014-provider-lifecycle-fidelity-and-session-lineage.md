# ADR 0014 — Provider lifecycle fidelity and session lineage

## Status

Proposed; accepted for phased implementation (2026-07-20). Absorbs the narrower
"conformance fail-closed" plan (item P2 of the prior roadmap) as Phase 2.

## Context

A community review (GitHub Discussion #11, `ofekron`) prompted an audit of how ActraDeck
normalizes lifecycle state. The audit found a high-severity correctness defect — **terminal
poisoning** — verified against the code:

- Codex `turn_aborted` is normalized to session state `failed`
  (`apps/sidecar/src/normalize-codex-rollout.ts:395`).
- Codex `systemError` is normalized to terminal `failed`
  (`apps/sidecar/src/normalize-codex.ts:433`).
- `thread/closed` is normalized to `completed`
  (`apps/sidecar/src/normalize-codex.ts:356`).
- Terminal states are immutable: `STATE_TRANSITIONS[completed|failed|interrupted] = []`
  (`packages/event-model/src/state.ts`).
- The projection reducer **freezes on terminal and ignores every later event**:
  `if (isTerminalState(current)) return { projection: finalize(current), ignoredAfterTerminal: true }`
  (`packages/projection/src/index.ts:501-506`), and clears pending approvals.

Combined effect: a single aborted turn, a transient system error, or a thread unload
permanently marks the session `failed`/`completed`, and every subsequent real event
(new turns, resume) is dropped from the projection. This directly violates the plan.md
KPI "show the observed actual work state."

External provider lifecycle semantics (verified 2026-07-20 against the Codex app-server
README and the Claude Code hooks reference):

- **Codex**: `thread/closed` is a temporary UNLOAD (emitted after ~30 min of inactivity,
  after running SessionEnd hooks), **not** a delete. A closed thread is resumable via
  `thread/resume`; the true terminal is `thread/delete` → `thread/deleted`.
- **Claude Code**: SessionStart `source` ∈ {`startup`, `resume`, `clear`, `compact`};
  SessionEnd `reason` ∈ {`clear`, `resume`, `logout`, `prompt_input_exit`,
  `bypass_permissions_disabled`, `other`}. `resume` denotes continuation of a saved
  conversation.

Both providers distinguish a persistent conversation/thread from one execution over it, and
support resume — a distinction ActraDeck currently collapses onto one `session_id`/`state`.
The event model already intends the split (`event.ts:41`: `session_id` = one observed agent
run; `provider_session_id` = the provider's raw id), but `provider_session_id`, though present
in the schema, is **not persisted** (omitted from both the events INSERT and the sessions
upsert in `apps/backend/src/ingest-store.ts`).

## Decision

Do **not** make terminal states re-openable. Instead:

1. Split the concerns currently conflated onto a single `state` value into **orthogonal axes**.
2. Model a provider conversation as distinct from the observation runs over it (**run lineage**);
   resume creates a NEW `session_id`, never re-opens the old one. Terminal stays immutable.

### Orthogonal axes

- **Normalized phase** — the existing `State` machine: what the agent is doing now.
- **Failure outcome** — `last_turn_outcome: "completed" | "failed" | "interrupted" | undefined`
  (a *turn's* result, not the session's).
- **Recoverability** — `continuation: "resumable" | "not_resumable" | "unknown"`.
- **Terminal evidence** — `terminal_evidence: "provider" | "process_exit" | "timeout" | "inferred"`.
- **Run lineage** — `provider_session_id` links a chain of observation runs.

```
provider_session_id  (persistent provider conversation / thread)
├── session_id = run-1  start_kind=fresh     → completed
├── session_id = run-2  start_kind=resume    → failed
└── session_id = run-3  start_kind=recovery  → active
```

This keeps normalization to a common state while **declaring, not hiding, lost capabilities**.

## Phased implementation (priority order)

**Phase 1 — Stop terminal poisoning (highest priority; correctness).**
- `turn.failed` / `turn_aborted` → do NOT set session state `failed`; return to `idle` or
  `running.model_wait`; project `last_turn_outcome="failed"` on the separate axis.
- `systemError` → `stalled` or `disconnected` unless there is an explicit process exit;
  reserve `failed` for a definite session/run failure.
- `thread/closed` → a new terminal state **`suspended`** (`end_kind="unloaded"`,
  `recoverability="resumable"`), NOT `completed`.
- Add minimal projections: `last_turn_outcome`, `continuation`, `terminal_evidence`.

**Phase 2 — Conformance false-green fixes + semantic extensions (absorbs prior P2).**
- Errors: empty stream; same `event_id` with differing content; same `seq` with a different
  `event_id`; missing `payload.kind`; an event after terminal; a re-start after terminal on the
  same `session_id`; an unrequested approval resolution; an unresolved approval at terminal
  (error/warning per the capability manifest).
- Restart-recovery is NOT proven by the conformance checker alone; a separate integration
  harness with real process restarts covers it.

**Phase 3 — `provider_session_id` persistence + run lineage.**
- Persist `provider_session_id` on `sessions` (and `events` if needed); add
  `sessions.{start_kind, resumed_from_session_id, end_kind, recoverability}`
  (`start_kind: fresh | resume | recovery | clear | unknown`).
- Claude Attach: do NOT reuse the raw hook `session_id` as the ActraDeck `session_id`; mint a
  new run id per SessionStart `source=startup|resume|clear`; put the raw id in
  `provider_session_id`; `source=compact` does NOT create a new run (a compaction event within
  the existing run).
- Codex rollout: one rollout file = one observation run; the thread UUID = `provider_session_id`.
- UI links runs sharing a `provider_session_id` as "continued from".
- Existing events without `provider_session_id` are treated as single-run lineages (no
  destructive migration).

**Phase 4 — Approval restart reconciliation.**
- `tool.permission.resolved` gains `resolution_origin` (`operator | timeout | policy | shutdown |
  child_exit | relay_lost`) and `delivery_status` (`sent | not_sent | unknown`). Never claim a
  deny was "sent" when the provider vanished (e.g. child exit → `deny, origin=child_exit,
  delivery=not_sent`; timeout → `deny, origin=timeout, delivery=sent`; daemon crash → `cancel,
  origin=relay_lost, delivery=not_sent`).
- Sidecar `hello` gains `runtime_epoch` and `active_pending_request_ids`; the backend keeps
  pending across a backend restart if the same sidecar reconnects, and makes stale pending
  non-actionable when the sidecar epoch changed.

**Phase 5 — Adapter capability manifest + UI.**
- `adapter.manifest.json` per adapter declaring capabilities over a closed vocabulary
  {`authoritative`, `observed`, `inferred`, `unsupported`, `unverified`} (session_start,
  session_end, resume, restart_recovery, approval_observation, approval_relay,
  sequence_counter, …).
- `session.started` carries the manifest version/hash and capability snapshot, so an audit
  session records its guarantee level even if the adapter later changes.
- UI surfaces honesty: terminal signal (authoritative / unavailable), resume (tested /
  unverified), approval (relay / observe-only / unavailable), state evidence (provider event /
  process / inferred).

## Acceptance tests (minimum)

1. `turn.failed` → the next `turn.started` projects normally (not frozen).
2. `systemError` → recovers to active.
3. Claude SessionEnd(resume) → SessionStart(resume): different `session_id`, same
   `provider_session_id`, old run stays terminal, new run active.
4. SessionStart(compact) does NOT create a new run.
5. Codex `thread/closed` → `thread/resume` is not treated as `completed`.
6. A pending approval across a backend restart resolves exactly once with the same request id
   after reconnect.
7. After a sidecar restart, a stale approval card is not left actionable.
8. An opencode adapter with no terminal signal does not fabricate `completed`.
9. A mismatch between an adapter manifest's capability claims and its fixtures/tests fails CI.

## Consequences

- Fixes a high-severity correctness bug; the cockpit stops falsely terminating live sessions.
- The core differentiator (cross-provider audit) becomes a trustworthy shared **contract**, not
  merely common labels, because lost capabilities are declared rather than hidden.
- Adds a new terminal state `suspended` and additive projection/lineage columns; existing rows
  backfill as single-run lineages (no destructive migration).
- Each phase touches high-risk surface (event order, state semantics, approval, terminal) and
  goes through the SEC/QA/TDA audit loop with a separate-turn adjudication.
- The design answer to ofekron is orthogonal axes + lineage, **not** more `State` enum values.
- npm publish of `event-model` remains unnecessary; ship the conformance CLI after Phase 2.
