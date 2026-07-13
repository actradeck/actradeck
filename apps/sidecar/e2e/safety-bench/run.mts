/**
 * Safety benchmark runner — one command, deterministic output.
 *
 *   pnpm --filter @actradeck/sidecar run bench:safety           # human tables + JSON summary
 *   pnpm --filter @actradeck/sidecar run bench:safety -- --json # JSON only (machine / docs)
 *
 * Deterministic: no timestamps, no randomness, no network. The corpora are fixed and the
 * production redactor / classifier are pure functions, so the numbers are byte-stable across runs
 * (a property the docs rely on for reproducibility).
 *
 * Placed under apps/sidecar/e2e/** so its synthetic fake-secret corpus sits on the PATH-based OSS
 * secret-scan exemption (see redaction-corpus.ts header). Not part of the vitest suite and not in
 * the coverage `include: src/**`, so it does not affect coverage thresholds.
 */

import { scoreRedaction, scoreClassifier, SCORED_CATEGORIES } from "./bench.js";

const jsonOnly = process.argv.includes("--json");

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const pad = (s: string, n: number): string => s.padEnd(n);
const padL = (s: string, n: number): string => s.padStart(n);

const redaction = scoreRedaction();
const classifier = scoreClassifier();

// --------------------------- JSON summary (stable shape) ---------------------------
const summary = {
  redaction: {
    corpus: { positives: redaction.totalPositives, negatives: redaction.totalNegatives },
    overall: {
      recall: Number(redaction.overallRecall.toFixed(4)),
      precision: Number(redaction.overallPrecision.toFixed(4)),
      detected: redaction.totalDetected,
      leaked: redaction.totalLeaked,
      negativesPreserved: redaction.negativesPreserved,
      falsePositives: redaction.falsePositives.length,
    },
    byKind: redaction.byKind.map((k) => ({
      kind: k.kind,
      support: k.support,
      detected: k.detected,
      leaked: k.leaked,
      fragmentLeaked: k.fragmentLeaked,
      recall: Number(k.recall.toFixed(4)),
    })),
    leaks: redaction.leaks,
    falsePositives: redaction.falsePositives,
    // Fragment-survival (R4 finding A): partial leaks a full-substring check misses. NO-RAW —
    // records carry only kind + lengths + boolean, never the surviving fragment.
    fragment: {
      minLen: redaction.fragmentMinLen,
      totalFragmentLeaks: redaction.totalFragmentLeaks,
      leaks: redaction.fragmentLeaks,
    },
  },
  classifier: {
    corpus: { vectors: classifier.totalVectors },
    micro: {
      precision: Number(classifier.microMetric.precision.toFixed(4)),
      recall: Number(classifier.microMetric.recall.toFixed(4)),
      f1: Number(classifier.microMetric.f1.toFixed(4)),
    },
    byCategory: classifier.byCategory.map((c) => ({
      category: c.category,
      support: c.support,
      precision: Number(c.metric.precision.toFixed(4)),
      recall: Number(c.metric.recall.toFixed(4)),
      tp: c.metric.tp,
      fp: c.metric.fp,
      fn: c.metric.fn,
    })),
    gate: classifier.gate.map((g) => ({
      policy: g.policyName,
      precision: Number(g.metric.precision.toFixed(4)),
      recall: Number(g.metric.recall.toFixed(4)),
      tp: g.metric.tp,
      fp: g.metric.fp,
      fn: g.metric.fn,
      tn: g.tn,
    })),
    riskExactAccuracy: Number(classifier.riskExactAccuracy.toFixed(4)),
    dangerNonLowRecall: Number(classifier.dangerNonLowRecall.toFixed(4)),
    misses: classifier.misses,
  },
};

if (jsonOnly) {
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  process.exit(0);
}

// --------------------------- Human-readable tables ---------------------------
const lines: string[] = [];
lines.push("=".repeat(78));
lines.push("ActraDeck safety benchmark — redaction + risk classifier (synthetic corpus)");
lines.push("=".repeat(78));

