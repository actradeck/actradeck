# Changelog

All notable changes to ActraDeck are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

ActraDeck is **early / active development (pre-1.0)**: while below 1.0.0, minor
version bumps may include breaking changes (SemVer §4). The version is applied in
**lockstep** across the root package and every workspace by `scripts/version.sh`.

## [Unreleased]

### Added

- **Two degradation counters that nothing could read are now on `GET /realtime/readiness`.** The
  sidecar counted approval `request_id` mints that the redactor mangled (`unstableRequestIdCount`),
  and the backend counted stale DB approvals it declined to retire because their id matched neither
  the canonical nor a known-legacy form (`nonRetirableSkipCount`). Both were "observable" only in
  the sense that a getter existed: no route, hello frame, log line, or telemetry ever read them, so
  a real degradation was silent in a running deployment. The readiness endpoint — already the
  read-only aggregate behind the `/realtime` bearer gate — now carries a `counters` object with
  both, and the sidecar reports its own count on the hello frame it already sends. Zero is normal;
  anything above zero is worth investigating.
  Only non-negative integers cross the wire. A shared parser in the event model projects both the
  hello field and the endpoint response onto a closed shape, so a buggy or hostile daemon that
  stuffs a path or a token into an extra field has it dropped at the boundary, and a negative or
  fractional count collapses to zero rather than reaching the endpoint. A daemon that reports
  nothing (an older build, or the observe-only Codex rollout tail, which has no approval bridge) is
  excluded from the sum rather than counted as zero. The counters carry no request id, session id,
  or path — only how many, never which.

### Changed

- **The scan normalisation that source-reading tripwires share is now one implementation, it reads
  trailing comments, and it no longer loses its place inside template interpolation or a regular
  expression.** Ten test files read source with comment text removed, so that a verbatim copy
  sitting in a comment cannot satisfy a pin and a forbidden word written in a comment cannot trip
  one. Seven places carried their own removal code in six different shapes, and the weakest shape
  decided what any given scan could see: one stripped only comments that begin a line, two stripped
  a trailing comment only when whitespace preceded it, one stripped every double slash regardless of
  context - truncating 133 of the 596 scanned files at their first URL - and one tracked strings but
  not regular expressions. All ten now call one scanner in the event model, beside the test database
  guard and for the same reason: four workspaces share it, and a helper under `apps/` could only be
  reached from a package by importing upwards.
  Trailing line comments are removed, along with the whitespace before them. Measuring that is only
  meaningful with the derivation stated, so: counting the comment ranges the TypeScript parser
  reports as single-line trivia that have non-whitespace before them on their own line, over every
  `.ts`/`.tsx`/`.mts`/`.cts` path in `git ls-files`, gives 2,088 such comments in
  299 files, 50,285 characters that were previously part of what a tripwire could
  see.
  Two whole classes of desynchronisation are closed rather than disclosed. The contents of a
  template interpolation are scanned as the code they are, nested templates included; without that,
  a `// was: …` note parked inside one satisfied a presence pin that a backend invariant relies on,
  and the same comment on the same line failed to satisfy it on the previous release - the branch
  was weaker than what it replaced. And a regular expression whose terminating slash is immediately
  followed by another is no longer read as an expression: `(t) => /^alias\.[^=\s]+=!/i.test(t)`
  ends in a character that looks like the start of one, so the closing slash swallowed half of the
  line comment after it. Two guards fail closed: an unterminated block comment is treated as not a
  comment at all, because a `/*` inside a character class otherwise ate every remaining line of its
  file, and a slash that cannot close on its own line is never a regular expression.
  The claim that only comments are removed is now checked two ways on every tracked TypeScript
  source, not on one package: the text left after deleting exactly the comment ranges the parser
  reports must match the scanner's output, and the parser's leaf token stream must be identical
  before and after. The first catches both directions; the second catches lost code. Neither sees a
  line comment that survives intact, because it is read as a comment again - that limit is stated
  where the scanner is defined. The suite also counts its own executed cases and refuses to pass if
  a group was skipped, and CI asserts the same from the outside.
  What is still not handled is pinned as behaviour, with its direction: leaving a comment in place
  is the strict side for a scan that forbids a token and the *lax* side for one that requires it, so
  neither is described as safe. A regular expression in a position the heuristic declines to treat
  as one, a verbatim copy written as a string literal, and the single-source sweep's dependence on
  the identifier it looks for are each measured and disclosed.

