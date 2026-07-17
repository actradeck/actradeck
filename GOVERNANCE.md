# ActraDeck Governance

This document describes how ActraDeck is developed, how external contributions are
taken in, and how the project makes decisions. It is written to be **honest about the
project's current stage**: ActraDeck is early (pre-1.0) and, at the time of writing, is
run by a **single maintainer** doing best-effort review. Nothing here promises a review
SLA or a fixed timeline — it describes the process and the intent, not a guarantee.

If you just want to contribute, start with [`CONTRIBUTING.md`](./CONTRIBUTING.md); this
document explains the machinery behind it.

## 1. Project structure: this repository is canonical

As of **2026-07-18**, this public repository (`github.com/actradeck/actradeck`) is the
**canonical source of truth** for ActraDeck. Development happens here: pull requests
are reviewed and **merged normally**, contributor commits (author identity and SHAs)
appear in this repository's history, and releases are cut from this `main`.

**History note.** Before the cutover, this repository was a one-way curated mirror of a
private repository, so the history **before the cutover is synthetic** — one snapshot
commit per sync, not per-change history. That is a permanent artifact of the old model;
everything **after** the cutover is real, per-change history. The pre-cutover private
repository remains archived on the maintainer's side and is no longer a source of truth.
Pull requests accepted **under the old model** show as _Closed_ (with an explanatory
comment describing how they were imported and shipped) rather than _Merged_ — from now
on, accepted PRs are simply **Merged**.

**What remains maintainer-private.** A small private overlay repo holds things that are
not product source: the maintainer's local agent/tooling rules, internal process docs,
marketing-site sources, and the publication tooling. Nothing in the overlay is needed to
build, test, or contribute to ActraDeck — the product's source of truth (code, type and
schema contracts, invariant tests `INV-*`, CI) lives entirely in this repository.

**Leak safety moved to the edge.** Keeping secrets out of persisted and published data
is central to ActraDeck's design, and that discipline now runs **before every commit and
push** on the maintainer's side (author-identity, secret, coupling, and private-path
gates at commit time; a full pushed-range object scan at push time), backed by GitHub
push protection and a CI leak job on this repository. This is a strong safety net, not
an absolute guarantee — see [`SECURITY.md`](./SECURITY.md) for reporting anything that
slips through.

## 2. How external contributions are taken in

You contribute the standard GitHub way: **fork, branch, open a pull request against
`main`.** You do not need any maintainer-private tooling. See
[`CONTRIBUTING.md`](./CONTRIBUTING.md) for setup, the local gate, and PR guidelines.

When your PR is accepted it is **merged normally** — your commits, with your author
identity, become part of this repository's history, and GitHub shows the PR as
**Merged**. Branch protection requires the CI gate to pass before merge.

**Credit.** Your merged commits are the primary, durable record.
[`CONTRIBUTORS.md`](./CONTRIBUTORS.md) additionally credits contributors (including
those whose work landed under the old import model, whose SHAs pre-date the cutover).

**Licensing / sign-off.** Contributions are accepted under the **Developer Certificate of
Origin 1.1**; see [`CLA.md`](./CLA.md) (there is no separate form — `git commit -s` adds
the sign-off). All contributions are licensed under the project's Apache-2.0 license.

## 3. Decision-making

**Current model: single maintainer.** ActraDeck is at an early stage and today the
maintainer holds final say over what is accepted, released, and shipped.
This is stated openly rather than dressed up as a committee — the honest picture is a
solo, best-effort project.

**Security-first, independently audited changes.** Being solo does not mean unchecked.
Changes — especially to the security- and correctness-sensitive surfaces (secret
redaction, approval gating, event ordering, liveness) — go through an **independent audit
process** before merge: separate **security**, **QA**, and **tech-debt** reviews, whose
findings are collected and adjudicated (BLOCK / CONDITIONAL / APPROVE) before anything
ships. The invariants that these reviews defend are documented in
[`CONTRIBUTING.md`](./CONTRIBUTING.md#security-sensitive-areas-please-read) (`INV-REDACTION`,
`INV-APPROVAL`, `INV-EVENT-ORDER`, `INV-STALLED`) and enforced by tests, not by discretion.

Architectural decisions are recorded as ADRs under [`docs/adr/`](./docs/adr/); see
[ADR 0001](./docs/adr/0001-product-positioning-and-oss.md) for the product positioning and
OSS rationale.

## 4. Toward external maintainers

ActraDeck would like to grow beyond a single maintainer. This section describes the
**intended** path — it is an early-stage statement of direction, **not a commitment or a
guaranteed timeline**. There is no formal committee, no voting process, and no promised
promotion track yet; what follows is how the maintainer intends to grow trust as the
community forms.

The rough progression:

1. **Sustained, quality contributions.** A track record of focused PRs that pass the gate
   and respect the security-sensitive boundaries builds the trust everything else rests on.
2. **Triage rights on the public repo.** A trusted, regular contributor may be given
   permission to help triage issues and pull requests on this repository (labelling,
   shepherding good-first-issues, initial review) — meaningful responsibility that does
   **not** require access to the maintainer's private overlay.
3. **Co-maintainer.** As the project and the contributor base mature, the intent is to
   bring on co-maintainers with a real say in direction and releases, and to move
   decision-making from a single person toward a small maintainer group. The concrete
   criteria and mechanics for this will be written down **when there is a community to
   write them with** — this document will be updated at that point rather than pretending
   the process already exists.

If you are interested in a larger role, the path starts at step 1: contribute, and open a
conversation with the maintainer.

## 5. Releases and versioning

ActraDeck follows **[Semantic Versioning](https://semver.org/spec/v2.0.0.html)** and is
**pre-1.0**: while below `1.0.0`, minor version bumps may include breaking changes
(SemVer §4). The version is applied in **lockstep** across the root package and every
workspace by `scripts/version.sh`. Notable changes are recorded in
[`CHANGELOG.md`](./CHANGELOG.md) in [Keep a Changelog](https://keepachangelog.com/) format.

Release artifacts are signed and digest-verified; the distribution model (signed release
tarball, `npx actradeck@latest install` bootstrap CLI, npm Trusted Publishing) is
described in [ADR 0013](./docs/adr/0013-release-signing-and-distribution.md) and the
[README](./README.md#quickstart). Security fixes target the latest `main`; there are no
long-term-support branches yet (see [`SECURITY.md`](./SECURITY.md#supported-versions)).

## 6. Security and licensing pointers

- **Reporting a vulnerability:** do **not** open a public issue. Follow
  [`SECURITY.md`](./SECURITY.md) (GitHub private vulnerability reporting).
- **Contribution licensing / DCO sign-off:** [`CLA.md`](./CLA.md).
- **Code of Conduct:** [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).
- **How to contribute (setup, gate, PR guidelines):** [`CONTRIBUTING.md`](./CONTRIBUTING.md).
