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
- **Phase 2 (deferred):** Docker image on GHCR signed with cosign keyless. Trigger:
  demand for one-command bring-up.
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
- Phase 2/3 remain deferred with tracked follow-ups; nothing here promises them.