- **The two gates that metatest applies to the classifier's gap classes no longer depend on how
  those classes are spelled, and a rule spelled in a way the extractor does not understand can no
  longer land at all.** Both gates - the coupling assertion (the characters a rule's quantified
  class excludes must be a subset of the separators the seed derivation cuts on) and the structural
  gate (a hand-written separator class requires the canonical segment-scoped expression and a
  segment-only sample) - read only classes written with a quantifier directly after them. A class
  wrapped in a group or a capture, one written as an alternation, and an unquantified class were
  extracted as nothing at all, so a rule spelled that way passed both gates silently; combined with
  one of the open seed blind spots, such a rule also measured as linear while being quadratic
  (measured last round: a group-wrapped quadratic gap with a carriage-return-prefixed sample passed
  the coupling, the gate, and every ratio check).
  The extractor is not made cleverer - that would be a denylist chasing spellings. Instead the test
  now requires, for every scanned expression, that the *positions* of the unescaped `[` in its
  source match the positions where the extractor started its matches. Counting alone was not
  enough: a review found that appending a semantically inert `(?:\[\s\S]*)?` - whose `[` is
  escaped, so it is not counted as a class opener, while the extractor still reads a class out of
  the same text - balanced the totals and walked a group-wrapped quadratic rule straight through.
  Comparing positions rejects that. Eight spellings are measured as refused: the four above, the
  carriage-return-widened variant of the group-wrapped one (the widening was measured on that
  spelling only), and three phantom-balanced forms. (Seven was correct until the third phantom form
  was added to discriminate the length half of the verdict's conjunction; the figure tracks the
  number of fixture rows expecting refusal, and a later sweep will derive it rather than restate
  it.) The seventeen expressions that ship today match
  position-for-position and an escaped `\[abc\]` matches as two empty sets, so nothing that ships
  today turns red. That is a list of what was measured, not a claim that no spelling escapes it.
  What none of the three gates reach is a rule that expresses the gap's accepted set in syntax
  other than a character class. Three such spellings have been measured, and they are examples
  rather than an enumeration - an earlier revision of this entry did enumerate "two shapes" and a
  later review falsified it with a third. A quantified shorthand such as `\S*` or `\s+`, or `.`
  under the `s` flag, carries no class at all. A negative-lookahead gap,
  `(?:(?!\|)(?!;)(?!&)(?!\n)[\s\S]{1}){0,512}`, does carry a quantified class, so the census
  matches position-for-position, and `[\s\S]` excludes nothing, so the coupling and the structural
  gate have nothing to object to. A class-free alternation gap, `(?:\w|\s|…){0,512}`, does the
  same without either. All three behave like the shipped `[^|;&\n]{0,512}` - the last was checked
  against it on seven vectors - and all three pass every gate. Uniting the gate's two axes does not
  help; what the union uniquely buys is a rule whose coupling check was bypassed by an exemption.
  Separately, the scan lines themselves are unobserved. Single-sourcing the two verdicts protects
  what each verdict *says*, not that the loop still consults it: substituting an empty verdict,
  making the scan vacuously true, or returning early from the top of the structural gate's loop all
  pass silently, on this branch and on main alike. Fixing that means changing what the metatest
  scans for a fourth time in one branch, so it is tracked as follow-up work rather than done here.
  All of this is disclosed in the test, in the classifier, and here.
  The structural gate additionally decides what counts as a separator class from what the class
  actually accepts - a class accepting both an alphanumeric character and a non-alphanumeric one
  that is not a separator spans arbitrary text - **in addition to**, not instead of, the older test
  on the spelling `[^`. Replacing rather than adding was itself a defect the review caught: a
  negated class that accepts no alphanumeric at all, such as `[^a-zA-Z0-9|]`, does not span by the
  new test and was silently dropped from the gate. The union is monotone; a broad gap written as a
  positive class is now gated where before it was not, the alphanumeric-free negated classes stay
  gated, and the flag-matching `[a-z]` in the `git clean` rule still is not.
  Three duplications behind those gates are collapsed into one source each: the class probe (built
  in three places, with three variants of deriving the excluded set and a pin on only one of them),
  the exemption predicate (the scan wrote it inline while the value pins tested a local copy, so
  inserting a one-sided-keyed predicate next to the pinned line passed everything), and the flags a
  probe inherits from its expression (`i`, `u`, `v` are propagated, `g` and `y` deliberately are
  not - they make `test` stateful). The finite character set the coupling compares against no
  longer hand-lists five non-ASCII separators; it derives them by scanning the BMP for `\p{Zs}`,
  `\p{Zl}` and `\p{Zp}`, which adds the fourteen it was missing. A gap class excluding only a
  character that is neither a Unicode separator nor in that set still evades the coupling, and the
  set stays add-only.
  Two counting gaps close alongside. The case count the metatest pins is the number of tests it
  registered, not the number it ran, so turning `it(` into `it.skip(` at one site or returning
  early from the callback left all 110 unmeasured and green; the controls got an executed-case
  counter last round and the main loop now gets one too, checked in `afterAll` against the same 110. And the declaration census that catches a shadowed helper looked only for `const`, `let` and
  `var` in a hand-written list of 27 names, so a `function`-form shadow walked through it; the
  census now extracts the describe's top-level declarations structurally (57 today), covers
  `class`, plain `function`, `async function` and generator `function*`, and asserts that the
  hand-written 27 are contained in what it extracted rather than replacing them. Four shadowing
  shapes still escape every axis and are disclosed rather than claimed closed: destructuring, a
  shadow introduced by a parameter name, the second and later bindings of a single
  `const a = 1, b = 2;`, and an IIFE's formal parameters.
  Finally, the executable control that proves the metatest can still detect a quadratic rule gains
  a second positive fixture whose gap is bounded at 10000 rather than unbounded. The existing
  positive separates at a median ratio above 55, so relaxing the threshold from 24 to 39 was
  measured as undetected; the new fixture sits at a median of 28.6 to 31.0 unloaded across two
  independent measurers (single ratio points reach as low as 18.0, which the median absorbs), which puts the
  detection floor an order of magnitude closer to the threshold and makes both a 24-to-39 relaxation
  and a reduction of the input scale from 8 to 6 fail. It is added, not substituted. Under a
  2x-nproc load the new fixture's median ranges between 28.3 and 87.2, so the 24-to-39 detection
  is bounded to the unloaded regime. The negative control has two margins, one per threshold, and
  they must not be mixed: under load its median reaches 15.99 against a limit of 24, and its worst
  single ratio reaches 22.94 against a limit of 40 - 1.50x and 1.74x respectively. An earlier
  revision reported "median up to 22.8, a margin of 1.05x", which had put a worst-case observation
  in the median's column. Both figures are observed ceilings, not guarantees.
  On eight loaded runs and five unloaded ones neither positive
  nor the negative control produced a false red.

