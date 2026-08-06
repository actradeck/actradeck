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
  (a _turn's_ result, not the session's).
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
- Implemented (Phase 1 sweep note): beyond the three sites verified in Context, a FOURTH
  poisoning site landed in this phase — the Codex app-server `error` notification with
  `willRetry=false` previously fell to terminal `failed`; it now maps to the non-terminal
  diagnostic `stalled` (recoverable; `willRetry=true` leaves the state unchanged). The
  `last_turn_outcome` value `interrupted` has no producer path today (the reducer derives
  only `turn.completed`→completed and `turn.failed`→failed); it is a forward-compatible enum
  member, documented as such on the type.

**Phase 2 — Conformance false-green fixes + semantic extensions (absorbs prior P2).**

- Errors: empty stream; same `event_id` with differing content; same `seq` with a different
  `event_id`; missing `payload.kind`; an event after terminal; a re-start after terminal on the
  same `session_id`; an unrequested approval resolution; an unresolved approval at terminal
  (error/warning per the capability manifest).
- Restart-recovery is NOT proven by the conformance checker alone; a separate integration
  harness with real process restarts covers it.
- Accepted-risk (QA-4): a legitimate at-least-once retry stays a warning only when it re-sends
  content **identical** to the first appearance of that `event_id` (compared order-insensitively).
  An adapter that rebuilds the event on retry and lets any field drift (e.g. a fresh `timestamp` or
  updated `metrics`) now trips `event-id-collision` (error). This is defensible — the backend keeps
  the first write and dedupes later ones (contract §3.3), so a "retry" whose content changed is
  genuinely a different event on a reused id — and adapters are told to re-send the same event, but
  it is a stricter reading than "same id ⇒ retry". Severity is intentional, not a manifest concern.

**Phase 3 — `provider_session_id` persistence + run lineage.**

- Persist `provider_session_id` on `sessions` (and `events` if needed); add
  `sessions.{start_kind, resumed_from_session_id, end_kind, recoverability}`
  (`start_kind: fresh | resume | recovery | clear | unknown`).
- Claude Attach: do NOT reuse the raw hook `session_id` as the ActraDeck `session_id`; mint a
  new run id per SessionStart `source=startup|resume|clear`; put the raw id in
  `provider_session_id`; `source=compact` does NOT create a new run (a compaction event within
  the existing run).
