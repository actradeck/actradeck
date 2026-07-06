# ADR 0013: Release signing & distribution — signed GitHub Releases, SBOM, provenance

- Status: Accepted (Phase 1: infrastructure + dry-run verification; not yet published)
- Source: decision `019f2bc1`

## Context

ActraDeck already lets a recipient _verify what we ship_ at the data layer: session
audit reports export with a SHA-256 hash chain and an optional Ed25519 signature
(ADR 0007 lineage; tamper-evident export). But the **release artifacts themselves**
— the thing a user downloads and runs — were unsigned and unverifiable. That posture
is asymmetric: "we sign the data but not the software." This ADR closes that gap for
the distribution layer.

Constraints that shape the design:

- **The product is one unit, not one binary.** It runs as four tiers plus an embedded
  Postgres; `npm i actradeck` cannot bring that up, so a "single binary on npm" story
  would over-promise. The honest install story is clone/download → quickstart.
- **Solo, pre-1.0.** Heavy release machinery (changesets, release-please, multi-channel
  publishing) is disproportionate. Prefer the smallest mechanism that is verifiable.
- **A sanitized public mirror already exists** (`scripts/prepare-oss.sh` strips internal
  content and runs a leak gate). Releases should inherit that gate, not re-derive it.
- **2026 supply-chain baseline.** Keyless signing (OIDC → Sigstore) and
  `actions/attest-build-provenance` (SLSA build provenance) remove long-lived signing
  tokens — the class of secret behind recent registry-poisoning incidents.

## Decision

### D1 — Channel & phases

- **Phase 1 (this ADR):** the canonical distributable is a **signed GitHub Release on
  an annotated tag `vX.Y.Z`**. Assets: (1) a source tarball (`git archive` of the tag),
  (2) a CycloneDX SBOM, (3) `checksums.txt`, each attested with SLSA build provenance.
- **Phase 2 (implemented — decisions `019f305f` / `019f3271`):** one-command Docker image
  on GHCR (cockpit stack: backend + webui + embedded PGlite), signed with cosign keyless +
  a SLSA build-provenance attestation of the image digest. Trigger met (demand for
  one-command bring-up). The image job is **USER-GATED** (off by default) and builds →
  leak-scans the image filesystem → pushes; the live GHCR push + signature fire on the
  first opted-in tag/dispatch. See [`docs/docker.md`](../docker.md).
- **Phase 3 (deferred):** npm publish of the attach CLI via Trusted Publishing (OIDC),
  contingent on resolving the dependency-closure / native-addon story. Homebrew:
  deferred indefinitely.

### D2 — Versioning

**Lockstep single version:** the root package and every workspace share one version,
stamped by `scripts/version.sh <X.Y.Z>`, which also rolls the `CHANGELOG.md`
`[Unreleased]` section and creates a **local** annotated tag (never pushed by the
script). First release: `v0.1.0`.

### D3 — Signing technique, and separation from the product's own signature

| Layer | Key / identity | Signs | Verified with |
| --- | --- | --- | --- |
| **Release** (this ADR) | Ephemeral OIDC certificate (Sigstore, per-run) | CI build artifacts (tarball, SBOM) | `gh attestation verify` (transparency log) |
| **Audit export** (ADR 0007 lineage) | Long-lived **operator** Ed25519 key, fingerprint-pinned | Runtime session data at export time | recipient re-computes the manifest root + checks the pinned key |

These are **different threat models on purpose.** The long-lived operator audit key is
**never** reused to sign releases (a long-lived key in CI has a large blast radius and
no per-build identity binding). The _posture_ is consistent ("we sign what we ship");
the _mechanisms_ are deliberately distinct.

### D4 — Releases are cut from the sanitized mirror

`release.yml` ships **in the public mirror** and fires on a tag push to the mirror.
The tarball is `git archive` of the tag — i.e. the tree already stripped and
leak-scanned by `prepare-oss.sh` — so it is leak-free by construction. The release job
still re-applies a public-safe leak scan to the tarball and SBOM (defense in depth);
any hit aborts the release.

### D5 — SBOM single source

CycloneDX generation lives in one function (`scripts/lib/sbom.sh`, `sbom_generate`)
called by **both** `prepare-oss.sh` and `release.yml`, so the two never drift. It
covers the **production dependency closure only** (dev tooling excluded) and copies
only `{name, version, license}` — never absolute paths — from the package manager
output. `sbom.sh` is the one lib in `scripts/lib/` that ships to the mirror (it is
public-safe); the private coupling-scan lib does not ship.

### D5b — Supply-chain pinning (C1/C3)

Everything the CI/release pipeline pulls from outside is pinned to an immutable
reference, so an upstream tag hijack cannot silently change what runs:

- **GitHub Actions → full commit SHA (C1).** Every remote `uses:` across
  `.github/workflows/*.yml` is pinned to a 40-hex commit SHA (with a trailing `# vN`
  comment for readability), not a mutable `@vN` tag.
