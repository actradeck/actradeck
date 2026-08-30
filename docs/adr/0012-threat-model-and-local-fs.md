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
  Taking over a stale lock is **identity-checked**: the lock is detached atomically with
  `rename` and only discarded when the detached file still holds the exact bytes the
  staleness check read; otherwise it is linked back and the acquirer backs off. A lock
  that is simply *missing* (`ENOENT`) is treated as "just released", not as stale, and is
  never unlinked. Without both, the non-atomic read-then-`unlink` could delete a *live*
  lock that a third process created in between, letting two processes hold it at once.
  A lock whose content cannot be read at all (`EACCES`, `EISDIR`) is **not** taken over,
  because its identity cannot be re-verified. The consequence is that such a lock does not
  recover on its own: until the file is removed, the approval allowlist's add/revoke/clear
  and the approval-policy persist fail (the daemon does not crash; it reports the failure
  count), and an auto-allow that is already persisted stays in force until its TTL — 7 days
  by default — expires. The operator removes the offending `*.actradeck-lock` by hand. This
  is a deliberate trade against the previous behaviour, which took an unreadable lock over
  blindly and, when the lock path was a directory, spun in a silent busy-loop with no timeout.

  Three limits of this mechanism, stated honestly:

  1. **The identity re-check is byte-for-byte, which is pid granularity, not lock-instance
     granularity.** The lock content is only ever `${pid}\n`, so two locks minted by the same
     pid are indistinguishable. Reaching that case requires pid reuse, which is out of scope
     below. Identity by `(dev, ino)` is a candidate refinement for v0.9.
  2. **The restore-failure abort is reachable under third-party contention**, not dead code.
     A concurrent acquirer can take the lock path between the `rename` that detaches it and
     the `linkSync` that would restore it. The process that fails to restore throws and never
     enters the critical section, so it is not itself a double-holder; the residual exposure is
     that the evicted live holder and the third party can overlap. Tracked for v0.9.
  3. **`<lockPath>.stale-<pid>-<seq>` remnants can survive a crash** between the detach and
     the cleanup that follows it. There is no reaper. The sequence number is monotonic within
     a process, so such a name is never reused, and no code path ever reads one as a lock.
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
