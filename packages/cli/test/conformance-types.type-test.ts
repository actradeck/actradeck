// Compile-time BIDIRECTIONAL type-equivalence: the CLI's LOCAL mirror of the conformance report
// shapes (src/lib/conformance-types.ts) must stay EXACTLY equal to @actradeck/event-model's
// canonical exports. This is the anti-drift guard for the mirror — the output-equivalence E2E
// canNOT catch a type drift (both programs call the same runtime `checkConformance`; TS types are
// erased, so an added/optional field like the never-rendered `eventId` diverges silently at
// runtime). Here a real type-checker evaluates it.
//
// event-model is imported TYPE-ONLY (erased under verbatimModuleSyntax → never emitted, never
// packed → the published `actradeck` keeps zero dependencies and event-model stays private; this
// file is compiled ONLY by tsconfig.test.json / `type-check:test`, never by the shipped build).
//
// `Equal` is the function-type identity trick (as in tsd/type-fest): unlike a naive mutual-extends
// check it distinguishes optional vs required and readonly modifiers, so dropping/adding even an
// OPTIONAL field flips it to `false` and the `= true` assignments below go RED.
import type {
  ConformanceReport as EMReport,
  ConformanceFinding as EMFinding,
  ConformanceRule as EMRule,
  ConformanceSeverity as EMSeverity,
} from "../../event-model/src/conformance.js";
import type {
  ConformanceReport as MirrorReport,
  ConformanceFinding as MirrorFinding,
  ConformanceRule as MirrorRule,
  ConformanceSeverity as MirrorSeverity,
} from "../src/lib/conformance-types.js";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const _report: Equal<EMReport, MirrorReport> = true;
const _finding: Equal<EMFinding, MirrorFinding> = true;
const _rule: Equal<EMRule, MirrorRule> = true;
const _severity: Equal<EMSeverity, MirrorSeverity> = true;

// Reference the bindings so noUnusedLocals is satisfied — they exist for the type assertion, not a
// runtime value.
void _report;
void _finding;
void _rule;
void _severity;
