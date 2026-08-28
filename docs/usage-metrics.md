# Usage metrics

ActraDeck separates public distribution signals, local product usage, and explicitly opted-in
anonymous telemetry. The product remains local-first: central telemetry is off by default, while
`npx actradeck demo` remains a network-free synthetic preview.

## Public distribution snapshots

`.github/workflows/public-metrics.yml` runs daily and writes a dated JSON file under
`metrics/public/` on the dedicated
[`metrics` branch](https://github.com/actradeck/actradeck/tree/metrics/metrics/public), not on
`main`: the `main` ruleset requires a pull request and the `verify` status check, so a direct
push by the workflow is rejected (GH013), and the branch keeps snapshot commits out of the
product history. The branch is created by the first run and holds nothing but
`metrics/public/`. Each snapshot records:

- npm downloads for the previous UTC day;
- npm's rolling seven-day per-version breakdown;
- cumulative GitHub release-asset download counters.

Repository traffic (views/clones) is deliberately **not** snapshotted: GitHub scopes that data to
push-access holders, and anything this public repository's workflow writes is public. Read
traffic in GitHub Insights directly.

These counters are distribution signals, not installations or users. The daily snapshots retain
history that the upstream APIs only expose for short windows. Run the collector manually:

```bash
node scripts/collect-public-metrics.mjs --dry-run
```

A missed day is backfilled by dispatching the workflow with its `date` input (or locally with
`--date YYYY-MM-DD`). The npm daily figure is exact for the requested day because the npm API is
queried by date; the seven-day per-version window and the release-asset counters are whatever
the APIs report at collection time, and `collected_at` in the file says when that was. The
2026-08-25 to 2026-08-27 snapshots were backfilled this way on 2026-08-28 (UTC) after the
scheduled runs of 2026-08-26 to 2026-08-28 had failed on the `main` push.

## Local aggregate usage

With the cockpit running, inspect the local database through the authenticated loopback endpoint:

```bash
./scripts/actradeck usage --since 30d
./scripts/actradeck usage --since 2026-08-01 --json
```

The aggregation runs range-bounded against the base tables and reports UTC day buckets only:

- `cockpit_demo_started` and `cockpit_demo_completed`;
- `real_sessions` — distinct non-demo sessions with at least one non-heartbeat event on the day.
  Note (QA-R3-3): the `totals` block sums these per-day distincts, so over a multi-day window it
  counts **session-days**, not unique sessions — a session active on two days contributes 2 to
  `totals.real_sessions` but 1 to `protected_sessions` (derived per session). The direction is
  safe (the protected ratio can only be under-reported) and the anonymous telemetry batch
  consumes only the per-day rows, never this fold.
  Deriving this from events (not from observed session starts) keeps sessions that ActraDeck
  attached to mid-flight visible as activity;
- `protected_sessions` (real sessions explicitly declaring `governance_mode=enforcement`);
- `approval_requests`;
- `operator_decisions` (`resolution_origin=operator`).

Honest boundaries of `protected_sessions`: the guarantee is only recorded when a session **start**
was observed carrying governance evidence. Sessions stored before the governance-mode upgrade,
and sessions whose start ActraDeck never observed (mid-flight attach), stay unclassified (NULL)
and are never inferred as protected — for those enumerated cases the direction is strictly
under-reporting. Two disclosures go the other way (broader than their evidence):

1. **Managed Codex constant declaration** (TDA-R4-2): a managed Codex session declares
   `enforcement` as a constant because ActraDeck's shared approval bridge supervises it, but
   ActraDeck does not read Codex's own approval configuration — an operator `approval_policy`
   that suppresses approval requests would not demote the declaration. Deriving that
   declaration from observed approval traffic is tracked as a follow-up.
2. **Mid-session bypass switch** (SEC-R5-1): the governance declaration is evaluated once at
   session start, while the approval gate re-evaluates `permission_mode` per operation. A
   session that starts under a gated mode and is switched to `bypassPermissions` mid-run keeps
   its start-time `enforcement` declaration, so `protected_sessions` (and the derived
   `governed_session_started` telemetry counter) can over-count such sessions. The live gate
   itself is unaffected — per-operation evaluation stays correct. Demoting the stored
   declaration when the observed mode weakens is tracked as a follow-up.

The endpoint and CLI never return prompts, commands, paths, repository names, session/event IDs,
or sub-day timestamps. These metrics stay on the machine unless the operator explicitly exports
the JSON output or separately opts in to the closed-schema anonymous counters described in
[Anonymous telemetry](./anonymous-telemetry.md).

## Explicit anonymous telemetry

The Cockpit **Settings → Privacy** panel and `actradeck telemetry` CLI show the exact outgoing batch
and provide enable, disable, reset-ID, and manual-send controls. Nothing is uploaded before an
explicit enable action. The independently deployed aggregate collector and PMF report are
documented in [Anonymous telemetry](./anonymous-telemetry.md).

## Governance guarantee

`session.started` may carry one closed-enum guarantee:

| `governance_mode` | Meaning                                                                 |
| ----------------- | ----------------------------------------------------------------------- |
| `enforcement`     | ActraDeck's approval gate is in the execution path.                     |
| `observe_only`    | The session is auditable, but ActraDeck cannot stop the execution path. |
| `unavailable`     | The producer cannot establish the guarantee at session start.           |

Missing and `unavailable` values are never inferred as protected. Codex rollout capture and the
throwaway cockpit demo are `observe_only`; an ordinary managed/Claude hook session declares
`enforcement`. A Claude `bypassPermissions` session is conservatively `unavailable` because the
effective per-repository gate cannot be proven by the synchronous session-start normalizer.
A managed Codex session declares `enforcement` from the shared approval bridge that supervises
it; unlike the Claude path, this declaration is not demoted by Codex-side approval settings
(see the boundary note above).
