# ADR 0015 — Evidence-based completion: work items, completion claims, and verification evidence

## Status

Proposed (2026-08-03). Product direction is fixed by decision `019fc4a9` ("was that completion
verified against the current code?"); this ADR adjudicates only the contracts (types / events /
DB / UI) and the phase decomposition. Absorbs ADR 0014 Phase 5 (adapter capability manifest)
into the observation-evidence axes defined here (§D7). ADR 0014 Phase 4 (approval restart
reconciliation) remains in ADR 0014, untouched.

## Context

Agents self-report work items as "completed". Nothing in the pipeline answers the operator's
real question — the plan.md KPI "does it need intervention?" in its sharpest form: *the agent
says it is done; did anything actually verify that, and is that verification still valid for
the code as it stands now?* Shipping this closes the differentiation gate (decision `019ec619`):
the cockpit UI must distinguish four states per claimed-complete work item — self-claimed /
verified / verification failed / changed after verification.

### Verified provider behavior (2026-08-03, real data — not assumed)

**Claude Code 2.1.220 hooks**
- `TaskCreated` / `TaskCompleted` fire, with exactly 8 payload fields: `session_id`,
  `transcript_path`, `cwd`, `prompt_id`, `hook_event_name`, `task_id`, `task_subject`,
  `task_description`. There is **no `agent_id`**.
- `task_id` is a session-scoped serial string (`"1"`), **not** a UUID → work-item identity must
  be the composite (session, task_id). `task_subject` / `task_description` are free text →
  redaction before persistence is mandatory (existing hook receiver → `sink.emit` choke).
- `TaskCompleted` **exit-2 block is proven**: `TaskUpdate(status=completed)` returns
  `success:false`, the transition does not happen, and hook stderr reaches the model as a
  tool_result. This is a real future gating point (§D9) — **not used in P0**.
- There is **no `TaskUpdated` hook**: intermediate transitions (in_progress, cancel, content
  edits) are not observable via task hooks. However the sidecar already observes `PostToolUse`
  for the `TaskCreate` / `TaskUpdate` **tool calls** (tool_input / tool_response), which covers
  all transitions at lower fidelity (§D2, §D7).
- `InstructionsLoaded` fires but its real fields (`file_path`, `memory_type`, `load_reason`)
  diverge from docs. P1 material only; not registered in P0.
- The current hook injection (`settings-injection.ts` `MANAGED_HOOK_EVENTS`) does **not**
  register `TaskCreated` / `TaskCompleted` — P0-B extends the injected set. Unregistered hooks
  simply never fire; unknown registered hooks fall to the normalizer default case (heartbeat),
  so partial deployment degrades benignly.

**Codex 0.145.0**
- The plan signal in real rollouts (`~/.codex/sessions/`) is the **`update_plan` function_call
  record** (349 occurrences across 19 of the last 200 files): `payload.type="function_call"`,
  `name="update_plan"`, `arguments` = JSON string → `{"plan":[{"step":str,"status":str}]}`.
  Observed status values: `completed` 668 / `pending` 623 / `in_progress` 288. Provider event
  kinds `turn.plan.updated` / `plan_update` do **not** exist in rollouts (0 occurrences).
- Current sidecar gaps (P0 implementation targets):
  (a) managed path `normalize-codex.ts:266-277` maps only step strings and **drops per-step
  status**; (b) rollout path `normalize-codex-rollout.ts:310-343` has no `update_plan` case, so
  it falls into the generic `function_call` branch and is **misrouted to `command.started`**
  (worse than unobserved — it pollutes the command stream); (c) the normalized payload contract
  `TurnPlanUpdated = {plan?, steps?}` (`packages/event-model/src/payload.ts:198`) has no status.
- Codex plan steps have **no id** (positional) → identity strategy adjudicated in §D3.
- Codex `hooks.json` exists (trust-gated, CC-compatible; PostToolUse confirmed via a real
  plugin) but task-hook support is unconfirmed. P0 Codex observation relies **only** on
  rollout / app-server; Codex hooks stay future work.

### Verified codebase constraints

- `git-watcher.ts` already emits `diff.updated` with `diff_hash` =
  sha256(porcelain status ∥ unstaged diff ∥ staged diff) — a working-tree dirty fingerprint.
  It does **not** include HEAD, and untracked-file *content* changes are invisible (porcelain
  lists names only). §D5 fixes both.
