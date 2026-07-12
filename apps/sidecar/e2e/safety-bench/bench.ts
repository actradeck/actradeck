/**
 * Safety benchmark scoring — pure, deterministic functions over the labelled corpora.
 *
 * Exercises the REAL production code paths (no mocks, REAL DATA ONLY discipline):
 *   - redaction:  `redactString` from @actradeck/redaction (T1 canonical redactor).
 *   - classifier: `classifyCommandWithCategories` from apps/sidecar/src/normalize.ts.
 *
 * A "leak" (redaction FN) is measured by substring survival of the raw secret — the
 * security-relevant metric. A "false positive" (over-redaction) is measured by any `[REDACTED:`
 * marker appearing in output for a benign negative. Classifier metrics are standard multi-label
 * precision/recall against the human-assigned category labels, plus the gate-decision outcome
 * under a given enabled-category policy.
 */

import { redactString, countRedactionMarkersByKind } from "@actradeck/redaction";
import { DEFAULT_GATED_CATEGORIES, PolicyCategory } from "@actradeck/event-model";
import type { PolicyCategory as PolicyCategoryT } from "@actradeck/event-model";
import { classifyCommandWithCategories } from "../../src/normalize.js";
import { POSITIVES, NEGATIVES } from "./redaction-corpus.js";
import { COMMANDS } from "./classifier-corpus.js";

/** Standard classification counters + derived rates. */
export interface Metric {
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly precision: number; // tp / (tp+fp); 1 when no predictions
  readonly recall: number; // tp / (tp+fn); 1 when no positives
  readonly f1: number;
}

function metric(tp: number, fp: number, fn: number): Metric {
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { tp, fp, fn, precision, recall, f1 };
}

// ------------------------------ Redaction ------------------------------

export interface RedactionKindRow {
  readonly kind: string;
  readonly support: number; // # positive vectors of this kind
  readonly detected: number; // # masked (secret absent from output)
  readonly leaked: number; // # secret survived (FN)
  readonly recall: number;
}

export interface RedactionLeak {
  readonly kind: string;
  readonly input: string;
  readonly secret: string;
}

export interface RedactionFalsePositive {
  readonly label: string;
  readonly input: string;
  readonly output: string;
  readonly markedKinds: readonly string[];
}

export interface RedactionReport {
  readonly totalPositives: number;
  readonly totalDetected: number;
  readonly totalLeaked: number;
  readonly overallRecall: number;
  readonly totalNegatives: number;
  readonly negativesPreserved: number;
  readonly falsePositives: readonly RedactionFalsePositive[];
  /** Vector-level precision: TP / (TP + FP negatives over-redacted). */
  readonly overallPrecision: number;
  readonly byKind: readonly RedactionKindRow[];
  readonly leaks: readonly RedactionLeak[];
}

export function scoreRedaction(): RedactionReport {
  const kinds = [...new Set(POSITIVES.map((p) => p.kind))].sort();
  const byKind: RedactionKindRow[] = [];
  const leaks: RedactionLeak[] = [];
  let totalDetected = 0;
  let totalLeaked = 0;

  for (const kind of kinds) {
    const group = POSITIVES.filter((p) => p.kind === kind);
    let detected = 0;
    for (const p of group) {
      const out = redactString(p.input);
      if (out.includes(p.secret)) {
        leaks.push({ kind: p.kind, input: p.input, secret: p.secret });
      } else {
        detected += 1;
      }
    }
    const leaked = group.length - detected;
    totalDetected += detected;
    totalLeaked += leaked;
    byKind.push({
      kind,
      support: group.length,
      detected,
      leaked,
      recall: group.length === 0 ? 1 : detected / group.length,
    });
  }

  const falsePositives: RedactionFalsePositive[] = [];
  for (const n of NEGATIVES) {
    const out = redactString(n.input);
    if (out !== n.input || out.includes("[REDACTED:")) {
      const markedKinds = Object.keys(countRedactionMarkersByKind(out)).sort();
      falsePositives.push({ label: n.label, input: n.input, output: out, markedKinds });
    }
  }

  const totalPositives = POSITIVES.length;
  const fp = falsePositives.length;
  return {
    totalPositives,
    totalDetected,
    totalLeaked,
    overallRecall: totalPositives === 0 ? 1 : totalDetected / totalPositives,
    totalNegatives: NEGATIVES.length,
    negativesPreserved: NEGATIVES.length - fp,
    falsePositives,
    overallPrecision: totalDetected + fp === 0 ? 1 : totalDetected / (totalDetected + fp),
    byKind,
    leaks,
  };
}

// ------------------------------ Classifier ------------------------------