- **The metatest that keeps the approval classifier's literal rules linear now derives a fourth
  adversarial seed.** Those rules are scanned on every command the approval gate classifies, and a
  `program … keyword` rule with an unbounded gap between the two words is quadratic in the input
  length; the metatest catches that by measuring how each rule's runtime scales on seeds it derives
  from the rule's own source and its sample command. The third seed — the longest prefix of the
  sample that no longer matches the rule — quietly lost its teeth whenever the sample carried a
  shell separator (`|`, `;`, `&`, or a newline) _before_ the rule's leading word: repeating such a
  prefix re-inserts the separator, the rule's gap class refuses to cross it, and a genuinely
  quadratic rule measured as linear. The metatest now additionally takes the sample's tail after
  its last separator and derives the same prefix from that, which repeats cleanly. One quadratic
  rule was injected with a sample in each separator form — `&&`, `;`, `|`, a leading newline, two
  separators, no surrounding space, and `2>&1` — and every form survived the first three seeds and
  fails on the fourth, at scaling ratios of 61 to 68 against a threshold of 24. No rule that ships
  today has such a sample, so the measured case count is unchanged and no classifier behaviour
  changed: this is a hole in the test, and it is closed for samples whose tail after the last
  separator still matches the rule — a partial closure, not a complete one.
  What the fourth seed uniquely buys is narrower than it looks: when a rule spells its leading word
  flatly, the first seed already fails such a rule, so the fourth seed is the only detector at the
  intersection of a leading literal fragmented in the rule's source, a separator before it in the
  sample, and no separator after the match completes. Three structural blind spots are disclosed in
  the test and in the classifier's documentation — and that list is what review and re-measurement
  have found so far, not a claim that nothing else remains. A rule whose trailing literal is
  reconstructed by repeating its own leading literal. A sample carrying a separator both before the
  leading word and after the match completes: the tail then no longer matches the rule, the fourth
  seed is null, and, because the third seed is already broken up, such a sample evades all four
  seeds. And a rule whose gap class excludes more characters than the test's own copy of that
  class — a quadratic rule spelled with a carriage return in its gap class, given a sample with a
  carriage return before its leading word, still measures as linear. No rule that ships today has a
  sample or a spelling of any of the three shapes. Widening the fourth seed to every suffix, and
  coupling the test's copy of the gap class to the classifier's, were tracked as follow-up work and
  are closed by the entry below.

- **That metatest now derives a fifth seed, judges the scaling ratio from three measurements instead
  of one, and is coupled to the classifier's own gap classes.** Three holes closed together, because
  closing any one alone would have left the other two able to hide a quadratic rule.
  _The fifth seed_ takes every suffix that follows a shell separator in the sample, not only the one
  after the last separator, and derives the same non-matching prefix from each. The fourth seed went
  null whenever the sample carried a separator both before the rule's leading word and after the
  match completed - the tail then no longer matched the rule - and the third seed was already broken
  up by the leading separator, so such a sample evaded all four. A quadratic rule was injected with a
  sample in each of five such shapes (a leading `&&` with a trailing pipe, a leading `&&` with a
  trailing `;`, a leading pipe with a trailing pipe, two quoted `;` inside a wrapper, and newlines on
  both sides); every one survived the four seeds at ratios of 7.9 to 8.5 and fails on the fifth at
  median ratios of 62.7 to 64.1. The fifth seed is a superset of the fourth, which is kept rather
  than replaced. No rule that ships today has such a sample, so the measured case count is unchanged
  at 110; the teeth are a per-rule synthetic command that wraps each sample in both a leading and a
  trailing separator, non-vacuous for all 17 scanned expressions, where the fourth seed is null by
  construction.
  _The ratio verdict_ is now two-sided. A single measurement let a genuinely quadratic rule pass once
  in twelve runs inside the test harness, and let a linear rule fail above the threshold on a loaded
  machine. The test now measures the ratio three times and requires the median below 24 and the
  maximum below 40: a single low outlier can no longer make a quadratic rule green, and a single high
  outlier can no longer make a linear rule red. The per-test timeout moves from 30s to 120s because a
  quadratic rule now takes three measurements to diagnose.
  _The coupling_ replaces the test's hand-written copy of the classifier's gap class with an
  assertion about the classifier itself: for every scanned expression, the characters its quantified
  character classes exclude must be a subset of the separators the seed derivation cuts on. A rule
  spelled with a carriage return in its gap class, one spelled with redirection characters, and one
  using a positive class all fail that assertion, where before they measured as linear and shipped
  silently. One exemption is recorded, keyed to both the expression and the class it exempts, for the
  flag-matching `[a-z]` in the `git clean` rule, which is not a gap between two words; a case
  matching only one half of that pair - the same expression with a different class, or the same
  class on a different expression - is not exempted. The test pins that meaning on a local copy of
  the predicate, and holds the scanning line itself with the verbatim tripwire. Alongside it,
  a structural gate refuses a rule whose whole-command expression spells a separator class by hand
  with the quantifier written immediately after the class, unless it also carries the canonical
  segment-scoped expression and a sample that only the segment scope matches - the discipline that a
  hand-written separator class is a second parser, previously only written down in the rules, is now
  enforced by a failing test for that spelling.
  What remains open is stated in the test and in the classifier's documentation, and it is what this
  round's search found, not a claim of completeness. A rule whose trailing literal is reconstructed
  by repeating its own leading literal still evades every seed. The coupling compares against a
  finite set of characters (ASCII plus five control characters and five non-ASCII separators), so a
  gap class that excludes only some character outside that set would pass the coupling and evade the
  cut - measured with a non-breaking space, which is why the set now contains one and is documented
  as add-only. And both the coupling and the structural gate read only classes written with a
  quantifier directly after them: a class wrapped in a group or a capture, one written as an
  alternation, a quantified shorthand such as `\S*`, and an unquantified class are not extracted at
  all - measured - so neither gate applies to a rule spelled that way. The seeds still measure every
  scanned expression regardless of its spelling, so what those spellings escape on their own is the
  two gates, not the measurement - but a rule that combines such a spelling with one of the open
  seed blind spots above escapes the measurement too (measured: a group-wrapped quadratic gap with a
  carriage-return-prefixed sample passed the coupling, the gate, and every ratio check).

### Fixed

- **Taking over a stale lock no longer deletes a live one.** The advisory file lock that
  serializes the approval allowlist, the approval policy, and attach settings across processes
  decided a lock was stale (unreadable, its own leftover, or held by a dead pid) and then removed
  it with a separate `unlink`. Between those two steps the previous holder could release and a
  third process could take the lock — and the `unlink` then deleted _that_ live lock, letting two
  processes run the read-modify-write at once and lose one of the writes. A missing lock file was
  read as "corrupt" and hit the same path. Takeover is now identity-checked: the lock is detached
  atomically with `rename`, discarded only when the detached file still holds the exact bytes the
  staleness check read, and otherwise linked back with the acquirer backing off (a restore that
  cannot be completed aborts loudly rather than continuing with two holders). A lock that is simply
  missing is treated as "just released" and retried without deleting anything. A lock whose content
  cannot be read at all is no longer taken over, because its identity cannot be re-verified against
  what the staleness check saw; previously such a lock was taken over blindly, and a lock path that
  was a directory spun in a silent busy-loop that never timed out. (Releasing your _own_ lock no
  longer needs to read it — see the identity entry below.)
  A pathological free-to-held flap now aborts loudly after 1000 immediate retries rather than
  spinning in silence. The `<lockPath>.stale-<pid>-<seq>` file a takeover detaches into is removed
  on every normal path, but a crash between the detach and that cleanup can leave one behind; there
  is no reaper, and such a file is never read as a lock.
  `INV-FILELOCK-STALE-TAKEOVER-IDENTITY` reproduces both races with three real processes.
