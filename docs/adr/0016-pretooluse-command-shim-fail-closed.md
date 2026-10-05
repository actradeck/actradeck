# ADR 0016 — PreToolUse through a command shim that blocks when the daemon is unreachable

## Status

Accepted (2026-10-05); implementation pending (v0.10). Source decisions `01a108aa` (design) and
`01a108ac` (default behavior chosen by the maintainer). Until it ships, the cases listed in the
attach constraints of [attach-mode.md](../attach-mode.md) still apply.

## Context

The Claude Code approval gate ([ADR 0009](0009-approval-governance.md)) runs on HTTP hooks that
ActraDeck writes into Claude Code settings. Once the daemon has accepted a hook as an approval
request, an error while handling it is answered with a deny (`INV-APPROVAL-FAIL-CLOSED`).

Everything before that point is decided by Claude Code's hook contract (checked against the raw
upstream pages on 2026-10-05): an HTTP hook that cannot connect, gets a non-2xx response, or
times out is a non-blocking error, and the tool call continues. No settings key makes an HTTP
hook failure blocking. So the gate does not hold a tool call when the daemon is stopped,
restarting or crashed, when authentication fails, when the request body exceeds the daemon's
4 MB limit, when the hook times out on the Claude Code side, or when `allowedHttpHookUrls` /
`httpHookAllowedEnvVars` keep the hook from being sent or authenticated.

For command hooks, exit code 2 blocks `PreToolUse`, and JSON output cannot override it. Exit 2 is
not honored for `PermissionRequest`. A command hook's own timeout is also non-blocking.

## Decision

1. **Only `PreToolUse` moves to a command hook.** The hook runs a small shim shipped in the
   sidecar build (`node <dist>/hook-shim.js` in exec form, no shell). That file always runs the
   shim; it does not check how it was started. The shim forwards the hook input to the daemon at
   `http://127.0.0.1:<port>/hook`:
   - a 200 response with a JSON object body is printed unchanged and the shim exits 0, so allow,
     deny and "no opinion" (`{}`) keep their current meaning;
   - anything else (connection failure, any other status including 403 and 204, an empty or
     non-JSON body, the connection dropping while waiting, the shim's own deadline, oversized
     input, no usable token, bad arguments, or stdout that cannot be written) exits 2.

   `hook-shim.js` loads the rest of the shim (`hook-shim-core.js`, next to it) at run time, so a
   library file that is missing or cut short also exits 2 with the same message instead of
   failing to start.

   Claude Code shows a blocking hook's stderr to the model as the reason for the block, so the
   shim's stderr is only the cause (a fixed list of words) and one fixed sentence telling the
   model to ask the user to check the ActraDeck daemon. The block message never contains token
   values, request or response bodies, or arguments, and names no command, settings file,
   endpoint or the `--on-unreachable` switch; how to recover is documented for operators, not
   told to the agent.

   The shim has no risk classifier and no policy; the daemon stays the only place that decides.
2. **`PermissionRequest` and the observation hooks stay HTTP.** Exit 2 cannot block
   `PermissionRequest`, and that hook only fires when Claude Code is about to prompt or auto-deny,
   so a failure there falls back to the native prompt rather than to an unapproved run.
3. **Blocking is the default.** `--on-unreachable allow` restores the current behavior for an
   attach scope; the value is written into the hook arguments, and an unknown value means block.
   Managed sessions always block. Detaching (`daemon stop`) removes the hooks as today.
4. **The token is not passed on the command line.** Literal attach and managed sessions read it
   from a file given by absolute path, which must be a regular file (not a symlink or FIFO) that
   only its owner can read; `env` token-mode reads it from the Claude Code process environment.
   The file holds the token itself, optionally followed by one line break (LF or CRLF); a token
   written as JSON is sent with its quotes, the daemon rejects it, and every `PreToolUse` is
   blocked.
   The command hook is not subject to `allowedHttpHookUrls` or `httpHookAllowedEnvVars`.
5. **Three timeouts in a fixed order, derived from one source.** The approval wait (300 s by
   default) ends before the shim's deadline (315 s), which ends before the Claude Code hook
   timeout (330 s). `INV-APPROVAL-TIMEOUT-ORDERING` is extended to cover all three.
6. **Migration.** The next daemon start replaces the existing `PreToolUse` entry in place; the
   existing self-heal and detach paths recognize ActraDeck entries by their marker, whatever the
   hook type.

## Consequences

- While an attached daemon is down, every `PreToolUse` in the scope it is wired to is blocked
  (for `user` scope, every project). The block message says only that ActraDeck could not decide
  and asks for the daemon to be checked. Running the daemon as a service, cleaning up wiring left
  by a crashed daemon, and a `daemon status` warning ship in the same release to keep that window
  short and visible.
- Each `PreToolUse` costs one extra process start; the measured latency will be documented.
- Still not covered: a mod that handles `tool.check` can approve a blocked call unless the hook is
  in managed settings; `allowManagedHooksOnly` or `disableAllHooks` turn ActraDeck's hooks off
  entirely (the same as detaching); lowering the hook timeout below the shim deadline reopens the
  timeout case; if the shim cannot be started at all (`hook-shim.js` itself missing or unreadable,
  or no Node runtime), Claude Code treats that as a non-blocking error. A missing or broken
  `hook-shim-core.js` blocks instead; the forms tested are the entry copied without the library,
  the entry symlinked on its own and run with `--preserve-symlinks-main`, and a truncated
  library. When the shim blocks because it could not load the library, it does not read the hook
  input first, so Claude Code may see a broken pipe for a large input (not tested against Claude
  Code). A token file on a network file system that stops
  responding can keep the shim from exiting before the hook timeout.

## Alternatives considered

- **Answer authentication failures with 200 + deny instead of 403.** Only helps while the daemon
  is running.
- **A separate URL for approval hooks.** Same limitation.
- **A risk classifier inside the shim, blocking only high-risk calls.** A second definition of the
  gate that would drift from the daemon's.
- **Keep HTTP and add a health-check command hook.** Does not cover a crash while a call is waiting
  for approval.
- **Move `PermissionRequest` to the shim as well.** Exit 2 is not honored there; denying on failure
  would only remove the native prompt.
- **Install the hooks in managed settings.** The only way to stop mod overrides, but it needs an
  administrator and is outside the single-operator setup ([ADR 0012](0012-threat-model-and-local-fs.md)).
