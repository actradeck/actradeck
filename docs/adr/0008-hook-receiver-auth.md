# ADR 0008: Hook receiver auth — per-launch token + loopback guard

- Status: Accepted
- Source: SEC-3 (`apps/sidecar/test/sec-hook-auth.test.ts`), decision `019ebc37`

## Context

The sidecar runs a local HTTP server to receive Claude Code hook events. It must
not accept events from arbitrary local processes, and must not be reachable via
DNS-rebinding from a browser.

## Decision

- Each agent launch gets a **per-launch random token** injected into the agent's
  settings; the receiver requires it on every hook and compares it in **constant
  time**. Wrong/missing token → `403`, and **no event is emitted**.
- Enforce **loopback / Origin / Host** guards (DNS-rebinding protection).
- For low-risk `PreToolUse` / `PermissionRequest`, the hook returns an **empty
  `{}`**, not `"defer"` — `{}` is Claude Code's compatible "no opinion" response;
  `"defer"` mis-behaves in some subagent paths (`INV-HOOK-SUBAGENT-COMPAT`).

## Consequences

- Only the launched agent can post events to the receiver.
- The token-bearing settings file is written `0600` and is per-launch (worthless
  after the receiver stops — see ADR 0012).
- The `{}` vs `defer` distinction is a correctness contract with Claude Code and is
  pinned by a regression test.