- **A lock is now identified by the file it is, not by the pid written in it.** The identity
  re-check above compared the detached file's bytes with the bytes the staleness check read. A lock
  only ever contains `${pid}\n`, so that comparison was really pid-granular: a holder that released
  and immediately re-acquired produced a byte-identical but _different_ file, and the acquirer
  discarded that live lock and entered the critical section alongside it. The acquirer now records
  the `(dev, ino)` of the inode it links into place and requires **both** that pair and the exact
  bytes to match before discarding anything (the byte check is kept, not replaced), so a same-bytes
  different-inode swap is restored and backed off instead of destroyed.
  What this narrows rather than eliminates: the pair is still a number the operating system may
  recycle. **On the takeover side**, where the acquirer always has both the pair and the bytes,
  reaching the ambiguous case now needs the same pid _and_ a recycled inode number, where before
  the same pid alone sufficed. That conjunction does not describe the release side, which has the
  bytes only while the lock is readable — see the release entries below.
  `INV-FILELOCK-IDENTITY-V2` reproduces the race with real processes, and had to allocate decoy
  files to stop ext4 handing the freed inode number straight back — measured, not assumed.
- **Releasing a lock is now atomic the same way taking one over is.** Release read the lock,
  decided it was ours, then unlinked it; a third party could swap the lock in between, and the
  unlink then removed theirs. Release now detaches with `rename`, re-checks `(dev, ino)`, and only
  then unlinks — and if what it detached turns out to be someone else's, it links it back and, when
  even that fails, aborts loudly rather than silently leaving the serialization broken. That abort
  is the only loud path on the release side, and it is narrow: it needs a detach, a mismatch, a
  failed restore _and_ a guarded function that returned normally. If the function threw, its error
  is the one that propagates. Every other release outcome is **silent** — an identity mismatch, a
  readable lock naming somebody else, a read failure outside the permission class, a failed `stat`
  or a lost `rename` all just return, with no throw, counter or log line. What the next acquirer
  does with the leftover then splits three ways. If its content is readable and names a dead pid,
  or is corrupt, or names the acquirer itself, it is a stale remnant: taken over, and the lock
  recovers by itself. If the content is readable but names **a live pid other than the acquirer's**
  it is not stale at all, so it is not taken over — the acquirer backs off and then throws once
  `maxRetries` is spent (measured), and the lock stays put until that holder exits. If it stays
  unreadable for a reason outside the permission class, acquisition **rethrows immediately** rather
  than take over a lock it cannot re-verify, so the file wedges the lock until an operator removes
  it — a lock large enough that decoding it overflows the maximum string length
  (`ERR_STRING_TOO_LONG`, measured) lands there and stays. Only the first of the three recovers on
  its own; the last is carried over rather than introduced here, since the pre-identity code
  rethrew the same failures on acquisition.
- **A lock that becomes unreadable while you hold it no longer wedges the approval allowlist.**
  Because release now identifies its own lock by `(dev, ino)` — which `stat` reports without read
  permission — a lock whose mode or ownership changes out from under a running daemon is still
  released. Previously release went through the same read as takeover, so an `EACCES` lock stayed on
  disk: the approval allowlist's add, revoke and clear, the approval-policy persist and the
  attach-settings merge/detach all failed until an operator deleted the file by hand, and an
  auto-allow already on disk kept allowing without a UI approval until its TTL (7 days by default)
  ran out. Acquisition is unchanged and still refuses to take over a lock it cannot read — that one
  might belong to somebody else. A lock file that is unreadable _and_ not the inode this process
  linked into place is still left alone, and one that cannot even be `stat`ed still needs the
  operator.
  Release still reads whenever it can, and it is the errno that decides what "unreadable" means.
  Only a failure that can actually **describe a lock this process can no longer read** — `EACCES`
  or `EPERM` — lets the `(dev, ino)` match settle ownership by itself. Everything else declines.
  That includes the transient failures (`EMFILE`, `ENFILE`, `EIO`, …), which say nothing about who
  owns the file, and `EISDIR`, which cannot describe our own lock at all: a lock is a regular file
  put in place with `link`, so a directory on the lock path with a matching identity can only be a
  third party's directory sitting on a recycled inode number — trusting it would let release
  quietly carry that directory off to a detached name; without that split, running out of file descriptors would have been enough to delete a
  third party's live lock sitting on the same recycled inode number, which
  `INV-FILELOCK-IDENTITY-V2` now reproduces with a real process under a lowered `ulimit -n`.
  The residual that stays: a lock that is unreadable **for a permission reason** _and_ happens to
  occupy the inode number this process linked is deleted on release even if it belongs to a live
  third party. Producing that needs an out-of-band mode or ownership change plus inode-number
  reuse, both inside the trust boundary.
- **A takeover that cannot restore what it detached now keeps that file instead of deleting it.**
  When a third process grabs the lock path in the window between the `rename` that detaches a lock
  and the `link` that would put it back, the restore fails and the acquirer aborts without entering
  the critical section — but the cleanup that followed then deleted the detached file, destroying
  the lock of a holder that was still running. The detached inode is now kept under its
  `.stale-<pid>-<seq>` name and the error message names the path. The exposure this does not remove:
  the evicted holder and the third party can still overlap, which is why the abort is loud.