- **Container base + service images → manifest digest (C3).** The Dockerfile `FROM`
  lines, external `COPY --from=<image>` / `RUN --mount=…,from=<image>` refs, the workflow
  service-container `image:` (ci.yml Postgres), `docker-compose.yml`'s `image:`, and any
  composite action `runs.image` all carry a `@sha256:` digest (tag kept alongside for
  legibility).
- **Freshness without staleness.** A raw pin never updates itself, so
  `.github/dependabot.yml` watches the `github-actions` and `docker` ecosystems and
  opens a weekly grouped PR that bumps the pinned SHA/digest **and** its `# vN` comment
  together — review + merge moves the pin forward. Note: Dependabot's `docker` ecosystem
  covers the Dockerfile and `docker-compose.yml`, **not** a workflow's service-container
  `image:`; those are held by `INV-IMAGE-DIGEST-PINNED` plus manual update.
- **Regression-locked.** `scripts/test-release-prep.sh` (wired into CI) pins two
  falsifiable meta-tests. Both **parse the workflow/compose YAML with a real parser
  (PyYAML)** and recursively walk **every** `uses:` / `image:` key, so block-style,
  flow-style (`- {uses: …}` / `db: {image: …}`), flow-sequence (`steps: [{uses: …}]`) and
  line-continuation forms are all checked uniformly — the earlier line-anchored regex only
  saw block-style inline and silently passed the other syntaxes (SEC-PIN-R2-1). Workflow /
  composite targets are discovered by glob (`.github/workflows/*.yml|*.yaml`, plus
  `.github/actions/**/action.yml` composites); **Dockerfiles are discovered recursively and
  case-insensitively across the whole tracked tree via `git ls-files`** (basename matches
  `dockerfile` / `Dockerfile.*` / `Dockerfile-*` / `*.dockerfile`, so `backend/Dockerfile`,
  `dev.Dockerfile`, `Dockerfile-legacy` are all covered), which also structurally excludes
  the untracked `./oss` + `.oss-sync` mirror copies and `node_modules` — no hardcoded file
  list (SEC-PIN-R3-2). `INV-ACTIONS-SHA-PINNED` fails unless every remote `uses:` is a full
  40-hex commit SHA (`./…` local refs exempt; a `docker://image:tag` mutable-tag ref now
  **fails** unless it carries a full `@sha256:<64-hex>` digest — SEC-PIN-R3-4; a non-scalar
  `uses:` value is a violation, not a silent skip — SEC-PIN-R3-3). `INV-IMAGE-DIGEST-PINNED`
  fails unless every `FROM` / external `COPY --from=<image>` / `RUN --mount=…,from=<image>` /
  service `image:` / compose `image:` / composite `runs.image` carries a **full
  `@sha256:<64-hex>` digest** (a truncated digest such as `@sha256:deadbeef` is rejected);
  prior build-stage self-references (`FROM`/`COPY --from=<stage>`, case-insensitive) and a
  numeric `--from=<index>` are exempt, `runs.image: 'Dockerfile'` (local build) is exempt,
  and a dynamic `FROM ${VAR}` build-arg is **rejected** as unverifiable (SEC-PIN-R3-2). The
  Dockerfile parser joins `\`-continuations and skips build flags (`--platform=…`) so a
  legitimately digest-pinned, `--platform`-flagged base is not over-rejected. PyYAML absent
  ⇒ the gate is **fail-closed** (never a silent pass). **Parser-pin caveat:** the earlier
  unpinned `pip install --user pyyaml` fallback in CI has been **removed** (TDA-PIN-R3-1) —
  an unpinned fetch inside a supply-chain pin gate was self-contradictory. `ci.yml` now only
  **verifies** preinstalled PyYAML (`python3 -c "import yaml"`, which ubuntu-latest ships via
  `python3-yaml`); if it is ever absent the CI step **fails loud** rather than silently
  fetching an unpinned wheel. Each invariant asserts GREEN on the real tree and RED on an
  injected un-pinning across all of those syntaxes/surfaces, so **a silently loosened pin
  cannot pass CI regardless of YAML syntax.**

  **Honest coverage boundary.** What the gate *enforces* (task 019f3460 **landed** — the
  previously-open gaps below are now closed): every remote `uses:` across all workflow YAML
  (any style — block / flow / flow-sequence / line-continuation) is a full 40-hex commit
  SHA; every `docker://image` ref (in `uses:` or a composite `runs.image`) carries a full
  `@sha256:<64-hex>` digest (mutable tags rejected — SEC-PIN-R3-4 / TDA-PIN-R3-3); Dockerfiles
  are discovered **recursively + case-insensitively** across the tracked tree so subdir and
  non-standard-name files (`backend/Dockerfile`, `dev.Dockerfile`, `Dockerfile-legacy`) are
  covered (SEC-PIN-R3-2); external `COPY --from=<image>` and `RUN --mount=…,from=<image>` refs
  must be digest-pinned (SEC-PIN-R3-1); a dynamic `FROM ${VAR}` build-arg is **rejected** as
  unverifiable (SEC-PIN-R3-2); and a non-scalar `uses:`/`image:` value is a violation, not a
  silent skip (SEC-PIN-R3-3). A compose `build:` context needs no special handling **when it
  points at a name-pattern-matching Dockerfile** — discovery is a **name-pattern gate** that
  enumerates tracked files whose basename matches `dockerfile` / `Dockerfile.*` /
  `Dockerfile-*` / `*.dockerfile` (case-insensitive), so a conventionally-named in-repo
  Dockerfile that a `build:` stanza references is already covered (TDA-COV-1: the earlier
  "any in-repo Dockerfile it points at is already found" phrasing over-claimed — discovery is
  filename-scoped, not build-context-following). **NOT covered (honest, 0-instance today):**
  an OCI-standard `Containerfile` and a compose `build.dockerfile: <arbitrary-name>` (a
  non-conventional filename) fall **outside** the name-pattern and are therefore **not
  scanned**; if the repo ever adopts Podman (`Containerfile`) or an arbitrary compose-build
  filename, the discovery pattern must be **extended** (and, because that widens the scan
  surface, re-audited under `full`). Enumeration is over **tracked** files (`git ls-files`),
  which is byte-for-byte the tree CI checks out — but that also means a Dockerfile **not yet
  committed is invisible to a LOCAL run** (TDA-COV-3); it becomes covered the moment it is
  committed, i.e. the exact state CI sees (no filesystem walk keeps the gate CI-faithful; the
  only blind spot is the staged-before-commit local window, never CI). What remains
  **outside** the boundary (honest, by design): this is a **CI-side tripwire enforcing
  literal digest pins**, not an adversary-proof control (see Adversary boundary); an
  **expression ref** such as `uses: ${{ matrix.action }}` does not match `@<40-hex>` and so
  fails **closed** (a spurious RED, never a silent pass); and the gate depends on
  **preinstalled PyYAML** (no unpinned install — absence fails loud in CI, TDA-PIN-R3-1).

  **Adversary boundary.** Beyond coverage, this is a CI-side tripwire under the
  single-operator / CI trust boundary — it rejects a non-pinned `uses:` / `image:` / `FROM`
  in any YAML syntax, but it is not an adversary-proof control against someone with
  repo-write who can edit the gate itself.

