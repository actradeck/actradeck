import type { Deps } from "../lib/types.js";

/**
 * `actradeck demo` — a zero-side-effect product preview.
 *
 * This intentionally does not pretend to exercise the live classifier or approval bridge: the
 * published npm package is a dependency-free bootstrapper, not the four-tier product. The command
 * gives a first-time visitor the product story in a few seconds, then points to the real pipeline
 * demo in the cockpit. It performs no network, filesystem, subprocess, or install action.
 */
export async function cmdDemo(deps: Deps): Promise<number> {
  deps.io.out(`ActraDeck safety preview

SAFE SIMULATION — no command is executed, no file is changed, and no network call is made.

Claude Code requests:
  rm -rf ./important-directory

[HIGH RISK] recursive filesystem delete detected
[HELD]      waiting for a human decision
[DENIED]    no approval received; safe-side timeout

Agent output contains:
  GITHUB_TOKEN=[REDACTED:github-token]

[RECORDED]  decision + redacted event added to the replayable audit trail

That is ActraDeck's first job: put risky coding-agent actions back in front of you.

Try the real ingestion -> approval -> redaction -> audit pipeline:
  docker run --rm -p 127.0.0.1:55400:55400 -v actradeck_pgdata:/data \\
    ghcr.io/actradeck/actradeck:latest
  then open http://localhost:55400 and click "Run the 30-second safety demo".

Detection is best-effort, not a sandbox. Read the documented limits:
  https://github.com/actradeck/actradeck/blob/main/SECURITY.md`);
  return 0;
}