- **Three hardenings in this work are defensive rather than pinned.** Reverting any of them leaves
  the suite green, because making them observable would have meant adding further injection points:
  reading the holder's identity from the **open descriptor** rather than by path (closing a swap
  between the `open` and the `stat`); the **`dev`** half of the identity pair, which only matters
  once a lock path can move between filesystems; and taking the held identity from the **temp file**
  rather than from the lock path after the link (closing a swap between the `link` and the `stat`).
  A fourth is unreachable rather than merely unobserved: the release-side errno gate refuses to
  trust a read failure that carries no `errno`, and every failure that path can raise carries one.
  They are recorded here so nobody mistakes them for behaviour a test is holding in place.
- **The daily public-metrics snapshot lands on a dedicated `metrics` branch instead of `main`.**
  The `main` ruleset requires a pull request and the `verify` check, so every scheduled run from
  2026-08-26 to 2026-08-28 was rejected with GH013 and no snapshot was recorded. The workflow now
  runs the collector from the `main` checkout and commits the JSON into `metrics/public/` on the
  `metrics` branch (created from an empty tree on first use, so it carries only snapshots); the
  three missed days were backfilled through the `date` input. `docs/usage-metrics.md` and
  `metrics/public/README.md` point at the branch, and the collector test pins the branch and the
  push shape so the workflow cannot silently drift back to `main`.
- **`DROP DATABASE` now draws an approval card under ordinary approval.** The risk classifier
  rated `psql -c 'DROP DATABASE …'` as `low` while attaching the `db-drop` category, so the
  category-driven bypass/YOLO gate held it but ordinary approval — which keys off the risk verdict
  alone — never carded it, even though `DROP TABLE` and `TRUNCATE` were carded. The literal now
  rates `high`, and the PostgreSQL CLI form `dropdb` is a new `high` / `db-drop` literal.
  `INV-DB-DROP-RISK-VERDICT` pins the verdict and the bridge-level card. The published classifier
  benchmark was regenerated (danger recall 98.2% → 100.0%). The cost is a keyword false positive
  of the same kind already accepted for `DROP TABLE` — `grep -rn 'DROP DATABASE' migrations/` now
  draws a card — and, for the new bare-token `dropdb` literal, a wider one: any command line that
  merely mentions the word (`man dropdb`, `which dropdb`, a commit message naming a `dropdb`
  wrapper) now draws a card too. Both are safe-direction over-gates; the benchmark corpus carries
  a benign `man dropdb` vector so that this cost is measured rather than assumed.
- **The `db-drop` category now recognises other engines and granularities.** The literal list was
  PostgreSQL-centric: `mysqladmin … drop`, the Mongo shell `db.dropDatabase()` from the command
  line, `DROP SCHEMA`, `DROP OWNED BY`, and redis `FLUSHALL` / `FLUSHDB` all rated `low` with no
  category, so they drew no approval card in either mode. They are now `high` / `db-drop` literals
  (added, none removed), and the snake_case `drop_database(` of pymongo / sqlalchemy-utils joins the
  same literal for symmetry (its usual `python -c` carrier was already carded as `inline-code`; it
  now also names the category). `INV-DB-DROP-RISK-VERDICT`
  pins each form at the classifier and at the bridge, and the published classifier benchmark was
  regenerated (89 vectors; `db-drop` precision 66.7% → 75.0%; default-gated precision 94.2% →
  93.1%, recall stays 100%). The cost is the same keyword class as `dropdb`: a command line that
  merely mentions `flushall` / `flushdb` (`grep -rn flushall src/`) now draws a card, and the
  corpus carries that vector so the cost is measured. Mongo's `db.collection.drop()` is
  deliberately not a literal (`.drop(` collides with pandas and friends); it remains disclosed in
  `docs/approval-policy.md`.

### Changed

- **`mysqladmin … drop` is now recognised when the password is quoted, and the rule no longer
  carries its own idea of where a command ends.** The literal expressed "no separator between the
  program name and the `drop` subcommand" with a hand-written character class rather than the
  quote-aware splitter the rest of the classifier shares. That class cannot see quoting, and MySQL
  _requires_ quoting a password that contains shell metacharacters — so `-p'a;b'`,
  `--password='x;y'`, `-p"p&q"`, a backslash line continuation, and forms whose redirect operator
  contains `&` (`-f &> out.log drop appdb`, `2>&1 > out.log drop appdb`) were read as if the
  subcommand lay past a separator, and a real database drop rated `low` with no category in every
  mode. The rule now also scans the canonical segments, where a quoted or escaped metacharacter is
  not a separator. Real separators still end the run, so `mysqladmin status | grep drop`,
  `; echo drop`, `&& echo drop` and a newline stay `low` as before. The original whole-command scan
  is kept next to the new one as a non-weakening backstop, because the splitter removes redirect
  operators together with their target word and a segment-only rule would have let
  `mysqladmin status > drop.log` fall from `high` to `low`; that form still rates `high`, exactly as
  before. When the splitter cannot parse the command at all — an unterminated quote or heredoc — it
  falls back to the coarse split plus the whole command, so a quoted separator inside an unterminated
  quote still ends up gated (fail-closed), the same direction the classifier takes elsewhere on
  unparseable input. What the tests pin: no verdict in the benchmark corpus changed, the previously
  documented limitations are now `high` / `db-drop`, and none of the vectors in those pinned lists
  narrows. (An audit sweep outside
  the suite, recorded in decision 01a04955, moved 105 of 219 generated separator / quoting / escape /
  redirect vectors and narrowed none.) The published benchmark was regenerated (91 vectors;
  `db-drop` precision 75.0% → 78.6%; default-gated precision 93.1% → 93.3%, recall stays 100%), and
  the corpus gained the quoted-password form and a long-option invocation whose gap is 319
  characters — the widest the public corpus exercises, so the 512 bound's own boundary stays pinned
  by unit tests rather than by the benchmark. `INV-DB-DROP-BOUND-DOC` derives that number from the
  pattern itself and pins it against the prose, so the documented bound cannot drift from the code.