### D6 — Opt-in verified install

`scripts/install.sh` gains `ACTRADECK_VERIFY=1`: it requires `ACTRADECK_REF` to be a
`v*` tag and the `gh` CLI (no silent fallback), downloads the Release tarball, verifies
build provenance **and** the sha256 digest, and only then extracts and installs.
Missing attestation or a digest mismatch is a non-zero abort **before** anything is
executed. With `ACTRADECK_VERIFY` unset the installer keeps its existing clone
behavior byte-for-byte.

### D7 — Not npm-publishable in Phase 1

Every `package.json` keeps `private: true`, so an accidental `npm publish` is a no-op.
The NO-LEAK invariant is pinned to the **git-archive tarball** (the real shipped
artifact), not to `npm pack`.

## USER-GATED boundary (honest scope)

**Buildable/verifiable now (no publishing):** version stamping + local tag; mirror
generation → tarball; SBOM generation + leak scan; workflow permission/lint checks; the
installer's fail-closed digest path exercised against a locally tampered tarball.

**Requires the maintainer, at publish time:** pushing a real tag, creating the GitHub
Release, the actual attestation firing (needs a public repo + OIDC), and any future
GHCR / npm publish. Until then this is **infrastructure that is structurally verified,
with the live signing path pending first publication** — not "already published."

## Consumer verification

```sh
# Confirm the tarball came from this repo's release workflow, then check its digest:
gh attestation verify actradeck-<version>.tar.gz --repo <owner>/<name>
sha256sum -c checksums.txt

# …or let the installer verify for you (fails closed):
ACTRADECK_VERIFY=1 ACTRADECK_REF=v<version> \
  ACTRADECK_REPO=https://github.com/<owner>/<name> sh scripts/install.sh
```

The owner/name are resolved at run time (`${{ github.repository }}` in the workflow,
`ACTRADECK_REPO` for the installer); no org is hardcoded.

## Consequences

- The keyless trust root is GitHub OIDC + Sigstore; forging a release requires
  compromising that infrastructure simultaneously, not stealing one token.
- The SBOM, provenance, and tarball are new NO-RAW surfaces; they must pass the leak
  gate (INV-SBOM-NO-RAW / INV-RELEASE-TARBALL-NO-LEAK), enforced in CI.
- Invariants pinned by `scripts/test-release-prep.sh` (wired into CI): lockstep version
  single-source, tag ↔ version match, tarball has no internal/secret content, SBOM
  covers prod deps and carries no raw paths, workflow permissions are least-privilege,
  and the installer rejects a tampered tarball.
- Phase 2 (GHCR Docker image + cosign) is implemented and USER-GATED; its live signing
  path fires on first opted-in publish (same posture as Phase 1). Phase 3 (npm) remains
  deferred with tracked follow-ups; nothing here promises it.
