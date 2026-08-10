import { describe, it, expect } from "vitest";
import { run, parseInstallOpts } from "./cli.js";
import { makeFakeDeps } from "./lib/fake.js";

describe("parseInstallOpts", () => {
  it("parses flags in any order", () => {
    expect(parseInstallOpts([])).toEqual({
      version: undefined,
      dryRun: false,
      skipProvenance: false,
    });
    expect(parseInstallOpts(["--dry-run", "--version", "v0.4.0", "--skip-provenance"])).toEqual({
      version: "v0.4.0",
      dryRun: true,
      skipProvenance: true,
    });
    expect(parseInstallOpts(["-n", "--version=v1.2.3"])).toEqual({
      version: "v1.2.3",
      dryRun: true,
      skipProvenance: false,
    });
  });
  it("throws on a missing --version value or unknown flag", () => {
    expect(() => parseInstallOpts(["--version"])).toThrow(/needs a value/);
    expect(() => parseInstallOpts(["--bogus"])).toThrow(/Unknown install option/);
  });
});

describe("run — dispatch", () => {
  it("prints usage for no args / help", async () => {
    for (const argv of [[], ["help"], ["-h"], ["--help"]]) {
      const f = makeFakeDeps();
      expect(await run(f.deps, argv)).toBe(0);
      expect(f.out.join("\n")).toMatch(/put risky coding-agent actions/);
    }
  });

  it("prints the CLI version for -v/--version", async () => {
    const f = makeFakeDeps({ selfVersion: "0.4.0" });
    expect(await run(f.deps, ["--version"])).toBe(0);
    expect(f.out).toEqual(["0.4.0"]);
  });

  it("routes to demo, up, and doctor", async () => {
    const f0 = makeFakeDeps();
    expect(await run(f0.deps, ["demo"])).toBe(0);
    expect(f0.out.join("\n")).toContain("SAFE SIMULATION");

    const f1 = makeFakeDeps();
    expect(await run(f1.deps, ["up"])).toBe(0);
    expect(f1.out.join("\n")).toContain("docker run --rm");

    const f2 = makeFakeDeps({ tools: { pnpm: { stdout: "10.0.0" } } });
    expect(await run(f2.deps, ["doctor"])).toBe(0);
  });

  it("returns 2 and prints usage for an unknown command", async () => {
    const f = makeFakeDeps();
    expect(await run(f.deps, ["frobnicate"])).toBe(2);
    expect(f.err.join("\n")).toMatch(/Unknown command: frobnicate/);
    expect(f.out.join("\n")).toMatch(/put risky coding-agent actions/);
  });

  it("catches a command error and returns exit code 1 (no throw)", async () => {
    // install with a malformed --version throws inside cmdInstall -> run() catches it.
    const f = makeFakeDeps();
    expect(await run(f.deps, ["install", "--version", "main"])).toBe(1);
    expect(f.err.join("\n")).toMatch(/error: --version must be a release tag/);
  });

  it("catches a bad option parse and returns 1", async () => {
    const f = makeFakeDeps();
    expect(await run(f.deps, ["install", "--nope"])).toBe(1);
    expect(f.err.join("\n")).toMatch(/error: Unknown install option: --nope/);
  });
});
