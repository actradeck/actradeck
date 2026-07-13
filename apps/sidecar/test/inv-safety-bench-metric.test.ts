/**
 * INV-SAFETY-BENCH-METRIC — pins the safety-bench MEASUREMENT logic (not just the corpus).
 *
 * The fragment-survival metric and the gitleaks cross-eval synthesis are pure functions that decide
 * whether a partial secret leaked / whether a gitleaks-shaped token is masked. Without a test they
 * could silently regress (a broadened threshold, a dropped remainder-exclusion, a broken TOML parse)
 * and the published benchmark numbers would drift. This test lives under `test/**` so it is inside
 * the vitest include set and runs in CI (unlike the `e2e/` harness itself). It consumes the exported
 * measurement helpers so they are not dead API surface (TDA-4).
 *
 * Mutation-tested (see the PR report): setting FRAGMENT_MIN_LEN to 9, or dropping the remainder
 * exclusion in `leakedFragmentSpan`, turns specific assertions here RED.
 */
import { describe, expect, it } from "vitest";

import { redactString } from "@actradeck/redaction";

import { FRAGMENT_MIN_LEN, leakedFragmentSpan, scoreRedaction } from "../e2e/safety-bench/bench.js";
import { POSITIVES } from "../e2e/safety-bench/redaction-corpus.js";
import {
  MAPPING,
  parseGitleaksToml,
  synthesizeSample,
  toJsRegex,
  crossEval,
  GITLEAKS_PINNED_SHA,
  GITLEAKS_TOML_BLOB_SHA1,
  GITLEAKS_TOML_SHA256,
  GITLEAKS_TOML_SIZE,
  type CrossEvalReport,
} from "../e2e/safety-bench/cross-eval.mjs";

describe("INV-SAFETY-BENCH-METRIC: fragment-survival (leakedFragmentSpan)", () => {
  const K = FRAGMENT_MIN_LEN;

  it("FRAGMENT_MIN_LEN is 8", () => {
    expect(K).toBe(8);
  });

  it("masked fragment → 0 (no >=8 substring survives)", () => {
    expect(leakedFragmentSpan("ABCDEFGH", "x ABCDEFGH y", "x [REDACTED:foo] y", K)).toBe(0);
  });

  it("leaked len-8 fragment → 8", () => {
    // Secret leaks verbatim; remainder ("k= ") does not contain it.
    expect(leakedFragmentSpan("ABCDEFGH", "k=ABCDEFGH", "k=ABCDEFGH", K)).toBe(8);
  });

  it("secret shorter than minLen → 0 (guard; QA-4: a sub-minLen full leak is not a fragment leak)", () => {
    expect(leakedFragmentSpan("abc12", "password=abc12", "password=abc12", K)).toBe(0);
  });

  it("full leak → span equals secret length", () => {
    const s = "ABCDEFGHIJ"; // 10 chars, leaks verbatim
    expect(leakedFragmentSpan(s, `v=${s}`, `v=${s}`, K)).toBe(s.length);
  });

  it("coincidence with preserved public text → 0 (discord-type false positive is excluded)", () => {
    // The secret's digit run also appears in the preserved public webhook id → not a real leak.
    const secret = "tok0123456789";
    const input = `id=123456789012345678 ${secret}`;
    const output = "id=123456789012345678 [REDACTED:discord-webhook]";
    expect(leakedFragmentSpan(secret, input, output, K)).toBe(0);
  });

  it("multiple occurrences: only the first is removed from remainder (SEC-3 current semantics)", () => {
    // The 2nd occurrence leaks, but it is 'explained' by the retained first-removal remainder, so the
    // metric reports 0. Pins the documented current behaviour (the full-leak metric still catches a
    // redactor that leaves any occurrence unmasked).
    const secret = "SECRETTOK";
    const input = `${secret}-${secret}`;
    const output = `[REDACTED:x]-${secret}`;
    expect(leakedFragmentSpan(secret, input, output, K)).toBe(0);
  });

  it("real corpus: exactly one vector fragment-leaks (bounded-capture tail), span >= 4902, not a full leak", () => {
    let fragCount = 0;
    let bigSpan = 0;
    let bigFull = true;
    for (const p of POSITIVES) {
      const out = redactString(p.input);
      const span = leakedFragmentSpan(p.secret, p.input, out, K);
      if (span >= K) {
        fragCount += 1;
        expect(p.kind).toBe("credential-assignment");
        bigSpan = span;
        bigFull = out.includes(p.secret);
      }
    }
    expect(fragCount).toBe(1);
    expect(bigSpan).toBeGreaterThanOrEqual(4902);
    // The full-substring recall counts this vector as detected; only fragment survival catches it.
    expect(bigFull).toBe(false);
  });

  it("scoreRedaction: 0 full leaks and exactly 1 fragment leak over 38 positives", () => {
    const r = scoreRedaction();
    expect(r.totalPositives).toBe(38);
    expect(r.totalLeaked).toBe(0);
    expect(r.totalFragmentLeaks).toBe(1);
    expect(r.fragmentMinLen).toBe(8);
  });
});

