/**
 * Safety benchmark scoring — pure, deterministic functions over the labelled corpora.
 *
 * Exercises the REAL production code paths (no mocks, REAL DATA ONLY discipline):
 *   - redaction:  `redactString` from @actradeck/redaction (T1 canonical redactor).
 *   - classifier: `classifyCommandWithCategories` from apps/sidecar/src/normalize.ts.
 *
 * A "leak" (redaction FN) is measured by full-substring survival of the raw secret. Because a
 * full-match check is blind to PARTIAL survival, the harness also measures fragment-survival (R4
 * finding A): a contiguous >= FRAGMENT_MIN_LEN substring of the secret surviving in the output that
 * is not explained by preserved non-secret input (see `leakedFragmentSpan`). A "false positive"
 * (over-redaction) is measured by any `[REDACTED:` marker appearing in output for a benign negative.
 * Classifier metrics are standard multi-label precision/recall against the human-assigned category
 * labels, plus the gate-decision outcome under a given enabled-category policy.
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

/**
 * Fragment-survival threshold (R4 finding A). A "leak" measured only by full-secret substring
 * survival (`out.includes(secret)`) is blind to PARTIAL survival: a straddle/bounded-capture
 * residual can mask the head of a secret while a long tail fragment survives, and the full-match
 * check still reports "detected". This benchmark additionally flags any contiguous substring of the
 * raw secret of length >= FRAGMENT_MIN_LEN that survives in the output.
 *
 * 8 is a deliberately conservative floor: real straddle residuals observed in production (memory:
 * redact-before-truncate-or-straddle-leaks) leave prefixes below the downstream floor-regex minimum
 * lengths (~15 chars for a GitHub token, ~39 for a high-entropy run), so an 8-char surviving run is
 * already a meaningful partial disclosure while staying above incidental 1–7 char coincidences.
 */
export const FRAGMENT_MIN_LEN = 8;

/**
 * Longest contiguous substring of `secret` (>= `minLen`) that survives in `output` AND is not
 * explained by preserved non-secret input — i.e. a real partial leak, not a coincidence.
 *
 * Why "not explained by remainder": a naive "any >=K substring of the secret present in the output"
 * over-counts. A hard example from this corpus: the `discord-webhook` positive embeds the digit run
 * `…0123456789…` inside its secret, while the URL prefix that redaction legitimately PRESERVES
 * contains the public webhook id `…123456789012345678…`. The token itself is fully masked, yet an
 * 8-char digit run coincides between the secret and the preserved public id. That is not a leak of
 * the secret. So a candidate fragment counts only if it appears in `output` and does NOT appear in
 * `remainder` = the input with the secret occurrence removed (all the non-secret text redaction is
 * allowed to keep). Returns the length of the longest such surviving fragment, or 0.
 *
 * The returned span is a LOWER BOUND on the true longest surviving fragment (QA-1). The `>= minLen`
 * boolean (span >= minLen) is exact — the metric never misses a real fragment leak — but for a
 * PERIODIC secret the gram-run heuristic can under-report the span by a few characters: a masked
 * head gram can equal a surviving tail gram, so a run is extended into the masked region and the
 * final `includes` verification then shrinks it back from the end (e.g. the long-credential vector's
 * true 4904-char tail is reported as 4902). Under-reporting the magnitude is the safe direction; the
 * shrink guarantees the reported value is a genuine surviving substring.
 *
 * Bounded & deterministic: uses `minLen`-gram sets (O(|output|+|input|)) to find leaked run starts,
 * then verifies contiguity with a single bounded `includes`. Corpus inputs/outputs are small (the
 * redacted output is bounded by MAX_REDACT_INPUT), so this is linear in practice.
 */