- The canonical command tokenizer (`tokenize` / `commandName` / `normalizeCommandName`) lives in
  `apps/sidecar/src/normalize.ts` and is **not importable from `packages/projection`**
  (layering). §D6 places the check classifier accordingly.
- The projection reducer freezes on terminal; `last_turn_outcome` is the implemented template
  for a *sticky orthogonal axis*; `deriveActionSubject` reads only redacted-payload allowlist
  fields. `pending_approvals` (bounded jsonb, cap 64) is the bounded-fold precedent.
- Managed Codex `command.completed` carries `exit_code` (`item.exitCode`); the CC hook path
  carries `exit_code` when numeric; the rollout `function_call_output` path currently extracts
  **no** exit code (§D6 honesty fallback).
- Rollout event ids are deterministic (`stableRolloutEventId`: session + file basename + offset
  + eventIndex) → typed plan emission stays idempotent across re-tails.
- Migrations live in `db/migrations/` (11 so far, all additive after init; TEXT columns, no
  CHECK constraints, closed-enum gates at the app boundary — house style).

### Fixed product constraints (decision `019fc4a9` — binding)

1. **No control-plane regression.** ActraDeck already enforces (CC PreToolUse deny honored even
   under `bypassPermissions`, ADR 019f0c3e; managed Codex under ApprovalBridge). Integrity
   detection (contradiction / omission / unverified completion) is **additive observation, not a
   replacement** for governance. P0 never blocks.
2. **P0-A is a trimmed spine**: only what P0-B needs — typed work item, CompletionClaim,
   VerificationResult (tree fingerprint + automatic staleness; a permanent `verified` boolean is
   forbidden), evidence refs, and the 3-axis observation evidence. ContextSource / Version /
   Inclusion are P1 (additive migration later).
3. `compact_summary` persistence, if/when added (P1), goes through the INV-REDACTION choke
   (LEVEL 0). Its location is **unverified** (docs claim PreCompact; the sidecar currently keeps
   only the trigger) — reserved section, honestly marked unverified.
4. Naming: the P1 feature is "Effective Context Evidence"; ContextPresence has 5 levels
   (`configured / discovered / eligible / loaded / referenced`) — **"used" is forbidden**;
   `parent_thread_id` is subagent spawn lineage and is never conflated with resume
   (decision `019fc49f`).

## Decision

### D1. No state-machine changes; everything is orthogonal per-item projection

