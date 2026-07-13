/**
 * External-corpus cross-evaluation (R4 finding B) — independence check for the redactor.
 *
 * The safety-bench corpus is authored by the same people who wrote the redactor, so its recall is
 * self-correlated. This harness measures our redactor against an INDEPENDENT ground truth: the
 * secret-detection rules shipped by gitleaks (github.com/gitleaks/gitleaks — MIT licensed). For a
 * curated subset of gitleaks rules that map onto our redaction kinds, it synthesizes a sample that
 * is a valid instance of the gitleaks rule (verified against the rule's own regex), runs it through
 * our production `redactString`, and reports how many gitleaks-shaped secrets we also mask, plus the
 * kind distribution and the misses.
 *
 * ## Provenance & integrity (pinned, checksum-verified)
 * gitleaks ships its rules as regexes in `config/gitleaks.toml`. We fetch that single file at a
 * PINNED commit at run time (never vendored into this repo) and verify its integrity before use:
 *   - `GITLEAKS_PINNED_SHA` — immutable gitleaks commit (v8.30.1).
 *   - `GITLEAKS_TOML_BLOB_SHA1` / `GITLEAKS_TOML_SIZE` — GitHub's authoritative git blob object id
 *     and byte size for the pinned file (from the GitHub contents API). The script recomputes the
 *     git-blob-sha1 over the fetched raw bytes and refuses to proceed on any mismatch (fail-loud).
 *   - `GITLEAKS_TOML_SHA256` — the raw-byte SHA-256 of the pinned file, computed from a real fetch
 *     of the pinned commit and enforced in addition to the git-blob-sha1. The script always prints
 *     the SHA-256 it computed so a maintainer re-pinning a new gitleaks version can update both.
 *
 * ## Safety constraints
 *   - NO gitleaks fake-secret VALUES are ever committed to this repo. The fetch happens only at run
 *     time; synthesized samples live in memory; no secret value is printed to stdout or the docs.
 *   - SSRF: the fetch target is a single fixed URL built only from the pinned commit constant — no
 *     external input is interpolated into the URL.
 *   - NOT run in CI (network-dependent). Opt-in only: `pnpm --filter @actradeck/sidecar run
 *     bench:cross-eval`.
 *
 * ## Honest scope (see docs/benchmarks/redaction-and-risk-classifier.md for the full disclosure)
 * gitleaks is an at-rest git-history scanner; we are a streaming text redactor. They overlap on
 * inline token shapes but not on scope. Samples are synthesized from the MINIMAL valid instance of
 * each rule (first alternation branch, minimum repetition), so a miss can mean either a genuine
 * coverage gap OR that gitleaks accepts a shorter/edge instance than a real secret — the docs triage
 * each miss by rule name and shape (never by value).
 *
 * ## Updating the pin (bumping to a newer gitleaks release)
 *   1. Pick the new release commit SHA → set `GITLEAKS_PINNED_SHA` (a tag's commit, not a branch).
 *   2. Recompute all three checksums from a real fetch of the pinned file and update the constants:
 *      `GITLEAKS_TOML_SIZE` (byte length), `GITLEAKS_TOML_BLOB_SHA1` (git blob object id — the script
 *      prints it), and `GITLEAKS_TOML_SHA256` (the script prints it too). A stale pin fails loud.
 *   3. Re-check the `MAPPING` against the new ruleset: a run prints "unmapped (out of our scope)"
 *      and any `absent` rows flag a renamed/removed rule id that must be re-mapped. Re-measure the
 *      recall and update docs/benchmarks/redaction-and-risk-classifier.md (REAL DATA only).
 */
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import { redactString, countRedactionMarkersByKind } from "@actradeck/redaction";

/** Pinned gitleaks release commit (v8.30.1). */
export const GITLEAKS_PINNED_SHA = "83d9cd684c87d95d656c1458ef04895a7f1cbd8e";
/** Fixed fetch URL — built only from the pinned constant (no external input → SSRF-safe). */
const GITLEAKS_TOML_URL = `https://raw.githubusercontent.com/gitleaks/gitleaks/${GITLEAKS_PINNED_SHA}/config/gitleaks.toml`;
/** GitHub-authoritative git blob object id (sha1) + byte size for the pinned file. */
export const GITLEAKS_TOML_BLOB_SHA1 = "256f64790ea6d954f0041024be2938089ae1e7a7";
export const GITLEAKS_TOML_SIZE = 97731;
/** Raw-byte sha256 of the pinned file (from a real fetch); enforced in addition to the blob sha1. */
export const GITLEAKS_TOML_SHA256 =
  "e163e53b9e7e8a8511e77271e2b323ed057759542a6d988258afe3a1fa329caf";

