// Shared types for the ActraDeck bootstrap CLI.
//
// Every side effect the commands need — writing output, running a subprocess, checking a
// binary on PATH, HTTP, reading the filesystem, extracting a tarball, handing off to
// quickstart — enters through this `Deps` object. The commands are otherwise pure, so the
// unit tests inject fakes and never touch the network or the real filesystem (REAL DATA
// discipline still holds: the integration/E2E path exercises the real Deps end to end).

import type { ConformanceReport } from "./conformance-types.js";

export interface IO {
  /** Write an informational line to stdout. */
  out(msg: string): void;
  /** Write a diagnostic/error line to stderr. */
  err(msg: string): void;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Deps {
  io: IO;
  /** process.env (or a fake) — repo/install-dir overrides are read from here. */
  env: Record<string, string | undefined>;
  /** process.platform, e.g. "linux" | "darwin" | "win32". */
  platform: string;
  /** process.arch, e.g. "x64" | "arm64". */
  arch: string;
  /** process.version, e.g. "v22.16.0". */
  nodeVersion: string;
  /** The CLI's own version (read from its package.json by the real Deps). */
  selfVersion: string;
  /** os.homedir(). */
  homedir(): string;

  /** True iff `cmd` resolves on PATH. Offline, no side effects. */
  which(cmd: string): Promise<boolean>;
  /** Run `cmd args`, capturing output. Never throws on a non-zero exit — returns the code. */
  exec(cmd: string, args: string[], opts?: { cwd?: string }): Promise<ExecResult>;
  /**
   * HTTP GET returning the parsed JSON body, or throw on a non-2xx / network error.
   * Injected so tests never hit the network.
   */
  fetchJson(url: string): Promise<unknown>;
  /** HTTP GET returning the raw body bytes, or throw on a non-2xx / network error. */
  fetchBytes(url: string): Promise<Uint8Array>;

  /**
   * Read the whole input as UTF-8: the file at `file`, or STDIN (fd 0) when no file is given.
   * Throws on an IO error (the `conformance` command maps that to exit code 2).
   */
  readInput(file?: string): Promise<string>;
  /**
   * Run the ingestion-contract conformance checker over an ordered event stream and return the
   * structured report. Pure logic (no IO), but injected so the command stays testable AND so the
   * shipped bin loads the checker from the BUILD-TIME bundle (dist/lib/conformance-core.js — the
   * inlined @actradeck/event-model closure) instead of a runtime dependency: `actradeck` stays
   * dependency-zero and event-model stays private (ADR 019f5131 · decision 019f739f). The real
   * Deps lazy-loads the bundle so `doctor`/`version` stay lean; the fake uses the same canonical
   * `checkConformance` from event-model's source, keeping unit tests on the single source of truth.
   */
  checkConformance(events: readonly unknown[]): Promise<ConformanceReport>;

  /** Create a fresh temp directory and return its absolute path. */
  mkdtemp(): Promise<string>;
  /** Write bytes to an absolute path (parent must exist). */
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  /** True iff `path` exists and is a non-empty directory. */
  dirHasContent(path: string): Promise<boolean>;
  /** Extract a `.tar.gz` into `destDir`, stripping the top-level `actradeck-<ver>/` prefix. */
  extractTarball(tarPath: string, destDir: string): Promise<void>;
  /** Recursively remove a path (best effort; used to clean temp dirs). */
  rmrf(path: string): Promise<void>;
  /**
   * Run `scripts/quickstart` inside `installDir` with inherited stdio, resolving to its
   * exit code. This is the final hand-off — the CLI's job ends here.
   */
  handoffQuickstart(installDir: string): Promise<number>;
}
