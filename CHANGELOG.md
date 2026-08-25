# Changelog

All notable changes to ActraDeck are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

ActraDeck is **early / active development (pre-1.0)**: while below 1.0.0, minor
version bumps may include breaking changes (SemVer §4). The version is applied in
**lockstep** across the root package and every workspace by `scripts/version.sh`.

## [Unreleased]

### Added

- **Anonymous telemetry, off by default.** An explicitly opted-in, closed-schema daily counter
  batch (random installation UUID, event enum, UTC day, version, coarse platform, count — no
  prompts, commands, paths, repository names, or session/event identifiers can be represented).
  Controlled from **Settings → Privacy** or `actradeck telemetry`; the exact outgoing batch is
  previewable before enabling. The independently deployed Cloudflare Worker collector stores an
  HMAC of the installation UUID and rejects out-of-window days. See
  `docs/anonymous-telemetry.md`.
- **`actradeck usage` — local-only aggregate usage report.** UTC-day buckets for demo runs, real
  and governance-protected sessions, and approval activity, computed range-bounded on the local
  store. Nothing leaves the machine.
- **`governance_mode` on `session.started`** (closed enum `enforcement` / `observe_only` /
  `unavailable`) recording whether the approval gate is in the execution path; never inferred
  when missing.
- **Daily public distribution snapshot workflow** (npm downloads and release-asset counters —
  deliberately no repository traffic, which GitHub scopes to push-access holders).
- `ACTRADECK_TELEMETRY_ENDPOINT` / `ACTRADECK_TELEMETRY_STATE` / `ACTRADECK_TELEMETRY_DISABLED`
  operator settings (see `docs/configuration.md`).

### Fixed

- **Approvals from resumed sessions are actionable again.** Sessions that resumed without a
  SessionStart hook folded into their previous terminated run, whose projection suppresses
  pending approvals — approval cards never appeared in the Inbox or Live Wall and every request
  timed out to deny. The sidecar now reopens a new run on any first hook after a terminal reap,
  preserving lineage (`resumed_from`).
- **Telemetry flush no longer follows redirects.** The endpoint gate (HTTPS-only, loopback-HTTP
  only for development, no credentials) validated only the first hop; a 3xx from the configured
  collector could forward the batch to a destination the gate would reject directly. The send
  now uses `redirect: "error"` and a redirect fails closed as `send_failed`.
- **`migrate:down` works again on databases that applied the interim `usage_daily` view.** The
  view migration briefly existed on this branch and was deleted after the aggregation moved to
  range-bounded queries; it is restored as an idempotent cleanup (`DROP VIEW IF EXISTS`), so
  mid-branch databases regain a working migration chain, and running `migrate:down` there also
  removes the stale view (fresh databases are unaffected).
- **Approval cards can no longer be hidden by a terminated session projection.** Pending
  approvals now follow the request's own lifecycle: reaching a terminal state still clears that
  run's open approvals, but a request arriving _after_ the terminal state — a live daemon
  holding a real round-trip — stays visible and actionable instead of silently timing out to
  deny.
