# Usage metrics

ActraDeck separates public distribution signals, local product usage, and explicitly opted-in
anonymous telemetry. The product remains local-first: central telemetry is off by default, while
`npx actradeck demo` remains a network-free synthetic preview.

## Public distribution snapshots

`.github/workflows/public-metrics.yml` runs daily and writes a dated JSON file under
`metrics/public/`. It records:

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

## Local aggregate usage

With the cockpit running, inspect the local database through the authenticated loopback endpoint:

```bash
./scripts/actradeck usage --since 30d
./scripts/actradeck usage --since 2026-08-01 --json
```

The aggregation runs range-bounded against the base tables and reports UTC day buckets only:

- `cockpit_demo_started` and `cockpit_demo_completed`;
- `real_sessions` — distinct non-demo sessions with at least one non-heartbeat event on the day.
  Deriving this from events (not from observed session starts) keeps sessions that ActraDeck
  attached to mid-flight visible as activity;
- `protected_sessions` (real sessions explicitly declaring `governance_mode=enforcement`);
- `approval_requests`;
- `operator_decisions` (`resolution_origin=operator`).

Honest boundaries of `protected_sessions`: the guarantee is only recorded when a session **start**
was observed carrying governance evidence. Sessions stored before the governance-mode upgrade,
and sessions whose start ActraDeck never observed (mid-flight attach), stay unclassified (NULL)
and are never inferred as protected — so the protected ratio under-reports rather than
over-claims.

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
