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

  On acquisition, a lock whose content cannot be read at all (`EACCES`, `EISDIR`) is **not**
  taken over, because it might belong to somebody else and its identity cannot be re-verified
  against what the staleness check saw. Previously that made an unreadable lock permanent:
  release went through the same read, so the file stayed on disk and the approval allowlist's
  add/revoke/clear, the approval-policy persist and the attach-settings merge/detach all
  failed until an operator removed it by hand, while an auto-allow already persisted kept
  allowing without a UI approval until its TTL (7 days by default) expired. Release no longer
  reads: `stat` needs no read permission, so a process still releases a lock that became
  unreadable while it held it. A lock file that is unreadable _and_ not the inode this process
  linked is still left alone; one that cannot even be `stat`ed still needs the operator.

  Limits of this mechanism, stated honestly:
  1. **`(dev, ino)` is an OS-recycled pair, not a globally unique lock id.** It is
     lock-instance granular in the ordinary case — the previous byte-for-byte check was
     effectively pid granular, because the content is only ever `${pid}\n`, so a holder that
     released and re-acquired produced an indistinguishable lock. Reaching the ambiguous case
     now requires the same pid _and_ a recycled inode number. Both are benign OS behaviours
     that stay _inside_ the trust boundary (only pid _spoofing_ is out of scope below); inode
     numbers are recycled eagerly, which the real-process regression had to work around with
     decoy allocations to make the distinct-inode race reproducible at all.
  2. **The restore-failure abort is reachable under third-party contention**, not dead code.
     A concurrent acquirer can take the lock path between the `rename` that detaches it and
     the `linkSync` that would restore it. The process that fails to restore throws and never
     enters the critical section, so it is not itself a double-holder; the residual exposure is
     that the evicted live holder and the third party can overlap. The detached inode is
     **kept** under its `.stale-<pid>-<seq>` name (it is a live holder's lock) and the error
     message names the path; earlier the cleanup deleted it.
  3. **`<lockPath>.stale-<pid>-<seq>` remnants can survive a crash** between the detach and
     the cleanup that follows it, and a failed restore leaves one deliberately. There is no
     reaper. The sequence number is monotonic within a process, so a name is never reused by
     the same process; across processes (a restart, or pid reuse) the same name can recur, in
     which case `rename` silently replaces a leftover regular file (benign self-cleanup) and a
     leftover directory makes the takeover abort loudly. Release detaches into a distinct
     `.stale-rel-<pid>-<seq>` series so it does not consume the takeover sequence.
     No code path ever reads a remnant as a lock.
  4. **Release aborts loudly only when the guarded function succeeded.** If release detaches a
     lock that turns out not to be ours and cannot link it back, it throws — but when the
     guarded function itself threw, that error is the one that propagates and the release
     failure is swallowed, so a lock problem never masks the caller's error. Every other
     release failure (`stat`, `rename`, `unlink`) stays best-effort.
  5. **The test seams are gated at runtime, not just by type.** The injection points used by
     the invariant tests live behind a single `testHooks` field and `withFileLock` **throws**
     when it is passed outside a test run (`NODE_ENV=test` / `VITEST`), so a production call
     site cannot silently disable staleness detection or backoff. The production option
     surface is `lockPath` / `maxRetries` / `retryDelayMs`.

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