- **You now have five minutes to answer an approval card, up from thirty seconds.** Thirty
  seconds was rarely enough to read a command and decide, and an unanswered card falls to the
  safe deny — so the old window mostly produced denials that nobody had actually judged. The
  wait is now 300 seconds. Timing out still denies, so the change costs availability (an agent
  can sit blocked for five minutes when nobody is watching), never safety.
  The window cannot simply be lengthened on its own. The gate works by holding the agent's hook
  response open, and Claude Code's contract is explicit that a hook which reaches its own
  timeout **does not block the tool call** — it falls through to the normal permission flow. So
  if the hook timeout ever expired first, the approval would turn into a silent pass rather than
  a deny. Those two numbers previously lived as unrelated literals in separate files (a 30 and a
  35, plus a second copy of the 35 for managed sessions), where editing one alone would have
  inverted the ordering without a single test failing. A bridge constructed with an explicit
  `timeoutMs` (a programmatic option; no CLI flag or environment variable sets it) can only
  _shorten_ the wait — the effective value is capped at the canonical default, because the
  hook timeout is derived from that default and written into settings before the bridge
  exists. The approval wait is now the canonical
  value in `@actradeck/event-model` and every hook timeout is **derived** from it with a margin,
  bounded so the derived value stays within Claude Code's documented default for HTTP hooks.
  `INV-APPROVAL-TIMEOUT-ORDERING` pins the ordering and the derivation, and reads the four
  enumerated consuming sources to check that each one still calls the canonical derivation and has
  not drifted back to one of the known hand-written literals. That check is scoped to those four
  files rather than to the repository at large; what covers a consumer written some other way is
  the companion `INV-APPROVAL-TIMEOUT-EMIT`, which pins the value actually written into settings.
  Honest scope: this ordering guarantee covers the Claude Code hook path. Managed Codex receives
  approvals as inbound JSON-RPC requests, so how long it waits for a response is not something
  ActraDeck configures, and Codex rollout tailing is observe-only and never blocks.

### Fixed

- **A tampered `algorithm` field no longer verifies.** The audit manifest and review-packet
  manifest declare `algorithm: "sha256-chain"` and render it in the shipped integrity tables,
  but the field was bound by neither the hash chain, the signature header, nor the
  well-formedness gate — a signed, fingerprint-pinned manifest with a rewritten `algorithm`
  still reported `verified`. `verifyAuditManifest` / `verifyPacketManifest` now reject any
  value other than the declared one as `malformed-manifest` / `malformed-packet-manifest`
  (fail-closed). No format bump: every manifest ever exported carries the declared value, so
  existing v3 / v2 documents keep verifying. The binding-completeness invariant now sweeps the
  top-level envelope as a fourth tier, uses the key-union of all events as its template, and
  pins at the type level that no projection field is optional.
- **The reconciler no longer retires pendings it could never have matched.** The restart
  reconciliation synthesizes a `relay_lost` cancel for every persisted pending that is absent
  from the daemon's hello declaration. The declaration side already enforces the canonical
  request-id shape, but the database side compared ids against the declared set only — so an
  id that could never appear in a conforming declaration (one mangled by redaction at rest, or
  a `tu:` command-correlation key) was treated as stale and retired while the approval was
  still live. Pendings whose id is neither canonical nor one of the shipped legacy shapes
  (`<session>:apr-<22 base64url>` from the sidecar bridge in v0.1.0–v0.6.0, the safety demo's
  `<session>:apr-<n>` in v0.4.0–v0.6.0, and the pre-release `<session>:apr-<ms>-<seq>`)
  are now skipped (fail-safe: nothing is destroyed) and counted in a NO-RAW
  `nonRetirableSkipCount`. Legacy-shaped pendings are still retired on the first hello after a
  coordinated upgrade, as documented in 0.7.0.

### Changed

- **The `db-drop` literal list now has one display source.** The list of forms the category
  recognises was copied by hand into the approval-policy docs (table row and note), the
  event-model category docstring and the ja/en cockpit labels, and the copies had already drifted
  (`dropdb` missing from one, only representative forms in another). `DB_DROP_LITERAL_FORMS` in
  `@actradeck/event-model` is now the display source: each sidecar literal rule carries its display
  labels, `INV-DB-DROP-ENUMERATION` pins the rule labels and both docs copies to that list in both
  directions (a missing or extra form fails), and the cockpit label is generated from the list
  instead of being copied. The classifier itself is unchanged.
- **The classifier's linear-scaling metatest now derives a third adversarial seed from each
  pinned sample.** `INV-LITERAL-RULES-LINEAR` measured every high-risk literal with seeds taken
  from the regex text and from the sample's first word, which left a quadratic rule whose leading
  literal is spelled across an alternation, a character class, or a two-word chain unmeasured
  whenever the sample's first word was not that literal. Every rule now also gets the longest
  prefix of its pinned sample that does not match, which follows the engine as deep into the rule
  as the sample does regardless of spelling; the vacuity guard now counts derived seeds only (the
  generic seed had made it a tautology); and the metatest pins its own threshold, input geometry,
  timeout, seed axes and case count so that a single-site edit of any pinned construct (the
  constant declarations, their use sites, the declaration census) fails on its own. The pins now
  also cover the measurement helpers themselves (`minOf`, the warm-up, repeat loop and return of
  `bestOfMs`, `fill`, `isLive`) and the seed loop header, and the case count is taken from the
  number of tests actually registered rather than from the derived set: thinning the seed loop to
  one case per rule had silently dropped 85% of the ratio measurements while the count pin stayed
  green, and now fails. Every pin pattern is additionally checked against a view of the file with
  the pin block cut out, which fails a pattern that has no target outside the pin block.
  Six pins that tolerate a prettier wrap are bounded to a single statement (`[^;]*?`): the earlier
  unbounded form let a pin head reach the tail of a *different* assertion 8,451 and 14,474
  characters away, so making the target line vacuous left the pin green. Each of the six now
  carries the weakening that must kill it, and the metatest builds the mutated source in memory and
  asserts the pattern stops matching; every pin must also match within 400 characters, two orders
  of magnitude below those cross-statement spans and well above the observed maxima (108 pristine;
  after a wrap the worst span depends on how far the probe lengthens the message, and three probes
  measured 144, 167 and 175, so the cap has 2.3x to 2.8x of headroom). The two negative asserts
  that pin the cut point gained positive pairs on the same literal, because renaming the array type
  annotation had silently made both vacuous.
