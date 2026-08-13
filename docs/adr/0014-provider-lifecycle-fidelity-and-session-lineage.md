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
  | Claude Code hooks (managed + attach; `RunIdentity`) | raw hook `session_id`, on all events                                     | **Observed, best-effort**: derived from the observed SessionStart `source` (`startup`→`fresh`, `resume`→`resume`, `clear`→`clear`); with an observed parent but no usable `source`, `resume`; else `unknown`. **Managed launch argv override** (decision 019fd2ac ②): a positively detected `--resume`/`--continue` in the launch argv authoritatively sets the generation-0 `start_kind` to `resume` (launch-owned evidence beats the advisory hook `source`; absence of the flags asserts nothing) | Observed in-process parent (including across an attach reap, via the terminal tombstone — decision 019fd2ac ①), **or** a declared edge from an explicit managed `--resume <uuid>` argv value (UUID shape-gated, self-loop-guarded; an unobserved referent renders as linked-unknown, same tier as declared rollout edges) | A provider-id change or a terminal-reopen mints a distinct run (synthetic `sess_<uuidv7>`); monitoring events never drive a boundary (D3). Attach: a SessionEnd reap records a bounded terminal tombstone (provider id → last run id) so the **first observed hook of any type** for the same provider id re-enters the terminal-reopen path (new synthetic run + observed `resumed_from`) instead of folding into the terminated run. Revision (decision 019fd2ac ①, revised 2026-08-13, audit TDA-R5-1): consumption was originally SessionStart-only with non-SessionStart stragglers folding — that behavior let resumed sessions from clients that never fire SessionStart fold permanently into the terminal projection, rendering their approval requests invisible until timeout-deny (a real production incident), so any-hook consumption is now the contract and a straggler simply becomes a small synthetic run with a recorded lineage edge rather than an invisible fold. If resume activity is observed before the SessionEnd reap, no tombstone exists yet and the ordinary pre-reap terminal-reopen path (also any-hook) applies — same semantics, no false edge |
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
    session id: `mintApprovalRequestId` derives `s<sha256(session_id)[0..12]>:apr-<token>`
    (R2 shipped a 128-bit base64url token; round 3 superseded it with the canonical 32-hex /
    122-bit form) so no charset run reaches the redaction high-entropy threshold. The old
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

  **Audit round 4 hardening (2026-08-07, full SEC/QA/TDA re-audit of the R3 landing — no H):**

  - **Old manifests verify honestly (SEC-R3-1/TDA-R3-3, M).** The v2→v3
    `AUDIT_MANIFEST_VERSION` bump is a breaking change for every manifest exported by v0.6.0:
    before this round the verify surface collapsed them to `malformed-manifest` (HTTP 400 via
    `decodeManifestBase64`), making "made by an older build" indistinguishable from "tampered"
    — an evidence-continuity defect for a tamper-evidence product. `decodeManifestBase64` now
    passes any string-versioned manifest through and `verifyAuditManifest` reports a distinct
    `unsupported-manifest-version` reason. Still fail-closed: no prior version can verify
    `ok=true` (the chain is only recomputed under the current canonical form). Recorded in the
    CHANGELOG as a breaking note.
  - **Manifest summary projection is value-bound (QA-R3-1, M).** Every
    `normalizeSummaryForManifest` field is pinned with distinct non-zero values (the R3 fixture
    used `synthetic_retired: 0`, so a `str(0)` constant mutation survived — class-wide,
    pre-existing). A manifest can no longer cryptographically sign a wrong ledger value without
    a red test.
  - **Demo minting pinned in T1 (QA-R3-2, M).** `deriveDemoApprovalRequestId` reverting to the
    legacy `${sessionId}:apr-1` shape was invisible (all call sites recompute expectations via
    the same helper). `INV-APPROVAL-REQUEST-ID-STABLE` case (d) pins RE conformance,
    determinism and real-redactor invariance independently.
  - **Third exclusion site pinned (QA-R3-3, M).** Of the three "synthetic events are not
    observed activity" sites, audit-coverage's `MAX(ingested_at)` WHERE exclusion had no
    failing test; a real-PG vector (relay_lost as the only recent event keeps `last_received`
    stale, plus an operator-resolved positive control) closes the asymmetry.
  - **Display-tier honesty is regression-protected (QA-R3-4/TDA-R3-2/SEC-R3-3, M/L).** The
    webui's hand-copied `ResolutionOrigin` mirror is replaced by the canonical
    `RESOLUTION_ORIGINS` export from event-model (structural drift removal, per
    security-gate-reuse-canonical-parser), and the previously untested surfaces — closed-set
    parse gate, `synthetic_retired` totals, relay_lost muted tag + dedicated label vs operator
    tones, `decisionLabel` cancel/allow_for_session, list/modal retired chips — are all pinned
    (5/5 QA mutants killed).
  - **Re-roll defence class corrected + structural metatest (SEC-R3-2, M).** The bridge re-roll
    only mitigates token-dependent redaction rules; the tag and the `:apr-` literal are
    invariant across re-rolls, so a fixed-portion rule defeats all 8 attempts
    deterministically. The docstring now says so; a non-negative `unstableRequestIdCount`
    (NO-RAW) is queryable on the bridge API — honestly: **no runtime consumer is wired yet**,
    so runtime degradation stays silent (round 5 pins the increment behaviour in a unit test
    and discloses this; surfacing the counter is tracked follow-up work); the real gate is
    the structural metatest — all
    `REDACTION_RULES` × an adversarial + fuzz id corpus must produce zero matches, so adding a
    colliding rule of either class goes red in CI the same day.
  - **Exclusion scope boundary disclosed (TDA-R3-1/SEC-R3-7, M/L).** The relay_lost activity
    exclusion covers `liveness_state` (SQL + TS mirrors) and audit-coverage `last_received`
    only. It deliberately does **not** cover `session_state.last_event_at` (projection fold
    advances it unconditionally; it feeds ordering, purge exemption, `activity_at`, and the
    audit report's `last_event_at` which is chain-bound into the manifest) — defensible because
    the event really was appended, and verified harmless for liveness: the webui freshness
    branch can only downgrade live→idle, and `sessions.source` is not updatable via ingest
    upsert, so a synthetic cancel cannot convert a session into a Wall recency-proxy candidate.
    Bounded residual: a genuinely `source="external"` session stays inside the Wall
    `WALL_RECENT_MS` retention window (order/retention only, no LIVE badge); practically
    unreachable today because observe-only codex-rollout daemons do not send
    `active_pending_request_ids`, and an omitted declaration means no reconcile. Changing the
    fold itself is a boundary-gate scope change → full audit by default.
  - **Entropy disclosure (SEC-R3-8, L).** The uuid-v4 token carries 122 bits (6 bits fixed by
    version/variant), down from R2's 128-bit `randomBytes(16)` — still far beyond the 3#SEC-1
    requirement; docstrings updated (including the demo-id rationale: the operative guard is
    the per-connection controlToken, not "backend-internal" execution).

  **Audit round 5 hardening (2026-08-07, full SEC/QA/TDA re-audit of the R4 landing — no H):**

  - **Decision vocabulary consolidation, audit tier (TDA-R4-3, M).** The backend audit tally
    fold (`AUDIT_DECISIONS`) and the webui tally/membership arrays now consume the canonical
    `APPROVAL_DECISIONS` (`ApprovalDecision.options`) from event-model — the R4 enum sweep
    had stopped at the origin list while identical hand mirrors of the *decision* list
    remained, which would have let a 5th decision silently vanish from `by_decision` and be
    absorbed into `pending`. Honest scope (SEC-R5-1): this consolidated the *tally fold and
    membership scans*, not every consumer — the signed manifest's canonical form still
    projects the decisions as hand-written `approval_<d>` keys, and the sidecar
    approval-message gate plus two webui type mirrors kept hand copies until R6
    (`INV-APPROVAL-DECISION-VOCAB` now pins reference identity and the manifest projection;
    a vocabulary extension goes RED there, forcing a deliberate manifest version bump).
  - **The relay_lost sentinel is single-sourced (TDA-R4-5, M).** `SYNTHETIC_RETIRE_ORIGIN` +
    `isSyntheticRetireOrigin` live in event-model; the classification fold (audit-store), the
    liveness TS mirror, the packet reason and the webui modal consume the predicate, and
    `INV-SYNTHETIC-RETIRE-SENTINEL` pins the SQL literals (outside the type system) to the
    canonical value by source coupling — a rename or a second synthetic origin can no longer
    silently reclassify synthetic retires as operator decisions.
  - **Packet manifests are versioned for the governance semantics change (TDA-R4-4, M).**
    `AUDIT_PACKET_MANIFEST_VERSION` v1→v2 (+ chain domain), because Phase 4 changed what
    `hard_gate` means under an unchanged v1; the packet verify gate now shares the session
    manifest's version-gate helper and reports old v1 packets as the distinct
    `unsupported-packet-manifest-version` (CHANGELOG carries the breaking note).
  - **The "verified harmless" preconditions are now CI-enforced (TDA-R4-6, M).** Real-PG pins:
    the ingest upsert never updates `sessions.source` (the synthetic producer deliberately
    claims `source:"external"`), and a synthetic relay_lost cancel on a stale session leaves
    `session_state.liveness.state` non-live — this second pin also names the load-bearing
    dependency the R4 prose omitted: liveness is **recomputed on the synthetic ingest** with
    the relay_lost exclusion applied; a frozen liveness value plus the advanced
    `last_event_at` would render live through the webui freshness branch.
  - **The manifest's non-binding surface is disclosed and pinned (SEC-R4-1, M).**
    `summary.entries[]` (per-approval itemized rows; JSON/packet-JSON tiers only, never
    rendered in HTML/MD) is **outside** the manifest binding: forging an entry does not fail
    verification. Totals and packet flagged items are bound, so aggregate forgery and
    review-item forgery are detected. The module doc now says so instead of claiming "every
    displayed fact", and a boundary pin test fixes the scope as intended — extending the
    binding to entries is a canonical-form change (version bump + full audit). Recipients
    distributing JSON as evidence must cross-check entries against the bound tally/timeline.
  - **The hello declaration parser requires the canonical id shape (SEC-R4-8, L→code).**
    `parseActivePendingRequestIds` projects each id through `APPROVAL_REQUEST_ID_RE` and
    rejects the whole declaration on any non-conforming id (per-id dropping would fail
    unsafe: a live pending absent from the parsed set gets synthetically cancelled). Rollout:
    daemons on older dists declaring legacy-shape ids fall back to "no reconcile" (stale
    cards persist until the coordinated upgrade — the pre-Phase-4 behaviour, safe direction).
  - **Dead surfaces resolved (TDA-R4-1/R4-2, M).** `runtime_epoch` is now exposed on the
    daemons listing (`GET /realtime/daemons`) as a non-credential diagnostic for operator
    inspection (restart discrimination), pinned by a route test. Honest scope (TDA-R5-2):
    this is an operator-facing surface only — the webui daemons parser deliberately extracts
    `id`/`spawn_capable` and drops the field, so there is no programmatic consumer; wiring a
    restart-discrimination badge is future work, not a shipped claim. `unstableRequestIdCount` stays a
    queryable bridge API: the docstring/ADR wording is corrected to say no runtime consumer
    is wired (CI's structural metatest is the enforcement), and a unit test pins the bounded
    re-roll + counter semantics under a worst-case always-mangling redactor mock.
  - **Daemon-tier wiring is pinned (QA-R4-1, M).** A real-ws test fixes that the attach
    daemon's hello carries `active_pending_request_ids` (empty array = a meaningful
    zero-pending declaration) and that the observe-only codex-rollout daemon does not; the
    managed sidecar's wiring to the shared `pendingIdsFromBridge` helper is source-pinned.
    Previously deleting the provider wiring survived the full sidecar suite (silent-off).

  **Audit round 6 (2026-08-07, landing of the R5 full re-audit findings — no H):**

  - **Decision vocabulary consolidation completed across tiers (TDA-R5-1 + SEC-R5-1 +
    QA-R5-1, M).** The four residual hand copies are gone: the sidecar approval-message
    security gate consumes `APPROVAL_DECISIONS` (set-equivalent refactor, pinned by a
    real-wiring test asserting every canonical member reaches `resolve` and no non-member
    does), the ws-client message type and the webui `ApprovalDecision` re-export the
    canonical type, and `decisionLabel` is driven by a `Record<ApprovalDecision, MessageKey>`
    map (compile-exhaustive; unknown raw values still pass through for tolerant display).
    `INV-APPROVAL-DECISION-VOCAB` pins `AUDIT_DECISIONS`/webui `DECISIONS` reference identity
    (the identical hand literal previously survived the full suite — probe P3c) and pins the
    signed manifest's `approval_<d>` projection over the whole vocabulary, so a future 5th
    decision goes RED at the normalize stage; the *binding* follow-through (that a declared
    field actually folds into the signed root) is enforced separately by the R7
    root-sensitivity pin (`INV-AUDIT-BINDING-COMPLETENESS`, SEC-R6-1) — the projection pin
    alone did not force it.
  - **Renderer-side binding-boundary complement (QA-R5-4, M).** The SEC-R4-1 pin only fixed
    "entries do not change `root`"; nothing failed if a renderer started displaying entries
    (probe P22). HTML/MD outputs are now pinned byte-identical under entries injection, so
    extending the renderer forces extending the binding (version bump + full audit).
  - **prettier regression fixed (QA-R5-0, M).** The R5 commit's Testing notes claimed a green
    format gate while `packages/event-model/vitest.config.ts` was RED; fixed.
  - **Sentinel metatest hardened (SEC-R5-3 + TDA-R5-3, L).** The scan now sweeps all backend
    src files (no allow-list), strips full-line comments (a comment could previously satisfy
    the non-vacuity guard), forbids `!==`/`case` comparison forms and single quotes, and pins
    constant consumption by the producer (`approval-reconciler`) and the shipped report
    labels (`audit-report` now interpolates `SYNTHETIC_RETIRE_ORIGIN`, byte-identical).
  - **Packet version coupling closed (QA-R5-2 + QA-R5-3, L).** `PACKET_CHAIN_DOMAIN` is
    pinned to share the version prefix (probe P16: version-only bump survived), and the
    packet verify route gains the old-version case the session route already had (200 +
    `unsupported-packet-manifest-version`, not 400).
  - **Deferred with deadline — DB-side id gate asymmetry (SEC-R5-2, M).** The reconciler
    checks DB pendings against the declaration Set but never against
    `APPROVAL_REQUEST_ID_RE`, while the declaration side requires it. A pending whose
    at-rest id was mangled by a redaction rule matching the id's fixed part (the bridge
    returns the unstable id after exhausting 8 re-rolls) can appear in no conforming
    declaration and is therefore always synthetically cancelled past the watermark — a live
    approval retired with an audit row asserting `relay_lost`. Honest scoping: the trigger
    class is structurally kept at zero by CI (`INV-APPROVAL-REQUEST-ID-STABLE`: all
    `REDACTION_RULES` × id-shape corpus = 0 matches — deterministic for fixed-part-matching
    rules; sparse probabilistic rules are outside the corpus guarantee and are mitigated by
    the bridge's runtime re-roll, per that metatest's own coverage disclosure), the
    degradation is inside the single-operator boundary, and it predates R5. The fix is a gate change on the predicate
    that decides destruction (skip synthesis for ids that are neither canonical nor a
    known-legacy shape the coordinated deploy intends to retire), which per the
    finding-registry's boundary-gate default requires a full re-audit — it is scheduled into
    the v0.7 redaction-integration work (with the url-credential charset/gate redesign,
    which lands under a full audit anyway) rather than expanding this round.
  - **Sweep (L).** relay_lost human-label divergence across tiers (TDA-R5-4) and the
    `ACTIVE_PENDING_FIELD`/`RUNTIME_EPOCH_FIELD` exports with no external runtime consumer
    (TDA-R5-5, disclosed in their docstring) are tracked in the phase tech-debt sweep.

  **Audit round 7 (2026-08-07, landing of the R6 targeted re-audit findings — no H):**

  - **The fifth hand copy is gone (TDA-R6-1, M).** The R6 claim "the four residual hand
    copies are gone" was literally true for the four sites the R5 audit enumerated, but the
    attach daemon — the default observation mode — carried a byte-identical `!==` chain with
    zero tripwire (no test exercised its approval handler). The gate now consumes
    `APPROVAL_DECISIONS` (same set-equivalent form as the managed sidecar) and the
    set-equivalence test runs against **both** wirings. Honest scope after this round: the
    **hand-copied** untyped-gate class is closed repo-wide (the remaining untyped-input
    gates — backend's two module-private `VALID_DECISIONS` sets — consume
    `ApprovalDecision.options` as an import-time snapshot, not a hand list); the
    `by_decision.<d>` hand projections in the CSV/HTML/MD report renderers remain
    (TDA-R6-2, L — a 5th decision would silently miss from those outputs while the
    conservation row and the vocabulary pin go visibly inconsistent; tracked in the sweep,
    not individually).
  - **The set-equivalence pin now asserts argument fidelity (QA-R6-1, M).** The R6 test
    asserted only call counts; an injected mutant that discarded the validated decision and
    passed `"allow"` — converting every operator deny/cancel into allow on the relay —
    survived 1654/1654. Each canonical member is now asserted to reach `resolve` with the
    **unaltered** decision (`toHaveBeenLastCalledWith`), plus a non-vacuity guard on the
    vocabulary length (QA-R6-3).
  - **Binding completeness is pinned (SEC-R6-1, M).** The R6 projection pin fixed only the
    normalize stage; a field added to the interface + normalize but omitted from
    `canonicalizeSummary`'s positional list would be declared yet unbound (forgeable with
    `verify ok=true`) while every tripwire stayed green. `INV-AUDIT-BINDING-COMPLETENESS`
    asserts root-sensitivity for **every** `manifest.summary` key (auto-extends on key
    addition; 23-field floor), closing the declared-but-unbound class for the summary
    projection. The ADR wording above is corrected accordingly.
  - **Canonical arrays are frozen (SEC-R6-4, L).** `APPROVAL_DECISIONS` /
    `RESOLUTION_ORIGINS` are now frozen copies (the approval gate's runtime dependency must
    not be a shared mutable array; zod's `.options` stays untouched internally), with an
    `Object.isFrozen` pin. `decisionLabel` lookups are `Object.hasOwn`-guarded so
    prototype-chain members (`"constructor"`, `"__proto__"`) pass through as raw text instead
    of vanishing (SEC-R6-3, with test vectors).
  - **Sentinel metatest precision (SEC-R6-2/R6-5, L).** The SQL-presence guard is per known
    file (a trailing comment can no longer satisfy the count while the real SQL disappears),
    `/* … */ code` lines keep their code tail, and the test name says "backend src" honestly
    (sidecar/webui sentinel switches are compile-guarded; the operand-order asymmetry of the
    forbidden-form regex is sweep-tracked, TDA-R6-3).
  - **Tracked with deadline (QA-R6-2, M).** One unidentified flaky sidecar test appeared once
    under CPU contention and was lost to output truncation; a task requires CI to retain the
    full sidecar reporter output so the next occurrence is identifiable.

  **Audit round 8→9 (2026-08-07, landing of the R8 targeted re-audit findings — no H; QA
  lane APPROVE, SEC/TDA CONDITIONAL on the items below, all landed):**

  - **Binding completeness extended to the sibling projections (SEC-R8-1, M).** The R7
    root-sensitivity pin covered only `summary`; the same declared-but-unbound class stayed
    open for `canonicalizeEventFields` (9 positional fields — carrying `command` and
    `decision`, a higher-value forgery target) and `canonicalizeDiff` (6 fields), verified
    by mutants surviving 728/728. The pin now sweeps every `events[i]` key (except `hash`,
    the chain output) and every `diff` key with the same auto-extending loops and
    non-vacuity floors (9 / 6). Honest scope (TDA-R9-1 ≡ SEC-R9-1): the swept tiers are the
    **three projections** (summary 23/23, events 9/9, diff 6/6 — no unbound field exists in
    them today); the **top-level envelope is not swept**, and its `algorithm` field is
    declared, rendered in the shipped integrity tables, yet bound by neither the chain, the
    signature header, nor well-formedness — a signed manifest with a tampered `algorithm`
    still verifies `ok=true`. Today it has zero branching consumers (display-only; the
    verifier's own reason string names the real algorithm), but it falsifies the module
    doc's "any displayed value" claim and becomes an algorithm-confusion surface the day a
    second algorithm branches on it. The fix (fail-closed `algorithm` well-formedness gate
    + a fourth envelope sweep loop; no version bump — the canonical form is unchanged) is a
    scan-scope change and lands as a dated v0.7 task under a full audit. The key-template
    limitation of the auto-extending loops (only unconditionally-present keys are swept;
    optional projection fields would escape — none exist today, and the normalize object
    literals compile-force non-optional props) is disclosed with it (SEC-R9-2).
  - **Present→forwarded direction pinned (QA-R8-1/R8-2, L).** The gate tests only emitted
    frames omitting `reason`/`persist`, so discarding the operator's rationale or forcing
    the persistent-allowlist flag permanently off survived the full suite (fail-safe
    directions; the unsafe persist-on direction was already killed). One additional emit
    asserts both values are forwarded unaltered.
  - **`RESOLUTION_ORIGINS` freeze is now pinned (TDA-R8-2, L).** The R7 text claimed an
    `Object.isFrozen` pin for both canonical arrays but only `APPROVAL_DECISIONS` had one,
    while `RESOLUTION_ORIGINS` is likewise a runtime membership gate (webui origin
    filtering); the missing pin is added, making the claim true.
  - **Sentinel scan strips inline/trailing comments (SEC-R8-2, L).** Moving the real SQL
    predicate into a same-line comment could still satisfy the per-file presence guard; the
    scan now removes inline `/* … */` and whitespace-preceded trailing `//` segments (the
    in-string edge cases are disclosed in the helper's doc).
  - **Recurrence tripwire for the gate-copy class (TDA-R8-1, M → tracked with deadline).**
    Hand copies of the decision vocabulary surfaced three rounds in a row (R4 mirrors → R5
    sidecar gate → R6 attach daemon); closure so far rests on per-round manual sweeps. A
    v0.7 task tracks a structural metatest (reusing the sentinel scanner) that forbids
    untyped decision-literal comparisons repo-wide.
  - **Sweep.** Accessor unification for backend's `VALID_DECISIONS` sets (SEC-R8-3 ≡
    TDA-R8-3), a stale line-number comment (TDA-R8-4), and the packet chain-domain suffix
    nit (QA-R6-4) stay in the phase tech-debt sweep.

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
