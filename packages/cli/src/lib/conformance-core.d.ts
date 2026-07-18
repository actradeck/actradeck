// Ambient declaration for the BUILD-TIME conformance bundle. At runtime this module id resolves
// to dist/lib/conformance-core.js — the self-contained esbuild bundle of event-model's
// `checkConformance` closure (scripts/bundle-conformance.mjs). There is no `.ts`/`.js` source for
// it in `src/`; tsc types the dynamic import in lib/deps.ts against this declaration, and nothing
// is emitted for a `.d.ts`, so the ONLY dist/lib/conformance-core.js is the bundler's output.
import type { ConformanceReport } from "./conformance-types.js";

export declare function checkConformance(events: readonly unknown[]): ConformanceReport;