- **Harmless search commands no longer flood the approval inbox, and redirects can no longer
  hide a destructive command.** The command risk classifier split segments on `|` and `;` even
  inside quotes, so a quoted regex alternation (`rg -n 'a|b.*[Cc]' src`) was torn apart and
  floored to "needs approval" — with nobody watching the cockpit, every such card timed out to
  deny and effectively blocked agents. The splitter is now shell-syntax-aware (quotes,
  backslash escapes, `#` comments, heredoc bodies) and a single `&` (background terminator)
  separates in both the primary splitter and the legacy fallback/backstop splitter.
  Redirections are now lexed as whole tokens and removed from the segment together with their
  target word, instead of being treated as separators: splitting there tore a program name away
  from its flags, so `rm >out.log -rf /path` — which bash really does execute — classified as
  harmless with no approval card in any mode. That affected redirect forms placed between a
  program and its arguments (`>`, `>>`, `>|`, `<`, `<>`, `>&`, `<&`, `&>`, `&>>`, `<<<`, with or
  without an fd prefix, and with escaped or quoted target words); a generated matrix of operator
  forms by position pins those, and a second matrix covers redirect targets that execute code
  (`>$(...)`, backticks, and process substitution), which is where two of the later regressions
  hid. Dangerous paths stay gated: stdin shells and real pipes classify as before.
  A previous revision of this entry promised, as a structural backstop, that any command the old
  classifier rated high would still rate high. That promise was overstated and is withdrawn: the
  backstop runs the _legacy_ splitter, and this branch rewrote that splitter too, so it is no
  longer the old classifier in any strict sense. A counter-example is
  `find /tmp -delete &> rm -rf /x`, which the old classifier rated high and this one rates medium.
  Both still gate, and no case is known where the verdict falls to harmless, but "still high" is
  not something the code enforces and it should not have been written as if it were.
  An earlier revision of this entry claimed command substitution also classified as before. That
  was wrong and is corrected here: eliding a redirect target removed the substitution in that
  position from analysis entirely, so `cp a >$(find /tmp -delete)` — which bash really executes —
  lost both its approval card and its policy category. The elided target is now carried into
  classification, nested process substitutions are extracted by counting parentheses rather than
  stopping at the first one, and a destructive body raises the verdict even when the launcher only
  reads it.
  Honest limits of that guarantee. Changing a splitter is **not monotone** with respect to
  risk: the legacy splitter is also the fallback for unparseable input, so a finer split there
  can lower a verdict as well as raise one — which is how the redirect hole was introduced in
  the first place — and both directions are now pinned by tests rather than assumed. The
  equivalence check between the two splitters cannot catch this class either, because both can
  agree on the same wrong answer; correctness is carried by the operator matrix, not by that
  agreement. A dangerous-looking string inside quotes (`echo 'a; rm -rf /'`) or inside a quoted
  heredoc body (writing a runbook that documents `rm -rf`) still classifies high even though
  the shell would not execute it — the false-negative guarantee is bought with those known
  false positives. Removing redirects from the segment also stopped the primary splitter from
  leaving the body of a process substitution behind as a fragment, which silently dropped the
  policy category for a command whose launcher only reads it (`cat <(find /tmp -delete)`). Since
  the bypass/YOLO gate is driven by categories rather than by the risk verdict, that turned
  previously gated forms into ungated ones. The body of a process substitution is now classified
  even when the launcher only reads it, and a destructive body raises the verdict as well — a
  category alone leaves the ordinary (non-bypass) approval card missing, which is how
  `tee >(chown -R nobody /srv)` ran an irreversible ownership change with no card in either mode.
  A body that classifies as harmless still leaves the verdict alone, so `diff <(ls) <(ls)` and
  friends produce no new cards.
  One more hole in the same family closed here: a backslash-escaped separator followed by `#`
  (`echo a\># ; rm -rf /path`) was read as the start of a comment, and the rest of the line was
  discarded without even falling back to the conservative splitter. Bash starts no comment there
  and runs the command. The word-head test now shares the scanner's escape state, which also
  restores the rule that the splitter may only discard a region that is genuinely a shell comment.
  A known gap remains and is tracked rather than claimed closed: the process-substitution
  medium-floor suppression is decided per command rather than per segment, so a benign
  `diff <(ls) ;` prefix relaxes it for the whole line. (A quoted assignment whose value contains a
  space — `FOO='a b' rm -rf /path` — was listed here as a second gap; the single word reader
  described below now reads it the way bash does, so that entry is removed.)
  (`tee 2>(rm -rf /path)` was listed here as a gap in an earlier revision; it now gates, so the
  entry is removed rather than left to imply an exposure that no longer exists.)
  Analysis has limits, and past them the classifier gates rather than waves through: a process
  substitution nested more than four deep, or one whose body runs past the size at which the
  classifier stops parsing, is held for approval even when its body is harmless. That costs an
  occasional card on shapes that are rare in practice, and it is deliberate — an unreadable
  construct is not evidence of safety.
  Neither where a shell appears in the command nor how it is written changes whether it is gated.
  The check that recognises "this launcher executes what the process substitution produces" looked
  only at the first segment, so `bash <(echo rm -rf /srv)` gated while `ls; bash <(echo rm -rf
/srv)` — the same execution, one harmless command earlier — classified as harmless with no card
  in either mode. It was also, alone among the five places that derive a program name, skipping the
  leading-assignment step, so `FOO=1 bash <(...)` fell through the same hole. Both are closed, and
  the check is now bound to the command that actually carries the substitution rather than to the
  command string as a whole — an earlier attempt at position-independence scanned every segment,
  which made `diff <(sort a) <(sort b) && node build.js` raise a card. A generated matrix over
  prefixes, runner wrappers, launchers and trailing commands pins all of it.
  Quoting is read the way bash reads it. `$'…'` processes backslash escapes, so `$'a\'b'` does not
  end at that quote; treating it as an ordinary `$` followed by an ordinary `'` shifted the quote
  phase for the rest of the command and made `;`, `>` and `<(` land on the wrong side of it —
  destructive commands after such a string disappeared from classification entirely while bash ran
  them. One scanner now reads quote spans for the splitter, the word reader and the substitution
  collector. Text inside single quotes is data: `grep -rn '<(' .` and `git commit -m 'use $( )
syntax'` no longer raise cards, and `echo 'a$(rm -rf /srv)b'` is a literal string rather than a
  gated command, while `echo "$(rm -rf /srv)"` — which bash does expand — still classifies high.
  Comments are data too, so an apostrophe in a trailing `# don't` no longer manufactures a card.
  Substitution scanning is bounded. Each unterminated substitution used to be rescanned to the end
  of the command, so a 16 KiB command of repeated `$(` cost roughly 850 ms of synchronous work on
  the hook path — enough for one command to stall approval relays and timeout timers. Repeated
  failures now stop the scan, and stopping escalates the verdict rather than softening it: an
  earlier revision of this entry claimed stopping was safe "because the first failure has already
  forced the gate", which was true of the risk level but not of the named category, and an operator
  gating on that category specifically would have lost it.
  Two more holes of the same family closed here. The "could not analyse this segment" backstop was
  suppressed whenever any earlier segment had produced a category, so a harmless-looking prefix
  stripped the gate off an unanalyzable segment behind it; it is scoped to its own segment now. And
  a quoted script handed to a remote or in-container shell (`ssh host '… | sh'`, `docker exec`,
  `kubectl exec`) was only ever caught by accident, because the old quote-blind splitter tore the
  operand apart at the pipe; the operand is classified as inner code now, and only gates when that
  inner code is itself dangerous, so `ssh host 'ls -la'` stays silent.
  Every shell word is now read by one reader. Nine audit rounds of this classifier produced the
  same class of hole each time — quoting, escaping and word boundaries were hand-copied into four
  places (the splitter, redirect targets, heredoc delimiters, the tokenizer) and one of them was
  always a character out of step. Those copies are gone: a single word reader owns quote spans,
  backslash escapes and concatenation, and the splitter, the redirect-target reader, the heredoc
  delimiter reader and the tokenizer all call it. That also closed the quoted-assignment hole
  (`FOO='a b' rm -rf /path` hid the program because the old tokenizer turned quotes into spaces),
  the `ssh host $(rm -rf /srv)` hole (an early return in the remote-runner branch made the
  command-substitution gate unreachable — every runner, both substitution forms), a heredoc-body
  hole (shell quoting was applied to text that has none, so an even number of apostrophes in the
  body swallowed a real `$(…)`), and shell compound statements (`if …; then rm -rf /; fi`,
  `for`/`while`/`case`, whose keywords were taken for the program name). Two bash-parity edges
  follow the same reader: `$$'…'` is the PID parameter followed by an ordinary quote, not ANSI-C
  quoting, and a backslash inside single quotes is literal. The executor-binding check that stops
  `diff <(sort a) <(sort b) && node build.js` from raising a card is now bounded by total scan work
  rather than by a count of substitution sites, so `node build.js && paste <(a) … <(l)` with a
  dozen sites stays silent instead of degrading to the earlier position-blind scan. Expected
  behaviour throughout was checked against what bash actually executes, using a stub `PATH` and
  marker files rather than destructive commands. Honest accounting: the file did not get smaller
  — the single reader builds word literals the old approximations skipped, and the audit fixes
  landed alongside it — so the size tripwires now record 1916 executable lines and a summed
  ceiling that a file split cannot dodge.

