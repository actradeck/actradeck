# actradeck

> Bootstrap CLI for **ActraDeck** — a local-first audit cockpit for coding agents (Claude
> Code, Codex, …): observe them, redact secrets before they're stored, keep a tamper-evident
> audit trail, and relay approvals where supported (Claude Code in Attach, Codex in Managed
> Mode).

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
npx actradeck@latest conformance < events.jsonl   # (next release) check an adapter's stream vs the contract
```

> **`conformance` is not in the published CLI yet.** The four commands above ship in the current
> published `actradeck`; `conformance` was added after the latest release and lands in the next
> tagged one (npm publish is USER-GATED — see ADR 0013). To run the checker today, use the from-clone
> path in the [ingestion contract §8](../../docs/ingestion-contract.md#8-verify-your-adapter-conformance-checker).
> The canonical, already-signed way to get the full product is the GitHub Release / GHCR image or
> `scripts/install.sh`.

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

### `conformance`

Validate that a third-party ingestion adapter's event stream satisfies the ActraDeck ingestion
contract — **without cloning the monorepo**. (Ships in the next release; the currently published
CLI predates it — run the checker from a clone today, see the
[ingestion contract §8](../../docs/ingestion-contract.md#8-verify-your-adapter-conformance-checker).)
Capture your adapter's emitted NormalizedEvents as **JSONL** (one JSON object per line, in emission
order) and pipe them in:

```sh
npx actradeck@latest conformance < events.jsonl      # read JSONL from stdin
npx actradeck@latest conformance events.jsonl        # or from a file
npx actradeck@latest conformance events.jsonl --json # machine-readable JSON report
```

It checks the stream-level and cross-field invariants a single-event schema parse cannot see:
every event parses as a NormalizedEvent; `payload.kind === event_type`; per-session `timestamp` is
non-decreasing; and per-session `seq`, when present, is a dense 0-based counter (so the backend can
detect silent mid-stream drops — a session that emits no `seq` is a **warning**, not an error). A
repeated `event_id` or `seq` is a **warning**, not an error — an at-least-once retry is legitimate
and the backend dedupes it (§3.3 / §4.4). Redaction is **not** checked: the backend ingress
redaction floor is the sole redaction point, so an adapter cannot and need not prove it.

**Exit codes:** `0` = conformant (warnings allowed) · `1` = one or more errors · `2` = usage /
input error. The checker core is ActraDeck's canonical `checkConformance`, bundled into this CLI at
build time — the published package still has **zero runtime dependencies**. It is the same check as
the in-repo `scripts/check-conformance.mjs` (see `docs/ingestion-contract.md` §8); for piped output
it is byte-identical (an interactive TTY differs only in ANSI color). The input is read fully into
memory, which suits adapter sample streams rather than an unbounded live feed.

## Environment

| Variable                | Default              | Meaning                                             |
| ----------------------- | -------------------- | --------------------------------------------------- |
| `ACTRADECK_REPO`        | `actradeck/actradeck`| `owner/name` (or git URL) to resolve releases from  |
| `ACTRADECK_INSTALL_DIR` | `~/actradeck`        | where `install` extracts the verified source        |

## License

[Apache-2.0](./LICENSE).
