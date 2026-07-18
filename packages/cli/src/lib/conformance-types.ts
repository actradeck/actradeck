// Local mirror of @actradeck/event-model's conformance report shape (packages/event-model/
// src/conformance.ts). The CLI cannot cleanly cross-import event-model's types across the tsc
// package boundary (event-model is private and never a dependency of the published, dep-zero
// `actradeck`; its checker is bundled into dist at build time — see scripts/bundle-conformance.mjs).
//
// These plain interfaces let the command render the report with full type-safety. Two DISTINCT
// guards keep this mirror honest:
//   - COMPILE-TIME type-equivalence (test/conformance-types.type-test.ts, run by `type-check:test`):
//     a bidirectional `Equal<>` assertion between these interfaces and event-model's canonical
//     exports — the ONLY guard that catches a TYPE drift (an added/dropped/optional field such as
//     the never-rendered `eventId`), since TS types are erased at runtime.
//   - RUNTIME output-equivalence (test/conformance-equivalence.e2e.test.ts): renders the same
//     fixtures through both `scripts/check-conformance.mjs` and the built `actradeck conformance`
//     and asserts identical stdout + exit — this guards the RENDERING, the bundled checker, and
//     exit-code parity, but NOT the type mirror (both sides call the same runtime checker).
export type ConformanceSeverity = "error" | "warning";

export type ConformanceRule =
  | "schema"
  | "payload-kind-mismatch"
  | "event-id-duplicate"
  | "timestamp-regression"
  | "seq-not-contiguous"
  | "seq-absent";

export interface ConformanceFinding {
  /** 0-based position in the input stream; -1 for a session-level (post-scan) finding. */
  readonly index: number;
  readonly severity: ConformanceSeverity;
  readonly rule: ConformanceRule;
  readonly message: string;
  readonly sessionId?: string;
  readonly eventId?: string;
}

export interface ConformanceReport {
  readonly total: number;
  readonly schemaValid: number;
  readonly sessions: number;
  readonly findings: readonly ConformanceFinding[];
  readonly errors: number;
  readonly warnings: number;
  /** true iff there are no `error`-severity findings. */
  readonly ok: boolean;
}