export function leakedFragmentSpan(
  secret: string,
  input: string,
  output: string,
  minLen: number,
): number {
  if (secret.length < minLen || output.length < minLen) return 0;
  // Semantics (SEC-3): if the secret appears MORE THAN ONCE in the input, only the FIRST occurrence
  // is removed from `remainder`. The other occurrences stay in `remainder`, so a fragment that also
  // matches one of them is treated as "explained by preserved input" and not counted. This is the
  // deliberate current behaviour (pinned by inv-safety-bench-metric): the corpus has no such vector,
  // and preferring the safe (non-alarming) direction on ambiguous multi-occurrence inputs is correct
  // for a benchmark. A redactor that leaves ANY occurrence unmasked is still caught by the full-leak
  // metric; this helper's job is the partial-survival signal on single-occurrence secrets.
  const idx = input.indexOf(secret);
  // Replace the secret occurrence with a single space so surrounding public context is retained but
  // no cross-boundary gram spans the removed secret. If the secret is not a literal substring of the
  // input (should not happen — corpus self-consistency test pins it), fall back to the full input.
  const remainder = idx < 0 ? input : `${input.slice(0, idx)} ${input.slice(idx + secret.length)}`;
  const grams = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i + minLen <= s.length; i++) set.add(s.slice(i, i + minLen));
    return set;
  };
  const outGrams = grams(output);
  const remGrams = grams(remainder);
  const starts = Math.max(0, secret.length - minLen + 1);
  const leaked = new Uint8Array(starts);
  for (let i = 0; i < starts; i++) {
    const g = secret.slice(i, i + minLen);
    if (outGrams.has(g) && !remGrams.has(g)) leaked[i] = 1;
  }
  let best = 0;
  let i = 0;
  while (i < starts) {
    if (!leaked[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < starts && leaked[j + 1]) j++;
    // The consecutive leaked grams [i..j] cover secret[i, j+minLen). Verify the whole span is truly
    // contiguous in output (overlapping grams do not guarantee the union is a single output run);
    // shrink from the end until the candidate is a genuine leaked substring.
    let cand = secret.slice(i, j + minLen);
    while (cand.length >= minLen && !(output.includes(cand) && !remainder.includes(cand))) {
      cand = cand.slice(0, -1);
    }
    if (cand.length > best) best = cand.length;
    i = j + 1;
  }
  return best;
}

export interface RedactionKindRow {
  readonly kind: string;
  readonly support: number; // # positive vectors of this kind
  readonly detected: number; // # masked (full secret absent from output)
  readonly leaked: number; // # full secret survived (FN)
  readonly fragmentLeaked: number; // # vectors where a >=FRAGMENT_MIN_LEN fragment survived
  readonly recall: number;
}

export interface RedactionLeak {
  readonly kind: string;
  readonly input: string;
  readonly secret: string;
}

/**
 * A partial (fragment) survival. NO-RAW: carries only public metadata (kind, lengths, boolean) —
 * never the surviving fragment or the raw secret. `leakedSpan` is the length of the longest
 * contiguous secret substring that survived; `fullLeak` marks whether the WHOLE secret survived.
 * A full leak implies a fragment leak ONLY when the secret is at least `FRAGMENT_MIN_LEN` long
 * (QA-4): the corpus contains a 5-char secret (`password=abc12`), so a hypothetical full leak of a
 * sub-`minLen` secret would be counted by the full-substring recall but not by fragment survival.
 */
export interface RedactionFragmentLeak {
  readonly kind: string;
  readonly secretLen: number;
  readonly leakedSpan: number;
  readonly fullLeak: boolean;
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
  /** Fragment-survival (R4 finding A). `fragmentLeaks` includes full leaks (full ⇒ fragment). */
  readonly fragmentMinLen: number;
  readonly totalFragmentLeaks: number;
  readonly fragmentLeaks: readonly RedactionFragmentLeak[];
}

export function scoreRedaction(): RedactionReport {
  const kinds = [...new Set(POSITIVES.map((p) => p.kind))].sort();
  const byKind: RedactionKindRow[] = [];
  const leaks: RedactionLeak[] = [];
  const fragmentLeaks: RedactionFragmentLeak[] = [];
  let totalDetected = 0;
  let totalLeaked = 0;

  for (const kind of kinds) {
    const group = POSITIVES.filter((p) => p.kind === kind);
    let detected = 0;
    let fragmentLeaked = 0;
    for (const p of group) {
      const out = redactString(p.input);
      const fullLeak = out.includes(p.secret);
      if (fullLeak) {
        leaks.push({ kind: p.kind, input: p.input, secret: p.secret });
      } else {
        detected += 1;
      }
      // Fragment-survival is measured independently of the full-substring outcome (R4 finding A): a
      // vector counted as `detected` above (full secret masked) can still leak a partial fragment.
      const span = leakedFragmentSpan(p.secret, p.input, out, FRAGMENT_MIN_LEN);
      if (span >= FRAGMENT_MIN_LEN) {
        fragmentLeaked += 1;
        fragmentLeaks.push({
          kind: p.kind,
          secretLen: p.secret.length,
          leakedSpan: span,
          fullLeak,
        });
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
      fragmentLeaked,
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
    fragmentMinLen: FRAGMENT_MIN_LEN,
    totalFragmentLeaks: fragmentLeaks.length,
    fragmentLeaks,
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
