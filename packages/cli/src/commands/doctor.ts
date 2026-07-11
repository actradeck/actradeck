import type { Deps } from "../lib/types.js";

// `actradeck doctor` — offline-safe machine diagnosis. No network. Reports platform + Node +
// pnpm + git + Docker. Exit code is NON-ZERO when a REQUIRED prerequisite is missing/too old
// (Node >= 20, pnpm — both needed to run ActraDeck natively). git/Docker are recommended-only
// (git for the from-source path, Docker for the container path), so they WARN but never fail.

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  required: boolean;
}

/** Extract the major version from a "vXX.YY.ZZ" string, or null. */
export function nodeMajor(nodeVersion: string): number | null {
  const m = /^v?(\d+)\./.exec(nodeVersion.trim());
  return m ? Number(m[1]) : null;
}

/** Return the first line of `cmd`'s version output, or null if absent / non-zero. Offline. */
async function toolVersion(deps: Deps, cmd: string, args: string[]): Promise<string | null> {
  if (!(await deps.which(cmd))) return null;
  const r = await deps.exec(cmd, args);
  if (r.code !== 0) return null;
  const line = (r.stdout || r.stderr).split("\n")[0]?.trim();
  return line && line.length > 0 ? line : `${cmd} (version unknown)`;
}

export async function cmdDoctor(deps: Deps): Promise<number> {
  const checks: Check[] = [];

  checks.push({
    name: "platform",
    ok: true,
    detail: `${deps.platform}/${deps.arch}`,
    required: false,
  });

  const major = nodeMajor(deps.nodeVersion);
  const nodeOk = major !== null && major >= 20;
  checks.push({
    name: "node",
    ok: nodeOk,
    detail: nodeOk
      ? `${deps.nodeVersion} (CLI needs >=20; ActraDeck itself needs >=22.16)`
      : `${deps.nodeVersion} — need Node >=20 (install e.g. 'nvm install 22')`,
    required: true,
  });

  const pnpm = await toolVersion(deps, "pnpm", ["--version"]);
  checks.push({
    name: "pnpm",
    ok: pnpm !== null,
    detail: pnpm ?? "not found — install with 'npm i -g pnpm' (required to build/run ActraDeck)",
    required: true,
  });

  const git = await toolVersion(deps, "git", ["--version"]);
  checks.push({
    name: "git",
    ok: git !== null,
    detail: git ?? "not found — only needed to install from source (git clone)",
    required: false,
  });

  const docker = await toolVersion(deps, "docker", ["--version"]);
  checks.push({
    name: "docker",
    ok: docker !== null,
    detail: docker ?? "not found — only needed for the Docker cockpit path ('actradeck up')",
    required: false,
  });

  let failed = false;
  for (const c of checks) {
    const mark = c.ok ? "ok  " : c.required ? "FAIL" : "warn";
    deps.io.out(`[${mark}] ${c.name.padEnd(9)} ${c.detail}`);
    if (!c.ok && c.required) failed = true;
  }

  if (failed) {
    deps.io.err(
      "doctor: a required prerequisite is missing — resolve the FAIL line(s) above before installing.",
    );
    return 1;
  }
  deps.io.out("doctor: all required prerequisites present.");
  return 0;
}