## [0.8.0] - 2026-08-25

### Changed

- **Telemetry collector purges rows after 24 months.** `TELEMETRY_RETENTION_MONTHS` (new, in
  `@actradeck/telemetry-contract`) is the single source for a daily cron-triggered `scheduled`
  handler that deletes rows whose `occurred_on` is older than 24 months, and for the retention
  statement in the consent copy. Operators redeploy the Worker to register the trigger
  (`triggers.crons` in `wrangler.example.jsonc`). Wire contract unchanged.
- **Telemetry consent copy now matches the wire contract and the collector.** The Settings →
  Privacy panel gains a "Purpose" block (aggregate product-usage judgement and development
  prioritisation only — not billing, advertising, identification, or third-party sharing), lists
  every per-row field (including `app_version` and coarse `platform`, which were previously
  omitted), states that `cockpit_started` is a once-per-day presence marker rather than a launch
  count, and adds a "Retention and deletion" block: 24-month purge, "Stop and delete ID" is
  local-only, and deleting already-sent rows earlier requires emailing the installation ID to
  **privacy@actradeck.io** (`TELEMETRY_PRIVACY_CONTACT` in the contract) before it is deleted
  locally (the identifier is stored only as a keyed hash). Same facts added to
  `docs/anonymous-telemetry.md`, the README, and a new "Privacy requests" section in
  `SECURITY.md`.

### Added

- **Anonymous telemetry, off by default.** An explicitly opted-in, closed-schema daily counter
  batch (random installation UUID, event enum, UTC day, version, coarse platform, count — no
  prompts, commands, paths, repository names, or session/event identifiers can be represented).
  Controlled from **Settings → Privacy** or `actradeck telemetry`; the exact outgoing batch is
  previewable before enabling. The independently deployed Cloudflare Worker collector stores an
  HMAC of the installation UUID and rejects out-of-window days. See
  `docs/anonymous-telemetry.md`.
- **`actradeck usage` — local-only aggregate usage report.** UTC-day buckets for demo runs, real
  and governance-protected sessions, and approval activity, computed range-bounded on the local
  store. Nothing leaves the machine.
