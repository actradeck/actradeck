#!/usr/bin/env node
// =============================================================================
// gen-shot-webp.mjs — Generate responsive WebP variants of the LP screenshots
// =============================================================================
// The product screenshots ship as 2880px PNGs but render at ~440–1000 CSS px.
// Serving the full PNG wastes bytes (Lighthouse: ~382KB oversize + ~222KB by not
// using a modern format) and slows LCP. This emits width-stepped WebP variants so
// the <picture> srcset in landing/index.html can serve a right-sized modern image.
//
// The .webp files are committed build artifacts (like optimized images usually
// are). Regenerate after replacing a source PNG:  node scripts/gen-shot-webp.mjs
// Keep the width list in sync with the srcset/sizes in landing/index.html, and add
// new variants to OSS_MEDIA_REVIEWED_RE in scripts/lib/oss-patterns.sh (publish gate).
import { createRequire } from "node:module";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);

// sharp is a transitive dep (next) under pnpm and is not hoisted to root
// node_modules; resolve it from node_modules/.pnpm/sharp@*/ portably.
function loadSharp() {
  try {
    return require("sharp");
  } catch {
    const pnpm = fileURLToPath(new URL("../node_modules/.pnpm/", import.meta.url));
    const dir = readdirSync(pnpm).find((d) => d.startsWith("sharp@"));
    if (!dir) throw new Error("sharp not found — run `pnpm install` first");
    return require(path.join(pnpm, dir, "node_modules", "sharp"));
  }
}

const sharp = loadSharp();
const SHOTS = fileURLToPath(new URL("../landing/assets/shots/", import.meta.url));

// width steps per shot (capped at native via withoutEnlargement)
const PLAN = {
  "live-wall.png": [480, 768, 1280, 1920],
  "approval-inbox.png": [480, 768, 1280, 1920],
  "audit-actradeck.png": [480, 768, 1280, 1920],
  "replay.png": [480, 768, 1280, 1920],
  "redaction-panel.png": [480, 732],
};

let made = 0;
let bytes = 0;
for (const [file, widths] of Object.entries(PLAN)) {
  const base = file.replace(/\.png$/, "");
  for (const w of widths) {
    const out = path.join(SHOTS, `${base}-${w}.webp`);
    const info = await sharp(path.join(SHOTS, file))
      .resize({ width: w, withoutEnlargement: true })
      .webp({ quality: 80, effort: 5 })
      .toFile(out);
    made++;
    bytes += info.size;
    console.log(
      `  ${base}-${w}.webp  ${info.width}x${info.height}  ${(info.size / 1024).toFixed(1)}KB`,
    );
  }
}
console.log(`\ngenerated ${made} webp, total ${(bytes / 1024).toFixed(0)}KB`);
