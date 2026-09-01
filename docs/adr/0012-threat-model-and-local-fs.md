# ADR 0012: Threat model — single-operator / local-fs / loopback; advisory locks; 0600 atomic writes

- Status: Accepted
- Source: decision `019ea476` (threat model), `019ee68f` (fs-atomic); `apps/sidecar/src/file-lock.ts`

## Context

The sidecar writes state files, lock files, and per-launch token files locally, and
it runs an approval gate. These guarantees need a stated trust boundary; without one,
"is it secure?" has no answerable scope.

## Decision

The threat model is **single-operator / local-fs / loopback**. Within that boundary:

- **Concurrency.** Cross-process read-modify-write (multiple daemons touching the
  same file during `systemctl` restarts, etc.) is serialized with an **advisory file
  lock** (hardlink `linkSync` exclusive create — content-complete with the holder pid,
  so there is no empty-file window; pid-based stale detection; fail-loud on timeout).
  Both **taking over a stale lock and releasing your own** are **identity-checked**: the lock
  is detached atomically with `rename` and only discarded once the detached file is confirmed
  to be the one that was judged; otherwise it is linked back and the caller backs off. A lock
  that is simply _missing_ (`ENOENT`) is treated as "just released", not as stale, and is
  never unlinked. Without both, the non-atomic read-then-`unlink` could delete a _live_
  lock that a third process created in between, letting two processes hold it at once.

  Identity is the **`(dev, ino)` of the inode the process linked into place**, recorded at
  acquisition. Takeover requires that pair _and_ the exact bytes the staleness check read to
  match before it discards anything (the byte comparison is kept as a second axis, not
  replaced). Release identifies its own lock by the pair, and consults the content only to
  decline: if the lock is readable and names a different live pid, a third party overwrote
  the inode in place and release leaves it alone.

  On acquisition, a lock whose content cannot be read **for any reason** is **not** taken over,
  because it might belong to somebody else and its identity cannot be re-verified against what
  the staleness check saw. Previously that made an unreadable lock permanent: release went
  through the same read, so the file stayed on disk and the approval allowlist's
  add/revoke/clear, the approval-policy persist and the attach-settings merge/detach all
  failed until an operator removed it by hand, while an auto-allow already persisted kept
  allowing without a UI approval until its TTL (7 days by default) expired. Release does not
  need the read: `stat` needs no read permission, so a process still releases a lock that
  became unreadable while it held it.

  Release does still read when it can, and the errno decides what an unreadable lock means to
  it. Only a failure that can actually describe **our own lock, which we can no longer read** —
  `EACCES` or `EPERM` — lets the `(dev, ino)` match settle ownership on its own; that is the
  recovery path. Everything else declines. `EISDIR` is not in the class: a lock is a regular
  file put in place with `link`, so a directory on the lock path cannot be the lock this
  process took. And a transient failure (`EMFILE`, `ENFILE`, `EIO`, …) says nothing about who
  owns the file, so release declines to touch it rather than trusting identity alone; without that distinction, running out of file descriptors
  would be enough to delete a third party's live lock that happens to sit on the same recycled
  inode number. A lock file that is unreadable _and_ not the inode this process linked is left
  alone either way; one that cannot even be `stat`ed still needs the operator.

  Limits of this mechanism, stated honestly:
  1. **`(dev, ino)` is an OS-recycled pair, not a globally unique lock id.** It is
     lock-instance granular in the ordinary case — the previous byte-for-byte check was
     effectively pid granular, because the content is only ever `${pid}\n`, so a holder that
     released and re-acquired produced an indistinguishable lock. **On the takeover side**,
     where both axes are always available, reaching the ambiguous case now requires the same
     pid _and_ a recycled inode number. Both are benign OS behaviours that stay _inside_ the
     trust boundary (only pid _spoofing_ is out of scope below); inode numbers are recycled
     eagerly, which the real-process regression had to work around with decoy allocations to
     make the distinct-inode race reproducible at all.
  2. **The release side does not always have both axes, so that conjunction does not describe
     it.** Release consults the content only to _decline_, and it can only do so while the
     content is readable: a readable lock naming a different live pid is left alone, which is
     the axis that makes a recycled inode number harmless there. When the content cannot be
     read at all, the decision falls back to `(dev, ino)` **alone** — and that fallback is
     restricted to `EACCES` and `EPERM`, the failures that can describe a lock this process
     can no longer read rather than a lock it does not own. Every other read failure declines:
     the transient ones (`EMFILE`, `ENFILE`, `EIO`, …) say nothing about ownership, and
     `EISDIR` cannot describe our own lock at all, since a lock is a regular file put in place
     with `link`. The residual that remains: a lock that is
     **unreadable for a permission reason _and_ happens to sit on the inode number this
     process linked** is deleted on release even if it is a third party's live lock. Producing
     it needs an out-of-band mode/owner change plus inode-number reuse, both inside the trust
     boundary. `INV-FILELOCK-IDENTITY-V2` pins the transient case (fd exhaustion under a
     lowered `ulimit -n`, with a live foreign lock on the reused inode number) as
     "not touched".
  3. **The release side declines silently, and what happens next depends on the errno.** Every
     path where release decides not to act — the identity mismatch, the readable-but-foreign
     content, a read failure outside the permission class, a failed `stat`, a `rename` that
     loses the race — simply returns. There is no throw, no counter and no log line. What the
     _next_ acquirer then does splits in two, and only one half is the benign story:
     - If the content is readable **and** names a dead pid, or is corrupt, or names this
       process, the leftover is a stale remnant: it is taken over and the lock recovers on its
       own.
     - If the content is readable but names **a live pid other than the acquirer's**, it is not
       stale, so acquisition does not take it over. It backs off and then **throws** once
       `maxRetries` is spent (measured). The lock stays until that pid exits, at which point
       the previous case applies. This is the ordinary contended path, not a fault, but it is
       not "recovers on its own" either.
     - If the content stays unreadable for a reason outside the permission class, acquisition
       **rethrows immediately** — it refuses to take over a lock whose identity it cannot
       re-verify — so the file wedges the lock until an operator removes it, exactly as an
       `EACCES` lock did before release learned to identify itself by `(dev, ino)`. A lock file
       large enough that decoding it overflows the maximum string length
       (`ERR_STRING_TOO_LONG`, measured) reaches this state and stays there. This is unchanged
       from before identity v2 — the previous code rethrew the same failures on acquisition —
       so it is a carried-over residual rather than something this work introduced.
     Only the restore-failure path below is loud.
  4. **The restore-failure abort is reachable under third-party contention**, not dead code.
     A concurrent acquirer can take the lock path between the `rename` that detaches it and
     the `linkSync` that would restore it. The process that fails to restore throws and never
     enters the critical section, so it is not itself a double-holder; the residual exposure is
     that the evicted live holder and the third party can overlap. The detached inode is
     **kept** under its `.stale-<pid>-<seq>` name (it is a live holder's lock) and the error
     message names the path; earlier the cleanup deleted it.
  5. **`<lockPath>.stale-<pid>-<seq>` remnants can survive a crash** between the detach and
     the cleanup that follows it, and a failed restore leaves one deliberately. There is no
     reaper. The sequence number is monotonic within a process, so a name is never reused by
     the same process; across processes (a restart, or pid reuse) the same name can recur, in
     which case `rename` silently replaces a leftover regular file (benign self-cleanup) and a
     leftover directory makes the takeover abort loudly. Release detaches into a distinct
     `.stale-rel-<pid>-<seq>` series so it does not consume the takeover sequence.
     No code path ever reads a remnant as a lock.
  6. **The one loud release path is narrow.** Release throws in exactly one situation: it
     detached a file, that file turned out not to be ours, linking it back failed, _and_ the
     guarded function had returned normally. If the guarded function threw, its error is the
     one that propagates and the release failure is swallowed, so a lock problem never masks
     the caller's error. Every other release failure (`stat`, `rename`, `unlink`) stays
     best-effort and silent, per limit 3 above.
  7. **The test seams are gated at runtime, not just by type.** The injection points used by
     the invariant tests live behind a single `testHooks` field and `withFileLock` **throws**
     when it is passed outside a test run (`NODE_ENV=test` / `VITEST`), so a production call
     site cannot silently disable staleness detection or backoff. The production option
     surface is `lockPath` / `maxRetries` / `retryDelayMs`. What the type system contributes is
     narrower than "containment": it keeps the injection surface down to a single entry point
     so the accompanying source scan only has to watch one word. The scan itself covers
     `apps/sidecar/src/**/*.ts` and nothing else.
  8. **Three hardenings here are defensive, not pinned by a falsifying test.** Each was
     verified by reasoning and left without a regression that would go red if it were undone,
     because making them observable would have meant adding further injection points:
     (a) reading the holder's identity from the **open descriptor** (`fstat`) rather than by
     path, which closes a swap between the `open` and the `stat`; (b) the **`dev`** half of the
     identity pair, which only matters when a lock path can move across filesystems; and
     (c) taking the held identity from the **temp file** rather than from the lock path after
     the link, which closes a swap between the `link` and the `stat`. A fourth is unreachable
     rather than merely unobserved: the release-side errno gate treats a read failure carrying
     **no** `errno` as untrustworthy, but every failure `readLockHolder` can raise comes from
     `open`/`fstat`/`read`/`close` and carries one. Reverting any of the four leaves the suite
     green.

- **At-rest secrecy.** Secret/token-bearing state files are written **`0600`** via a
  single shared atomic helper — `writeJson0600` (temp-write → `rename`) — so all
  such writers share one audited implementation instead of drifting copies.
- **Approvals** fail safe on timeout (ask/deny).

Explicitly **out of scope**: pid-spoofing resistance, and isolation between mutually
distrusting local users with the same privileges as the agent.

## Consequences

- Lost-update and partial-write are prevented within the boundary; this is **not** a
  defense against a hostile local user at equal privilege.
- The boundary is documented in [`SECURITY.md`](../../SECURITY.md).
- Every `0600` atomic writer **in the sidecar** must go through `writeJson0600`
  (`apps/sidecar/src/fs-atomic.ts`); re-hand-rolling temp+rename+chmod there is drift
  and is rejected in review.
- Scope revision (2026-08-14 audit, TDA-R3-8): the backend's telemetry consent-state
  writer (`apps/backend/src/telemetry.ts` `writeDirect`) is a recorded exception, not
  drift. The shared helper is synchronous and lives in `apps/sidecar`, which the backend
  does not depend on, so literal reuse is structurally impossible today. The backend
  implementation follows the same procedure (parent `0700` → temp `0600` `wx` → rename)
  and additionally cleans up the temp file on failure. Extracting an async
  `writeJson0600` into a shared package so both sides converge is tracked as a
  follow-up; until then, any **third** hand-rolled 0600 writer is still rejected.
