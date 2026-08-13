# Usage metrics

ActraDeck separates public distribution signals, local product usage, and explicitly opted-in
anonymous telemetry. The product remains local-first: central telemetry is off by default, while
`npx actradeck demo` remains a network-free synthetic preview.

## Public distribution snapshots

`.github/workflows/public-metrics.yml` runs daily and writes a dated JSON file under
`metrics/public/`. It records:

- npm downloads for the previous UTC day;
- npm's rolling seven-day per-version breakdown;
- GitHub's rolling views and clone counters;
- cumulative GitHub release-asset download counters.

These counters are distribution signals, not installations or users. The daily snapshots retain
history that the upstream APIs only expose for short windows. Run the collector manually with a
repository-scoped GitHub token:

```bash
GITHUB_TOKEN=... node scripts/collect-public-metrics.mjs --dry-run
```

## Local aggregate usage

With the cockpit running, inspect the local database through the authenticated loopback endpoint:

```bash
./scripts/actradeck usage --since 30d
./scripts/actradeck usage --since 2026-08-01 --json
```

The `usage_daily` database view reports UTC day buckets only:

- `cockpit_demo_started` and `cockpit_demo_completed`;
- `real_sessions` (demo sessions excluded);
- `protected_sessions` (real sessions explicitly declaring `governance_mode=enforcement`);
- `approval_requests`;
- `operator_decisions` (`resolution_origin=operator`).

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
