#!/usr/bin/env node
// Capture REAL, read-only screenshots of the running ActraDeck cockpit for the
// landing page. Adapted from record-cockpit-cast.mjs — same proven selectors and
// navigation, but it takes clean PNG screenshots (NO caption overlay, NO video)
// in the dark theme with the English cockpit UI.
//
// No app data is mocked. Whatever the cockpit shows is real and already redacted
// at the sidecar choke point. The browser needs no secrets (the web UI's BFF
// authenticates server-side). For the approval-inbox shot it best-effort stages
// ONE real pending approval (a real Claude Code session driven to a gated rm -rf
// in a throwaway repo, which the hook blocks); if `claude` is unavailable or the
// card does not materialize, it falls back to whatever the inbox currently shows
// and the governance story is still carried by the audit-detail shot.
//
// Usage:
//   node scripts/capture-cockpit-shots.mjs [out-dir]
//   COCKPIT_URL=http://localhost:55400 node scripts/capture-cockpit-shots.mjs
//   CAP_STAGE=0 node scripts/capture-cockpit-shots.mjs   # skip live approval staging
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync, rmSync } from "node:fs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const URL = process.env.COCKPIT_URL || "http://localhost:55400";
const OUT = resolve(ROOT, process.argv[2] || "landing/assets/shots");
const STAGE = process.env.CAP_STAGE !== "0";
// Demo-staging knobs (defaults preserve original behaviour; override for a
// project-scoped clean-fleet capture — see record-cockpit-cast.mjs):
const DEMO_REPO = process.env.CAP_DEMO_REPO || "/tmp/ad-demo";
const AUDIT_FILTER = process.env.CAP_AUDIT_FILTER ?? "ActraDeck";
const SESSION_HINT = process.env.CAP_SESSION_HINT || "0b7df3b5";
const W = 1440,
  H = 900;

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error("Playwright not found. pnpm add -Dw playwright && npx playwright install chromium");
  process.exit(1);
}

try {
  const r = await fetch(URL, { method: "GET" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
} catch (e) {
  console.error(`Cockpit not reachable at ${URL} (${e.message}). Start it: ./scripts/actradeck up`);
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });

const b = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
});
const ctx = await b.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 2, // crisp retina PNGs for the LP
  reducedMotion: "reduce",
});
// Pin dark theme + English cockpit UI before first paint (no-flash scripts read these keys).
await ctx.addInitScript(() => {
  try {
    localStorage.setItem("ad-theme", "dark");
    localStorage.setItem("ad-locale", "en");
  } catch {
    /* private mode: ignore */
  }
});
const p = await ctx.newPage();

const hold = (ms) => p.waitForTimeout(ms);
const click = (sel) =>
  p
    .click(sel, { timeout: 4000 })
    .then(() => true)
    .catch(() => false);
async function boardTab() {
  const btns = await p.$$('[data-testid="top-tabs"] button');
  if (btns[0]) await btns[0].click();
  await hold(700);
}
async function shot(name) {
  const file = resolve(OUT, `${name}.png`);
  await p.screenshot({ path: file }); // viewport clip (clean browser-window shot)
  console.log(`[shot] ${name}.png`);
}
// Element screenshot — isolates a single panel so neighbouring real data (other
// projects / local paths in the timeline) never lands in the LP asset.
async function elShot(sel, name) {
  try {
    const el = p.locator(sel).first();
    await el.scrollIntoViewIfNeeded({ timeout: 3000 });
    await hold(300);
    await el.screenshot({ path: resolve(OUT, `${name}.png`) });
    console.log(`[shot] ${name}.png (element ${sel})`);
    return true;
  } catch {
    console.log(`[shot] SKIP ${name} (element ${sel} not found)`);
    return false;
  }
}

