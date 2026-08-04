# Running ActraDeck in Docker

> ADR [`0013`](./adr/0013-release-signing-and-distribution.md) Phase 2. Status:
> **published** — a signed image is available on GHCR since **v0.4.0**
> (`ghcr.io/actradeck/actradeck`, versioned tags plus `latest`). Publishing stays
> user-gated per release — see
> [Publishing](#publishing-the-signed-image-maintainers).
>
> **Architecture:** since **v0.5.0** the published image is a **multi-arch manifest
> list** covering **`linux/amd64`** and **`linux/arm64`**, so arm64 (Apple Silicon)
> hosts pull a native image. The older `0.4.0` tag remains `linux/amd64` only (earlier
> images are not rebuilt retroactively) — see [Honest limits](#honest-limits).

The Docker image runs the **cockpit** with no external database. Pull the signed
prebuilt image from GHCR (or build it locally from the same Dockerfile) and run it —
see [Quick start](#quick-start-cockpit-only). It is the fastest way to _look at_ ActraDeck;
it is **not** the whole product.
Read [What runs where](#what-runs-where-the-honest-support-matrix) before you rely on it.

## What runs where (the honest support matrix)

ActraDeck is four tiers plus a database. They do **not** all belong in a container.

| Tier                                           | Where it runs                  | Why                                                          |
| ---------------------------------------------- | ------------------------------ | ------------------------------------------------------------ |
| **backend** (ingestion + realtime, `:55410`)   | **container**                  | pure network service                                         |
| **webui / BFF** (Cockpit UI, `:55400`)         | **container**                  | pure network service                                         |
| **embedded PostgreSQL** (PGlite)               | **container** (`/data` volume) | in-process; no external DB needed                            |
| **sidecar** — Claude Code attach (`ad-attach`) | **host**                       | observes the host's Claude Code **hooks** + process liveness |
| **sidecar** — Codex attach (`codex attach`)    | **host**                       | tails the host's Codex **rollout files** (`CODEX_HOME`)      |

The sidecar's entire job is to watch coding-agent CLIs **on your machine** — their hook
callbacks, their rollout JSONL, whether the process is alive. Those live in the host's
process and file space. A sidecar inside a container would see an empty container, not
your `claude` / `codex` runs — so shipping it in the image would be theatre, not
observation. The container therefore runs the **cockpit stack**, and the sidecar runs on
the host and connects back over loopback. This mirrors how `scripts/actradeck` already
splits the cockpit server tier from the observation-daemon tier.

**Consequence:** `docker run` alone gives you a cockpit that is _up_ but _empty_ until a
host-side agent is wired to it. That is expected and honest — the same way the native
quickstart's cockpit stays empty until you run an agent.

## Quick start (cockpit only)

> Prefer building from source? The published image is built from the repository root
> `Dockerfile` — the exact same one the release workflow signs — so this is equivalent:
>
> ```bash
> docker build -t actradeck .
> docker run --rm -p 127.0.0.1:55400:55400 -v actradeck_pgdata:/data actradeck
> ```
>
> The rest of this page uses `ghcr.io/actradeck/actradeck:latest` as the image
> reference; substitute your locally built `actradeck` tag if you build from source.

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

Once the image is pulled (or built), running it needs no external Postgres and no secrets to set —
the entrypoint generates an ephemeral `INGEST_TOKEN` / `REALTIME_TOKEN` at boot (never
printed, never baked into the image). To pin your own, pass them explicitly (see [Configuration](#configuration)).

### Run the 30-second safety demo (no host wiring)

The cockpit opens _empty_ — no agent is wired yet. To see what ActraDeck actually does
before wiring anything, run the built-in demo straight from the empty board:

1. Open <http://localhost:55400>.
2. On the empty board, click **Run the 30-second safety demo**.
3. Watch a throwaway session drive **block → redact → audit** with real events:
   - a high-risk `rm -rf …/build` raises an **approval card** and is held (not run);
   - with no response it degrades safe-side to **deny** (never auto-allow) — or you can
     Deny it yourself from the Approval Inbox;
   - a command carrying dummy credentials is **redacted before it is stored** (the
     detected secret is replaced with a `[REDACTED:<kind>]` marker before the event
     reaches Postgres; per-kind counts are derived from the markers);
   - the whole run is replayable from the audit trail.

This needs **zero host wiring** — the demo session is driven entirely inside the cockpit
stack against the real ingestion → event-store → projection pipeline.

**Honest scope of the demo** (it is a throwaway teaching aid, not your agents):

- Observing _your own_ agents still requires a host-side sidecar (see
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
- The demo driver is TypeScript executed through `tsx` from the backend **source** tree
  (`apps/backend/src/safety-demo-driver.ts`). The shipped image copies that source, so the
  demo works out of the box. A custom **dist-only** deployment (one that strips `src/`)
  disables the demo: the CTA fails loud with `503` (never a silent no-op), while the rest
  of the cockpit keeps working.

**Next step — wire your own agents.** After the demo finishes, the cockpit still observes
nothing on your machine (the board shows the same staged guidance above the finished demo
session). To see your real `claude` / `codex` runs, connect a host-side sidecar:
[Observing a host agent](#observing-a-host-agent-wire-the-sidecar).

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

Managed Mode (`./scripts/actradeck codex "<task>"`, a wrapper over
`agentmon codex -- "<prompt>"`) and Codex approval relay are host-side concerns
unchanged by Docker — see [`docs/attach-mode.md`](./attach-mode.md).

## Configuration

Everything is overridable with `-e` (nothing is required — sensible container defaults
are applied by `scripts/docker-entrypoint.sh`).

| Env var                  | Container default | Meaning                                                              |
| ------------------------ | ----------------- | -------------------------------------------------------------------- |
| `INGEST_TOKEN`           | generated at boot | sidecar → backend ingestion auth. **Set it** to wire a host sidecar. |
| `REALTIME_TOKEN`         | generated at boot | backend → UI realtime auth. Set it if you proxy the UI.              |
| `ACTRADECK_WEBUI_PORT`   | `55400`           | Cockpit UI port inside the container.                                |
| `ACTRADECK_BACKEND_PORT` | `55410`           | Backend ingestion/realtime port inside the container.                |
| `ACTRADECK_PGDATA`       | `/data/pgdata`    | Embedded DB data dir (mount `/data` to persist).                     |
| `DATABASE_URL`           | _(unset)_         | Set to use an **external** Postgres instead of the embedded DB.      |

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
provenance attestation of the image digest — a _different_ trust root from the product's
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

The GHCR publish is **USER-GATED** — a tag push does **not** push an image unless the
operator has opted in (the public repo has this opt-in enabled since v0.4.0). The
`docker` job in [`.github/workflows/release.yml`](../.github/workflows/release.yml) runs
only when the operator opts in, one of two ways:

- set the repository variable **`ENABLE_GHCR_PUBLISH=true`** (then the image job rides
  along with each `vX.Y.Z` tag push), or
- **manually dispatch** the `Release` workflow against an existing `vX.Y.Z` tag (the
  verify/release jobs are guarded to `push` events, so a dispatch only runs the image job).

The job builds from the root `Dockerfile` for **both `linux/amd64` and `linux/arm64`**. The
`amd64` half builds natively on the runner; the **`arm64` half is built under QEMU user-mode
emulation** (`docker/setup-qemu-action`, which registers the `tonistiigi/binfmt` image) — so the
emulator sits inside the build trust path for the arm64 image (accepted, single-operator/CI trust
boundary; the authoritative FS scan still inspects the emulated arm64 image before it can be
pushed). Residual: the binfmt installer image (`tonistiigi/binfmt`) is pulled by tag, not
digest-pinned — pinning it is a tracked follow-up. It builds **each architecture locally first**
(`--load`, no push), **scans every per-arch image's filesystem for leaks before anything is
pushed**, and only then re-assembles the two architectures into a single **multi-arch manifest
list** and pushes `:<version>` + `:latest`. The multi-arch push re-uses the per-arch **build
cache** the local `--load` builds wrote (`--cache-from` per arch), so the pushed layers are the
scanned ones re-played from cache rather than a fresh rebuild — on a cache miss buildx would
rebuild, but the leak-relevant `/app` tree is a deterministic allowlist `COPY` (leak-equivalent),
and strict byte-identity is not relied upon; instead `INV-DOCKER-SCAN-BEFORE-PUSH` checks, by
flag **token position** (not a raw substring), that the push carries a `--cache-from` for each
scanned arch — a commented-out or echo-string `--cache-from` does not satisfy it. It then signs
the **manifest-list (index) digest** with
cosign keyless and attests SLSA build provenance of that index digest to the registry. It needs
`packages: write` + `id-token: write` + `attestations: write` (job-scoped only; the workflow
stays `contents: read` at the top level).

### How the image is kept leak-free (authoritative vs. secondary gates)

The **authoritative** leak gate is the real **image-filesystem scan**
([`scripts/lib/scan-image-fs.sh`](../scripts/lib/scan-image-fs.sh)): it exports the built
image and fails closed on any forbidden internal file or secret/coupling literal in the
app layers. It runs in **two** places, with different arch coverage:

- **`release.yml`, before every GHCR push** — runs **once per published architecture** (each
  `--load`ed per-arch image, `amd64` and `arm64`, is scanned before the manifest list is pushed).
  This is the arch-complete gate: `arm64` content is authoritatively scanned here.
- **`ci.yml`'s `docker-image-scan` job**, on **any change to image content** (`apps/**`,
  `packages/**`, `db/**`, root `package.json`, the Dockerfile) — builds and scans the **native
  `amd64`** image only (no emulation in the fast pre-merge path). Because the leak-relevant `/app`
  tree is produced by the same architecture-independent allowlist `COPY`, the `amd64` pre-merge
  scan catches source-level leaks on every content change; the `arm64`-specific authoritative scan
  is the release-time per-arch scan above.

Because it inspects the actual built image, it catches a real leak regardless of how the
workflow YAML is shaped.

The invariant checks in [`scripts/test-release-prep.sh`](../scripts/test-release-prep.sh)
(`INV-DOCKER-SCAN-BEFORE-PUSH`, `INV-DOCKERFILE-RUNTIME-ALLOWLIST`) are **secondary**: they only
assert that the workflows _wire the real scan in correctly_ (present, before the push, not
disabled or no-op — and, for the multi-arch image, that **every published architecture is
scanned first**, so a new `--platform` entry can't ship unscanned) and that the Dockerfile
does not broad-copy the whole tree. A gap in one of those config-checkers cannot ship a leak
on its own — any change to baked-in content re-fires the authoritative scan in CI.

### How publishing is gated (the parallel structure for the publish face)

Publishing to GHCR is defended in **three layers**, ordered from static to authoritative — the
same _authoritative-vs-secondary_ shape as the leak face above:

1. **closed-enum whitelist** (`INV-IF-GATE-PARSER`) — the job `if:` may reference only the gate's
   own inputs (`github.ref`, `github.event_name`, `vars.ENABLE_GHCR_PUBLISH`), so a bypass that
   pulls in an unrelated context is _unexpressible_.
2. **canonical AST pin** (`INV-GHCR-PUBLISH-GATED`) — the job `if:` must match a canonical
   expression exactly, so any _enum-inside_ weakening (which a sampled truth-table would miss)
   breaks the pin and forces a review-visible change.
3. **runtime publish guard** (`INV-PUBLISH-RUNTIME-GUARD`) — the **authoritative** layer: a step
   that runs _before the push_ and **exits non-zero** unless the ref is a tag AND
   (`workflow_dispatch` OR `vars.ENABLE_GHCR_PUBLISH == 'true'`) truly holds at run time. Even if
   the `if:` were weakened, this blocks the push. Like the leak scan, it is real behavior, not a
   YAML shape check; the two config-checkers above are secondary wiring checks around it.

## Honest limits

- The signed GHCR image and its cosign signature have been **live since v0.4.0**. Each
  opted-in release publishes a freshly leak-scanned, signed image; publishing stays
  user-gated per release, so a release that does not opt in publishes no image.
- **Multi-arch shipped in v0.5.0 and is not retroactive.** Tags `0.5.0` and later
  (including `latest`) are `linux/amd64` + `linux/arm64` **manifest lists** — the release
  workflow builds and scans each arch, then pushes one index. `docker pull` on either
  architecture resolves the right image automatically, and the cosign signature + SLSA
  provenance are on the **manifest-list (index) digest**, so `cosign verify` /
  `gh attestation verify` against the tag or the index digest work identically regardless
  of which arch you pull. The older **`0.4.0` tag stays `linux/amd64` only** — arm64
  (Apple Silicon) hosts run it under emulation.
- The image carries `tsx` and the TypeScript sources because the product runs its
  entrypoints through `tsx` in production (as the native `scripts/actradeck` supervisor
  does); it is not a slimmed, precompiled single binary. Size optimization is a follow-up.
- The container is the cockpit stack. It does not — and by design cannot — observe agents
  by itself. Agent observation is a host-side concern (see the matrix above).
- The **30-second safety demo** is a self-contained teaching aid (block/redact/audit on a
  throwaway session), not a substitute for wiring a sidecar to observe your own agents. Its
  redaction is the real ingress floor; its "block" proves the event/approval/audit flow,
  not the halting of a real command. See the demo scope note under Quick start.
