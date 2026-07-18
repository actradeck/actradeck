import { defineConfig } from "vitest/config";

// packages/cli — the sole publishable package (ADR 019f5131). The command modules are
// dependency-injected (all IO — fetch / child_process / fs / process — enters through a
// Deps object), so the unit tests reach the branch logic without touching the network or
// the real filesystem. Coverage EXCLUDES the two thin IO-wiring modules that cannot be
// exercised without real IO:
//   - src/index.ts   — the bin shebang wrapper (builds real Deps, calls process.exit)
//   - src/lib/deps.ts — the real Deps factory (wraps node:fs / node:child_process / fetch)
// (same pattern as apps/backend excluding its network index.ts / db pool wiring.)
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.{test,spec}.ts", "test/**/*.{test,spec}.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/index.ts",
        "src/lib/deps.ts",
        "src/lib/fake.ts",
        "src/**/*.{test,spec}.ts",
        // Type-only modules with no runtime footprint: an ambient declaration for the build-time
        // conformance bundle, and the local mirror of event-model's report interfaces (both fully
        // erased by tsc, so they carry no executable lines to cover).
        "src/**/*.d.ts",
        "src/lib/conformance-types.ts",
      ],
      reporter: ["text", "json-summary"],
      // Erosion tripwires, NOT targets (memory: per-file-coverage-floor-below-worst-not-best).
      // Floors sit BELOW the worst observed run (CI regime) with a 3-5pt margin so a normal
      // async-timing swing never trips them; a real regression (a whole branch/function going
      // uncovered) drops well below and DOES. Values calibrated after measuring — see the PR
      // notes. The command modules are pure/synchronous over injected Deps, so the swing is small.
      thresholds: {
        // Global (All-files) erosion tripwires. Observed worst (deterministic — pure sync over
        // injected Deps): 99.32 / 95.39 / 100 / 99.62 (after the `conformance` command landed).
        // Floors sit ~5pt below so a real regression (a whole command's error branch going
        // uncovered) trips, but v8/node cross-env branch-counting jitter does not.
        statements: 95,
        branches: 90,
        functions: 95,
        lines: 95,
        // checksum.ts is the security core (digest verification, fail-closed). Observed 100/100/
        // 100/100 — floors sit BELOW that with margin (95/90/90/95): an EROSION TRIPWIRE, not a
        // 100%-mandate. It does not require 100% coverage; it fires only when a verify branch
        // drops well below the observed level (a real regression), never on cosmetic jitter.
        "src/lib/checksum.ts": { statements: 95, branches: 90, functions: 90, lines: 95 },
        // conformance.ts renders the checker report + maps exit codes. Observed (deterministic):
        // 100 / 96.42 / 100 / 100 — the one uncovered branch is a defensive String(err) fallback on
        // JSON.parse, which only ever throws an Error (genuinely unreachable). Floors sit well BELOW
        // worst (branches 85 ≈ 11pt under) so a real regression (the --json path or an exit-code
        // branch going uncovered) trips, not v8 jitter.
        "src/commands/conformance.ts": { statements: 95, branches: 85, functions: 90, lines: 95 },
      },
    },
  },
});