// --- best-effort: stage ONE real pending approval (like the cast does) -------
let claudeProc = null;
function stageApproval() {
  try {
    rmSync(DEMO_REPO, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  mkdirSync(`${DEMO_REPO}/build`, { recursive: true });
  try {
    execFileSync("git", ["-C", DEMO_REPO, "init", "-q"]);
  } catch {
    /* ignore */
  }
  try {
    const child = spawn(
      "claude",
      [
        "-p",
        `Run this exact shell command using the Bash tool: rm -rf ${DEMO_REPO}/build`,
        "--allowedTools",
        "Bash",
        "--permission-mode",
        "default",
      ],
      { cwd: DEMO_REPO, stdio: "ignore" },
    );
    child.on("error", () => {});
    return child;
  } catch {
    return null;
  }
}

// --- capture ----------------------------------------------------------------
await p.goto(URL, { waitUntil: "domcontentloaded" });
await p.waitForSelector('[data-testid="cockpit"]', { timeout: 30000 });
await hold(1500);

if (STAGE) claudeProc = stageApproval(); // card lands ~20-30s later, when we reach the inbox

// 1. Cockpit board (hero)
await boardTab();
await hold(800);
await shot("cockpit-board");

// 2. Live Wall
if (await click('[data-testid="open-wall"]')) {
  await hold(1400);
  await shot("live-wall");
}

// 3. Session detail — liveness (decomposed heartbeats)
await boardTab();
await click('[data-testid="toggle-history"]');
await hold(800);
if (!(await click(`[data-testid="session-row"]:has-text("${SESSION_HINT}")`))) {
  await click('[data-testid="session-row"]');
}
await hold(1200);
await p.evaluate(() => window.scrollTo(0, 0));
await hold(400);
await shot("session-detail");

// 3b. Clean panels (element screenshots — no leaky timeline / other-project paths):
//   - decomposed liveness heartbeats (a key differentiator)
//   - Changes & Risk + per-kind Redaction Breakdown (the redaction value prop)
await elShot('[data-testid="detail-liveness"]', "liveness");
await elShot('[data-testid="risk-pane"]', "redaction-panel");

// 4. Redaction badge — center it, then shoot
{
  const badge = p.getByText(/Secrets detected in this session:\s*[\d,]+/).first();
  await badge.evaluate((e) => e.scrollIntoView({ block: "center" })).catch(() => {});
  await hold(600);
  await shot("redaction");
}

// 5. Approval Inbox — a REAL pending approval if staging worked
await boardTab();
await click('[data-testid="open-inbox"]');
await hold(800);
if (STAGE) {
  let found = false;
  for (let i = 0; i < 20; i++) {
    const btns = await p.$$('[data-testid="approval-deny"]');
    if (btns.length) {
      await btns[0]
        .evaluate((e) => {
          e.scrollIntoView({ block: "center" });
          const card = e.closest('[data-testid="approval-card"], li') || e.parentElement;
          if (card) {
            card.style.outline = "3px solid #f85149";
            card.style.borderRadius = "8px";
          }
        })
        .catch(() => {});
      found = true;
      break;
    }
    await hold(1500);
  }
  if (!found) console.log("[shot] no live pending card — capturing inbox as-is");
}
await hold(500);
await shot("approval-inbox");

// 6. Audit — overview (totals + export)
await boardTab();
await click('[data-testid="open-audit"]');
await hold(700);
await click('[data-testid="audit-load"]');
await hold(1500);
await shot("audit-overview");

// 6b. Cross-vendor proof, scoped to ActraDeck only (filter out other projects so
// the LP asset shows just this repo's claude_code + codex rows in one audit log).
{
  const filter = p.locator('[data-testid="audit-filter-search"]').first();
  if ((await filter.count()) > 0) {
    await filter.fill(AUDIT_FILTER).catch(() => {});
    await hold(1200);
    await shot("audit-actradeck");
    await filter.fill("").catch(() => {});
    await hold(800);
  }
}

// 7. Cross-vendor — highlight a real Codex row in the same audit log
{
  const codexRow = p.locator('[data-testid="audit-row"]:has-text("codex")').first();
  if ((await codexRow.count()) > 0) {
    await codexRow
      .evaluate((e) => {
        e.scrollIntoView({ block: "center" });
        e.style.outline = "3px solid #1f6feb";
        e.style.borderRadius = "8px";
      })
      .catch(() => {});
    await hold(500);
    await shot("cross-vendor");
    await codexRow.evaluate((e) => (e.style.outline = "")).catch(() => {});
  }
}

// 8. Audit detail — a per-session approval + redaction trail
{
  const rows = await p.$$('[data-testid="audit-row"]');
  let opened = false;
  for (let i = 0; i < rows.length && i < 14; i++) {
    await rows[i].click();
    await hold(450);
    const tl = await p.$('[data-testid="audit-detail-timeline"]');
    const liCount = tl ? await tl.$$eval("li", (els) => els.length) : 0;
    if (liCount > 0) {
      opened = true;
      break;
    }
    await p.keyboard.press("Escape").catch(() => {});
    await hold(200);
  }
  if (opened) {
    await hold(600);
    await shot("audit-detail");
  }
  await p.keyboard.press("Escape").catch(() => {});
  await hold(400);
}

// 9. Replay
await boardTab();
await click('[data-testid="toggle-history"]');
await hold(600);
if (!(await click(`[data-testid="session-row"]:has-text("${SESSION_HINT}")`))) {
  await click('[data-testid="session-row"]');
}
await hold(900);
if (await click('[data-testid="open-replay"]')) {
  await hold(1400);
  await shot("replay");
}

await ctx.close();
await b.close();

// cleanup staged agent + throwaway repo
try {
  claudeProc?.kill("SIGTERM");
} catch {
  /* ignore */
}
try {
  rmSync(DEMO_REPO, { recursive: true, force: true });
} catch {
  /* ignore */
}
console.log(`[done] shots in ${OUT}`);
