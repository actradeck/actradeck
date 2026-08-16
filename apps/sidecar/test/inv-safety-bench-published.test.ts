/**
 * INV-SAFETY-BENCH-PUBLISHED — the benchmark doc's published numbers stay TRUE.
 *
 * docs/benchmarks/redaction-and-risk-classifier.md publishes concrete figures (recall,
 * precision, benign preservation, the classifier per-category + gate-decision tables,
 * risk-level accuracy, danger recall). Those are a TRUST ASSET: an outside reader is
 * told "run the command yourself and you will get the same figures." The existing
 * guards pin corpus completeness (inv-safety-bench-corpus) and the fragment metric
 * logic (inv-safety-bench-metric), but NOT the doc's detailed numbers — so a change to
 * the redactor or classifier (or an edit to the doc) could silently make the published
 * numbers false while every guard stays green (the classifier's design bias holds recall
 * at 100%, masking precision/gate/risk drift).
 *
 * This test closes that gap with a TWO-WAY lock around a single source of truth
 * (`PUBLISHED`):
 *   1. the live bench (scoreRedaction / scoreClassifier over the REAL production
 *      redactor + classifier) must PRODUCE these numbers, and
 *   2. the shipped markdown doc must PRINT these numbers.
 * A code change that moves a number fails (1) → you update PUBLISHED → that then fails
 * (2) until you also update the doc. The doc can never silently lie.
 *
 * NOT a security gate (the hard guarantees are the INV-REDACTION-* / classifier
 * invariants); this only gates DOC HONESTY. If a number legitimately changes, update
 * PUBLISHED + the doc together — the test passes again. The network-dependent gitleaks
 * cross-eval (58.8%) is intentionally OUT of scope here (it is "NOT run in CI"); its
 * number stays manually maintained in the doc.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { scoreClassifier, scoreRedaction } from "../e2e/safety-bench/bench.js";

const DOC_PATH = fileURLToPath(
  new URL("../../../docs/benchmarks/redaction-and-risk-classifier.md", import.meta.url),
);

/** Percentage exactly as the doc formats it (one decimal place, matching run.mts `pct`). */
const pct1 = (x: number): string => (x * 100).toFixed(1);

/**
 * The numbers PUBLISHED in docs/benchmarks/redaction-and-risk-classifier.md.
 * SINGLE SOURCE OF TRUTH: the bench must produce these AND the doc must print these.
 * `doc` strings are verbatim substrings that must appear in the markdown.
 */
const PUBLISHED = {
  redaction: {
    positives: 38,
    negatives: 28,
    recallPct: "100.0", // overall recall (full secret caught)
    maskPrecisionPct: "90.5", // masks that hit a secret (38/42)
    benignPct: "85.7", // hard negatives preserved verbatim (24/28)
    benignPreserved: 24,
    falsePositives: 4,
    fragmentLeaks: 0,
    kindFamilies: 29,
  },
  classifier: {
    micro: { support: 50, precisionPct: "84.7", recallPct: "100.0" },
    // support / precision% / recall% per the "Results — risk classifier" table.
    byCategory: [
      { category: "recursive-rm", support: 17, precisionPct: "100.0", recallPct: "100.0" },
      { category: "disk-destroy", support: 4, precisionPct: "80.0", recallPct: "100.0" },
      { category: "history-rewrite", support: 8, precisionPct: "100.0", recallPct: "100.0" },
      { category: "db-drop", support: 3, precisionPct: "75.0", recallPct: "100.0" },
      { category: "fork-bomb", support: 1, precisionPct: "100.0", recallPct: "100.0" },
      { category: "perm-change", support: 5, precisionPct: "100.0", recallPct: "100.0" },
      { category: "inline-code", support: 9, precisionPct: "100.0", recallPct: "100.0" },
      { category: "migrate-prod", support: 2, precisionPct: "50.0", recallPct: "100.0" },
      { category: "high-risk-other", support: 1, precisionPct: "16.7", recallPct: "100.0" },
    ],
    gate: [
      {
        policyName: "default-gated",
        precisionPct: "95.1",
        recallPct: "100.0",
        tp: 39,
        fp: 2,
        fn: 0,
        tn: 26,
      },
      {
        policyName: "strict-all",
        precisionPct: "92.0",
        recallPct: "100.0",
        tp: 46,
        fp: 4,
        fn: 0,
        tn: 17,
      },
    ],
    riskExactPct: "91.0",
    dangerRecallPct: "97.8",
  },
} as const;

