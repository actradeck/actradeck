#!/usr/bin/env node
// =============================================================================
// gen-en-landing.mjs — Generate landing/en/index.html from the bilingual source
// =============================================================================
// The landing page is authored ONCE as a bilingual file (landing/index.html with
// data-i18n / data-en / data-ja). For valid hreflang we also need a real EN URL
// (/en/) whose *served* HTML is English by default. This script derives that page
// from the single source so there is no hand-synced duplicate to drift:
//
//   - <html lang="en" data-lp-locale="en">  (app.js pins EN on this URL)
//   - every [data-i18n] node's innerHTML set to its data-en value
//   - head retargeted for /en/ (canonical, og:url, og:locale, og:description)
//   - relative ./asset refs rewritten to root-absolute /asset (page is one dir deep)
//   - demo <source> defaults to the EN cut (/assets/usage.mp4)
//
// landing/en/index.html is a GENERATED artifact: regenerate after editing
// landing/index.html with `node scripts/gen-en-landing.mjs` (verify-en-landing.mjs
// guards against drift). Do NOT hand-edit it.
//
// jsdom is resolved from apps/webui (monorepo dep) without a machine-specific path.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(new URL("../apps/webui/package.json", import.meta.url));
const { JSDOM } = require("jsdom");

const srcPath = new URL("../landing/index.html", import.meta.url);
const outDir = new URL("../landing/en/", import.meta.url);
const outPath = new URL("../landing/en/index.html", import.meta.url);

export function generateEn(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  // 1. Pin EN for this URL (app.js reads data-lp-locale before navigator detection).
  doc.documentElement.setAttribute("lang", "en");
  doc.documentElement.setAttribute("data-lp-locale", "en");

  // 2. Render EN as the served default (innerHTML, since data-en may carry markup).
  doc.querySelectorAll("[data-i18n]").forEach((el) => {
    const en = el.getAttribute("data-en");
    if (en != null) el.innerHTML = en;
  });

  // 3. Retarget head metadata at /en/.
  const set = (sel, attr, val) => {
    const e = doc.querySelector(sel);
    if (e) e.setAttribute(attr, val);
  };
  // No trailing slash: the site runs trailingSlash:false, so /en/ 308-redirects to
  // /en. Canonical / og:url must be the final (non-redirecting) URL.
  set('link[rel="canonical"]', "href", "https://actradeck.io/en");
  set('meta[property="og:url"]', "content", "https://actradeck.io/en");
  set('meta[property="og:locale"]', "content", "en_US");
  set('meta[property="og:locale:alternate"]', "content", "ja_JP");
  const enDesc = doc.querySelector('meta[name="description"]')?.getAttribute("content");
  if (enDesc) set('meta[property="og:description"]', "content", enDesc);
  // hreflang alternates (ja->/, en->/en/, x-default->/) are already reciprocal — keep as-is.

  // 4. Root-absolute the page-local refs so they resolve from /en/ too.
  doc.querySelectorAll("[src],[href],[poster]").forEach((el) => {
    for (const a of ["src", "href", "poster"]) {
      const v = el.getAttribute(a);
      if (v && v.startsWith("./")) el.setAttribute(a, "/" + v.slice(2));
    }
  });

  // 5. EN demo cut as the default <source>.
  set("#demoSource", "src", "/assets/usage.mp4");

  return "<!DOCTYPE html>\n" + doc.documentElement.outerHTML + "\n";
}

// Run as a script (not when imported by the drift guard).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const html = readFileSync(srcPath, "utf8");
  const out = generateEn(html);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, out);
  console.log("generated landing/en/index.html (" + out.length + " bytes)");
}
