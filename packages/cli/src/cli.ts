import type { Deps } from "./lib/types.js";
import { cmdDoctor } from "./commands/doctor.js";
import { cmdUp } from "./commands/up.js";
import { cmdVersion } from "./commands/version.js";
import { cmdInstall, type InstallOpts } from "./commands/install.js";

const USAGE = `actradeck — bootstrap CLI for ActraDeck (local-first audit cockpit for coding agents)

Usage:
  actradeck <command> [options]

Commands:
  doctor      Diagnose this machine (platform / Node / pnpm / git / Docker). Offline-safe.
  install     Fetch + VERIFY a signed release (checksum + provenance), then hand off to quickstart.
              --version vX.Y.Z   install a specific release tag (default: latest stable)
              --dry-run, -n      resolve + verify only; stop before extracting / quickstart
              --skip-provenance  checksum-only (explicit opt-out; not recommended)
  up          Print the Docker cockpit bring-up command (prints only — does not run it).
  version     Print this CLI's version and whether a newer stable release is available.

Global:
  -h, --help      show this help
  -v, --version   print the CLI version

Environment:
  ACTRADECK_REPO         owner/name (or git URL) to resolve releases from (default: actradeck/actradeck)
  ACTRADECK_INSTALL_DIR  where 'install' extracts the source (default: ~/actradeck)

The full product ships as a signed GitHub Release + GHCR image; this CLI is a thin,
dependency-free bootstrapper. It never installs anything on 'npm install' — only the
explicit 'actradeck install' fetches and verifies a release.`;

/** Parse the options for `install`. Throws on an unknown flag or a missing --version value. */
export function parseInstallOpts(args: string[]): InstallOpts {
  let version: string | undefined;
  let dryRun = false;
  let skipProvenance = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--dry-run" || a === "-n") {
      dryRun = true;
    } else if (a === "--skip-provenance") {
      skipProvenance = true;
    } else if (a === "--version") {
      version = args[++i];
      if (!version) throw new Error("--version needs a value (e.g. --version v0.4.0).");
    } else if (a.startsWith("--version=")) {
      version = a.slice("--version=".length);
    } else {
      throw new Error(`Unknown install option: ${a}`);
    }
  }
  return { version, dryRun, skipProvenance };
}

/** Route argv to a command. Returns the process exit code. Never throws (errors -> code 1). */
export async function run(deps: Deps, argv: string[]): Promise<number> {
  const cmd = argv[0];
  const rest = argv.slice(1);
  try {
    switch (cmd) {
      case undefined:
      case "help":
      case "-h":
      case "--help":
        deps.io.out(USAGE);
        return 0;
      case "-v":
      case "--version":
        deps.io.out(deps.selfVersion);
        return 0;
      case "doctor":
        return await cmdDoctor(deps);
      case "up":
        return await cmdUp(deps);
      case "version":
        return await cmdVersion(deps);
      case "install":
        return await cmdInstall(deps, parseInstallOpts(rest));
      default:
        deps.io.err(`Unknown command: ${cmd}`);
        deps.io.out(USAGE);
        return 2;
    }
  } catch (e) {
    deps.io.err(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