describe("INV-SAFETY-BENCH-PUBLISHED: the doc's numbers match the live bench AND the doc text", () => {
  const doc = readFileSync(DOC_PATH, "utf8");
  const red = scoreRedaction();
  const cls = scoreClassifier();

  // ---- redaction: bench output === PUBLISHED ----
  it("redaction headline numbers are produced by the live bench", () => {
    expect(red.totalPositives).toBe(PUBLISHED.redaction.positives);
    expect(red.totalNegatives).toBe(PUBLISHED.redaction.negatives);
    expect(pct1(red.overallRecall)).toBe(PUBLISHED.redaction.recallPct);
    expect(pct1(red.overallPrecision)).toBe(PUBLISHED.redaction.maskPrecisionPct);
    expect(pct1(red.negativesPreserved / red.totalNegatives)).toBe(PUBLISHED.redaction.benignPct);
    expect(red.negativesPreserved).toBe(PUBLISHED.redaction.benignPreserved);
    expect(red.falsePositives.length).toBe(PUBLISHED.redaction.falsePositives);
    expect(red.totalFragmentLeaks).toBe(PUBLISHED.redaction.fragmentLeaks);
    expect(red.byKind.length).toBe(PUBLISHED.redaction.kindFamilies);
  });

  // ---- classifier: bench output === PUBLISHED ----
  it("classifier micro-average is produced by the live bench", () => {
    expect(cls.microMetric.tp + cls.microMetric.fn).toBe(PUBLISHED.classifier.micro.support);
    expect(pct1(cls.microMetric.precision)).toBe(PUBLISHED.classifier.micro.precisionPct);
    expect(pct1(cls.microMetric.recall)).toBe(PUBLISHED.classifier.micro.recallPct);
  });

  it("classifier per-category table is produced by the live bench", () => {
    for (const row of PUBLISHED.classifier.byCategory) {
      const actual = cls.byCategory.find((c) => c.category === row.category);
      expect(actual, `category ${row.category} missing from bench output`).toBeDefined();
      expect(actual!.support, `${row.category} support`).toBe(row.support);
      expect(pct1(actual!.metric.precision), `${row.category} precision`).toBe(row.precisionPct);
      expect(pct1(actual!.metric.recall), `${row.category} recall`).toBe(row.recallPct);
    }
  });

  it("gate-decision outcomes are produced by the live bench", () => {
    for (const g of PUBLISHED.classifier.gate) {
      const actual = cls.gate.find((x) => x.policyName === g.policyName);
      expect(actual, `gate policy ${g.policyName} missing`).toBeDefined();
      expect(pct1(actual!.metric.precision), `${g.policyName} precision`).toBe(g.precisionPct);
      expect(pct1(actual!.metric.recall), `${g.policyName} recall`).toBe(g.recallPct);
      expect(actual!.metric.tp, `${g.policyName} tp`).toBe(g.tp);
      expect(actual!.metric.fp, `${g.policyName} fp`).toBe(g.fp);
      expect(actual!.metric.fn, `${g.policyName} fn`).toBe(g.fn);
      expect(actual!.tn, `${g.policyName} tn`).toBe(g.tn);
    }
  });

  it("risk-level accuracy and danger recall are produced by the live bench", () => {
    expect(pct1(cls.riskExactAccuracy)).toBe(PUBLISHED.classifier.riskExactPct);
    expect(pct1(cls.dangerNonLowRecall)).toBe(PUBLISHED.classifier.dangerRecallPct);
  });

  // ---- doc text === PUBLISHED (the doc prints exactly what the bench produces) ----
  it("the published doc prints the redaction numbers", () => {
    const r = PUBLISHED.redaction;
    expect(doc, "recall").toContain(`**${r.recallPct}%** (${r.positives}/${r.positives}`);
    expect(doc, "mask precision").toContain(`**${r.maskPrecisionPct}%** (${r.positives}/42`);
    expect(doc, "benign").toContain(`**${r.benignPct}%** (${r.benignPreserved}/${r.negatives}`);
    expect(doc, "corpus size").toContain(
      `**${r.positives} redaction positives** across **${r.kindFamilies} kind families**, **${r.negatives} hard negatives**`,
    );
  });

  it("the published doc prints the classifier numbers", () => {
    const c = PUBLISHED.classifier;
    // micro-average row
    expect(doc, "micro precision").toContain(`**${c.micro.precisionPct}%**`);
    expect(doc, "micro recall").toContain(`**${c.micro.recallPct}%**`);
    // per-category rows: "| recursive-rm      | 6       | 100.0%    | 100.0%     |" (spacing-agnostic)
    for (const row of c.byCategory) {
      const re = new RegExp(
        `\\|\\s*${row.category}\\s*\\|\\s*${row.support}\\s*\\|\\s*${row.precisionPct}%\\s*\\|\\s*${row.recallPct}%\\s*\\|`,
      );
      expect(doc, `category row ${row.category}`).toMatch(re);
    }
    // gate rows: "| default-gated (out-of-box)          | 93.5%     | 100.0% | 29 / 2 / 0 / 22   |"
    for (const g of c.gate) {
      const re = new RegExp(
        `${g.precisionPct}%\\s*\\|\\s*${g.recallPct}%\\s*\\|\\s*${g.tp} / ${g.fp} / ${g.fn} / ${g.tn}`,
      );
      expect(doc, `gate row ${g.policyName}`).toMatch(re);
    }
    expect(doc, "risk exact").toContain(`**${c.riskExactPct}%**`);
    expect(doc, "danger recall").toContain(`**${c.dangerRecallPct}%**`);
  });
});