- **The linear metatest now protects itself with executable controls instead of only source-spelling
  pins.** Three fixture rules — a known-quadratic one, a known-linear one that differs only by
  bounding the same gap, and one whose seed matches at the measurement size — run through the same
  seed derivation, vacuity filter, timing helpers, geometry and thresholds as the real rules, and
  assert that the positive control is reported as a violation, the negative one is not, and the
  vacuous seed is excluded from measurement. Because the controls assert behaviour rather than
  spelling, collapsing a timing helper, shrinking the input geometry or capping `fill` makes them
  fail without anyone having written a pin for that particular spelling. Seven such edits were
  measured, each with its pin updated in step so the spelling checks stayed green: collapsing
  `bestOfMs`, pushing a constant duration, constant-folding `minOf`, capping `fill`, shrinking the
  `isLive` probe, shrinking the scale factor from 8 to 2, and raising the ratio threshold from 24
  to 100. Six of them fail on a control on their own. The seventh is only *uniquely* a control's
  catch
  when both ratio bounds are raised together (24 to 100 and 40 to 200); raising the lower bound
  alone is already caught by the pre-existing assertion that the upper bound exceeds the lower one,
  and a modest raise (24 to 39) is caught by nothing.
  That is the shape of the covered band, and it is bounded by measurement rather than claimed in
  general: a control fires when the edit pushes the known-quadratic fixture's measured ratio below
  the threshold. That fixture's median is 55.1-55.9 unloaded and 63.5-187.3 under 2x nproc load, so
  edits that keep the threshold below it — the 24-to-39 raise, and a scale factor of 6 instead of
  8 — were measured as surviving. The same coordinated method confirmed what else survives: the six
  statements inside the main test's callback are not shared with the controls, and relaxing only the
  upper ratio bound, the repeat count or the inner loop count leaves the controls green — those stay
  on the verbatim pins, as does making the vacuity guard tautological. Thinning the seed loop is
  caught, but by the structural floor on the case count rather than by a control. The measured case
  count stays 110; control cases are counted separately. With the controls in place the pin corpus
  is frozen: existing pins stay (removal remains forbidden), and a new tooth is added as a
  behavioural assertion or a CI gate first, with a new verbatim pin only when neither can cover it.
  Still not covered: the pin block itself (including the teeth and span checks added here), an edit
  that rewrites the pins together with the constants or the pinned code lines, a scan marker
  rewritten together with the title it points at, the negative control's calibration factor (not
  pinned; reverting it to 1 was measured as surviving and only degrades measurement quality under
  load), and the census right boundary, which is anchored
  to a neighbouring describe title and reports a false failure if an unrelated describe is inserted
  in between. The pins exist to make such an edit deliberate, not to prove the metatest cannot be
  weakened. Test-only: the classifier and the approval gate are unchanged.
- **The linear metatest's controls are now calibrated for a saturated machine and asserted to have
  actually run.** The negative control's small-input measurement took 0.33ms, small enough that
  scheduler jitter dominated the ratio when the whole suite runs against 2x nproc of external load,
  so its inner loop now repeats eight times. The geometry and thresholds are untouched and both
  sides of the ratio grow by the same factor, so the expected ratio is unchanged. The calibration
  sweep measured a byte-identical copy of the control's measurement placed elsewhere in the suite,
  not the control itself: over 24 samples per factor in that regime the uncalibrated copy reported a
  false violation 8 times and the calibrated one 0 times, and the worst median fell from 29.4 to
  13.6 against a threshold of 24. The real control at its own position reported none in eight
  saturated runs even uncalibrated, so the calibration is justified by escaping the jitter-dominated
  band rather than by a failure observed in place; eight saturated full-suite runs produced no false
  failure from the calibrated control. Separately,
  the count of control cases was taken at registration time, so replacing `it(` with `it.skip(` at
  one site, or an early return at the top of the callback, silently ran nothing while the suite
  stayed green; the callback now records that it reached its end and an `afterAll` requires both
  control cases to have done so, and `scripts/ci/assert-inv-ran.mjs` gained a `sidecar-linear` suite
  so CI also refuses a skipped or todo linear metatest. Both mutations were measured as red on this
  branch and green on its base; deleting the recording line itself — a line the base does not
  have — was measured as red on this branch alone. The main loop's 110 cases remain a
  registration-time count.

## [0.8.1] - 2026-08-26