- **`governance_mode` on `session.started`** (closed enum `enforcement` / `observe_only` /
  `unavailable`) recording whether the approval gate is in the execution path; never inferred
  when missing.
- **Daily public distribution snapshot workflow** (npm downloads and release-asset counters —
  deliberately no repository traffic, which GitHub scopes to push-access holders).
- `ACTRADECK_TELEMETRY_ENDPOINT` / `ACTRADECK_TELEMETRY_STATE` / `ACTRADECK_TELEMETRY_DISABLED`
  operator settings (see `docs/configuration.md`).

### Fixed

- **Approvals from resumed sessions are actionable again.** Sessions that resumed without a
  SessionStart hook folded into their previous terminated run, whose projection suppresses
  pending approvals — approval cards never appeared in the Inbox or Live Wall and every request
  timed out to deny. The sidecar now reopens a new run on any first hook after a terminal reap,
  preserving lineage (`resumed_from`).
- **Telemetry flush no longer follows redirects.** The endpoint gate (HTTPS-only, loopback-HTTP
  only for development, no credentials) validated only the first hop; a 3xx from the configured
  collector could forward the batch to a destination the gate would reject directly. The send
  now uses `redirect: "error"` and a redirect fails closed as `send_failed`.
- **`migrate:down` works again on databases that applied the interim `usage_daily` view.** The
  view migration briefly existed on this branch and was deleted after the aggregation moved to
  range-bounded queries; it is restored as an idempotent cleanup (`DROP VIEW IF EXISTS`), so
  mid-branch databases regain a working migration chain, and running `migrate:down` there also
  removes the stale view (fresh databases are unaffected).
- **Approval cards can no longer be hidden by a terminated session projection.** Pending
  approvals now follow the request's own lifecycle: reaching a terminal state still clears that
  run's open approvals, but a request arriving _after_ the terminal state — a live daemon
  holding a real round-trip — stays visible and actionable instead of silently timing out to
  deny. Post-terminal cards are cleared by the request's own resolution, or — if the daemon
  died first — by the synthetic relay-lost retire on the daemon's next reconnect; a card whose
  daemon never returns stays in the store but is hidden by Inbox presence gating and can never
  auto-allow.

## [0.7.0] - 2026-08-10

### Added

- **`actradeck demo` — a zero-side-effect five-second product preview.** The dependency-free
  npm bootstrapper now explains detect → hold → deny → redact → record before asking a visitor
  to install anything. It performs no network, filesystem, subprocess, or install action and
  labels the output as a synthetic simulation before pointing to the cockpit's real 30-second
  pipeline demo.

### Changed

- **README repositioned around the first user outcome.** The opening now leads with reducing
  blind coding-agent approvals, shows the held-action experience immediately, moves the live
  safety demo and shortest install paths ahead of architecture/assurance detail, and keeps mode
  support plus best-effort security limits explicit. npm metadata now uses the same outcome-led
  description and adds Claude Code, Codex, approval, audit, and agent-security discovery terms.
- **Breaking: audit manifest canonical form bumped to v3** (`actradeck-audit-manifest/v3`).
  The signed manifest summary now carries `approval_synthetic_retired` (relay-lost synthetic
  retires, itemized separately from operator decisions), which changes the canonical
  chain/signature input. Manifests exported by v0.6.0 (v2) no longer verify against the
  current form; the verify surface reports them as a distinct `unsupported-manifest-version`
  (not `malformed-manifest`), so archived evidence from older builds is distinguishable from
  tampering. Re-export reports to obtain v3 manifests. Approval request ids also use a new
  canonical shape (`s<hash12>:apr-<32 hex>`); pendings persisted by older daemons are retired
  as `relay_lost` on the first hello after a coordinated upgrade (designed recovery).
- **Breaking: audit review-packet manifest bumped to v2**
  (`actradeck-audit-packet-manifest/v2`). The packet governance semantics changed in the same
  release (`hard_gate` no longer counts relay-lost synthetic retires as operator denials, and
  flagged items may carry `reason: relay_lost`), so packets are versioned to keep two signed
  packets with different governance semantics distinguishable. Packets exported by v0.6.0
  (v1) report the distinct `unsupported-packet-manifest-version` on verify (fail-closed, not
  "tampered"). Re-export review packets to obtain v2.
  Recipient note: a packet document embeds one `actradeck-audit-packet-manifest` marker
  (proves the cross-session bundle: governance aggregation + per-session roots) **and** one
  `actradeck-audit-manifest` marker per bundled session (each proves that single session
  only). To verify the packet as a whole, extract and verify the packet marker — verifying
  only a session marker proves that session, not the bundle.

### Fixed

- **WebSocket browser boundary now enforces same-origin upgrades.** The WebUI rejects missing,
  duplicate, malformed, cross-origin, cross-site, and same-site cross-origin browser handshakes
  before `handleUpgrade`, and ships framing, MIME-sniffing, referrer, and base/object CSP headers.
