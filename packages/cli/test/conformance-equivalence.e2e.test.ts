import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// OUTPUT-EQUIVALENCE E2E — guards the CLI's RENDERING, the build-time BUNDLE, and EXIT-CODE parity.
// Runs the SAME fixtures through BOTH the canonical checker (node scripts/check-conformance.mjs,
// backed by @actradeck/event-model's dist) AND the built `actradeck conformance` (backed by the
// esbuild bundle), and asserts identical stdout + identical exit code. valid → PASS/0,
// invalid → FAIL/1.
//
// NOTE: this does NOT guard the local type mirror — both programs call the SAME runtime
// `checkConformance`, so a TYPE drift in src/lib/conformance-types.ts (e.g. the never-rendered
// `eventId`) would leave these assertions green. That drift is caught at COMPILE time by
// test/conformance-types.type-test.ts (`type-check:test`).

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../.."); // packages/cli/test -> repo root
const scriptPath = path.join(root, "scripts", "check-conformance.mjs");
const cliBin = path.join(root, "packages", "cli", "dist", "index.js");
const fixtures = path.join(root, "docs", "examples", "conformance");

function hasToolchain(): boolean {
  if (!existsSync(path.join(root, "node_modules"))) return false;
  try {
    execFileSync("pnpm", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

interface RunResult {
  stdout: string;
  code: number;
}

function runNode(args: string[], opts: { input?: string } = {}): RunResult {
  try {
    const stdout = execFileSync("node", args, {
      cwd: root,
      encoding: "utf8",
      input: opts.input ?? "",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    return { stdout: e.stdout ?? "", code: e.status ?? 1 };
  }
}

const enabled = hasToolchain();

describe.skipIf(!enabled)("conformance output-equivalence (built CLI vs reference script)", () => {
  beforeAll(() => {
    // Build both tiers from CURRENT source so the comparison always reflects HEAD (strongest
    // anti-drift): event-model dist for the reference script, and the CLI dist + esbuild bundle
    // for the subcommand.
    execFileSync("pnpm", ["--filter", "@actradeck/event-model", "build"], {
      cwd: root,
      stdio: "ignore",
    });
    execFileSync("pnpm", ["--filter", "./packages/cli", "build"], { cwd: root, stdio: "ignore" });
  }, 180_000);

  for (const [fixture, expectedCode] of [
    ["valid.jsonl", 0],
    ["invalid.jsonl", 1],
  ] as const) {
    for (const mode of [[], ["--json"]] as const) {
      const label = mode.join(" ") || "human";
      const file = path.join(fixtures, fixture);

      it(`${fixture} ${label} (file arg) — identical stdout + exit`, () => {
        const script = runNode([scriptPath, ...mode, file]);
        const cli = runNode([cliBin, "conformance", ...mode, file]);
        expect(cli.stdout).toBe(script.stdout);
        expect(cli.code).toBe(script.code);
        expect(cli.code).toBe(expectedCode);
      });

      it(`${fixture} ${label} (stdin) — identical stdout + exit`, () => {
        const input = readFileSync(file, "utf8");
        const script = runNode([scriptPath, ...mode], { input });
        const cli = runNode([cliBin, "conformance", ...mode], { input });
        expect(cli.stdout).toBe(script.stdout);
        expect(cli.code).toBe(script.code);
        expect(cli.code).toBe(expectedCode);
      });
    }
  }
});
