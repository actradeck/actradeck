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
installation identifier from the local state file. Enabling again creates a new identifier. The
state file is mode `0600` and defaults to `~/.actradeck/telemetry.json` (or beside an overridden
`ACTRADECK_PGDATA`).

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

| Event                      | Definition                                                                  |
| -------------------------- | --------------------------------------------------------------------------- |
| `install_verified`         | Anonymous telemetry was explicitly enabled for this random installation ID. Anchored to the enable day; clamped into the reported 30-day window when older. |
| `cockpit_started`          | A UTC day on which the opted-in cockpit backend was running (daily presence, recorded at most once per day — process restarts do not inflate it). |
| `cockpit_demo_started`     | Built-in Cockpit safety-demo start.                                         |
| `cockpit_demo_completed`   | Built-in Cockpit safety-demo completion.                                    |
| `first_agent_observed`     | First real agent activity represented in the reported history.              |
| `first_governed_session`   | First enforcement-mode session represented in the reported history.         |
| `governed_session_started` | Real session declaring `governance_mode=enforcement`.                       |
| `approval_requested`       | Approval request count.                                                     |
| `approval_decided`         | Operator-originated allow/deny decision count.                              |
| `active_day`               | UTC day with at least one real observed session (including sessions ActraDeck attached to mid-flight). |

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

Put the returned `database_id` into `wrangler.local.jsonc`. This local file is ignored. Then apply
the migration and deploy:

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
4. `first_governed_session` and `governed_session_started` indicate the approval gate was actually
   in the execution path—not merely observe-only.
5. D7/D30 `active_day` retention indicates repeated real use.

Stars and downloads alone cannot validate PMF. Conversely, a small number of retained governed
installations is more useful evidence than many demo runs. Pair aggregates with opt-in user
interviews; the counters explain **what happened**, not why.