- Codex rollout (Phase 3b-2, implemented): one rollout file = one observation run
  (`session_id` = the file's `session_meta.payload.id`). `provider_session_id` = the stable
  conversation `session_meta.payload.session_id` when declared, else the file id.
  `resumed_from_session_id` = the declared `forked_from_id`, and `start_kind = "resume"` only
  when that edge exists (otherwise `"unknown"`, never a claimed `"fresh"`). Unlike the CC hook
  path — which sets `resumed_from` only when the parent run was actually observed in-process —
  the rollout edge is emitted **as declared**: the parent may be unobserved, and the referent
  may be the stable conversation id (= `provider_session_id`) rather than an observed per-file
  run id. Consumers (the "continued from" UI) must resolve the edge by `session_id`, render a
  missing referent as linked-unknown (not an error), and must not self-loop when
  `forked_from_id` equals the stable conversation id. `parent_thread_id` is a subagent spawn
  hierarchy, not a continuation, and is never mapped to `resumed_from_session_id`.
- UI links runs sharing a `provider_session_id` as "continued from" (Phase 3c, implemented).
  The detail DTO exposes the lineage columns behind a read-time closed-enum gate (out-of-enum
  TEXT from non-ingest writers renders as absent, never as a claimed value), plus
  `resumed_from_observed` (does the referent exist as an observed session) and a bounded
  `lineage_runs` sibling list. Precedence (decision 019fd250): the displayed continuation is
  the single resolved value `stored recoverability ?? terminalContinuation(state)`
  (stored-first — provider/process evidence beats the state-keyed default; the two sources are
  never rendered side by side), and the projection `state` stays authoritative for lifecycle
  display (`end_kind` is run-boundary metadata only and never synthesizes a lifecycle claim).
- Existing events without `provider_session_id` are treated as single-run lineages (no
  destructive migration).
- Capture-path lineage fidelity matrix (Phase 3b sweep). This table is the single source for
  how much each observation path can honestly claim; UI and docs must not present a weaker
  tier as a stronger one (e.g. a declared rollout edge as an observed one):

  | Capture path                                        | `provider_session_id`                                                    | `start_kind`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `resumed_from_session_id`                                                                                                                                                                                                                                                                                                 | Run boundary / end                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
  | --------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Claude Code hooks (managed + attach; `RunIdentity`) | raw hook `session_id`, on all events                                     | **Observed, best-effort**: derived from the observed SessionStart `source` (`startup`→`fresh`, `resume`→`resume`, `clear`→`clear`); with an observed parent but no usable `source`, `resume`; else `unknown`. **Managed launch argv override** (decision 019fd2ac ②): a positively detected `--resume`/`--continue` in the launch argv authoritatively sets the generation-0 `start_kind` to `resume` (launch-owned evidence beats the advisory hook `source`; absence of the flags asserts nothing) | Observed in-process parent (including across an attach reap, via the terminal tombstone — decision 019fd2ac ①), **or** a declared edge from an explicit managed `--resume <uuid>` argv value (UUID shape-gated, self-loop-guarded; an unobserved referent renders as linked-unknown, same tier as declared rollout edges) | A provider-id change or a terminal-reopen mints a distinct run (synthetic `sess_<uuidv7>`); monitoring events never drive a boundary (D3). Attach: a SessionEnd reap records a bounded terminal tombstone (provider id → last run id) so the next observed SessionStart of the same provider id re-enters the terminal-reopen path (new synthetic run + observed `resumed_from`) instead of folding into the terminated run; non-SessionStart stragglers still fold (sanctioned 3b-1 behavior), and if a straggler re-materializes the entry before the resume SessionStart arrives — or the resume is observed before the SessionEnd reap — the tombstone stays unconsumed and the edge is simply skipped (safe best-effort degradation, no false edge) |
  | Codex managed (app-server)                          | **Enrich-only**: `thread.sessionId` when the server reports it           | Not emitted (`NULL` — this path observes no restart lineage)                                                                                                                                                                                                                                                                                                                                                                                                                                         | Not emitted                                                                                                                                                                                                                                                                                                               | One managed run per spawn. `end_kind`/`recoverability` are set on both the process-exit terminal and the handshake/connection-failure path (uniformized by the Phase 3c precedence decision 019fd250): `recoverability` is uniformly `not_resumable`; `end_kind` follows the exit — process-exit sets `completed`/`failed` by exit code, the failure path sets `failed`. The child is stopped on connection loss, so the process-exit rationale applies                                                                                                                                                                                                                                                                                                  |
  | Codex rollout (observe-only tail)                   | Stable `session_meta.payload.session_id` when declared, else the file id | `resume` only when a `forked_from_id` edge is declared, else `unknown` (never a claimed `fresh`)                                                                                                                                                                                                                                                                                                                                                                                                     | **As declared** by `forked_from_id`: the parent may be unobserved and the referent may be the stable conversation id                                                                                                                                                                                                      | One rollout file = one observation run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

  The consumer requirements for declared rollout edges are stated exactly once, in the Codex
  rollout bullet above; the normalizer docstring defers to that bullet instead of restating
  them.

**Phase 4 — Approval restart reconciliation.**

- `tool.permission.resolved` gains `resolution_origin` (`operator | timeout | policy | shutdown |
child_exit | relay_lost`) and `delivery_status` (`sent | not_sent | unknown`). Never claim a
  deny was "sent" when the provider vanished (e.g. child exit → `deny, origin=child_exit,
delivery=not_sent`; timeout → `deny, origin=timeout, delivery=sent`; daemon crash → `cancel,
origin=relay_lost, delivery=not_sent`).
- Sidecar `hello` gains `runtime_epoch` and `active_pending_request_ids`; the backend keeps
  pending across a backend restart if the same sidecar reconnects, and makes stale pending
  non-actionable when the sidecar epoch changed.

  **Landed 2026-08-06 (decision `019fd705`).** Implementation notes, where they refine the
  sketch above:

  - Reconciliation is driven by the `active_pending_request_ids` **declaration**, not by an
    epoch comparison: an empty array is a meaningful "no pending survives" declaration, while
    a missing field means an older (or observe-only) daemon and reconciliation is skipped
    entirely (fail-safe: nothing is retired on missing/malformed declarations, and only
    sessions the declaring connection currently owns are considered). `runtime_epoch` is
    announced and recorded for diagnostics; the declaration is always current, so an epoch
    comparison adds no reconcile signal.
  - Stale entries are retired by ingesting a synthetic `tool.permission.resolved
    { decision: cancel, resolution_origin: relay_lost, delivery_status: not_sent }` through
    the **normal ingress path** (redaction floor + `parseEvent` + store). The fold clears the
    card (acceptance #7) and the audit trail records honestly that nobody decided and nothing
    was delivered. Declared-alive entries are left untouched and resolve exactly once over the
    re-established relay (acceptance #6). Known edge (disclosed): a sidecar that reconnects
    with a queued real `resolved` still unsent can produce both the synthetic cancel and the
    real event for one request_id — projection treats the second as a no-op; the audit trail
    keeps both.
  - The Claude Code hook path gains real `child_exit` detection: a hook client that
    disconnects before the response resolves its pending immediately
    (`origin=child_exit, delivery=not_sent`) instead of hanging until the 30s timeout.
  - `delivery_status` derives from the actual write result (CC: hook HTTP response write
    accepted by the socket layer; codex: `sendResponse` success, with `suppressed`/sync-throw
    mapping to `not_sent`). "sent" claims socket-layer acceptance only, never that the peer
    read it.
  - `resolution_origin=policy` is reserved vocabulary with no current emitter: auto-allow
    paths still emit no `requested`/`resolved` pair (a request_id-less `resolved` would clear
    unrelated pending in the reducer), keeping the existing `auto_allowed`/`persist_grant`
    observation markers instead.

  **Audit round 2 hardening (2026-08-06, SEC/QA/TDA full audit findings landed):**

  - **Redaction-stable request ids (SEC-1, H).** Approval request ids no longer embed the raw
    session id: `mintApprovalRequestId` derives `s<sha256(session_id)[0..12]>:apr-<128bit>`
    so no charset run reaches the redaction high-entropy threshold. The old
    `${sessionId}:apr-…` shape was mangled at the ingress floor for `sess_<uuidv7>` session
    ids (41-char single run), splitting the id space between the bridge (raw) and the DB/UI
    (redacted) — which both made the UI approve relay a silent no-op and made reconciliation
    retire live pendings as `relay_lost`. `INV-APPROVAL-REQUEST-ID-STABLE` pins the contract
    against the real redactor, including a hazard-reproduction pin for the legacy shape.
  - **Freshness watermark (QA-1/TDA-5, M).** The declaration is a snapshot taken when the
    hello frame is built, so a pending created just after it cannot appear in it. The
    reconciler now skips pendings whose `requested_at` is newer than
    `receivedAt - RECONCILE_WATERMARK_MS` (2s; sidecar and backend share a clock on the
    loopback trust boundary). Genuinely stale pendings are retired by a later hello.
  - **Amplification guards (SEC-3, M).** Reconciles are capped at `MAX_CONCURRENT_RECONCILES`
    (excess signals dropped; retried on the next hello) and a signal covers at most
    `MAX_RECONCILE_SESSIONS` owned sessions (over-limit skips reconcile, fail-safe).
  - **Canonical wire parsing (TDA-2/SEC-6/TDA-9, M/L).** Field names, caps and validation for
    `runtime_epoch` / `active_pending_request_ids` live once in event-model
    (`approval-reconcile-wire.ts`) shared by the sidecar builder and the backend parser;
    `runtime_epoch` is gated to uuid shape; an over-cap declaration is **omitted, never
    truncated** (truncation would fabricate stale pendings). A provider returning `undefined`
    (bridge not yet constructed) omits the field rather than declaring "zero pending".
  - **Producer-side strict validation (SEC-4, M).** The synthetic cancel is validated against
    the strict `EventPayload` union before ingest (parity with the sidecar's
    `assertPayloadConsistency`); honest disclosure: backend ingress `parseEvent` passes
    payloads through a loose object, so enum strictness lives at producer/consumer parse
    boundaries, not at ingress (both realities are pinned by tests).
  - **Audit read-layer separation (TDA-1, H).** `relay_lost` synthetic cancels are no longer
    counted as operator hard gates: the audit store folds them into a separate
    `synthetic_retired` counter (excluded from `by_decision`, hence from `hard_gate`), and
    the review packet itemizes them under `reason=relay_lost` instead of `denied`. Nothing
    claims a gate was exercised when nobody decided.
  - **Production wiring gate (TDA-3, M).** `INV-APPROVAL-RECONCILE-WIRING` drives
    `buildIngestionServer` end-to-end (real WS hello → synthetic cancel → fold) so deleting
    the `onApprovalReconcile` registration goes red.
  **Audit round 3 hardening (2026-08-06, full SEC/QA/TDA re-audit of the R2 landing):**

  - **Canonical request-id minting for both tiers (TDA-R2-1/SEC-R2-4/QA-R2-5, M).** The minter
    moved to event-model (`approval-request-id.ts`): `s<sha256(sid)[0..12]>:apr-<32 lowercase
    hex>`. The hex token charset structurally excludes every vendor-prefix redaction rule
    (they all need non-hex letters, uppercase or `_`), upgrading redaction-stability from
    probabilistic (SEC-R2-3 measured ~4.5e-9/id under base64url) to structural; the sidecar
    bridge additionally re-rolls (bounded) against the real redactor as belt-and-braces.
    `safety-demo-driver` — the second legacy-shape minting site R2 missed — now derives its
    deterministic id via the shared `deriveDemoApprovalRequestId`. The backend real-PG
    acceptance vector calls the shared minter (the R2 comment claiming that coupling was
    false).
  - **Ledger completeness for `synthetic_retired` (SEC-R2-1/QA-R2-2/TDA-R2-2, M).** R2 removed
    relay_lost cancels from `by_decision` but only the JSON API carried the reconciling term,
    silently breaking `total = Σby_decision + pending` in every shipped export. The column/row
    now appears in CSV, HTML and Markdown (per-session and range totals), the signed manifest
    projection (`AUDIT_MANIFEST_VERSION` bumped to v3 — the canonical form changed), and the
    webui (parse + totals chip + entry tag: relay_lost renders muted with its own label, never
    the operator success/danger tones). A conservation test pins
    `total = allow+afs+deny+cancel+synthetic_retired+pending` across formatters.
  - **Synthetic events are not observed activity (SEC-R2-2, M; introduced in R1).** The
    synthetic cancel carries `timestamp = now`, and both freshness aggregations (SQL
    `aggregateObservationSql` and TS `observeFromEvents`, mirrored under INV-LIVENESS-PARITY)
    as well as the audit-coverage per-provider `MAX(ingested_at)` now exclude
    `resolution_origin=relay_lost` resolved events — the backend must not manufacture "fresh
    event observed" evidence at exactly the moment a daemon vanished (REAL DATA ONLY).
  - **Test-gap closures (QA-R2-1/3/4/6/7, M/L).** Real-PG pins for: the watermark's real data
    path (a fresh pending survives an empty declaration through actual ingest), and the
    `asResolutionOrigin` closed gate (an adversarial origin string ingested through the loose
    ingress projects to `undefined`, never reaching the HTTP surface). The daemon provider
    wiring is now a shared `pendingIdsFromBridge` helper whose "undefined, never `[]`"
    semantics is unit-pinned. All `skipIf(!reachable)` backend files must be registered in the
    `REAL_PG_TESTS` serialization list, enforced structurally by the tripwire metatest.
  - **Honest-scope corrections (TDA-R2-3/4/5, SEC-R2-6, L).** Wire-module docstring no longer
    claims field names are structurally single-sourced (caps and validation are; names are
    pinned by both tiers' tests); the 1024 cap documents its per-daemon derivation (64/session
    × 16); `synthetic_retired` documents that it counts resolved *events* (a double-audit-row
    request contributes to both terms, shrinking `pending` by clamp) and that
    `resolution_origin` is producer-claimed — there is no server-authoritative synthetic
    marker, which inside the INGEST_TOKEN boundary is the pre-existing trust model, not a new
    escalation.
  - **Coordinated rollout for the request-id change (TDA-R2-6).** The SEC-1 fix takes effect
    only when the sidecar dist is rebuilt and both daemons restarted alongside the backend.
    Until a resident attach daemon restarts it keeps minting legacy-shape ids, so the H
    symptoms (approve no-op, live pendings retired as relay_lost for `sess_<uuidv7>`-shaped
    sessions) persist for that daemon; the R2/R3 backend changes only mitigate and honestly
    account for the residue. Deploy sidecar + daemons + backend together (same requirement as
    the strict-enum vocabulary). Legacy pendings persisted before the upgrade no longer match
    any new declaration and are retired as relay_lost on the first hello — that is the
    designed recovery, not data loss.
  - **Watermark heuristic disclosure (SEC-R2-5, L).** The 2s watermark is anchored to the
    backend's hello *receipt* time; the sidecar's snapshot time is unknown, so a transport lag
    above the margin could still retire a just-created live pending (degrades to the
    pre-watermark behaviour; deny-direction, loopback makes it improbable). Carrying a
    `declared_at` timestamp in the hello would close the window exactly — tracked in the
    phase sweep with the other L follow-ups.

  - **Accepted-risk / tracked disclosures (deadline v0.7):** (a) SEC-2: a peer holding
    INGEST_TOKEN can claim any session with one hello and retire its pendings — same
    single-operator/loopback trust boundary as the existing claim-based relay takeover; a
    structural fix (restricting reconcile to ingest-observed sessions) would break acceptance
    #7 for restarted daemons, so this is disclosed and tracked instead. (b) SEC-5: when a
    real resolved is lost before persistence, the synthetic cancel row can be the only audit
    record for a request that an operator did in fact decide; the synthetic row is defined as
    an **observation of reconciliation**, not an assertion that the request was never
    resolved. (c) TDA-4: after a synthetic cancel the session state may remain `waiting.*`,
    keeping the needs-attention badge lit with no actionable card; state semantics for
    relay-lost sessions are a tracked follow-up.

**Phase 5 — Adapter capability manifest + UI.**
**Absorbed by ADR 0015 (§D7).** The closed vocabulary {`authoritative`, `observed`, `inferred`,
`unsupported`, `unverified`} maps onto ADR 0015's three observation-evidence axes
(availability × method × fidelity); the per-adapter `adapter.manifest.json` file is retired in
favor of in-band declaration (a `session.started` capability snapshot plus per-observation
stamps), which satisfies the same audit requirement — the session records its guarantee level
even if the adapter wiring later changes. Acceptance test #9 below transposes to: an adapter
whose fixtures contradict its declared `observation_evidence` fails CI. Phase 4 (approval
restart reconciliation) remains in this ADR, unaffected. Original phase text kept for the
record:

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
