// Test-only fake Deps. Records IO, serves programmed HTTP/tool responses, and captures the
// side-effecting calls (writeFile / extract / handoff). Excluded from the coverage gate — it
// is test scaffolding, not shipped logic (files: [dist,...] never packs src anyway).
import type { Deps, ExecResult } from "./types.js";
// This test-only fake is EXCLUDED from the tsc build and from the pack (tsconfig `exclude` +
// `files:[dist]`), so it may reach across the package boundary into event-model's SOURCE to serve
// the SAME canonical `checkConformance` the production bundle inlines — keeping unit tests on the
// single source of truth without making event-model a dependency of the published `actradeck`.
import { checkConformance as realCheckConformance } from "../../../event-model/src/conformance.js";

export interface FakeConfig {
  env?: Record<string, string | undefined>;
  platform?: string;
  arch?: string;
  nodeVersion?: string;
  selfVersion?: string;
  home?: string;
  /** tool name -> present + how `exec` responds, or false = not on PATH. */
  tools?: Record<string, { code?: number; stdout?: string; stderr?: string } | false>;
  /** url -> JSON body (or a thrown Error to simulate a network failure). */
  json?: Record<string, unknown | Error>;
  /** url -> raw bytes (or a thrown Error). */
  bytes?: Record<string, Uint8Array | Error>;
  /** absolute path -> true if it should report as non-empty. */
  nonEmptyDirs?: Record<string, boolean>;
  /** exit code handoffQuickstart resolves to. */
  handoffCode?: number;
  /** make extractTarball throw. */
  extractFails?: boolean;
  /** stdin served to readInput() when no file arg (or an Error to simulate a read failure). */
  stdin?: string | Error;
  /** file path -> content served to readInput(path) (or an Error to simulate a read failure). */
  files?: Record<string, string | Error>;
}

export interface FakeState {
  deps: Deps;
  out: string[];
  err: string[];
  execCalls: Array<{ cmd: string; args: string[] }>;
  writes: Array<{ path: string; bytes: Uint8Array }>;
  extracted: Array<{ tar: string; dest: string }>;
  handoffs: string[];
  removed: string[];
}

export function makeFakeDeps(cfg: FakeConfig = {}): FakeState {
  const out: string[] = [];
  const err: string[] = [];
  const execCalls: FakeState["execCalls"] = [];
  const writes: FakeState["writes"] = [];
  const extracted: FakeState["extracted"] = [];
  const handoffs: string[] = [];
  const removed: string[] = [];
  const tools = cfg.tools ?? {};

  const deps: Deps = {
    io: {
      out: (m) => out.push(m),
      err: (m) => err.push(m),
    },
    env: cfg.env ?? {},
    platform: cfg.platform ?? "linux",
    arch: cfg.arch ?? "x64",
    nodeVersion: cfg.nodeVersion ?? "v22.16.0",
    selfVersion: cfg.selfVersion ?? "0.4.0",
    homedir: () => cfg.home ?? "/home/tester",
    async which(cmd) {
      return tools[cmd] !== undefined && tools[cmd] !== false;
    },
    async exec(cmd, args): Promise<ExecResult> {
      execCalls.push({ cmd, args });
      const t = tools[cmd];
      if (t === undefined || t === false) return { code: 127, stdout: "", stderr: "not found" };
      return { code: t.code ?? 0, stdout: t.stdout ?? "", stderr: t.stderr ?? "" };
    },
    async fetchJson(url) {
      const v = (cfg.json ?? {})[url];
      if (v === undefined) throw new Error(`fake: no JSON stub for ${url}`);
      if (v instanceof Error) throw v;
      return v;
    },
    async fetchBytes(url) {
      const v = (cfg.bytes ?? {})[url];
      if (v === undefined) throw new Error(`fake: no bytes stub for ${url}`);
      if (v instanceof Error) throw v;
      return v;
    },
    async readInput(file) {
      if (file !== undefined) {
        const v = (cfg.files ?? {})[file];
        if (v === undefined) throw new Error(`fake: no file stub for ${file}`);
        if (v instanceof Error) throw v;
        return v;
      }
      const s = cfg.stdin;
      if (s instanceof Error) throw s;
      return s ?? "";
    },
    async checkConformance(events) {
      return realCheckConformance(events);
    },
    async mkdtemp() {
      return "/tmp/fake-work";
    },
    async writeFile(path, bytes) {
      writes.push({ path, bytes });
    },
    async dirHasContent(path) {
      return (cfg.nonEmptyDirs ?? {})[path] === true;
    },
    async extractTarball(tar, dest) {
      if (cfg.extractFails) throw new Error("fake: extract failed");
      extracted.push({ tar, dest });
    },
    async rmrf(path) {
      removed.push(path);
    },
    async handoffQuickstart(installDir) {
      handoffs.push(installDir);
      return cfg.handoffCode ?? 0;
    },
  };

  return { deps, out, err, execCalls, writes, extracted, handoffs, removed };
}

/** Build a valid `sha256sum`-format checksums body pairing a digest with an asset name. */
export function checksumsFor(digest: string, name: string, extra = ""): Uint8Array {
  return new TextEncoder().encode(`${digest}  ${name}\n${extra}`);
}
