// bundle-conformance.mjs — bundle @actradeck/event-model's `checkConformance` closure into the
// CLI's dist at BUILD time, so `actradeck conformance` ships the T1-canonical checker WITHOUT
// making event-model a runtime/published dependency (ADR 019f5131 dep-zero · decision 019f739f).
//
// Why this shape:
//   - Single source of truth: the entry re-exports event-model's `checkConformance` from SOURCE
//     (packages/event-model/src/conformance.ts). No reimplementation → no drift from the canonical.
//   - dependency-zero output: esbuild inlines the whole closure (conformance → event → the 5
//     schema modules → timestamp, plus the transitive `zod` and `uuid`) into one self-contained
//     ESM file. The published `actradeck` package.json keeps `dependencies` EMPTY.
//   - esbuild-wasm (NOT native esbuild): pure WASM, no postinstall. The release.yml npm job runs
//     `pnpm install --frozen-lockfile --ignore-scripts`; a native esbuild binary would be skipped
//     and fail to bundle, whereas esbuild-wasm works with install scripts disabled.
//   - No package.json pollution: esbuild-wasm lives in the ROOT devDependencies and event-model
//     is reached via a RELATIVE path (resolved by esbuild, not by a package dependency), so
//     packages/cli/package.json gains neither event-model nor the bundler (npm publish does not
//     rewrite workspace:* nor strip devDependencies, and INV-NPM-NO-LIFECYCLE forbids a
//     prepack/prepare cleanup — so nothing must be added there in the first place).
//   - Pack allowlist stays satisfied: output goes under packages/cli/dist/** with NO sourcemap
//     (*.map is forbidden by the pack gate) and no .tsbuildinfo.
import * as esbuild from "esbuild-wasm";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const cliDir = path.resolve(scriptDir, "..");
const eventModelSrc = path.resolve(cliDir, "../event-model/src");
const outfile = path.resolve(cliDir, "dist/lib/conformance-core.js");
const noticesFile = path.resolve(cliDir, "dist/THIRD-PARTY-NOTICES.txt");

await mkdir(path.dirname(outfile), { recursive: true });

const result = await esbuild.build({
  metafile: true,
  // Inline entry (no physical .ts file → nothing for tsc/eslint to compile). The relative import
  // is resolved against event-model's SOURCE dir; esbuild rewrites the `.js` specifier to the
  // `.ts` source and follows the closure from there.
  stdin: {
    contents: `export { checkConformance } from "./conformance.js";`,
    resolveDir: eventModelSrc,
    loader: "ts",
    sourcefile: "conformance-core.entry.ts",
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  minify: true,
  sourcemap: false, // *.map is forbidden by the pack allowlist gate.
  // "eof" preserves any inline @license/@preserve comments a bundled dep carries (defense in depth
  // / future-proof). zod + uuid currently ship their MIT notice as a SEPARATE LICENSE file, not an
  // inline comment, so this collects nothing today — their notices are gathered into
  // dist/THIRD-PARTY-NOTICES.txt below (from the esbuild metafile). No sourcemap either way.
  legalComments: "eof",
  outfile,
});

// Fail LOUD on a degenerate bundle (e.g. an entry/resolve regression that emits an empty or
// checker-less file that would still "build" but silently break `conformance`).
const emitted = readFileSync(outfile, "utf8");
const bytes = statSync(outfile).size;
const MIN_BYTES = 50_000; // the real closure (zod + uuid + schema) is ~330 KB; a floor well below.
if (bytes < MIN_BYTES || !emitted.includes("checkConformance")) {
  process.stderr.write(
    `bundle-conformance: degenerate bundle (${bytes} bytes, checkConformance ${
      emitted.includes("checkConformance") ? "present" : "MISSING"
    }) — refusing to ship.\n`,
  );
  process.exit(1);
}

// SEC-2: the inlined third-party deps (zod + uuid, both MIT) do NOT carry inline license comments,
// so `legalComments:"eof"` collects nothing. MIT still requires their notice to travel with the
// redistribution, so we generate a THIRD-PARTY-NOTICES from the ACTUAL bundled inputs (esbuild
// metafile → each node_modules package's package.json + LICENSE). Written UNDER dist/ so the pack
// allowlist (dist/**) accepts it without touching the `files` array. Generalizable: any future
// bundled dep is picked up automatically. NO filesystem paths are emitted (name@version + license
// text only) — no maintainer-path / secret leak.
const LICENSE_NAMES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "LICENCE", "COPYING"];
function packageRootOf(absPath) {
  const marker = `${path.sep}node_modules${path.sep}`;
  const idx = absPath.lastIndexOf(marker);
  if (idx === -1) return null;
  const rest = absPath.slice(idx + marker.length).split(path.sep);
  const name = rest[0]?.startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
  if (!name) return null;
  return path.join(absPath.slice(0, idx + marker.length), name);
}
const roots = new Set();
for (const input of Object.keys(result.metafile?.inputs ?? {})) {
  const abs = path.resolve(cliDir, input);
  if (!abs.includes(`${path.sep}node_modules${path.sep}`)) continue; // first-party source
  const root = packageRootOf(abs);
  if (root) roots.add(root);
}
const notices = [];
const seen = new Set();
for (const root of [...roots].sort()) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  } catch {
    continue;
  }
  const id = `${pkg.name}@${pkg.version}`;
  if (seen.has(id)) continue;
  seen.add(id);
  const licenseFile = LICENSE_NAMES.map((n) => path.join(root, n)).find((p) => existsSync(p));
  const text = licenseFile ? readFileSync(licenseFile, "utf8").trim() : "";
  const license = typeof pkg.license === "string" ? pkg.license : "see below";
  notices.push(
    `${"=".repeat(78)}\n${id}  (${license})\n${"=".repeat(78)}\n${text || "(no LICENSE file shipped by this package)"}\n`,
  );
}
const header =
  "ActraDeck CLI — third-party notices for code bundled into dist/lib/conformance-core.js.\n" +
  "The `conformance` command inlines the checker's dependency closure at build time; the\n" +
  "licenses of those bundled packages follow.\n\n";
await writeFile(noticesFile, header + notices.join("\n"), "utf8");
if (seen.size === 0 || !/permission is hereby granted/i.test(header + notices.join("\n"))) {
  // The known closure includes MIT (zod + uuid) — a notices file without any MIT permission text
  // means license collection silently broke.
  process.stderr.write(
    `bundle-conformance: THIRD-PARTY-NOTICES collected ${seen.size} package(s) but no MIT notice — refusing to ship.\n`,
  );
  process.exit(1);
}

process.stdout.write(
  `bundle-conformance: wrote ${path.relative(cliDir, outfile)} (${bytes} bytes) + THIRD-PARTY-NOTICES (${seen.size} pkgs)\n`,
);