- **YOLO policy classifier bypasses closed.** Shell-escaped executable names, BusyBox/Toybox
  applets, Git global options, Git shell aliases, and dynamic executable expansion can no longer
  bypass the default approval policy. Arbitrary inline code is now default-gated; the reproducible
  safety corpus includes these adversarial forms (53 vectors, 100% default-gate recall).
- **Approval-hook exceptions now fail closed.** Once a valid Claude Code `PermissionRequest` or
  `PreToolUse` hook is identified, identity, policy, event-sink, or bridge failures return the
  provider-specific explicit deny response instead of the no-op `{}` response that could continue
  execution.
- **Release tags can no longer bind the pre-version tree.** `scripts/version.sh` now separates
  stamping from a clean-tree `--tag-only` phase after commit, and the release invariant inspects
  the tag's own `package.json` instead of only checking that a same-named tag exists.
- **High-severity `nanoid` development dependency advisory patched.** The transitive
  Vitest/Vite/PostCSS path is pinned to the patched 3.3.17+ line; `pnpm audit --audit-level high`
  now reports no known vulnerabilities.
- **ReDoS timing invariant deflaked without loosening its threshold.** The sub-millisecond
  auth-header case now batches identical operations per timing sample so scheduler granularity
  cannot manufacture a super-linear ratio; the O(n²)-detecting 3.5 threshold is unchanged.

## [0.6.0] - 2026-08-05

### Added

- **`actradeck conformance` — a stream conformance checker for third-party adapters.**
  The bootstrap CLI now bundles the event-model conformance checker: feed it a JSONL
  event stream and it validates the ingestion contract offline (schema, cross-field,
  ordering, drop-detection wiring) plus the semantic lifecycle rules added by ADR 0014
  Phase 2 — empty streams, `event_id` retry-vs-collision, `seq` collisions, missing
  `payload.kind`, events after terminal, re-starts after terminal, and approval
  request/resolve lifecycle. False-green paths (an empty or `kind`-less stream passing
  silently) now fail closed.
- **Run lineage: resume no longer collapses onto a dead session.** ActraDeck now
  persists `provider_session_id`, `start_kind`, `resumed_from_session_id`, `end_kind`,
  and `recoverability` per session, and the cockpit detail pane shows a lineage section
  ("continued from", continuation, run chain) that distinguishes an observed parent
  from a declared-but-unobserved reference (linked-unknown) and never over-claims
  (ADR 0014 Phase 3). On top of that: an attach `SessionEnd` now leaves a bounded
  terminal tombstone, so resuming the same provider session after the daemon reaped it
  mints a new run with an observed `resumed_from` edge instead of folding post-terminal
  events into the terminated run; and a managed launch's own `--resume`/`--continue`
  argv now authoritatively sets the first run's `start_kind` (UUID shape-gated,
  self-loop-guarded — absence of the flags asserts nothing).
- **Evidence-based completion (ADR 0015).** Agent-declared plans and tasks (Claude Code
  task hooks, Codex `update_plan`) fold into per-session work items, completion claims
  are verified against observed checks, and the cockpit shows a work-items panel with
  evidence badges plus a claimed-unverified count on the Wall — "the agent said done"
  and "we saw it verified" are now visibly different states.
- **`scripts/ci-preflight.sh` — a one-command local mirror of the CI gates** (lint,
  type-check, tests with real PostgreSQL, builds, coverage, INV tripwires) with a
  drift tripwire so the local gate cannot silently diverge from `ci.yml`.
- **Post-demo onboarding.** After the safety demo the cockpit now guides you through
  wiring your real agents (per-agent readiness checks with concrete next commands)
  instead of dead-ending on demo data.

### Fixed

- **Terminal poisoning: a single aborted turn no longer freezes a live session
  (ADR 0014 Phase 1).** A Codex `turn_aborted`/`systemError` or a thread unload used to
  mark the whole session `failed`/`completed` permanently — every later real event was
  then ignored by the projection. Turn failures now land on a separate
  `last_turn_outcome` axis, transient system errors degrade to non-terminal
  diagnostics, and a thread unload becomes the resumable terminal `suspended`.
  Terminal states stay immutable; resume creates a new run with lineage instead of
  re-opening the old one.
- **Test harnesses refuse production-port databases (SEC-2).** Every workspace's test
  setup now fails closed if `DATABASE_URL` points at a production PostgreSQL port, so a
  misconfigured environment cannot let tests write into the live event store.
- **Two waves of high-severity dependency advisories patched** (INV-DEP-AUDIT keeps
  `pnpm audit` high/critical at zero).

### Changed

- **Positioning: the headline subject is now "audit cockpit", not "control plane".**
  README hero, landing hero/meta, the npm package description, and the CLI usage line
  now lead with _"A local-first audit cockpit for coding agents — observe across
  agents, redact secrets before persistence, and keep one replayable audit trail"_,
  with approval relay stated as a scoped sub-sentence (Claude Code in Attach, Codex in
  Managed Mode). "Control plane" as a headline implied enforcement across all targets,
  which the default Attach mode does not deliver for Codex (observe-only). The term
  remains in lower-tier/SEO contexts; see ADR 0001 (Amendment 2026-07-18) for the
  conditions to restore it.