describe("INV-SAFETY-BENCH-METRIC: gitleaks cross-eval pure functions (offline TOML fixture)", () => {
  // Inline fixture — no network. `some-unmapped-vendor` is intentionally NOT in MAPPING.
  const FIXTURE = [
    "[[rules]]",
    'id = "github-pat"',
    "regex = '''ghp_[0-9a-zA-Z]{36}'''",
    'keywords = ["ghp_"]',
    "[[rules]]",
    'id = "some-unmapped-vendor"',
    "regex = '''zzz_[0-9]{10}'''",
    "",
  ].join("\n");

  it("parseGitleaksToml extracts id → regex", () => {
    const rules = parseGitleaksToml(FIXTURE);
    expect(rules.size).toBe(2);
    expect(rules.get("github-pat")).toBe("ghp_[0-9a-zA-Z]{36}");
    expect(rules.get("some-unmapped-vendor")).toBe("zzz_[0-9]{10}");
  });

  it("synthesizeSample is deterministic and produces a valid instance of the rule", () => {
    const rx = "ghp_[0-9a-zA-Z]{36}";
    const a = synthesizeSample(rx);
    const b = synthesizeSample(rx);
    expect(a).not.toBeNull();
    expect(a).toBe(b); // deterministic
    expect(a!.length).toBe(40); // "ghp_" + 36
    const js = toJsRegex(rx);
    expect(js).not.toBeNull();
    expect(js!.test(a!)).toBe(true); // a genuine gitleaks-rule instance
  });

  it("synthesizeSample returns null on an unsupported construct (negated class)", () => {
    expect(synthesizeSample("[^a]{5}")).toBeNull();
  });

  it("crossEval surfaces parsed total + unmapped count and maps github-pat → github-token", () => {
    const rules = parseGitleaksToml(FIXTURE);
    const report: CrossEvalReport = crossEval(rules);
    expect(report.parsedRuleTotal).toBe(2);
    expect(report.unmappedRuleCount).toBe(1); // some-unmapped-vendor
    expect(report.mappedTotal).toBe(MAPPING.length);
    const ghRow = report.rows.find((r) => r.gitleaksId === "github-pat");
    expect(ghRow?.status).toBe("masked");
    expect(ghRow?.markedKinds).toContain("github-token");
    // github-pat is the only mapped rule present in the fixture → synthesized 1, masked 1.
    expect(report.synthesized).toBe(1);
    expect(report.masked).toBe(1);
    const absent = report.rows.filter((r) => r.status === "absent").length;
    expect(absent).toBe(MAPPING.length - 1);
  });

  it("pin constants are well-formed (guards against accidental un-pinning)", () => {
    expect(GITLEAKS_PINNED_SHA).toMatch(/^[0-9a-f]{40}$/);
    expect(GITLEAKS_TOML_BLOB_SHA1).toMatch(/^[0-9a-f]{40}$/);
    expect(GITLEAKS_TOML_SHA256).toMatch(/^[0-9a-f]{64}$/);
    expect(GITLEAKS_TOML_SIZE).toBeGreaterThan(0);
  });

  it("MAPPING has no duplicate gitleaks ids", () => {
    const ids = MAPPING.map((m) => m.gitleaksId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