/** The command-pattern categories this benchmark scores (approval-bridge composites excluded). */
export const SCORED_CATEGORIES: readonly PolicyCategoryT[] = [
  "recursive-rm",
  "disk-destroy",
  "history-rewrite",
  "db-drop",
  "fork-bomb",
  "perm-change",
  "inline-code",
  "migrate-prod",
  "high-risk-other",
];

export interface CategoryRow {
  readonly category: PolicyCategoryT;
  readonly support: number; // # vectors where category is expected
  readonly metric: Metric;
}

export interface ClassifierMiss {
  readonly command: string;
  readonly kind: "category-fn" | "category-fp" | "risk";
  readonly detail: string;
}

export interface GateOutcome {
  readonly policyName: string;
  readonly metric: Metric;
  readonly tn: number;
}

export interface ClassifierReport {
  readonly totalVectors: number;
  readonly byCategory: readonly CategoryRow[];
  readonly microMetric: Metric; // micro-averaged over all scored categories
  readonly gate: readonly GateOutcome[]; // gate-decision under default & strict policies
  readonly riskExactAccuracy: number;
  readonly dangerNonLowRecall: number; // of expect!=low vectors, fraction classifier flags non-low
  readonly misses: readonly ClassifierMiss[];
}

function intersects(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

export function scoreClassifier(): ClassifierReport {
  const predictions = COMMANDS.map((v) => {
    const { risk, categories } = classifyCommandWithCategories(v.command);
    return { vector: v, risk, categories };
  });

  const misses: ClassifierMiss[] = [];

  // Per-category multi-label counters.
  const byCategory: CategoryRow[] = [];
  let microTp = 0;
  let microFp = 0;
  let microFn = 0;
  for (const category of SCORED_CATEGORIES) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const p of predictions) {
      const expected = new Set<string>(p.vector.expectCategories);
      const predicted = p.categories;
      const exp = expected.has(category);
      const got = predicted.has(category);
      if (exp && got) tp += 1;
      else if (!exp && got) {
        fp += 1;
        misses.push({
          command: p.vector.command,
          kind: "category-fp",
          detail: `predicted '${category}' not in human label [${[...expected].join(",") || "∅"}]`,
        });
      } else if (exp && !got) {
        fn += 1;
        misses.push({
          command: p.vector.command,
          kind: "category-fn",
          detail: `missed '${category}' (human label)`,
        });
      }
    }
    microTp += tp;
    microFp += fp;
    microFn += fn;
    // A category with no human-labelled support AND no predictions would report a vacuous
    // P/R of 1.0 (metric() 0-denominator fallback) — omit such rows so JSON consumers never
    // see a meaningless "100%" (TDA-5). Micro totals above still fold in every category.
    if (tp + fp + fn > 0) {
      byCategory.push({ category, support: tp + fn, metric: metric(tp, fp, fn) });
    }
  }

  // Gate-decision outcome under a policy (enabled category set).
  const gateFor = (policyName: string, enabled: ReadonlySet<string>): GateOutcome => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;
    for (const p of predictions) {
      const expectedGated = intersects(new Set<string>(p.vector.expectCategories), enabled);
      const predictedGated = intersects(p.categories, enabled);
      if (expectedGated && predictedGated) tp += 1;
      else if (!expectedGated && predictedGated) fp += 1;
      else if (expectedGated && !predictedGated) fn += 1;
      else tn += 1;
    }
    return { policyName, metric: metric(tp, fp, fn), tn };
  };
  const gate: GateOutcome[] = [
    gateFor("default-gated", new Set<string>(DEFAULT_GATED_CATEGORIES)),
    gateFor("strict-all", new Set<string>(PolicyCategory.options)),
  ];

  // Risk level exact-match + danger recall.
  let riskExact = 0;
  let dangerTotal = 0;
  let dangerFlagged = 0;
  for (const p of predictions) {
    if (p.risk === p.vector.expectRisk) riskExact += 1;
    else {
      misses.push({
        command: p.vector.command,
        kind: "risk",
        detail: `risk ${p.risk} != expected ${p.vector.expectRisk}`,
      });
    }
    if (p.vector.expectRisk !== "low") {
      dangerTotal += 1;
      if (p.risk !== "low") dangerFlagged += 1;
    }
  }

  return {
    totalVectors: COMMANDS.length,
    byCategory,
    microMetric: metric(microTp, microFp, microFn),
    gate,
    riskExactAccuracy: COMMANDS.length === 0 ? 1 : riskExact / COMMANDS.length,
    dangerNonLowRecall: dangerTotal === 0 ? 1 : dangerFlagged / dangerTotal,
    misses,
  };
}