### Fixed

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
  only at the first segment, so `bash <(echo rm -rf /srv)` gated while
  `ls; bash <(echo rm -rf /srv)` — the same execution, one harmless command earlier — classified
  as harmless with no card
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
  collector. Text inside single quotes is data: `grep -rn '<(' .` and
  `git commit -m 'use $( ) syntax'` no longer raise cards, and `echo 'a$(rm -rf /srv)b'` is a
  literal string rather than a
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
  backslash escapes and concatenation; the redirect-target reader, the heredoc delimiter reader and
  the tokenizer call it, and the splitter's own loop consumes quote spans and escapes through the
  same quote-span reader rather than a copy. That also closed the quoted-assignment hole
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
  landed alongside it — so the size tripwires now record the measured executable lines, and a
  summed ceiling covers the module set reachable from the classifier through its imports (an
  earlier revision of this entry said a file split "cannot dodge" the ceiling; a file that neither
  imports nor is imported could, so the set is now defined by the import closure).
  The eleventh audit round found three more holes, closed here. A heredoc that never terminates
  (`echo a ; <<EOF rm -rf /path`, or a body whose delimiter never matches) was handed to the
  conservative splitter, which treats `<<` as a separator, so the delimiter word became the
  program name and the real command classified as harmless with no card in any mode — bash reads
  such a heredoc to end of input and runs the command; the splitter now does the same, removing the
  operator and delimiter like any other redirect. A substitution standing where the program name
  goes (an empty backtick substitution or `$()` followed by `rm -rf /path`) lost its named category once words were read
  correctly, because the old tokenizer had turned backticks into spaces by accident; the flattened
  form is now classified in addition, never instead, so the category returns without lowering any
  verdict. And the check classifier that labels commands as tests or lint runs had started sharing
  the reserved-word skipping introduced for compound statements, which credited
  `if false; then pytest; fi` (exit 0, pytest never runs) and `! pytest` (exit inverted) as
  passed checks. It now skips only environment assignments, and a command that contains a
  compound statement — on one line, or across several lines where the newline had put the check
  in a segment of its own — or a shell function definition (bash defines the function, runs
  nothing, and exits 0) is not credited. The function-definition check is structural: bash's
  grammar puts empty parentheses only in a function header, so a leading name followed by empty
  parentheses (whitespace or a backslash-newline inside them included) or the `function`
  keyword is refused, and a leading `time` (with its `-p` / `--` words), subshell or group
  opener is looked through rather than skipped, so `time run() { … }` and `( run() { … } )` are
  refused while `time pytest` and `( pytest )` keep their credit. The vectors for this are not
  listed by hand: the test suite generates spellings along prefix, wrapper, keyword, spacing,
  parenthesis-interior and body axes, runs each through bash itself with a marker file, and
  requires every spelling that bash defines without executing to be refused. That guarantee is
  bounded by the generated axes — spellings outside them are not covered, and an audit round
  that finds one adds it as an axis, and axes are only ever added, never removed (one round dropped
  variants while adding others; the dropped variants were restored and the axis arrays are now pinned
  verbatim). On the same `time` prefix the risk verdict had regressed:
  `time -p rm -rf …` was rated low with no category because the word after `time` was taken as
  the program; every option word after `time` is now skipped through one shared predicate (a
  closed `-p` / `--` set left `time -v rm …` unrated, and `/bin/sh` runs that form through the
  external `time`), and the risk level, categories and egress result of a `time`-prefixed command
  are pinned equal to the bare command's — the persistent-allowlist gate is a separate structural
  check and is not part of that pin. The transparent-prefix strip on the check side also drops the
  empty or whitespace-only word a leading backslash-newline produces, keeps going after a fused
  opener such as `({` leaves nothing behind, and looks through assignment prefixes; each of those
  had hidden a `function` definition from the check. Wrappers that can return a status that is
  not the child's (`script`, which exits 0 without `-e`; `watch`; `setsid`, which forks with `-f`)
  never credit a check under them — in every form, `-e` included — even though the risk verdict
  looks through them. A check followed by a pipe (`pytest | tee log`) or put in the background
  (`pytest &`) is still credited, as before; both are pinned as known gaps. Under-crediting
  is the safe direction for a verification badge. Sequencing after a check (`pytest ; echo done`,
  `npm test || true`) still credits it, as it always has, and is tracked rather than claimed
  closed. The check classifier also gained the command-length guard the risk verdict already had:
  it was the one consumer of the splitter without one, and a 4 MiB hook payload held the daemon
  for three minutes. The risk verdict also learned the command-running wrappers `ionice`, `chroot`,
  `unshare`, `taskset`, `flock`, `watch` and `script` — all unrecognised programs in v0.8.0, so
  `ionice -c3 rm -rf …` was rated low with no category and raised no approval card; the `-c` string
  form of `flock` and `script` is routed through the existing inline-shell path rather than parsed
  again, and each listed wrapper form is checked against bash itself in the test suite. Wrapper
  options are now read from one grammar table and only the options it understands are stripped:
  a long option that takes its value as a separate word (`env --unset FOO`, `nice --adjustment 5`,
  `timeout --signal KILL 5`, `chroot --userspec u:g /srv`) used to leave the value in the program
  position, so `env --unset FOO rm -rf …` was rated low; v0.8.0 happened to rate the same command
  medium only when a `!`, `2>&1` or `(` prefix tripped an accidental "unanalyzable" floor in the
  old tokenizer. Known valued options are skipped with their value, and an unknown separated long
  option now raises that floor deliberately (medium, `high-risk-other`) on top of the guess
  v0.8.0 already made, so the verdict is never below v0.8.0's and never silently low. `--` ends the options but positional arguments (`flock -- FILE cmd`) are
  still read, `--command=CMD`, `watch 'CMD'` and `su -c 'CMD'` go through the inline-shell path,
  and `su` joined the wrapper set. The wrapper table remains an allowlist: a wrapper not in it
  still hides the command it runs, and an unknown short option that takes a separate value is the
  same class of gap in a narrower space. The egress
  predicate gained the same guard, `time` and `builtin` joined the
  persistent-allowlist deny set alongside every other runner wrapper, and the executor-gate
  matrices pin every axis by literal. The benchmark corpus grew from 67 to 80 vectors with one
  shape from each audit round since the sixth, and the published numbers were regenerated from
  it.
- **Audit-manifest verify routes are rate-limited, and the CI gate no longer builds a regex
  from its arguments.** The two `/realtime` audit verify routes recompute a hash chain and an
  Ed25519 signature over caller-supplied input; an authenticated caller is now bounded to 60
  requests per minute on those two routes only (other routes stay unlimited, and unauthenticated
  callers are refused before the limiter counts them). `scripts/ci/assert-inv-ran.mjs` matched
  its raw selector argument by substring instead of compiling it. Neither was reachable without
  the bearer token; both open CodeQL alerts are closed rather than dismissed.

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

[Unreleased]: https://github.com/actradeck/actradeck/compare/v0.8.1...HEAD
[0.8.1]: https://github.com/actradeck/actradeck/releases/tag/v0.8.1
[0.8.0]: https://github.com/actradeck/actradeck/releases/tag/v0.8.0
[0.7.0]: https://github.com/actradeck/actradeck/releases/tag/v0.7.0
[0.6.0]: https://github.com/actradeck/actradeck/releases/tag/v0.6.0
[0.5.2]: https://github.com/actradeck/actradeck/releases/tag/v0.5.2
[0.5.1]: https://github.com/actradeck/actradeck/releases/tag/v0.5.1
[0.5.0]: https://github.com/actradeck/actradeck/releases/tag/v0.5.0
[0.4.0]: https://github.com/actradeck/actradeck/releases/tag/v0.4.0
[0.3.0]: https://github.com/actradeck/actradeck/releases/tag/v0.3.0