No new `State` enum values, no transition-table changes, no touching `running.*` semantics
(ADR 0014's lesson: orthogonal axes, not more State values). `work.item.updated` events carry
**no `state`** (`state: undefined` always — pure observation; the session keeps its current
phase). `turn.plan.updated` keeps its existing `running.planning` mapping. The session_state
reducer is not modified; work items live in a **separate fold** (§D4).

### D2. Event contract: one new event type + one additive payload extension; no verification event

- **New event type `work.item.updated`** (per-item observation; CC task list and any adapter
  with declared item ids). Closed payload variant:
  `{ kind, provider_task_id: string, status: WorkItemStatus, subject?, description?,
  observation?: ObservationStamp }`. `WorkItemStatus = z.enum(["pending","in_progress",
  "completed","cancelled","removed","unknown"])`. Emitted from: `TaskCreated` hook
  (status=pending), `TaskCompleted` hook (status=completed), and `PostToolUse(TaskCreate /
  TaskUpdate)` parsing (all transitions; only fields verified against live CC are parsed,
  unknown → `unknown`).
- **Additive typed items on the existing `turn.plan.updated`** (snapshot observation; Codex
  plans): `items?: Array<{ step: string, status: WorkItemStatus }>` (ordinal = array index).
  Legacy `steps` stays populated for old consumers. No new event type for plans: the state
  mapping, subject derivation (`undefined`), and both Codex normalizers already exist for
  `turn.plan.updated`; the typed field is the upgrade path that fixes gaps (a)+(c) in place.
- **Why two shapes, not one**: the providers genuinely observe differently. CC delivers
  per-item lifecycle events but never a full task-list snapshot; Codex delivers full-plan
  replacement snapshots and can only express item *removal* snapshot-wise. Forcing one shape
  would fabricate unobserved data in one direction or lose removal in the other. Provider
  differences stay honest at the event layer; **unification happens in the work-item fold**
  (§D4) — the same layering ADR 0014 chose (common contract, declared differences).
- **No `verification.recorded` event type.** VerificationResult is **derived in projection**
  from events that already exist: `command.completed` (+ the check annotation of §D6) and
  `diff.updated` (+ `head_sha` of §D5). Rationale: (i) the derivation is a pure function of the
  stream → rebuildable by construction, no dual-authority drift; (ii) zero new emission /
  redaction surface; (iii) it retroactively works for any source whose commands we observe,
  including external adapters. Evidence refs are the underlying `event_id`s
  (claim_event_id / verification_event_id / stale_event_id), so the UI can jump to the exact
  timeline entries — the evidence *is* the event log.
- Rejected alternatives: `task.created/updated/completed` event family (provider-biased noun;
  "task.completed" would bake the claim in as fact — the whole point is that completion is a
  *claim*; and 3 types where 1 level-based type suffices); deriving work items from generic
  `tool.started` payload parsing in projection (violates the redacted-allowlist discipline and
  the layering constraint); a `verification.recorded` event emitted by the sidecar (dual
  authority with the fold; new leak surface).

### D3. Work-item identity: canonical, deterministic, derived from post-redaction payload

Single canonical derivation in `event-model` (`deriveWorkItemId`), used **only in the
projection fold** — the sidecar does not stamp ids. Reason: ids must be re-derivable by every
consumer from the stored (redacted) event, or rebuild-from-events breaks; and hashing raw
pre-redaction text would create a secret-guessing oracle. Deriving from post-choke text is
deterministic (same redactor rules → same text → same id).

- Table key: `(session_id, work_item_id)`. Two id schemes, named for **observation shape**
  (not provider), because that is what determines the continuity guarantee:
  - `task:<sha256(provider_task_id)[:16]>` — declared-id scheme (`work.item.updated`).
    Continuity = provider's own id. Hash-always (no raw provider text in ids → DOM/testid/URL
    safe by construction, no sanitization edge cases).
  - `plan:<sha256(trim(step_text))[:16]>` — content-derived scheme (`turn.plan.updated` items).
