# Running ActraDeck in Docker (one-command cockpit)

> ADR [`0013`](./adr/0013-release-signing-and-distribution.md) Phase 2. Status:
> infrastructure + local build/run verified; the signed GHCR image is **published on
> demand** (the release workflow's image job is off by default — see
> [Publishing](#publishing-the-signed-image-maintainers)).

The Docker image gets you a running **cockpit** with one command and no external
database. It is the fastest way to *look at* ActraDeck; it is **not** the whole product.
Read [What runs where](#what-runs-where-the-honest-support-matrix) before you rely on it.

## What runs where (the honest support matrix)

ActraDeck is four tiers plus a database. They do **not** all belong in a container.

| Tier | Where it runs | Why |
| --- | --- | --- |
| **backend** (ingestion + realtime, `:55410`) | **container** | pure network service |
| **webui / BFF** (Cockpit UI, `:55400`) | **container** | pure network service |
| **embedded PostgreSQL** (PGlite) | **container** (`/data` volume) | in-process; no external DB needed |
| **sidecar** — Claude Code attach (`ad-attach`) | **host** | observes the host's Claude Code **hooks** + process liveness |
| **sidecar** — Codex attach (`codex attach`) | **host** | tails the host's Codex **rollout files** (`CODEX_HOME`) |

The sidecar's entire job is to watch coding-agent CLIs **on your machine** — their hook
callbacks, their rollout JSONL, whether the process is alive. Those live in the host's
process and file space. A sidecar inside a container would see an empty container, not
your `claude` / `codex` runs — so shipping it in the image would be theatre, not
observation. The container therefore runs the **cockpit stack**, and the sidecar runs on
the host and connects back over loopback. This mirrors how `scripts/actradeck` already
splits the cockpit server tier from the observation-daemon tier.

**Consequence:** `docker run` alone gives you a cockpit that is *up* but *empty* until a
host-side agent is wired to it. That is expected and honest — the same way the native
quickstart's cockpit stays empty until you run an agent.

## Quick start (cockpit only)

```bash
docker run --rm \
  -p 127.0.0.1:55400:55400 \
  -v actradeck_pgdata:/data \
  ghcr.io/actradeck/actradeck:latest
# open http://localhost:55400
```

- `-p 127.0.0.1:55400:55400` publishes the Cockpit UI **to loopback only** (do not bind
  `0.0.0.0` unless you understand the exposure — the cockpit is single-operator by design).
- `-v actradeck_pgdata:/data` persists the embedded database across container restarts.
  Omit it for a throwaway run (data is discarded when the container is removed).

No build step, no external Postgres, no secrets to set — the entrypoint generates an
ephemeral `INGEST_TOKEN` / `REALTIME_TOKEN` at boot (never printed, never baked into the
image). To pin your own, pass them explicitly (see [Configuration](#configuration)).

### Run the 30-second safety demo (no host wiring)

The cockpit opens *empty* — no agent is wired yet. To see what ActraDeck actually does
before wiring anything, run the built-in demo straight from the empty board:

1. Open <http://localhost:55400>.
2. On the empty board, click **Run the 30-second safety demo**.
3. Watch a throwaway session drive **block → redact → audit** with real events:
   - a high-risk `rm -rf …/build` raises an **approval card** and is held (not run);
   - with no response it degrades safe-side to **deny** (never auto-allow) — or you can
     Deny it yourself from the Approval Inbox;
   - a command carrying dummy credentials is **redacted before it is stored** (the raw
     secret never reaches Postgres — only per-kind redaction counts do);
   - the whole run is replayable from the audit trail.

This needs **zero host wiring** — the demo session is driven entirely inside the cockpit
stack against the real ingestion → event-store → projection pipeline.

**Honest scope of the demo** (it is a throwaway teaching aid, not your agents):

- Observing *your own* agents still requires a host-side sidecar (see
  [Observing a host agent](#observing-a-host-agent-wire-the-sidecar)). The demo does not
  observe anything on your machine.
- "Block" here proves the **event flow + approval card + audit trail**, not the halting of
  a real command — the demo never executes the `rm -rf`.
- The hold/timeout is owned by the **demo driver** for this throwaway session; a real
  session's hold is owned by the sidecar's `ApprovalBridge`.
- The risk level is a **fixed constant** in the demo; real sessions classify risk from the
  actual command (`classifyCommandRisk`).
- The **redaction is real** — it is the same backend ingress redaction floor that protects
  every stored event, not a demo-only shim.
- This is unrelated to Codex Attach approvals (Codex rollout tail is observe-only).

### Build it yourself

The image is built from the repository root `Dockerfile` (the same one the release
workflow signs):

```bash
docker build -t actradeck .
docker run --rm -p 127.0.0.1:55400:55400 actradeck
```

The runtime image is assembled with an explicit **allowlist** `COPY` (only the cockpit
runtime closure — never the whole tree), and `.dockerignore` keeps the test suites and
any credential material (`.env*`, `.npmrc`, `*.pem`/`*.key`, `credentials.json`, …) out
of the build context; the release workflow additionally re-scans the built image
filesystem for leaks before it is ever pushed.

## Observing a host agent (wire the sidecar)

To make the cockpit show real sessions, run the sidecar **on the host** and point it at
the container's ingestion port. Publish the backend port too, and share the token:

```bash
# 1. Generate one shared ingestion token on the host.
export INGEST_TOKEN="$(openssl rand -hex 32)"

# 2. Run the cockpit, injecting that token and publishing BOTH ports to loopback.
docker run --rm \
  -e INGEST_TOKEN \
  -p 127.0.0.1:55400:55400 \
  -p 127.0.0.1:55410:55410 \
  -v actradeck_pgdata:/data \
  ghcr.io/actradeck/actradeck:latest

# 3. On the host, from a clone, attach Claude Code to the published ingestion endpoint.
INGEST_TOKEN="$INGEST_TOKEN" \
ACTRADECK_BACKEND_PORT=55410 \
  node apps/sidecar/dist/cli.js attach --scope user --yes
#   (or: ./scripts/ad-attach — it reads INGEST_TOKEN from .env)
```

Now `cd ~/any/project && claude` and the session appears in the cockpit.

> **Publish the ingestion port to `127.0.0.1` only.** `INGEST_TOKEN` holders are inside
> the trust boundary (they can write events); binding `:55410` to `0.0.0.0` would expose
> that ingress to your LAN. The trust model is single-operator / loopback / local-fs — the
> same as the native install ([`docs/adr/0012`](./adr/0012-threat-model-and-local-fs.md)).

Managed Mode (`agentmon codex -- "<prompt>"`) and Codex approval relay are host-side
concerns unchanged by Docker — see [`docs/attach-mode.md`](./attach-mode.md).

## Configuration

Everything is overridable with `-e` (nothing is required — sensible container defaults
are applied by `scripts/docker-entrypoint.sh`).

| Env var | Container default | Meaning |
| --- | --- | --- |
| `INGEST_TOKEN` | generated at boot | sidecar → backend ingestion auth. **Set it** to wire a host sidecar. |
| `REALTIME_TOKEN` | generated at boot | backend → UI realtime auth. Set it if you proxy the UI. |
| `ACTRADECK_WEBUI_PORT` | `55400` | Cockpit UI port inside the container. |
| `ACTRADECK_BACKEND_PORT` | `55410` | Backend ingestion/realtime port inside the container. |
| `ACTRADECK_PGDATA` | `/data/pgdata` | Embedded DB data dir (mount `/data` to persist). |
| `DATABASE_URL` | _(unset)_ | Set to use an **external** Postgres instead of the embedded DB. |

Secrets are only ever taken from the environment or generated in-process; the image ships
tokenless and the entrypoint never logs a token value.

### Using an external Postgres

Set `DATABASE_URL` and the backend skips the embedded database entirely. Pass your own
Postgres connection string (see `.env.example` for the exact DSN format); from a container,
reach a host Postgres via `host.docker.internal`:

```bash
export DATABASE_URL="…your Postgres DSN…"   # e.g. see .env.example
docker run --rm \
  -e DATABASE_URL \
  -p 127.0.0.1:55400:55400 \
  ghcr.io/actradeck/actradeck:latest
```

The repository's `docker-compose.yml` still stands up a standalone Postgres for the
native (non-container) external-DB path; it is independent of this image.

## Verifying the image signature

Published images are signed **keyless** (OIDC → Sigstore) and carry a SLSA build
provenance attestation of the image digest — a *different* trust root from the product's
own audit-export signature, and never reused (ADR 0013 §D3). Verify before you run:

```bash
# 1. cosign keyless signature (checks the Rekor transparency log):
cosign verify ghcr.io/actradeck/actradeck:latest \
  --certificate-identity-regexp '^https://github.com/actradeck/actradeck/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

# 2. GitHub-native SLSA build provenance of the image digest:
gh attestation verify oci://ghcr.io/actradeck/actradeck:latest \
  --repo actradeck/actradeck
```

Replace `actradeck/actradeck` with the actual published `owner/name` — nothing is
hardcoded in the workflow (the registry path derives from `${{ github.repository }}`).

## Publishing the signed image (maintainers)

The GHCR publish is **USER-GATED** — a normal tag push does **not** push an image. The
`docker` job in [`.github/workflows/release.yml`](../.github/workflows/release.yml) runs
only when the operator opts in, one of two ways:

- set the repository variable **`ENABLE_GHCR_PUBLISH=true`** (then the image job rides
  along with each `vX.Y.Z` tag push), or
- **manually dispatch** the `Release` workflow against an existing `vX.Y.Z` tag (the
  verify/release jobs are guarded to `push` events, so a dispatch only runs the image job).

The job builds from the root `Dockerfile`, **scans the built image's filesystem for leaks
before it is pushed**, then pushes `:<version>` + `:latest`, signs the digest with cosign
keyless, and attests SLSA build provenance to the registry. It needs `packages: write` +
`id-token: write` + `attestations: write` (job-scoped only; the workflow stays
`contents: read` at the top level).

### How the image is kept leak-free (authoritative vs. secondary gates)

The **authoritative** leak gate is the real **image-filesystem scan**
([`scripts/lib/scan-image-fs.sh`](../scripts/lib/scan-image-fs.sh)): it exports the built
image and fails closed on any forbidden internal file or secret/coupling literal in the
app layers. It runs in **two** places — in `release.yml` **before every GHCR push**, and in
`ci.yml`'s `docker-image-scan` job on **any change to image content** (`apps/**`,
`packages/**`, `db/**`, root `package.json`, the Dockerfile). Because it inspects the actual
built image, it catches a real leak regardless of how the workflow YAML is shaped.

The invariant checks in [`scripts/test-release-prep.sh`](../scripts/test-release-prep.sh)
(`INV-DOCKER-SCAN-BEFORE-PUSH`, `INV-DOCKERFILE-RUNTIME-ALLOWLIST`) are **secondary**: they only
assert that the workflows *wire the real scan in correctly* (present, before the push, not
disabled or no-op) and that the Dockerfile does not broad-copy the whole tree. A gap in one of
those config-checkers cannot ship a leak on its own — any change to baked-in content re-fires the
authoritative scan in CI.

### How publishing is gated (the parallel structure for the publish face)

Publishing to GHCR is defended in **three layers**, ordered from static to authoritative — the
same *authoritative-vs-secondary* shape as the leak face above:

1. **closed-enum whitelist** (`INV-IF-GATE-PARSER`) — the job `if:` may reference only the gate's
   own inputs (`github.ref`, `github.event_name`, `vars.ENABLE_GHCR_PUBLISH`), so a bypass that
   pulls in an unrelated context is *unexpressible*.
2. **canonical AST pin** (`INV-GHCR-PUBLISH-GATED`) — the job `if:` must match a canonical
   expression exactly, so any *enum-inside* weakening (which a sampled truth-table would miss)
   breaks the pin and forces a review-visible change.
3. **runtime publish guard** (`INV-PUBLISH-RUNTIME-GUARD`) — the **authoritative** layer: a step
   that runs *before the push* and **exits non-zero** unless the ref is a tag AND
   (`workflow_dispatch` OR `vars.ENABLE_GHCR_PUBLISH == 'true'`) truly holds at run time. Even if
   the `if:` were weakened, this blocks the push. Like the leak scan, it is real behavior, not a
   YAML shape check; the two config-checkers above are secondary wiring checks around it.

## Honest limits

- The signed GHCR image and its cosign signature **fire for the first time on the first
  opted-in tag/dispatch** — until then this is structurally verified infrastructure, not
  a published artifact (same posture as the Phase 1 release signing).
- The image carries `tsx` and the TypeScript sources because the product runs its
  entrypoints through `tsx` in production (as the native `scripts/actradeck` supervisor
  does); it is not a slimmed, precompiled single binary. Size optimization is a follow-up.
- The container is the cockpit stack. It does not — and by design cannot — observe agents
  by itself. Agent observation is a host-side concern (see the matrix above).
- The **30-second safety demo** is a self-contained teaching aid (block/redact/audit on a
  throwaway session), not a substitute for wiring a sidecar to observe your own agents. Its
  redaction is the real ingress floor; its "block" proves the event/approval/audit flow,
  not the halting of a real command. See the demo scope note under Quick start.