lines.push("");
lines.push("REDACTION — per-kind recall (secret caught / total)");
lines.push("-".repeat(78));
lines.push(
  `${pad("kind", 26)}${padL("support", 9)}${padL("detected", 10)}${padL("leaked", 8)}${padL("fragLeak", 10)}${padL("recall", 10)}`,
);
for (const k of redaction.byKind) {
  lines.push(
    `${pad(k.kind, 26)}${padL(String(k.support), 9)}${padL(String(k.detected), 10)}${padL(String(k.leaked), 8)}${padL(String(k.fragmentLeaked), 10)}${padL(pct(k.recall), 10)}`,
  );
}
lines.push("-".repeat(78));
lines.push(
  `${pad("OVERALL", 26)}${padL(String(redaction.totalPositives), 9)}${padL(String(redaction.totalDetected), 10)}${padL(String(redaction.totalLeaked), 8)}${padL(String(redaction.totalFragmentLeaks), 10)}${padL(pct(redaction.overallRecall), 10)}`,
);
lines.push("");
lines.push(
  `REDACTION — false positives on ${redaction.totalNegatives} hard negatives: ${redaction.falsePositives.length} over-redacted (precision ${pct(redaction.overallPrecision)})`,
);
if (redaction.falsePositives.length > 0) {
  for (const fp of redaction.falsePositives) {
    lines.push(`  FP [${fp.label}] marked as [${fp.markedKinds.join(",")}]: ${fp.input}`);
  }
}
if (redaction.leaks.length > 0) {
  lines.push("");
  lines.push("REDACTION — LEAKS (full secret survived — finding):");
  for (const l of redaction.leaks) lines.push(`  LEAK [${l.kind}]: ${l.input}`);
}

lines.push("");
lines.push(
  `REDACTION — fragment survival (contiguous >=${redaction.fragmentMinLen}-char secret substring surviving, not explained by preserved public text): ${redaction.totalFragmentLeaks} vector(s)`,
);
if (redaction.fragmentLeaks.length > 0) {
  lines.push(
    "  (a full-substring 'detected' can still leak a partial fragment — this is the metric a full-match check misses)",
  );
  for (const f of redaction.fragmentLeaks) {
    lines.push(
      `  FRAGMENT-LEAK [${f.kind}]: longest surviving run ${f.leakedSpan} of ${f.secretLen} chars (fullLeak=${f.fullLeak})`,
    );
  }
}

lines.push("");
lines.push("CLASSIFIER — per-category precision / recall (multi-label, human ground truth)");
lines.push("-".repeat(78));
lines.push(
  `${pad("category", 20)}${padL("support", 9)}${padL("prec", 9)}${padL("recall", 9)}${padL("tp/fp/fn", 14)}`,
);
for (const c of classifier.byCategory) {
  lines.push(
    `${pad(c.category, 20)}${padL(String(c.support), 9)}${padL(pct(c.metric.precision), 9)}${padL(pct(c.metric.recall), 9)}${padL(`${c.metric.tp}/${c.metric.fp}/${c.metric.fn}`, 14)}`,
  );
}
lines.push("-".repeat(78));
lines.push(
  `${pad("MICRO-AVG", 20)}${padL("", 9)}${padL(pct(classifier.microMetric.precision), 9)}${padL(pct(classifier.microMetric.recall), 9)}${padL(`${classifier.microMetric.tp}/${classifier.microMetric.fp}/${classifier.microMetric.fn}`, 14)}`,
);
lines.push(`  scored categories: ${SCORED_CATEGORIES.join(", ")}`);
lines.push(
  "  (secret-egress / secret-file-edit / external-tool are approval-bridge composites — out of scope)",
);

lines.push("");
lines.push("CLASSIFIER — gate-decision outcome (would this command be held for approval?)");
lines.push("-".repeat(78));
lines.push(`${pad("policy", 16)}${padL("prec", 9)}${padL("recall", 9)}${padL("tp/fp/fn/tn", 16)}`);
for (const g of classifier.gate) {
  lines.push(
    `${pad(g.policyName, 16)}${padL(pct(g.metric.precision), 9)}${padL(pct(g.metric.recall), 9)}${padL(`${g.metric.tp}/${g.metric.fp}/${g.metric.fn}/${g.tn}`, 16)}`,
  );
}
lines.push("");
lines.push(`CLASSIFIER — risk-level exact-match accuracy: ${pct(classifier.riskExactAccuracy)}`);
lines.push(
  `CLASSIFIER — danger recall (expect!=low flagged non-low): ${pct(classifier.dangerNonLowRecall)}`,
);
if (classifier.misses.length > 0) {
  lines.push("");
  lines.push("CLASSIFIER — divergences from human labels (findings / calibration notes):");
  for (const m of classifier.misses) lines.push(`  [${m.kind}] ${m.command} :: ${m.detail}`);
}

lines.push("");
lines.push("JSON summary:");
lines.push(JSON.stringify(summary));
lines.push("");

process.stdout.write(lines.join("\n"));
