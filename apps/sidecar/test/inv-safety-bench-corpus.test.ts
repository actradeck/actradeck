/**
 * INV-SAFETY-BENCH-KINDS — the safety-bench redaction corpus stays complete.
 *
 * The published benchmark doc (docs/benchmarks/redaction-and-risk-classifier.md) claims
 * per-kind recall across ALL redaction kind families. The corpus derives its kind set from
 * itself (bench.ts aggregates whatever kinds the vectors declare), so nothing else stops the
 * canonical `REDACTION_KINDS` enum from growing while the corpus — and the shipped "29 kind
 * families, 100% recall" claim — silently goes stale (audit finding TDA-1, feat/redaction-
 * risk-bench). This test pins SET EQUALITY between the corpus and the canonical enum:
 *
 * - a new REDACTION_KINDS entry without a corpus vector fails here (add a positive vector —
 *   or, if a kind is intentionally not exercisable via redactString free text, add it to an
 *   explicit exclusion list in this file with a reason);
 * - a corpus kind typo / removal that no longer matches the enum also fails here.
 *
 * Importing the corpus from a test also gives it CI type-checking, which the e2e tree does
 * not otherwise get (TDA-4).
 */
import { describe, expect, it } from "vitest";

import { REDACTION_KINDS } from "@actradeck/event-model";

import { POSITIVES } from "../e2e/safety-bench/redaction-corpus.js";

/** Kinds deliberately NOT exercised by the benchmark corpus (must stay empty or reasoned). */
const EXCLUDED_KINDS: readonly string[] = [];

describe("INV-SAFETY-BENCH-KINDS: benchmark corpus covers the canonical redaction kind set", () => {
  it("corpus kind set === REDACTION_KINDS (minus explicit exclusions)", () => {
    const corpusKinds = [...new Set(POSITIVES.map((p) => p.kind))].sort();
    const expected = REDACTION_KINDS.filter((k) => !EXCLUDED_KINDS.includes(k)).sort();
    expect(corpusKinds).toEqual(expected);
  });

  it("every corpus vector's secret actually appears in its input (corpus self-consistency)", () => {
    for (const p of POSITIVES) {
      expect(p.input, `vector kind=${p.kind}`).toContain(p.secret);
    }
  });
});