/**
 * Curated mapping of gitleaks rule id → our redaction kind. Closed list: only rules whose secret
 * shape maps onto something our stream redactor targets. gitleaks ships 170+ rules; the ones NOT
 * listed here are out of our scope (vendor-specific tokens we do not model) and are disclosed as
 * excluded in the docs, not counted against recall.
 */
export const MAPPING: readonly { gitleaksId: string; ourKind: string }[] = [
  { gitleaksId: "aws-access-token", ourKind: "aws-access-key-id" },
  { gitleaksId: "github-pat", ourKind: "github-token" },
  { gitleaksId: "github-fine-grained-pat", ourKind: "github-token" },
  { gitleaksId: "gitlab-pat", ourKind: "gitlab-token" },
  { gitleaksId: "slack-bot-token", ourKind: "slack-token" },
  { gitleaksId: "slack-webhook-url", ourKind: "slack-webhook" },
  { gitleaksId: "stripe-access-token", ourKind: "stripe-key" },
  { gitleaksId: "sendgrid-api-token", ourKind: "sendgrid-key" },
  { gitleaksId: "npm-access-token", ourKind: "npm-auth-token" },
  { gitleaksId: "huggingface-access-token", ourKind: "huggingface-token" },
  { gitleaksId: "databricks-api-token", ourKind: "databricks-token" },
  { gitleaksId: "doppler-api-token", ourKind: "doppler-token" },
  { gitleaksId: "planetscale-password", ourKind: "planetscale-token" },
  { gitleaksId: "flyio-access-token", ourKind: "flyio-token" },
  { gitleaksId: "jwt", ourKind: "jwt" },
  { gitleaksId: "private-key", ourKind: "private-key" },
  { gitleaksId: "openai-api-key", ourKind: "openai-key" },
];

