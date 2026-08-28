# Public distribution snapshots

The scheduled `public-metrics.yml` workflow writes one JSON snapshot per UTC day into this
directory on the dedicated `metrics` branch
(<https://github.com/actradeck/actradeck/tree/metrics/metrics/public>). On `main` this directory
holds only this README: the `main` ruleset requires a pull request and the `verify` check, so the
workflow cannot push here, and snapshot commits stay out of the product history. See
`docs/usage-metrics.md` for the fields and for how a missed day is backfilled.

These values are distribution signals, not installations or users:

- npm daily downloads and the rolling seven-day per-version breakdown
- cumulative GitHub release-asset download counters

Repository traffic (views/clones) is deliberately not snapshotted: GitHub scopes it to
push-access holders, and everything committed here is public. Read it in GitHub Insights.

Keeping daily snapshots is intentional: the upstream per-version windows are short. Product
usage, prompts, commands, paths, session identifiers, and audit events are never sent to or
stored by this workflow.