## [0.5.2] - 2026-07-12

### Fixed

- **The audit-coverage panel now surfaces its own outage instead of freezing the last
  healthy snapshot.** Previously, if the coverage API stopped responding, the board kept
  rendering the last-known per-provider rows with a frozen "Xs ago" age — the audit-gap
  detector could not signal a gap in itself. The panel now books time-since-last-success
  client-side (clock-skew independent), shows a stale banner and dims the rows once data
  is older than three poll intervals, renders an explicit "unreachable" row when the API
  never answered, and bounds every pull with a fetch timeout so even a _hanging_ backend
  cannot freeze the signal. Fresh-path rendering is byte-identical to before.
- **Deflaked `INV-OPENCODE-ADAPTER-ERROR-MINIMIZED` (public CI false red).** The leak
  scan substring-matched dropped envelope values against runtime-generated fields, so a
  short numeric like `141` could collide with the hex timestamp of a freshly minted
  UUIDv7 `event_id`. Generated `event_id`/`timestamp` are now excluded from the negative
  scan (their formats are structurally enforced by the parser); every derived field is
  still scanned, pinned by a seeded collision test plus a real-leak injection test.
- **Deflaked the webui audit-detail replay test** — a heavy dynamic `import("jsdom")`
  inside the test body counted against the 5s test timeout and could exceed it on a
  contended CI runner; the import is now static (module-load phase) with an explicit
  per-test timeout as a backstop. Assertions unchanged.

### Changed

