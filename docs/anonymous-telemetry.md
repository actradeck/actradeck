# Anonymous telemetry

ActraDeck's central product telemetry is **off by default** and requires an explicit opt-in on
each installation. Local audit data and local usage aggregates work without opting in. The
five-second `npx actradeck@latest demo` never reads or writes telemetry state and never uses the
network.

## What users can see

Every clone includes the same controls. Each user can inspect their own state and the exact batch
before enabling or sending:

```bash
./scripts/actradeck telemetry status
./scripts/actradeck telemetry preview
./scripts/actradeck telemetry enable
./scripts/actradeck telemetry flush
./scripts/actradeck telemetry reset-id
./scripts/actradeck telemetry disable
```

The Cockpit's **Settings → Privacy** panel exposes the same controls. `disable` deletes the random
installation identifier from the local state file — it does not remove rows already received by
the collector (see [Retention and deletion](#retention-and-deletion)). Enabling again creates a new
identifier. The state file is mode `0600` and defaults to `~/.actradeck/telemetry.json` (or beside
an overridden `ACTRADECK_PGDATA`).

The official collector is
`https://actradeck-telemetry.actradeck-telemetry-collector.workers.dev/v1/events`. This public URL
is built into the backend only as the destination offered by the consent control; it does not turn
telemetry on. Self-hosters can still pass `--endpoint` or set `ACTRADECK_TELEMETRY_ENDPOINT`.

The local usage report is separate and remains available with telemetry off:

```bash
./scripts/actradeck usage --since 30d
```

## Closed wire contract

The sender can represent only these UTC-day counters:

| Event                      | Definition                                                                                                                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `install_verified`         | Anonymous telemetry was explicitly enabled for this random installation ID. Anchored to the enable day; clamped into the reported 30-day window when older.                                    |
| `cockpit_started`          | A UTC day on which the opted-in cockpit backend was running (daily presence, recorded at most once per day — process restarts do not inflate it).                                              |
| `cockpit_demo_started`     | Built-in Cockpit safety-demo start.                                                                                                                                                            |
| `cockpit_demo_completed`   | Built-in Cockpit safety-demo completion.                                                                                                                                                       |
| `first_agent_observed`     | First real agent activity represented in the reported history.                                                                                                                                 |
| `first_governed_session`   | First session that _declared_ `governance_mode=enforcement` at session start (a start-time declaration, not a per-operation measurement — see [Usage metrics](./usage-metrics.md)).            |
| `governed_session_started` | Real session declaring `governance_mode=enforcement` at session start. The declaration can be broader than its evidence; see the honest-boundary cases in [Usage metrics](./usage-metrics.md). |
| `approval_requested`       | Approval request count.                                                                                                                                                                        |
| `approval_decided`         | Operator-originated allow/deny decision count.                                                                                                                                                 |
| `active_day`               | UTC day with at least one real observed session (including sessions ActraDeck attached to mid-flight).                                                                                         |

Each row also contains the ActraDeck semantic version and coarse platform
(`linux`/`darwin`/`win32`/`other`). Batches contain a random UUID, absolute daily counts, and no
extension object. Unknown event names or fields fail strict validation at both contract tests and
the collector.

The schema cannot carry prompts, commands, filesystem paths, repository names, ActraDeck session
or event IDs, secrets, audit bodies, or sub-day activity timestamps. The collector application and
D1 schema do not store IP addresses or User-Agent values. The Worker passes Cloudflare's connection
IP to a Rate Limiting binding as a transient key only; Worker observability is disabled. Cloudflare
still processes network metadata as the infrastructure provider.

## Data flow and ownership

```text
local usage aggregation (range-bounded, UTC day buckets)
        |
        | explicit opt-in; HTTPS; 6-hour retry of absolute daily counters
        v
strict telemetry contract -> Cloudflare Worker -> HMAC(installation UUID) -> D1 daily rows
                                                                         |
                                                                         v
                                                          aggregate-only admin PMF report
```

An individual user sees only their local status and outgoing preview. The service operator sees
only the aggregate admin report; the API never returns installation UUIDs or their HMACs. There is
no shared dashboard embedded in every clone, because publishing a live global report would expose
product metrics and make metric poisoning easier. Maintainers may publish selected aggregate
numbers separately.

## Retention and deletion

These are the actual properties of the shipped collector, stated so that the consent decision is
made on facts rather than on the button labels:

- **Rows are kept for 24 months, then purged automatically.** `TELEMETRY_RETENTION_MONTHS` in
  `@actradeck/telemetry-contract` is the single source (operator decision, 2026-08-26). A daily
  cron trigger (`triggers.crons` in the Worker config) runs the `scheduled` handler, which
  deletes every row whose `occurred_on` is strictly older than 24 months at run time; the cutoff
  day itself is retained. There is no delete endpoint (the only routes are `/health`,
  `POST /v1/events`, and `GET /v1/admin/report`), so nothing except the purge and the operator's
  manual action removes rows before that.
- **`disable` is local.** "Stop and delete ID" removes the random installation UUID from the
  local state file. Rows already received under that UUID's hash remain on the server until the
  24-month purge reaches them.
- **Deletion of already-sent rows requires the installation ID.** The UUID is stored only as an
  HMAC under a server-side secret, and the admin report never returns hashes, so the operator
  cannot tell which rows belong to which installation on their own. The HMAC is deterministic,
  however: a user who sends their anonymous installation ID (shown in **Settings → Privacy** and
  by `actradeck telemetry status` while enabled) lets the operator recompute the hash and delete
  exactly those rows. Do this **before** running `disable` or `reset-id` — once the local ID is
  gone, nobody can identify the rows any more. Send the ID through a private channel (the
  reporting path in `SECURITY.md`), never in a public issue. There is no self-service deletion
  endpoint; without an ID the operator can only delete in bulk (by day range or by dropping the
  table).
- **Purpose.** The aggregates exist to judge whether the product is actually used (the funnel in
  [PMF interpretation](#pmf-interpretation)) and to prioritise development. They are not used for
  billing, advertising, identifying anyone, or sharing raw rows with third parties; Cloudflare
  hosts the Worker and D1 as the infrastructure provider. The consent panel states the same
  purpose before opt-in.
- **Reset and re-enable start a new lineage.** A regenerated or newly created UUID hashes to a
  different value; rows sent afterwards are unlinkable from earlier rows. Rotating `HASH_SECRET`
  server-side has the same effect for every installation at once.
- **Each row carries `app_version` and `platform`** in addition to the event name, UTC day, and
  count. Both are listed in the consent panel and visible in the preview.

## Operating the Cloudflare collector

The collector under `apps/telemetry-collector` is a Cloudflare Worker backed by D1. It is not
started by `actradeck up`. Its public source contains only binding names and a zero UUID placeholder;
the Cloudflare database ID and account-specific deployment configuration live in the ignored
`wrangler.local.jsonc`. The two actual secret values live only in Cloudflare Worker Secrets:

- `HASH_SECRET`: at least 32 random characters, used to HMAC installation UUIDs before D1 writes.
- `ADMIN_TOKEN`: at least 32 random characters, required by the aggregate report endpoint.

Never put either value in `wrangler*.jsonc`, `.env`, source code, CI logs, or GitHub Actions secrets
that do not need deployment access.

### First deployment

Install dependencies and validate the Worker locally:

```bash
pnpm install
pnpm --filter @actradeck/telemetry-collector test:worker
pnpm --filter @actradeck/telemetry-collector build:worker
```

Authenticate Wrangler, create the D1 database, and copy the example configuration:

```bash
pnpm --filter @actradeck/telemetry-collector exec wrangler login
pnpm --filter @actradeck/telemetry-collector exec wrangler d1 create actradeck-telemetry
cp apps/telemetry-collector/wrangler.example.jsonc \
  apps/telemetry-collector/wrangler.local.jsonc
```

Put the returned `database_id` into `wrangler.local.jsonc`. This local file is ignored. Keep
everything else identical to the example, including `triggers.crons`: the deploy registers that
daily cron, which runs the `scheduled` retention purge (see
[Retention and deletion](#retention-and-deletion)). A Worker deployed from a config without the
trigger never purges. Then apply the migration and deploy:

```bash
pnpm --filter @actradeck/telemetry-collector db:migrate:remote
pnpm --filter @actradeck/telemetry-collector run deploy
```

Add each secret through Wrangler's interactive prompt; paste a separately generated random value
without writing it to a repository file:

```bash
pnpm --filter @actradeck/telemetry-collector exec wrangler secret put HASH_SECRET \
  --config wrangler.local.jsonc
pnpm --filter @actradeck/telemetry-collector exec wrangler secret put ADMIN_TOKEN \
  --config wrangler.local.jsonc
```

The deploy command returns an HTTPS `workers.dev` URL. A custom domain is optional. Confirm only the
public health response before configuring clients:

```bash
curl -fsS https://actradeck-telemetry.actradeck-telemetry-collector.workers.dev/health
```

On the first Worker in a Cloudflare account, the dashboard may first ask the owner to register the
account-wide `workers.dev` subdomain. This repository does not automate that account-wide naming
choice.

`POST /v1/events` is intentionally public so explicitly opted-in installations can send closed,
anonymous daily counters. It is limited to 120 requests per minute per transient edge IP key and a
128 KiB body. `GET /v1/admin/report` is bearer-token protected and returns aggregates only. For an
additional owner-only boundary, put the admin path behind a Cloudflare Access policy. D1 itself is
visible only to members of the Cloudflare account with the required permissions.

Rotate `ADMIN_TOKEN` as a bearer credential. Rotating `HASH_SECRET` intentionally prevents linking
new uploads with old installation hashes, so do it only as a deliberate privacy reset or incident
response. Apply future D1 migrations before deploying code that depends on them.

Configure a default collector URL on Cockpit hosts if desired:

```bash
ACTRADECK_TELEMETRY_ENDPOINT=https://your-collector.example/v1/events
```

This overrides the official destination offered by the consent control. It does **not** enable
telemetry.

Fetch an aggregate report for a bounded UTC range (maximum 365 days):

```bash
curl -fsS \
  -H "Authorization: Bearer $TELEMETRY_ADMIN_TOKEN" \
  "https://actradeck-telemetry.actradeck-telemetry-collector.workers.dev/v1/admin/report?from=2026-08-01&to=2026-08-31"
```

The report contains funnel installation counts, total and daily governed sessions/approvals, and
exact-day D1/D7/D30 active-installation retention. Public OSS clients cannot carry a secret that
proves they are genuine, so these numbers are directional product evidence—not billing,
compliance, or fraud-resistant analytics. Rate limits, the closed schema, and the accepted
`occurred_on` window (past 90 days to next-day UTC; out-of-window days are rejected) bound abuse
but do not eliminate deliberate metric poisoning.

### Why GA is not the primary collector

D1 is the source of truth. The sender retries **absolute** UTC-day counters, and D1 keeps the maximum
value, so retries are idempotent. Forwarding every retry directly into GA would count the same usage
again. A future GA integration must derive monotonic deltas through an outbox or scheduled export;
it must not receive raw audit data or replace the D1 aggregates. GA is therefore intentionally not
enabled in this deployment.

## PMF interpretation

Use the signals as a funnel, not as a single vanity metric:

1. npm/GitHub snapshots indicate discovery.
2. `install_verified` and `cockpit_demo_completed` indicate successful evaluation.
3. `first_agent_observed` indicates the user crossed into a real workflow.
4. `first_governed_session` and `governed_session_started` count sessions that **declared**
   `governance_mode=enforcement` at session start. That is a declaration, not a per-operation
   measurement of the execution path: two enumerated cases are broader than their evidence (the
   managed-Codex constant declaration, and a mid-session switch to `bypassPermissions` that
   keeps the start-time declaration). See "Honest boundaries" in
   [Usage metrics](./usage-metrics.md) before quoting these counters.
5. D7/D30 `active_day` retention indicates repeated real use.

Stars and downloads alone cannot validate PMF. Conversely, a small number of retained governed
installations is more useful evidence than many demo runs. Pair aggregates with opt-in user
interviews; the counters explain **what happened**, not why.
