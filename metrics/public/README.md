# Public distribution snapshots

The scheduled `public-metrics.yml` workflow writes one JSON snapshot per UTC day here.

These values are distribution signals, not installations or users:

- npm daily downloads and the rolling seven-day per-version breakdown
- GitHub's rolling 14-day views and clones
- cumulative GitHub release-asset download counters

Keeping daily snapshots is intentional: the upstream per-version and repository-traffic
windows are short. Product usage, prompts, commands, paths, session identifiers, and audit
events are never sent to or stored by this workflow.
