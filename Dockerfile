# ActraDeck — one-command cockpit image (ADR 0013 Phase 2 / decision 019f2bc1).
#
# WHAT THIS IMAGE IS (honest scope — see docs/docker.md):
#   This image runs the **cockpit stack only**: the backend (ingestion + realtime,
#   :55410) + the webui/BFF (Cockpit UI, :55400) + an **embedded PostgreSQL (PGlite)**.
#   No external database is required — the embedded DB migrates itself on boot and
#   persists under the /data volume.
#
# WHAT THIS IMAGE IS NOT:
#   It does NOT contain the sidecar (attach / codex-attach). The sidecar observes the
#   HOST's coding-agent CLIs (Claude Code hooks / Codex rollout files / process
#   liveness) — those live in the host's process + file space, so a sidecar inside a
#   container would observe nothing. Agent observation therefore runs on the HOST and
#   connects to this container's ingestion port over loopback (docs/docker.md).
#
# Because the cockpit tiers (backend + webui) never import better-sqlite3 / node-pty
# (those are sidecar-only native addons), this image needs no native build toolchain
# and installs with --ignore-scripts.

# ---------------------------------------------------------------------------
# Stage 1 — builder: install the workspace and build shared dist + webui .next
# ---------------------------------------------------------------------------
FROM node:22.16.0-bookworm-slim AS builder

ENV CI=true \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

# pnpm is pinned by package.json's packageManager; corepack activates that exact version.
RUN corepack enable

WORKDIR /app

# Copy the whole (context-filtered by .dockerignore) tree, then install. node_modules,
# .git, .env, .claude, oss mirrors etc. are excluded by .dockerignore so no secret or
# host build artifact enters the image.
COPY . .

# Install the full workspace WITHOUT running native postinstall builds. The cockpit
# tiers do not use the sidecar's native addons, so we skip the toolchain entirely.
RUN pnpm install --frozen-lockfile --ignore-scripts

# Build shared package dist (topological) + backend tsc + webui `next build` via the root
# `build` script (single source: package.json "build" = `pnpm -r --if-present run build`),
# so the image build can't drift from the repo's canonical build command (TDA-4). Sidecar
# is built too but is not copied into the runtime stage below.
RUN pnpm run build

# ---------------------------------------------------------------------------
# Stage 2 — runtime: non-root, minimal, embedded-DB cockpit
# ---------------------------------------------------------------------------
FROM node:22.16.0-bookworm-slim AS runtime

# NODE_ENV=production: webui serves the prebuilt .next; backend picks the embedded DB
# path when DATABASE_URL is unset (default here). Secrets are NEVER baked in — the
# entrypoint injects/generates them at boot (see scripts/docker-entrypoint.sh).
ENV NODE_ENV=production \
    ACTRADECK_BACKEND_PORT=55410 \
    ACTRADECK_WEBUI_PORT=55400 \
    ACTRADECK_PGDATA=/data/pgdata

# corepack for the pinned pnpm (not strictly needed at runtime, but keeps `node` tooling
# consistent and lets `pnpm` work for debugging).
RUN corepack enable

# Dedicated non-root user. /data (embedded DB volume) and /home are writable by it.
RUN groupadd --system --gid 10001 actradeck \
    && useradd --system --uid 10001 --gid 10001 --create-home --home-dir /home/actradeck actradeck \
    && mkdir -p /data/pgdata \
    && chown -R actradeck:actradeck /data

WORKDIR /app

# ---------------------------------------------------------------------------
# DIRECTORY-LEVEL ALLOWLIST COPY (TDA-1) — carry ONLY the runtime closure, never the whole
# /app tree. The cockpit runs its TypeScript through tsx in production (as scripts/actradeck
# does), so the runtime needs: the backend/webui SOURCE (run by `tsx`), the workspace
# packages' built dist (resolved via each package's `main`/`exports`), the db migrations, and
# node_modules (tsx lives here now that it is a runtime dependency). It does NOT need the
# sidecar (host-only — see the header), the docs, CI config, dev scripts, or the root markdown.
#
# HONEST SCOPE of the protection (do NOT overclaim "leak-safe by construction"):
#   - This COPY is a DIRECTORY-level allowlist: it structurally drops whole trees (sidecar
#     source, docs, .github, dev scripts, root md) that never enter the image.
#   - BUT it copies apps/backend, apps/webui and packages as WHOLE directories. The private-
#     coupling literals in this repo live only in TEST files, and those are excluded by the
#     .dockerignore denylist (`**/test`, `**/*.test.*`) — a best-effort single layer, not a
#     construction guarantee. If a denylist entry were dropped, a test file inside a copied
#     dir would ride in.
#   - The ENFORCING backstop is the release workflow's image-filesystem leak scan (SEC-2),
#     which fails the publish on any coupling/secret literal before the image is pushed.
# So: directory-allowlist (structural) + .dockerignore test denylist (best-effort) + image
# scan (enforcing backstop) — three layers, honestly described.
#
# NOTE: keep this an explicit allowlist. Do NOT reintroduce a broad `COPY --from=builder
# /app /app` (or `/app/ /app/`) — that would re-bake the entire tree (test fixtures included)
# and is exactly the regression INV-DOCKERFILE-RUNTIME-ALLOWLIST pins in
# scripts/test-release-prep.sh.
COPY --from=builder --chown=actradeck:actradeck \
     /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml \
     /app/tsconfig.base.json /app/tsconfig.json ./
COPY --from=builder --chown=actradeck:actradeck /app/node_modules ./node_modules
COPY --from=builder --chown=actradeck:actradeck /app/packages ./packages
COPY --from=builder --chown=actradeck:actradeck /app/db ./db
COPY --from=builder --chown=actradeck:actradeck /app/apps/backend ./apps/backend
COPY --from=builder --chown=actradeck:actradeck /app/apps/webui ./apps/webui
COPY --from=builder --chown=actradeck:actradeck /app/scripts/docker-entrypoint.sh ./scripts/docker-entrypoint.sh

ENV HOME=/home/actradeck
USER actradeck

# Embedded PostgreSQL data dir (survives restarts if the operator mounts a volume here).
VOLUME ["/data"]

# Cockpit UI (55400) and backend ingestion/realtime (55410). By default only publish
# 55400; publish 55410 only when wiring a host sidecar (docs/docker.md).
EXPOSE 55400 55410

# Container healthcheck hits the webui BFF root (which itself depends on the backend).
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.ACTRADECK_WEBUI_PORT||55400)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