- **Tagline: "observe everything, govern selectively."** README and docs now lead with
  the honest split — cross-vendor observation, secret redaction, and one audit trail for
  every agent; approval governance where the mode supports it. The headline redaction
  claim is scoped per path (sidecar-observed sessions: before transmit and persist;
  external adapters: at backend ingress before persist — closes issue #16).
- **Public-mirror docs consistency (issue #5).** Shipped docs no longer link to files
  that exist only in the private canonical repo (`plan.md`, `CLAUDE.md`,
  `.claude/rules/`); references were replaced with public equivalents (`docs/adr/`,
  `CONTRIBUTING.md`) or honest "internal, not shipped" prose. `docs/docker.md` and the
  README were caught up to the v0.5.x multi-arch reality.
- **CI failures now name the failing tests.** Both real-DB INV assert steps (backend and
  db) previously re-ran the suite behind an `&&` chain, so when the suite itself failed
  no test name reached the log; they now capture the exit code and print each failed
  test (file + title) before failing with the original code.
- **Community-PR close comments are standardized.** `scripts/import-oss-pr.sh` now emits
  a close-comment template covering: imported into the canonical repo with authorship
  preserved, the public mirror commit, the shipped version, CONTRIBUTORS.md/CHANGELOG
  credit, and why the PR shows "Closed" instead of "Merged" on a one-way mirror.

## [0.5.1] - 2026-07-11

### Fixed

- **First npm publish passes registry-side provenance validation.** Publishing v0.5.0
  to npm was rejected (E422): the registry validates that the published
  `package.json`'s `repository.url` matches the provenance's source repository, and
  the `actradeck` package declared no `repository` at all. The package now declares
  `repository` (with the monorepo `directory`) pointing at the public repository, so
  0.5.1 is the first version that actually lands on npm — v0.5.0 shipped as a GitHub
  Release + GHCR image only.

## [0.5.0] - 2026-07-11

### Added

- **npm bootstrap CLI: `actradeck`.** A thin, dependency-free npm package that
  bootstraps a verified install: `actradeck install` resolves a signed GitHub Release,
  verifies the tarball's sha256 **and** its build-provenance attestation before handing
  off to quickstart (fail-closed; `--dry-run` supported); `doctor` diagnoses your
  machine; `up` prints the Docker cockpit bring-up command (it never executes Docker
  for you); `version` reports versions. The package has zero runtime dependencies and
  no lifecycle scripts, and publishes **only** from the public repository's release
  workflow via npm **Trusted Publishing** (OIDC — no long-lived tokens), behind a
  two-layer publish gate plus an `npm pack` content gate (files allowlist + leak scan)
  that runs before every publish. (ADR 0013 Phase 3)
- **Multi-arch Docker image (amd64 + arm64).** The GHCR cockpit image is now a
  manifest list covering `linux/amd64` and `linux/arm64`. Each architecture's
  filesystem is leak-scanned **before push**, and the cosign signature + SLSA
  attestation bind to the manifest-list (index) digest.
- **Silent-drop detection via optional `seq`.** Adapters may stamp events with a
  per-session `seq` counter; holes in the received set yield a **lower-bound** count
  of silently dropped events. Optional and additive — adapters that omit `seq` are
  unaffected, and at-least-once retries do not fabricate gaps. See
  [`docs/ingestion-contract.md`](docs/ingestion-contract.md) §4.4.
- **Per-provider audit coverage on the cockpit board.** The board now shows, per
  provider, how recently events were received and flags reception gaps
  (warn/critical), so a silently-broken observation pipeline is detected instead of
  assumed healthy (audit-gap detection Phase 1).
- **opencode adapter: turn-active heartbeat.** While a turn is in flight the adapter
  emits a periodic `heartbeat` event, so long tool-quiet turns stay visibly live
  instead of drifting to stalled (community issue #8).

### Changed

- **`scripts/actradeck doctor` checks Node and pnpm versions** (community PR #10 —
  thanks @Yurii201811).
- Verified-install digest checks normalize hex case and CRLF identically in the
  TypeScript CLI and `scripts/install.sh` (hex-equivalence only; verification is not
  weakened).

### Security

- **Release supply-chain checkers hardened (fail-closed).** The pre-push per-arch
  scan-coverage checker now rejects nested-quote wrappers it cannot parse and
  recognizes the fused `-otype=registry` publish spelling; cache parity is checked at
  token positions rather than by substring. CI/release actions were bumped with
  SHA-pins preserved (Dependabot PR #1) and the Docker base image bumped to
  `node:26.4.0-bookworm-slim` (PR #2).

## [0.4.0] - 2026-07-11

### Added

- **One-command Docker image (cockpit stack).** A signed container image publishes the
  cockpit — backend + webui/BFF + an embedded PostgreSQL (PGlite) — so you can try
  ActraDeck with a single `docker run` and no external database, a lighter on-ramp than
  the clone/quickstart install. The image is the cockpit stack only; agent observation
  (the sidecar) stays on the host and connects over loopback (see
  [`docs/docker.md`](docs/docker.md) for the honest support matrix).
- **GHCR publishing is USER-GATED and supply-chain hardened.** Publishing is off by
  default (opt in via `ENABLE_GHCR_PUBLISH=true` or a manual workflow dispatch against a
  `vX.Y.Z` tag). When it runs, the image is **leak-scanned before push**, signed with
  **cosign keyless** (OIDC → Sigstore/Fulcio → Rekor), and carries a **SLSA build-provenance
  attestation** of the image digest — a different trust root from the product's own
  audit-export signature, never reused. Verify with `cosign verify` +
  `gh attestation verify` (commands in `docs/docker.md`).
- **External adapters via the public ingestion contract.** Two dependency-zero,
  observe-only example adapters ship: an **opencode** plugin and a **Gemini CLI** hook
  adapter (`docs/examples/`). Any tool can map its events to `provider=<slug>` /
  `source=external` and `POST /ingest`; the backend ingress redaction floor applies to
  them like any other event. External adapters carry no client-side redaction — the
  backend floor is the only redaction defense (disclosed in each adapter's README).
- **External-adapter sessions on the Live Wall.** `source=external` sessions surface on
  the wall/board via a recency proxy; terminal (ended) sessions are excluded from the
  live indicator so a completed run no longer shows as “LIVE”.
- **Managed Codex spawn from the cockpit** (opt-in, default off). Launch an in-process
  Managed Codex session over the attach daemon's control channel, with cwd containment
  and the same approval supervision as any Managed session (ADR 019f4206).
- **Public-mirror PR import flow.** `scripts/import-oss-pr.sh` imports a community pull
  request into the canonical repo with your authorship preserved (`git am`), recording
  you in `CONTRIBUTORS.md`; CONTRIBUTING documents how the one-way mirror keeps
  contributions from being lost.

### Changed

- **Headline claims scoped to what is actually enforced.** README, docs, and the
  landing page now present cross-vendor secret redaction and audit as unconditional,
  with **selective** approval governance — relayed to the cockpit for Claude Code over
  Attach and for Codex in Managed Mode; external adapters are observe-only. This matches
  the vendor/mode support matrix (no over-claiming).
- **Shipped docs are English-canonical with Japanese companions** (`*.ja.md`).
- **`capture_mode` is shown at the session-list level** for an honest per-session view
  of how each agent is being observed.

### Security

- **Redaction floor: two straddle-leak classes bounded.** Secrets that straddled the
  redaction window could previously leave a raw prefix at rest below a rule's minimum
  match length. Both the PEM private-key class (SEC-2) and the JWT class (SEC-1) are now
  bounded, pinned by falsifiable real-PostgreSQL invariants (redact-before-truncate).

### Fixed

- Closed CodeQL true-positives (prototype-pollution, ReDoS) and a dead store; eliminated
  polynomial ReDoS in the ingestion-contract doc extractors.

## [0.3.0] - 2026-07-05

The first release produced by the signed pipeline (versioned tarball + CycloneDX
SBOM + SLSA build provenance). Prior public releases v0.1.0 (2026-06-27) and v0.2.0
(2026-06-30) were early manually-cut previews without signing; their notes live on the
GitHub Releases page. Everything below already works today against a live stack
with real sessions (no mocks); see the README support matrix for what each vendor mode
relays.

### Added

- **Secret redaction before persist or transmit (INV-REDACTION).** A single
  choke-point redactor masks detected secret keys, tokens, and `.env` contents
  _before_ any event reaches disk or the network, with per-kind counts surfaced in
  the cockpit. Detection is best-effort pattern matching (gitleaks-style rules plus
  custom regexes) — a strong safety net, not an absolute guarantee.
- **Approval governance (selective by mode).** A structural risk classifier gates
  high-risk commands and relays approval cards to the cockpit — for Claude Code over
  Attach and for Codex in Managed Mode; external adapters are observe-only. An opt-in
  persistent allowlist skips re-approving _safe_ operations without ever auto-allowing
  dangerous ones. Per-repo approval policy and a default-on catastrophic-operation gate
  for bypass/YOLO modes.
- **Cross-vendor observation.** Claude Code (via hooks) and Codex (via rollout
  tailing in Attach Mode, or the App Server in Managed Mode) are normalized into one
  common event model, surfaced in one approval inbox.
- **Live session state by evidence.** running / waiting-approval / waiting-user /
  stalled derived from decomposed liveness heartbeats, not a single signal.
- **Audit & replay.** Every session can be replayed after the fact. Session reports
  export to HTML/Markdown with an embedded integrity manifest (SHA-256 hash chain).
  Setting `ACTRADECK_AUDIT_SIGNING_KEY` (Ed25519) produces a signed, tamper-evident
  report that a recipient can independently verify was not altered after export.
- **Tamper-evident review packet.** Multiple sessions bundle into a single shareable,
  independently verifiable review packet with cross-session governance aggregation
  (hard / soft / auto gate classification) for review, incident analysis, and
  compliance workflows.
- **Local-first cockpit.** A sidecar on your machine collects structured events and
  serves a web cockpit you control (single-operator / loopback / local-fs trust
  boundary). Attach Mode observes an existing Claude Code install with minimal friction.
- **Supply-chain provenance (infrastructure).** Signed GitHub Release tooling: a
  lockstep version stamper, a CycloneDX SBOM generated from the production dependency
  closure, a release workflow that attests the release tarball with SLSA build
  provenance, and an opt-in `ACTRADECK_VERIFY=1` install path that fails closed if
  provenance is absent or the download digest does not match.
- **Public ingestion contract.** Any tool can normalize its own events and `POST /ingest`
  them into the cockpit ([docs/ingestion-contract.md](docs/ingestion-contract.md)):
  `provider` is an open slug dimension (`^[a-z][a-z0-9_-]{0,31}$` — a charset/length
  bound, not secret detection), `source` gains `"external"`, and `event_type` stays a
  closed enum (the state machine gives each type meaning; normalization is the
  adapter's job). The doc's golden example and event-type list are pinned by contract
  tests, so the published contract cannot silently drift from the schema. Ships with a
  zero-dependency example adapter (`docs/examples/ingest-adapter`).
- **Ingress redaction floor.** Direct `/ingest` POSTs that bypass the sidecar are now
  unconditionally redacted _before_ persist (shared `@actradeck/redaction` single
  source), and redaction counts are re-derived server-side from actual markers —
  client-declared counts are never trusted. This is an accident-prevention floor for
  honest adapters, not a defense against adversarial `INGEST_TOKEN` holders (they are
  inside the trust boundary).

### Fixed

- **File-lock lost-update race (found while de-flaking its own test).** The advisory
  file lock that serializes approval-allowlist, approval-policy, and attach-settings
  persistence had an empty-file window between exclusive create and pid write
  (create-then-fill TOCTOU): under CPU pressure a second process could misread the
  brand-new lock as stale, take it over, and enter the critical section concurrently —
  losing updates. Acquisition now publishes the lock file atomically _with_ its holder
  pid (hardlink from a pid-bearing temp), structurally removing the window. Pinned by a
  real multi-process invariant test (`INV-FILELOCK-NO-EMPTY-WINDOW`).

[Unreleased]: https://github.com/actradeck/actradeck/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/actradeck/actradeck/releases/tag/v0.8.0
[0.7.0]: https://github.com/actradeck/actradeck/releases/tag/v0.7.0
[0.6.0]: https://github.com/actradeck/actradeck/releases/tag/v0.6.0
[0.5.2]: https://github.com/actradeck/actradeck/releases/tag/v0.5.2
[0.5.1]: https://github.com/actradeck/actradeck/releases/tag/v0.5.1
[0.5.0]: https://github.com/actradeck/actradeck/releases/tag/v0.5.0
[0.4.0]: https://github.com/actradeck/actradeck/releases/tag/v0.4.0
[0.3.0]: https://github.com/actradeck/actradeck/releases/tag/v0.3.0
