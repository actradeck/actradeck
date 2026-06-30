#!/usr/bin/env node
// =============================================================================
// verify-en-landing.mjs — Drift guard for the generated landing/en/index.html
// =============================================================================
// landing/en/index.html is DERIVED from landing/index.html by gen-en-landing.mjs.
// Because it is committed (so prepare-landing's rsync ships it), it can silently
// drift if someone edits the bilingual source without regenerating. This guard
// regenerates in-memory and fails if the committed file differs — run it in the
// commit gate / before publishing.
//
//   node scripts/verify-en-landing.mjs   # exit 0 = in sync, 1 = drifted
import { readFileSync } from "node:fs";
import { generateEn } from "./gen-en-landing.mjs";

const srcPath = new URL("../landing/index.html", import.meta.url);
const enPath = new URL("../landing/en/index.html", import.meta.url);

const expected = generateEn(readFileSync(srcPath, "utf8"));
const actual = readFileSync(enPath, "utf8");

if (expected === actual) {
  console.log("OK: landing/en/index.html is in sync with landing/index.html");
  process.exit(0);
}
console.error(
  "DRIFT: landing/en/index.html is stale. Regenerate with `node scripts/gen-en-landing.mjs`.",
);
process.exit(1);
