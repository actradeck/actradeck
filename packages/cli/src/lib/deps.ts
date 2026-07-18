// The REAL Deps factory — the single place the CLI touches the network, the filesystem, and
// child processes. Excluded from the coverage gate (it is thin IO wiring; the branch logic is
// tested over a fake Deps). Node built-ins only — the package has ZERO runtime dependencies.
import { spawn } from "node:child_process";
import { access, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants as FS, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Deps, ExecResult } from "./types.js";

const UA = "actradeck-cli";

function runCapture(cmd: string, args: string[], opts?: { cwd?: string }): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts?.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", () => resolve({ code: 127, stdout, stderr }));
    child.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

// which — scan PATH ourselves (offline, no shell). Handles Windows PATHEXT.
async function whichCmd(cmd: string): Promise<boolean> {
  const path = process.env["PATH"] ?? "";
  const exts =
    process.platform === "win32" ? (process.env["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        await access(join(dir, cmd + ext), FS.X_OK);
        return true;
      } catch {
        // not here — keep scanning
      }
    }
  }
  return false;
}

async function fetchOk(url: string): Promise<Response> {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "application/vnd.github+json" },
    redirect: "follow",
    // QA-2: bound every request so a black-holed connection can't hang the CLI forever.
    // `version` treats a rejection as offline (prints local version); `install` fails closed.
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${new URL(url).host}`);
  return res;
}

async function readSelfVersion(): Promise<string> {
  try {
    const pkgUrl = new URL("../../package.json", import.meta.url);
    const raw = await readFile(fileURLToPath(pkgUrl), "utf8");
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof v === "string" ? v : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function makeRealDeps(): Promise<Deps> {
  const selfVersion = await readSelfVersion();
  return {
    io: {
      out: (m) => process.stdout.write(m + "\n"),
      err: (m) => process.stderr.write(m + "\n"),
    },
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    selfVersion,
    homedir,
    which: whichCmd,
    exec: runCapture,
    async fetchJson(url) {
      return (await fetchOk(url)).json();
    },
    async fetchBytes(url) {
      return new Uint8Array(await (await fetchOk(url)).arrayBuffer());
    },
    async readInput(file) {
      // fd 0 = stdin. readFileSync accepts a path OR a file descriptor and, with "utf8", returns a
      // string — the async fs/promises readFile does not type a raw fd, and reading the whole input
      // up front (as scripts/check-conformance.mjs does) is the right shape for a one-shot checker.
      return file !== undefined ? readFileSync(file, "utf8") : readFileSync(0, "utf8");
    },
    async checkConformance(events) {
      // Lazy-load the build-time bundle (dist/lib/conformance-core.js — the inlined event-model
      // closure) only when `conformance` actually runs, so doctor/version load no zod.
      const { checkConformance } = await import("./conformance-core.js");
      return checkConformance(events);
    },
    async mkdtemp() {
      return mkdtemp(join(tmpdir(), "actradeck-"));
    },
    async writeFile(path, bytes) {
      await writeFile(path, bytes);
    },
    async dirHasContent(path) {
      try {
        const entries = await readdir(path);
        return entries.length > 0;
      } catch {
        return false; // absent = empty
      }
    },
    async extractTarball(tarPath, destDir) {
      await mkdir(destDir, { recursive: true });
      const r = await runCapture("tar", ["xzf", tarPath, "-C", destDir, "--strip-components=1"]);
      if (r.code !== 0) throw new Error(`tar extraction failed (exit ${r.code}).`);
    },
    async rmrf(path) {
      await rm(path, { recursive: true, force: true });
    },
    handoffQuickstart(installDir) {
      return new Promise<number>((resolve) => {
        const qs = join(installDir, "scripts", "quickstart");
        const child = spawn(qs, [], { cwd: installDir, stdio: "inherit" });
        child.on("error", () => resolve(1));
        child.on("close", (code) => resolve(code ?? 0));
      });
    },
  };
}
