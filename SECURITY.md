# Security Policy

ActraDeck handles agent stdout/stderr, file diffs, approval requests, and events,
and its core promise is that **secrets are redacted before anything is stored or
transmitted**. A redaction bypass, an approval-gate bypass, or a secret reaching
disk/network is treated as an incident, not a normal bug.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Use GitHub's private vulnerability reporting:

1. Go to the repository's **Security** tab → **Report a vulnerability**
   (GitHub → _Security advisories_ → _Report a vulnerability_).
2. Describe the issue, affected component, and reproduction steps.

If private reporting is unavailable to you, open a minimal public issue that
contains **no exploit details** asking a maintainer to open a private channel.

When reporting, please include where practical:

- Affected component (sidecar / ingestion / state engine / web cockpit / a script).
- Version or commit (`git rev-parse HEAD`) and OS.
- A minimal reproduction and the observed vs. expected behavior.
- **Do not include real secrets** in your report — use synthetic test values
  (e.g. `ghp_` / `AKIA…` style dummies), exactly as the test suite does.

## Scope

In scope (high priority):

- **Redaction bypass** — any secret (key/token/`.env`/credential content) that
  reaches the local SQLite log, the database, or the transmit path _unmasked_.
- **Approval-gate bypass** — a high-risk operation auto-executing without approval,
  or a dangerous command becoming restart-persistable.
- **Secret/credential exposure** — secrets shown in the UI, logs, diffs, or events.
- **SSRF / unintended network access** from connectors or fetch paths
  (internal network / cloud metadata endpoints).
- **Sidecar file-permission / local-privilege issues** (e.g. world-readable state
  files, hook-token leakage, lock/temp-file abuse).

Generally out of scope:

- Attacks requiring an already-compromised local account with the same privileges
  as the agent (the threat model is single-operator / local-fs / loopback).
- Denial of service from deliberately pathological input _that is already bounded_
  (ReDoS resistance is tested; please still report regressions).
- Vulnerabilities in third-party dependencies — report those upstream, though we
  welcome a heads-up so we can pin/patch.

## Supported versions

ActraDeck is pre-1.0. Security fixes target the latest `main`. There are no
long-term-support branches yet.

## Disclosure

We aim to acknowledge a valid report quickly, work with you on a fix, and
coordinate public disclosure once a fix is available. We are happy to credit
reporters who wish to be named.
