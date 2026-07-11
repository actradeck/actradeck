# actradeck

> Bootstrap CLI for **ActraDeck** — a local-first control plane for coding agents (Claude
> Code, Codex, …): observe them, redact secrets before they're stored, gate high-risk actions
> behind approvals, and keep a tamper-evident audit trail.

This package is a **thin, dependency-free bootstrapper**. It does not contain the product —
the full four-tier stack ships as a **signed GitHub Release** and a **signed GHCR image**.
The CLI helps you _get to_ a running cockpit and verify what you download.

- **Zero runtime dependencies** (Node 20+ built-ins only).
- **No install hooks.** `npm install`/`npx` never changes your machine. Only the explicit
  `actradeck install` fetches anything, and only after verifying it.
- **Fail-closed verification.** `install` checks the release's sha256 checksum _and_ its
  SLSA build provenance before extracting a single file.

## Usage

```sh
npx actradeck@latest doctor        # diagnose: platform / Node / pnpm / git / Docker (offline-safe)
npx actradeck@latest install       # verify + fetch the latest signed release, then quickstart
npx actradeck@latest up            # print the Docker cockpit command (prints only; runs nothing)
npx actradeck@latest version       # your CLI version + whether a newer stable release exists
```

> **Not published yet.** The first npm publish is planned for **v0.5** (see the project's ADR
> 0013). Until then the commands above describe the intended flow; the canonical, already-signed
> way to get ActraDeck is the GitHub Release / GHCR image or `scripts/install.sh` from the repo.

### `install`

Resolves the latest stable GitHub Release (or `--version vX.Y.Z`), downloads the source
tarball + `checksums.txt`, verifies the **sha256 digest** (Node `crypto`) **and** the build
provenance (`gh attestation verify`), then extracts and hands off to the repo's own
`scripts/quickstart`.

```sh
npx actradeck@latest install --version v0.4.0     # a specific tag
npx actradeck@latest install --dry-run            # resolve + verify only; change nothing
npx actradeck@latest install --skip-provenance    # explicit opt-out (checksum still enforced)
```

Verification is **fail-closed** and never silently skipped: the checksum is always enforced,
and provenance is verified unless you pass `--skip-provenance` (which requires you to accept
the reduced guarantee). `--skip-provenance` exists only for machines that cannot install the
GitHub CLI.

## Environment

| Variable                | Default              | Meaning                                             |
| ----------------------- | -------------------- | --------------------------------------------------- |
| `ACTRADECK_REPO`        | `actradeck/actradeck`| `owner/name` (or git URL) to resolve releases from  |
| `ACTRADECK_INSTALL_DIR` | `~/actradeck`        | where `install` extracts the verified source        |

## License

[Apache-2.0](./LICENSE).