/** Parse `[[rules]]` id + single/triple-quoted regex from a gitleaks TOML file. */
export function parseGitleaksToml(toml: string): Map<string, string> {
  const rules = new Map<string, string>();
  const lines = toml.split(/\r?\n/);
  let id: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const idm = /^\s*id\s*=\s*"([^"]+)"/.exec(line);
    if (idm) {
      id = idm[1]!;
      continue;
    }
    const single = /^\s*regex\s*=\s*'''(.*)'''\s*$/.exec(line);
    if (single && id) {
      rules.set(id, single[1]!);
      continue;
    }
    const openTriple = /^\s*regex\s*=\s*'''(.*)$/.exec(line);
    if (openTriple && id && !/'''\s*$/.test(line)) {
      // Multi-line triple-quoted regex: accumulate until the closing '''.
      const parts = [openTriple[1]!];
      for (i++; i < lines.length; i++) {
        const l = lines[i]!;
        const close = /^(.*)'''\s*$/.exec(l);
        if (close) {
          parts.push(close[1]!);
          break;
        }
        parts.push(l);
      }
      rules.set(id, parts.join("\n"));
    }
  }
  return rules;
}

/**
 * Translate a gitleaks (Go RE2) regex into a JS RegExp for VERIFICATION only (to assert a
 * synthesized sample is a valid instance of the rule). Go inline flags `(?i)` / `(?i:…)` are not
 * valid JS; we strip them and compile case-insensitively (a superset — fine for asserting that our
 * sample matches). Returns null if the pattern cannot be compiled in JS.
 */
export function toJsRegex(re2: string): RegExp | null {
  const translated = re2.replace(/\(\?i\)/g, "").replace(/\(\?i:/g, "(?:");
  try {
    return new RegExp(translated, "i");
  } catch {
    return null;
  }
}

/**
 * Representative characters for a parsed character class. We CYCLE through these when filling a
 * quantified class so synthesized samples carry realistic entropy (mixed case + digits + symbols),
 * matching what a real high-entropy secret looks like — otherwise a single-char fill would
 * artificially dodge our high-entropy detector.
 */
function classPool(body: string): string[] {
  const pool: string[] = [];
  const add = (s: string) => {
    for (const c of s) if (!pool.includes(c)) pool.push(c);
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === "\\") {
      const n = body[i + 1];
      if (n === "x") {
        // \xHH hex escape — decode to the literal char (e.g. \x60 → backtick).
        add(String.fromCharCode(parseInt(body.slice(i + 2, i + 4), 16)));
        i += 3;
        continue;
      }
      i++;
      if (n === "w") add("aB3_");
      else if (n === "d") add("0123456789");
      else if (n === "s") add(" ");
      else if (n === "S") add("xY7");
      else if (n === "-") add("-");
      else if (n === ".") add(".");
      else if (n === "/") add("/");
      else if (n === "n") add("n");
      else if (n === "r") add("r");
      else if (n) add(n);
      continue;
    }
    if (body[i + 1] === "-" && i + 2 < body.length && body[i + 2] !== "]") {
      // range a-z: include the two endpoints and a middle char for entropy.
      const lo = body.charCodeAt(i);
      const hi = body.charCodeAt(i + 2);
      if (hi > lo) {
        add(String.fromCharCode(lo));
        add(String.fromCharCode(Math.floor((lo + hi) / 2)));
        add(String.fromCharCode(hi));
      }
      i += 2;
      continue;
    }
    add(c);
  }
  return pool.length ? pool : ["a"];
}

/**
 * Recursive-descent sampler: produce ONE deterministic sample string that is a valid instance of
 * the (RE2) regex, using the FIRST alternation branch and MINIMUM repetition counts. Supports the
 * construct subset used by the mapped gitleaks rules (literals, escapes, char classes, `(?:…)` /
 * `(…)` / `(?i:…)` groups, alternation, `{n}` `{n,}` `{n,m}` `?` `*` `+`, anchors `\b` `^` `$`,
 * `.`). Returns null on an unsupported construct so the caller can mark the rule unsynthesizable
 * (disclosed, not silently counted).
 */
export function synthesizeSample(regex: string): string | null {
  let pos = 0;
  let failed = false;

  function parseSeq(stopAtParen: boolean): string {
    // Parse a sequence up to end / unmatched ')' / top-level '|' (we take the first branch).
    let out = "";
    while (pos < regex.length && !failed) {
      const c = regex[pos]!;
      if (c === "|") {
        // First branch only: skip the rest of this alternation at this level.
        skipToGroupEnd(stopAtParen);
        break;
      }
      if (c === ")") break;
      const atom = parseAtom(stopAtParen);
      if (atom === null) {
        if (failed) return out;
        break;
      }
      const { min, emitter } = applyQuantifier(atom);
      for (let r = 0; r < min; r++) out += emitter(r);
    }
    return out;
  }

  function skipToGroupEnd(stopAtParen: boolean): void {
    // Consume the remaining alternatives of the current group without emitting.
    let depth = 0;
    while (pos < regex.length) {
      const c = regex[pos]!;
      if (c === "\\") {
        pos += 2;
        continue;
      }
      if (c === "[") {
        pos++;
        while (pos < regex.length && regex[pos] !== "]") {
          if (regex[pos] === "\\") pos++;
          pos++;
        }
        pos++;
        continue;
      }
      if (c === "(") {
        depth++;
        pos++;
        continue;
      }
      if (c === ")") {
        if (depth === 0) break;
        depth--;
        pos++;
        continue;
      }
      pos++;
    }
    void stopAtParen;
  }

  function parseClassBody(): string {
    // pos is at '['. Return the raw class body (between [ ]).
    pos++; // skip '['
    let body = "";
    if (regex[pos] === "^") {
      body += "^";
      pos++;
    }
    while (pos < regex.length && regex[pos] !== "]") {
      if (regex[pos] === "\\") {
        if (regex[pos + 1] === "x") {
          body += regex.slice(pos, pos + 4); // keep \xHH intact
          pos += 4;
          continue;
        }
        body += regex[pos]! + (regex[pos + 1] ?? "");
        pos += 2;
        continue;
      }
      body += regex[pos]!;
      pos++;
    }
    pos++; // skip ']'
    return body;
  }

  function parseAtom(stopAtParen: boolean): { pool: string[]; single: boolean } | null {
    const c = regex[pos]!;
    if (c === "(") {
      // group — handle (?:, (?i:, (?i), (?<...>, plain (
      pos++;
      if (regex[pos] === "?") {
        if (regex.startsWith("?i)", pos)) {
          pos += 3; // (?i) no-op
          return { pool: [""], single: true };
        }
        if (regex.startsWith("?i:", pos)) pos += 3;
        else if (regex[pos + 1] === ":") pos += 2;
        else if (regex[pos + 1] === "<") {
          // named/lookbehind — unsupported for sampling
          failed = true;
          return null;
        } else if (regex[pos + 1] === "=" || regex[pos + 1] === "!") {
          failed = true; // lookahead — unsupported
          return null;
        } else pos += 1;
      }
      const inner = parseSeq(true);
      if (regex[pos] === ")") pos++;
      return { pool: [inner], single: true };
    }
    if (c === "[") {
      const body = parseClassBody();
      if (body.startsWith("^")) {
        failed = true; // negated class — unsupported for sampling
        return null;
      }
      return { pool: classPool(body), single: false };
    }
    if (c === "\\") {
      const n = regex[pos + 1];
      pos += 2;
      if (n === "b" || n === "B" || n === "A" || n === "z" || n === "Z")
        return { pool: [""], single: true };
      if (n === "d") return { pool: ["0", "5", "9"], single: false };
      if (n === "w") return { pool: ["a", "B", "3", "_"], single: false };
      if (n === "s") return { pool: [" "], single: false };
      if (n === "S") return { pool: ["x", "Y", "7"], single: false };
      if (n === "n") return { pool: ["n"], single: true };
      if (n === "r") return { pool: ["r"], single: true };
      if (n === "x") {
        const hex = regex.slice(pos, pos + 2);
        pos += 2;
        return { pool: [String.fromCharCode(parseInt(hex, 16))], single: true };
      }
      return { pool: [n ?? ""], single: true };
    }
    if (c === "^" || c === "$") {
      pos++;
      return { pool: [""], single: true };
    }
    if (c === ".") {
      pos++;
      return { pool: ["x"], single: false };
    }
    if (c === ")" || c === "|") return null;
    void stopAtParen;
    // literal char
    pos++;
    return { pool: [c], single: true };
  }

  function applyQuantifier(atom: { pool: string[]; single: boolean }): {
    min: number;
    emitter: (r: number) => string;
  } {
    const pool = atom.pool.length ? atom.pool : [""];
    const cycle = (r: number): string => pool[r % pool.length]!;
    const q = regex[pos];
    let min = 1;
    if (q === "?") {
      pos++;
      min = 0;
    } else if (q === "*") {
      pos++;
      min = 0;
    } else if (q === "+") {
      pos++;
      min = 1;
    } else if (q === "{") {
      const m = /^\{(\d+)(,(\d*)?)?\}/.exec(regex.slice(pos));
      if (m) {
        pos += m[0].length;
        min = parseInt(m[1]!, 10);
      }
    }
    // Consume a trailing lazy/possessive modifier (`*?`, `+?`, `{n,}?`, …) — no effect on min.
    if (q && (regex[pos] === "?" || regex[pos] === "+")) pos++;
    // For a single-token atom (group result / literal), the "pool" holds one whole string; repeat
    // it. For a class/charset atom, cycle representative chars for entropy.
    if (atom.single) {
      const whole = pool[0]!;
      return { min, emitter: () => whole };
    }
    return { min, emitter: cycle };
  }

  const sample = parseSeq(false);
  if (failed) return null;
  return sample;
}

export type CrossEvalStatus = "masked" | "missed" | "unsynthesizable" | "absent";

export interface CrossEvalRow {
  readonly gitleaksId: string;
  readonly ourKind: string;
  readonly status: CrossEvalStatus;
  readonly markedKinds: readonly string[]; // our redaction kinds that fired (public enum, no values)
  readonly sampleLen: number; // length only — never the value
}

export interface CrossEvalReport {
  readonly parsedRuleTotal: number; // total [[rules]] parsed from the TOML (denominator sanity)
  readonly unmappedRuleCount: number; // parsed rules NOT in our MAPPING (surfaces stale mappings)
  readonly mappedTotal: number;
  readonly synthesized: number; // rules we could synthesize a verified sample for
  readonly masked: number; // synthesized rules our redactor masked (any kind)
  readonly recall: number; // masked / synthesized (over the mappable, synthesizable subset)
  readonly rows: readonly CrossEvalRow[];
}

/** Run the cross-eval over the parsed gitleaks rules. Pure — no I/O. */
export function crossEval(rules: Map<string, string>): CrossEvalReport {
  const rows: CrossEvalRow[] = [];
  let synthesized = 0;
  let masked = 0;
  // Surface how much of gitleaks' ruleset we map (TDA-2): a silently shrinking parse (e.g. a rename
  // that drops rules from the Map) or a MAPPING that covers a tiny slice must be visible, not hidden
  // behind a clean-looking recall on a stale denominator.
  const mappedIds = new Set(MAPPING.map((m) => m.gitleaksId));
  let unmappedRuleCount = 0;
  for (const id of rules.keys()) if (!mappedIds.has(id)) unmappedRuleCount += 1;
  for (const { gitleaksId, ourKind } of MAPPING) {
    const regex = rules.get(gitleaksId);
    if (!regex) {
      rows.push({ gitleaksId, ourKind, status: "absent", markedKinds: [], sampleLen: 0 });
      continue;
    }
    const sample = synthesizeSample(regex);
    const js = toJsRegex(regex);
    // A sample is only usable if it is a genuine instance of gitleaks' own rule.
    if (sample === null || js === null || !js.test(sample)) {
      rows.push({ gitleaksId, ourKind, status: "unsynthesizable", markedKinds: [], sampleLen: 0 });
      continue;
    }
    synthesized += 1;
    const out = redactString(sample);
    const markedKinds = Object.keys(countRedactionMarkersByKind(out)).sort();
    const isMasked = markedKinds.length > 0;
    if (isMasked) masked += 1;
    rows.push({
      gitleaksId,
      ourKind,
      status: isMasked ? "masked" : "missed",
      markedKinds,
      sampleLen: sample.length,
    });
  }
  return {
    parsedRuleTotal: rules.size,
    unmappedRuleCount,
    mappedTotal: MAPPING.length,
    synthesized,
    masked,
    recall: synthesized === 0 ? 0 : masked / synthesized,
    rows,
  };
}

function gitBlobSha1(bytes: Buffer): string {
  const header = Buffer.from(`blob ${bytes.length}\0`, "utf8");
  return createHash("sha1")
    .update(Buffer.concat([header, bytes]))
    .digest("hex");
}

async function main(): Promise<void> {
  process.stdout.write(`Fetching pinned gitleaks ruleset:\n  ${GITLEAKS_TOML_URL}\n`);
  let bytes: Buffer;
  try {
    // SEC-1 hardening: refuse redirects (the pinned URL must resolve directly — a redirect could
    // point off raw.githubusercontent) and bound the request with a 30s timeout.
    const res = await fetch(GITLEAKS_TOML_URL, {
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    process.stderr.write(
      `\nFETCH FAILED (${(err as Error).message}). This benchmark needs network access and is not run in CI.\n`,
    );
    process.exit(1);
    return;
  }

  const blobSha1 = gitBlobSha1(bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  process.stdout.write(
    `Fetched ${bytes.length} bytes\n  git-blob-sha1 = ${blobSha1}\n  sha256        = ${sha256}\n`,
  );
  if (bytes.length !== GITLEAKS_TOML_SIZE || blobSha1 !== GITLEAKS_TOML_BLOB_SHA1) {
    process.stderr.write(
      `\nINTEGRITY MISMATCH — refusing to proceed.\n  expected size=${GITLEAKS_TOML_SIZE} blob=${GITLEAKS_TOML_BLOB_SHA1}\n  got      size=${bytes.length} blob=${blobSha1}\n`,
    );
    process.exit(1);
    return;
  }
  if (GITLEAKS_TOML_SHA256 && sha256 !== GITLEAKS_TOML_SHA256) {
    process.stderr.write(
      `\nSHA-256 MISMATCH — refusing to proceed.\n  expected ${GITLEAKS_TOML_SHA256}\n  got      ${sha256}\n`,
    );
    process.exit(1);
    return;
  }
  process.stdout.write("Integrity OK (git-blob-sha1 pinned).\n\n");

  const rules = parseGitleaksToml(bytes.toString("utf8"));
  const report = crossEval(rules);
  printReport(report);
}

function printReport(report: CrossEvalReport): void {
  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
  const lines: string[] = [];
  lines.push("=".repeat(78));
  lines.push(
    "ActraDeck redaction — gitleaks cross-evaluation (external corpus, independence check)",
  );
  lines.push("=".repeat(78));
  lines.push("");
  lines.push(
    `Parsed gitleaks rules: ${report.parsedRuleTotal} | unmapped (out of our scope): ${report.unmappedRuleCount} | mapped: ${report.mappedTotal}`,
  );
  lines.push(`Mapped subset: synthesized ${report.synthesized} | masked ${report.masked}`);
  lines.push(`Recall over synthesizable mapped subset: ${pct(report.recall)}`);
  lines.push("");
  lines.push(
    `${"gitleaks rule".padEnd(28)}${"our kind".padEnd(22)}${"status".padEnd(16)}our marker`,
  );
  lines.push("-".repeat(78));
  for (const r of report.rows) {
    lines.push(
      `${r.gitleaksId.padEnd(28)}${r.ourKind.padEnd(22)}${r.status.padEnd(16)}${r.markedKinds.join(",")}`,
    );
  }
  lines.push("");
  lines.push("Notes: samples are the minimal valid instance of each gitleaks rule (first branch,");
  lines.push("min repetition). 'missed' = our redactor produced no [REDACTED:] marker. No secret");
  lines.push("value is printed. gitleaks = at-rest repo scan; ActraDeck = stream text redaction.");
  process.stdout.write(lines.join("\n") + "\n");
}

const isMain =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) void main();