- **Positional identity for Codex is rejected**: indexes silently re-bind claims to different
  work when a plan is revised/reordered (claim history corrupts without any signal). Content
  hash handles the dominant observed pattern (statuses flip on stable text: 668/623/288 status
  churn) and degrades *loudly and honestly* on revision: a reworded step becomes a new item
  (unverified) and the old one becomes `removed`. Known degradations, documented: duplicate
  step texts within one snapshot collapse to one item (last occurrence's status wins); a
  reworded step loses its verification continuity (starts over — the safe direction).
- Snapshot reconciliation (Codex): items present → upsert with status; items previously seen
  but absent from the new snapshot → status `removed` (**inferred** — the provider stopped
  listing it; distinct from `cancelled`, which is a declared act).
- Cross-run continuity (a resumed run re-observing the same CC task list) is **P1** (join via
  ADR 0014 run lineage / `provider_session_id`); P0 identity is per run, honestly.

### D4. Data model: one additive projection table + one shared pure fold

- **Storage adjudication**: (A) session_state jsonb blob — rejected (per-item lifecycle +
  cross-session queries outgrow a bounded blob; session_state row bloat). (C) separate
  append-only claim/verification tables — rejected (the events table *is* the append-only
  history; parallel append-only stores duplicate authority). Adopted: **(B) `work_items`
  projection table** (migration #12, additive), 1 row per (session_id, work_item_id), written
  in the same ingest transaction as session_state, **rebuildable from events** (projection, not
  source of truth — same standing as session_state).
- Columns (TEXT + app-side closed-enum gates, house style; all nullable unless noted):
  `session_id` (FK, CASCADE), `work_item_id`, `id_scheme`, `subject` (redacted, bounded
  post-floor via the existing `boundTurnSummary` cap — reuse, single source),
  `status` NOT NULL, `ordinal`, `created_at`, `created_event_id`,
  `claimed_at`, `claim_event_id`, `claim_method`, `claim_fidelity`,
  `verification_state` NOT NULL, `verified_at`, `verification_event_id`, `check_kind`,
  `check_match`, `check_exit_code`, `verified_tree_fp`, `run_dirty` (bool),
  `stale_at`, `stale_event_id`, `updated_at` NOT NULL. PK `(session_id, work_item_id)` — no
  extra indexes in P0 (per-session cardinality is small; list surfaces join on the PK prefix).
  `description` is **not** projected (leak/bloat trim; the redacted event retains it and the
  UI detail can read it from the timeline event).
- **Pure fold in `packages/projection`** (`applyWorkItemsEvent` / `reduceWorkItems`), shared by
  (i) backend incremental projection (gated to relevant event types only:
  `work.item.updated`, `turn.plan.updated`, `command.completed` with a check annotation,
  `diff.updated`, terminal-bearing events; all other events skip at zero cost) and (ii) the
  webui, which folds **client-side over the event feed the Session Detail already fetches** —
  the exact pattern the replay reducer established. An INV parity test pins table rows ==
  `reduceEvents` output.
- Bound: `MAX_WORK_ITEMS = 200` per session (DoS bound, `MAX_PENDING_APPROVALS` precedent);
  overflow drops new items and counts them (observable, honest).
- **Terminal freeze**: the fold freezes on `event_type === "session.ended"` or any event
  bearing a terminal `state` (self-contained rule; no dependency on the session reducer's
  internal transition validation). After the run ends, the badge preserves the end-of-run
  truth ("claimed, never verified" survives). Known corner: an invalid-transition terminal
  claim would freeze the work fold but not session_state — low impact (items merely stop
  updating), accepted and documented.
- Wall/list rollup (claimed-unverified count per session) is **derived by query/DTO join** —
  no new session_state columns, and it does **not** feed `needs_attention` (that stays
  approvals + liveness; a separate badge avoids alarm-fatigue coupling).

### D5. CompletionClaim, tree fingerprint, and automatic staleness

- **CompletionClaim** = the first observed transition of an item to `completed` (level-based
  fold ⇒ idempotent under at-least-once delivery and under the CC dual source: a
  `TaskUpdate(status=completed)` tool observation and the `TaskCompleted` hook fold to one
  claim; `claimed_at` = first observation, `claim_method/fidelity` upgraded to the
  highest-fidelity source observed). Reopening (completed → in_progress/pending) retracts the
  claim: claim & verification fields clear, `verification_state` returns to `unverified` (the
  events keep full history; the row is current-state).
- **Tree fingerprint**: canonical `treeFingerprint(head_sha, diff_hash)` =
  sha256(head ∥ "\0" ∥ diff_hash) in `event-model` (derivation single-source; computed in the
  fold, not stored on events). Two additive sidecar changes feed it:
  1. `diff.updated` payload gains `head_sha?` (`git rev-parse HEAD` at snapshot; absent on
     unborn/non-git → fingerprint degrades to diff_hash-only and the evidence axis says so).
  2. `snapshotDiff` hash input gains per-untracked-file stat lines (path, size, mtime) —
     closes the verified blind spot where editing an *untracked* file's content changed
     nothing in porcelain/diff output. (`diff_hash` is compared only against the in-memory
     previous value; historical at-rest values are opaque, so changing the derivation is safe.)
- **VerificationState** (closed): `unverified | passed | failed | stale | waived`.
  Transitions: `unverified → passed|failed` (a bound check completes with known exit);
  `passed → stale` (fingerprint change after `verified_at`); `passed|failed|stale →
  passed|failed` (newer bound check re-runs); `* → unverified` only via claim retraction;
  `waived` is **reserved** (operator mutation surface is P1; the vocabulary is complete now so
  the enum never churns). **No permanent verified boolean exists anywhere** — `passed` is
  always relative to `verified_tree_fp` and auto-degrades to `stale`.
- **Binding rule (P0, honest)**: checks are session-global. A classified check completion binds
  to **all** items of that session in `completed` status with `claimed_at ≤` check completion
  time; the latest bound check wins per item. Per-item selective binding ("this test verifies
  claim 3") is unknowable from observation — we do not fabricate it. Consequence, stated
  plainly in UI copy: `failed` means "the latest recognized check failed on the tree that
  includes this claimed work", not "this specific claim is wrong".
- **`run_dirty`**: if a `diff.updated` fingerprint change interleaves between the bound check's
  `command.started` and `command.completed`, the verification is recorded with `run_dirty=true`
  (the tree moved *during* the check — the pass is not cleanly attributable to either tree).
  Derivable in the fold; prevents a real false-green.
- Honest limits (documented, accepted): commit-after-verify changes HEAD → `stale` even though
  content is identical (safe-direction false positive; the UI can label it "committed after
  verification"); staleness is repo-global, not per-file relevant; staleness tracking is
  in-run only (post-run human edits are a P1 cross-run concern).

### D6. Check classification: sidecar-side, canonical tokenizer, honest confidence

- Classification runs **in the sidecar at emit time** and rides the payload as closed enums —
  exactly the `risk_level` precedent. `packages/projection` never parses raw command strings
  (layering constraint + `security-gate-reuse-canonical-parser`: the classifier reuses the
  canonical `tokenize` / `stripRunnerWrappers` / `commandName` / `normalizeCommandName` chain
  in `normalize.ts`; no second parser).
- Additive payload fields on `command.started` / `command.completed` (stamped wherever the
  command string is present at emit): `check_kind?: z.enum(["test","lint","typecheck","build",
  "format"])`, `check_match?: z.enum(["program","script"])`.
  - `program`: normalized program basename is a known check tool (vitest/jest/pytest/go test/
    cargo test/eslint/tsc/prettier --check/…). `script`: runner-wrapped script/target name
    matches the check vocabulary (`pnpm test`, `npm run lint`, `make typecheck`, …) — weaker
    evidence, and the UI says so (rendered as inferred).
  - **Mutating variants are excluded** (`eslint --fix`, `prettier --write`): a command that
    rewrites the tree is not verification evidence (it also invalidates the fingerprint it
    would claim to verify).
  - No `other_check` backstop: this is not a security gate; a false negative just means "no
    evidence", which is the honest default.
- Exit codes: CC hook path — present (verified); managed Codex — present (`item.exitCode`);
  rollout — P0-B extracts `exit_code` from `function_call_output` metadata where present
  (verified against real rollouts during implementation); when absent, the check is observed
  but its outcome is unknown → it does **not** flip `verification_state` (no fabricated green
  or red).
- External adapters MAY self-declare `check_kind` on their command events (open ingest
  contract); their fidelity is whatever their evidence declaration claims (§D7).

### D7. Observation evidence: 3 axes, two carriage points; ADR 0014 Phase 5 absorbed

Closed vocabularies in `event-model`:

```
Availability = available | unsupported | permission_denied | unavailable
Method       = official_hook | official_api | provider_jsonl | local_file | log_parse | heuristic
Fidelity     = authoritative | observed | parsed | inferred | unknown
```

- **Carriage point 1 — `session.started` capability snapshot**: additive payload field
  `observation_evidence?: Partial<Record<ObservedCapability, {availability, method, fidelity}>>`
  with `ObservedCapability = z.enum(["work_items","completion_claims","verification_checks",
  "tree_fingerprint"])`. The sidecar declares, per capture path, what it can observe and how —
  recorded on the session so the audit trail keeps its guarantee level even if wiring later
  changes (ADR 0014 Phase 5's own requirement, now in-band). `availability` semantics:
  `available` = channel wired; `unsupported` = structurally impossible in this mode;
  `unavailable` = wiring failed; `permission_denied` = e.g. rollout dir unreadable.
  (Named `observation_evidence`, not `evidence`, to avoid colliding with the existing
  `terminal_evidence` axis.)
- **Carriage point 2 — per-observation stamp**: `observation?: {method, fidelity}` on
  work-item-bearing payloads only. Needed because the *same* capability arrives over channels
  of different fidelity within one session (task hook vs PostToolUse parse). Availability is
  omitted per-event (an event that exists is available); unknown/enum-invalid stamps project to
  `undefined` (= evidence absent, safe).
- Per-event stamping on *all* events is rejected (payload bloat, no consumer); a
  per-capability-only snapshot is rejected (cannot express intra-session channel differences).
- **official ≠ authoritative** — enforced by the assignments. Nothing in P0 earns
  `authoritative` (reserved for provider-persisted ground truth re-readable on demand):

| Channel (real, verified) | method | fidelity |
|---|---|---|
| CC `TaskCreated`/`TaskCompleted` hook | `official_hook` | `observed` (dedicated semantic hook; best-effort delivery, no ordering guarantee) |
| CC `PostToolUse(TaskCreate/TaskUpdate)` parse | `official_hook` | `parsed` (semantics extracted from a general-purpose tool record) |
| Codex managed `turn/plan/updated` notification | `official_api` | `observed` |
| Codex rollout `update_plan` function_call | `provider_jsonl` | `parsed` |
| CC PostToolUse(Bash) exit_code (checks) | `official_hook` | `observed` |
| Codex rollout check exit (metadata, when present) | `provider_jsonl` | `parsed` |
| Tree fingerprint (git snapshot by sidecar) | `local_file` | `observed` |

- **ADR 0014 Phase 5 absorption**: the closed vocabulary
  {authoritative, observed, inferred, unsupported, unverified} maps onto the axes —
  authoritative/observed/inferred → `Fidelity`; unsupported → `Availability=unsupported`;
  unverified → `Fidelity=unknown` (declared-untested). The per-adapter `adapter.manifest.json`
  **file is retired for these capabilities**: in-band declaration (snapshot + stamps) is
  versioned with the events themselves, needs no separate distribution/hash plumbing, and
  satisfies the same audit requirement. ADR 0014's acceptance test #9 transposes to: an
  adapter whose fixtures contradict its declared `observation_evidence` fails CI. Phase 4
  stays in ADR 0014 unchanged. Capabilities beyond this ADR's four (session_end, resume,
  approval_relay, …) migrate into `ObservedCapability` additively if/when they get consumers.

### D8. UI derivation: one pure badge function, four states

Single source `deriveWorkItemBadge(item)` in the shared fold package (webui maps to locale
strings via the existing LocaleProvider pattern — no baked Japanese):

| badge | condition |
|---|---|
| self-claimed (自己申告完了) | `status=completed ∧ verification_state=unverified` |
| verified (検証済み) | `status=completed ∧ verification_state=passed` (implies fingerprint currently matches) |
| verification failed (検証失敗) | `status=completed ∧ verification_state=failed` |
| changed after verification (検証後変更あり) | `status=completed ∧ verification_state=stale` |

Non-completed items render plain status (no badge). `waived` renders only after its P1
mutation surface exists. Session Detail gains an additive work-items panel (fed by the
client-side fold over the already-fetched event feed; exact pane placement is
frontend-engineer discretion — the contract is the badge set, the per-item list with
`method/fidelity` evidence annotation, `run_dirty` and stale-reason display, and evidence-ref
links jumping to the claim / check / diff timeline entries). The Wall session card gains a
claimed-unverified count badge (query-derived, §D4). Merge point noted, not implemented here:
the 3c "continued from" UI (ADR 0014 Phase 3 lineage, task `019f8053-0a0c`) is where P1
cross-run work-item carry-over will attach (same lineage join, `parent_thread_id` stays
subagent lineage and is never treated as continuation).

### D9. Governance stance: observe in P0; the gating point is real and documented

P0 blocks nothing and changes no approval/policy behavior ("observe everything, govern
selectively" — integrity detection is additive). The proven mechanism for future
**task-completion gating** — `TaskCompleted` hook exit-2 causes `TaskUpdate(status=completed)`
to return `success:false` and feeds stderr back to the model — is the designated follow point:
a later opt-in phase can wire "claimed complete but latest check failed/absent on current
tree" into that hook response through the existing approval-policy machinery (a new
`PolicyCategory`-style opt-in, default OFF, same Web-UI-approval / timeout-deny shape as
ADR 019f0c3e). Explicitly out of P0 scope; recorded here so the observation contracts are
designed to be sufficient for it (they are: the fold state at claim time answers the gate
question).

### D10. Redaction and leak faces (INV-REDACTION extension)

All new free text (task subject/description, plan step text) enters only via existing emit
paths that pass the sink choke (`sink.emit` → redact → persist/send); no new emission path is
created. Enumerated new leak faces and their closures:

1. `work.item.updated` subject/description, `turn.plan.updated` item step text — through the
   existing choke on both hook and rollout paths; red test **INV-REDACTION-WORKITEM** (secret
   fixture in subject and in a plan step → at-rest payload carries markers, raw absent; both
   paths).
2. `work_items.subject` column — written only from post-choke payload by construction (the
   backend only ever sees redacted events), bounded post-floor with the existing cap
   (redact → truncate order preserved; truncation never precedes the floor).
3. Work-item ids — hash-only (no provider text in ids), derived from post-redaction text
   (§D3; no pre-redaction hash oracle).
4. `head_sha` — a commit id, content-free; `diff_hash` already ships.
5. Evidence stamps / capability snapshot — closed enums only (NO-RAW by construction; unknown
   values are structurally dropped at parse boundaries).
6. Check annotations — closed enums (`check_kind`/`check_match`) + integer exit codes; check
   stdout/stderr are **not** newly persisted (the existing bounded output-delta path is
   unchanged; verification stores refs + enums only).
7. Hook injection extension — a user-settings write, not a leak face: same non-destructive
   merge / reversible detach / 0600 atomic write rules as the existing injected hooks; no new
   credential class (same HOOK_TOKEN header mechanism).

## Phased implementation (each slice independently SEC/QA/TDA-auditable, ≤800 lines target)

**P0-A — spine (no UI, no hook injection):**

| slice | content | high-risk faces |
|---|---|---|
| A1 contracts | event-model: `work.item.updated` variant + `WorkItemStatus` / `VerificationState` / `CheckKind` / `CheckMatch` / Observation enums + `TurnPlanUpdated.items` + `command.*` check fields + `diff.updated.head_sha` + `session.started.observation_evidence` + `deriveWorkItemId` + `treeFingerprint` + `deriveWorkItemBadge`; migration #12 `work_items`; pure fold in `packages/projection` + INV tests (id determinism, fold parity, transition rules, freeze) | contract review only (no live-path behavior change); event-type enum addition ⇒ **deploy backend (event-model bump) before/with sidecar** — an old backend rejects unknown event types at ingest |
| A2 Codex plans | fix rollout misroute (add `update_plan` case → one `turn.plan.updated` with typed items; parse-fail → items absent, never the generic command fallthrough) + managed per-step status (gap (a)) + backend `work_items` incremental wiring; verify against **real rollouts** | event order/idempotency (re-tail same file → same ids, no dup items); removes existing command-stream pollution (misroute (b) is also a correctness bugfix) |

**P0-B — vertical (ship = differentiation gate):**

| slice | content | high-risk faces |
|---|---|---|
| B1 verification | sidecar check classifier (canonical tokenizer reuse) + exit-code extraction (rollout metadata; managed/CC already present) + `head_sha` + untracked-stat hash extension + verification/stale/`run_dirty` fold live | classifier correctness (canonical-parser reuse meta-test); redact→truncate order; fingerprint semantics (INV-VERIFICATION-STALE: no permanent verified) |
| B2 CC tasks | settings-injection: add `TaskCreated`/`TaskCompleted` to the injected set (single-source list, managed+attach) + `normalizeHook` cases + `PostToolUse(TaskCreate/TaskUpdate)` parsing → `work.item.updated`; live-verify field names before parsing | **user settings write** (non-destructive merge, reversible detach, 0600 atomic); **redaction choke** for subject/description (INV-REDACTION-WORKITEM); dual-source claim idempotency |
| B3 UI | Session Detail work-items panel (client fold), 4 badges, evidence/fidelity annotation, evidence-ref links, Wall claimed-unverified count | display-only; no live-gate interaction; NO-RAW in DOM (ids are hashes, subjects redacted+bounded) |

Multi-tier deploy note: event-model changes require backend + sidecar dist rebuild + webui in
one rollout (per the standing multi-tier redeploy rule); partial deployment degrades benignly
(old sidecar → new backend: fine; new sidecar → old backend: new event types rejected at
ingest — hence backend-first ordering).

**P1 reserved (explicitly out of P0):**
- **Effective Context Evidence** (fixed name): ContextSource / ContextVersion / ContextInclusion
  via additive migration; ContextPresence 5 levels `configured / discovered / eligible /
  loaded / referenced` — "used" is forbidden vocabulary.
- `compact_summary` persistence: location **unverified** (docs claim PreCompact; sidecar keeps
  only the trigger today) — must be live-verified first, and persistence goes through the
  INV-REDACTION choke (LEVEL 0), stored bounded post-floor.
- `InstructionsLoaded` registration (real fields `file_path` / `memory_type` / `load_reason`;
  docs drift on record).
- Task-completion gating (opt-in, §D9). Operator `waived` mutation surface. Cross-run
  work-item lineage merge (via `provider_session_id`; `parent_thread_id` never used for it).
  Codex hooks investigation.

## Acceptance tests (minimum)

1. `deriveWorkItemId` is deterministic and idempotent: same (scheme, text) → same id; ids
   contain no raw provider text (hash form only).
2. Re-tailing the same rollout file re-emits identical `turn.plan.updated` event ids; the fold
   produces no duplicate work items (INV-PLAN-SNAPSHOT-IDEMPOTENT).
3. A real-rollout `update_plan` record normalizes to `turn.plan.updated` with typed items and
   is **not** routed to `command.started`.
4. Managed `turn/plan/updated` preserves per-step status in `items`; legacy `steps` unchanged.
5. Codex snapshot reconciliation: a step absent from the next snapshot becomes `removed`; a
   reworded step becomes a new item and the old one `removed` (no silent re-binding).
6. CC dual-source claim: `PostToolUse(TaskUpdate→completed)` + `TaskCompleted` hook fold to
   **one** claim; `claimed_at` = first observation; fidelity upgrades to the dedicated hook.
7. `work.item.updated` carries no `state` and never moves the session state machine
   (INV-WORKITEM-NO-STATE).
8. Verification transitions: claim → passing bound check ⇒ `passed` (with `verified_tree_fp`);
   subsequent `diff.updated` with a different fingerprint ⇒ `stale` (INV-VERIFICATION-STALE —
   no permanent verified boolean); failing check ⇒ `failed`; reopen ⇒ claim retracted,
   `unverified`.
9. A fingerprint change interleaved between the bound check's start and completion sets
   `run_dirty=true`.
10. Untracked-file content edit changes `diff_hash` (stat-line extension) and drives staleness.
11. Check classification: mutating variants (`eslint --fix`, `prettier --write`) are not
    checks; `pnpm test` classifies as (`test`, `script`); `vitest run` as (`test`, `program`);
    classifier meta-test proves it consumes the canonical tokenizer chain (no second parser).
12. Rollout check with no extractable exit code does not flip `verification_state`.
13. INV-REDACTION-WORKITEM: secret fixtures in task subject and plan step are redacted at rest
    on both hook and rollout paths; `work_items.subject` is bounded and marker-bearing.
14. Fold parity: `work_items` table rows equal the pure `reduceWorkItems` output over the same
    event sequence (backend incremental == webui client fold == replay).
15. Terminal freeze: post-`session.ended` work-item / check / diff events do not mutate frozen
    rows.
16. An adapter whose fixtures contradict its declared `observation_evidence` fails CI
    (transposed ADR 0014 test #9).

## Consequences

- The differentiator becomes concrete and shippable: per work item, the cockpit answers
  "claimed / verified / failed / changed-since-verified" from observed events only — no
  fabricated certainty, with the observation channel and its fidelity declared on-screen.
- One new event type, one additive payload extension, one additive table; no State enum
  growth, no reducer changes, no destructive migration; everything rebuildable from the
  append-only event log.
- The verification fold is provider-agnostic (any source whose commands and diffs we observe
  gains verification for free; external adapters can self-declare checks and evidence).
- Honest-limit surface grows (session-global check binding, commit-after-verify staleness,
  content-hash identity degradations) — all documented above and rendered as evidence, which
  is the product's positioning, not a weakness.
- ADR 0014 Phase 5's manifest file is retired in favor of in-band evidence; ADR 0014 Phase 4
  is unaffected.
- P0 changes no governance behavior; the proven exit-2 gating point is documented and the
  contracts here are sufficient for a later opt-in gate (no redesign needed to govern).
