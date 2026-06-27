#!/usr/bin/env node
// Record a REAL, read-only walkthrough of the running ActraDeck cockpit with
// Playwright, and render it to an MP4 (full walkthrough) plus a short looping
// GIF teaser for inline embedding.
//
// It mostly NAVIGATES the cockpit you already have running (board / live wall /
// session detail / audit / approval inbox / replay) with caption overlays. For
// the approval beat it stages ONE real pending approval: it drives a real Claude
// Code session to a gated `rm -rf` in a throwaway repo (synthetic), which the
// ActraDeck hook blocks, and denies it live on camera. No app data is mocked —
// a pending card only exists while a real agent is blocked. The browser needs no
// secrets (the web UI's BFF authenticates server-side); whatever the cockpit
// shows is already redacted at the sidecar choke point before display.
//
// Language: defaults to English captions + English cockpit UI (the public
// audience is mostly English-speaking). Set CAST_LANG=ja for Japanese.
//
// Prerequisites (kept out of package.json on purpose, like the asciinema setup
// recorder): Playwright + a Chromium, and ffmpeg.
//   npm i -g playwright   # or: pnpm add -Dw playwright
//   npx playwright install chromium
//   (ffmpeg from your package manager)
//
// Usage:
//   node scripts/record-cockpit-cast.mjs [out-basename]
//   CAST_LANG=ja node scripts/record-cockpit-cast.mjs            # Japanese
//   COCKPIT_URL=http://localhost:55400 node scripts/record-cockpit-cast.mjs
//   PLAYWRIGHT_CHROMIUM_PATH=/path/to/chrome node scripts/record-cockpit-cast.mjs
//
// Output (default base docs/media/usage, or docs/media/usage.ja for CAST_LANG=ja):
//   <base>.mp4   full walkthrough (~70s, h264)
//   <base>.gif   short teaser (key beats) for README/getting-started
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtempSync, readdirSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const URL = process.env.COCKPIT_URL || "http://localhost:55400";
const LANG = (process.env.CAST_LANG || "en").toLowerCase() === "ja" ? "ja" : "en";
const OUT_BASE = resolve(
  ROOT,
  process.argv[2] || (LANG === "ja" ? "docs/media/usage.ja" : "docs/media/usage"),
);
const W = 1440,
  H = 900;

// Demo-staging knobs (defaults preserve the original behaviour; override for a
// project-scoped clean-fleet recording where the cockpit is narrowed via
// ACTRADECK_PROJECT_SCOPE so the operator's own session never lands on camera):
//   CAST_DEMO_REPO   throwaway repo for the staged rm -rf approval (must be in scope)
//   CAST_AUDIT_FILTER text to type into the audit filter ("" = show all in-scope rows)
//   CAST_SESSION_HINT substring used to pick the featured session row (liveness/replay)
const DEMO_REPO = process.env.CAST_DEMO_REPO || "/tmp/ad-demo";
const AUDIT_FILTER = process.env.CAST_AUDIT_FILTER ?? "ActraDeck";
const SESSION_HINT = process.env.CAST_SESSION_HINT || "0b7df3b5";

// Redaction badge text differs by cockpit locale — locate the visible badge per lang.
const BADGE = LANG === "ja" ? /秘匿を[\s\d,]+件検出/ : /Secrets detected in this session:\s*[\d,]+/;

// Caption copy (annotation only; the data underneath is real). { t: title, s: subtitle }.
const CAPS = {
  en: {
    intro: {
      t: "Approvals, secrets, and audit for your coding agents",
      s: "Supervise Claude Code and Codex across vendors from one cockpit",
    },
    wall: {
      t: "See every running agent at a glance",
      s: "Each lane shows state, current action, and working directory / repo — what's running where, in one line",
    },
    liveness: {
      t: "Don't assert “stalled” — show the evidence",
      s: "Decomposed heartbeats: process / event / stdout / file / model-stream. One fresh beat means it isn't stalled",
    },
    redaction: {
      t: "Secrets are masked before they're stored or shown",
      s: "Keys, tokens, .env values are never persisted or displayed — only per-kind detection counts remain",
    },
    auditOverview: {
      t: "Audit who allowed or denied what, across sessions",
      s: "Repo, vendor, and redaction counts at a glance. Export JSON / CSV for compliance and incident analysis",
    },
    crossvendor: {
      t: "Claude Code and Codex in one audit trail",
      s: "One event model — observed, redacted, audited across vendors. Codex over Attach is observed; approval relay needs Managed Mode (blue outline = a Codex session)",
    },
    auditDetail: {
      t: "A complete per-session trail",
      s: "Approval events (Bash, risk tier, allow_for_session) and redaction counts — verifiable after the fact",
    },
    inbox: {
      t: "Stop risky operations — a human denies, live",
      s: "One cross-session approval inbox. This Claude Code rm -rf is denied right here (Codex approvals relay in Managed Mode)",
    },
    replay: {
      t: "Replay any session after the fact",
      s: "Step through exactly what happened — for review, incident analysis, and compliance",
    },
    outro: {
      t: "The vendor-neutral control plane for approvals, secrets & audit",
      s: "Start with ./scripts/quickstart, then open http://localhost:55400",
    },
  },
  ja: {
    intro: {
      t: "コーディングエージェントの「承認・秘匿・監査」を1画面で",
      s: "Claude Code も Codex も、ベンダーを横断して同じコックピットで監督する",
    },
    wall: {
      t: "稼働中のエージェントを一目で把握する",
      s: "各レーンに状態・現在の作業・作業ディレクトリ / リポジトリ。どれが今どこで何をしているかが1行で分かる",
    },
    liveness: {
      t: "「止まっている」を断定せず、証拠で示す",
      s: "プロセス / イベント / stdout / ファイル / モデルストリームの鼓動を分解。fresh が1つでも残れば stalled ではない",
    },
    redaction: {
      t: "秘匿情報は「保存・表示の前」にマスクする",
      s: "鍵・トークン・.env の値は保存も表示もしない。UI に残るのは種別ごとの検出件数だけ",
    },
    auditOverview: {
      t: "誰が何を allow / deny したかをセッション横断で監査",
      s: "リポジトリ・ベンダー・秘匿件数を一覧。JSON / CSV でエクスポートしてコンプラ・インシデント分析へ",
    },
    crossvendor: {
      t: "Claude Code も Codex も、同じ1つの監査に集約",
      s: "イベントモデル1本で観測・redaction・監査を横断。Codex は Attach では観測のみ（承認 relay は Managed Mode）。青枠 = Codex セッション",
    },
    auditDetail: {
      t: "セッション単位の完全な証跡",
      s: "承認イベント（Bash・リスク区分・allow_for_session）と redaction 件数を後から検証できる",
    },
    inbox: {
      t: "危険な操作をその場で deny する",
      s: "セッション横断の1つの承認受信箱。この Claude Code の rm -rf をここで拒否（Codex の承認は Managed Mode で relay）",
    },
    replay: {
      t: "セッションを後から再生する",
      s: "レビュー・インシデント分析・コンプライアンスのために、実際に起きたことを時系列で再生",
    },
    outro: {
      t: "「承認・秘匿・監査」を束ねる、ベンダー中立の管制塔",
      s: "./scripts/quickstart で起動 → http://localhost:55400 を開くだけ",
    },
  },
};
const C = CAPS[LANG];

let chromium;
try {
  ({ chromium } = await import("playwright"));
} catch {
  console.error(
    "Playwright not found. Install it, e.g.:\n" +
      "  pnpm add -Dw playwright   (or: npm i -g playwright)\n" +
      "  npx playwright install chromium",
  );
  process.exit(1);
}

// Cockpit must be up (read-only check).
try {
  const r = await fetch(URL, { method: "GET" });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
} catch (e) {
  console.error(
    `Cockpit not reachable at ${URL} (${e.message}). Start the stack first:\n` +
      "  ./scripts/quickstart      (or ./scripts/actradeck up)",
  );
  process.exit(1);
}

const tmp = mkdtempSync(resolve(tmpdir(), "ad-cockpit-rec-"));
const videoDir = resolve(tmp, "video");
mkdirSync(videoDir, { recursive: true });

const b = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
});
const ctx = await b.newContext({
  viewport: { width: W, height: H },
  recordVideo: { dir: videoDir, size: { width: W, height: H } },
  reducedMotion: "reduce",
  // Force the dark cockpit theme on camera: colorScheme covers the "system" theme
  // (prefers-color-scheme: dark), and the ad-theme=dark initScript below pins the
  // explicit toggle. Either alone would do; both guarantee dark even if one path
  // regresses (the prior recording shipped in light because only the initScript was
  // set and the cockpit defaulted to "system" following a light browser preference).
  colorScheme: "dark",
});
// Pin the cockpit locale before first paint (the layout's no-flash script reads this key).
await ctx.addInitScript((lang) => {
  try {
    localStorage.setItem("ad-locale", lang);
    localStorage.setItem("ad-theme", "dark"); // record on the dark cockpit theme
  } catch {
    /* private mode: ignore */
  }
}, LANG);
const p = await ctx.newPage();

// --- caption overlay (annotation only; the data underneath is real) ---------
const marks = [];
let t0 = 0;
async function installCap() {
  await p.addStyleTag({
    content: `
    #adcap{position:fixed;left:0;right:0;bottom:0;z-index:2147483647;
      font-family:system-ui,'Noto Sans CJK JP',sans-serif;pointer-events:none;
      background:linear-gradient(0deg,rgba(8,12,20,.92),rgba(8,12,20,.78) 70%,rgba(8,12,20,0));
      padding:22px 34px 26px;transition:opacity .35s ease;opacity:0;}
    #adcap .t{color:#fff;font-size:30px;font-weight:800;letter-spacing:.5px;line-height:1.25}
    #adcap .s{color:#9fd0ff;font-size:18px;font-weight:600;margin-top:6px;line-height:1.4}
    #adcap .k{display:inline-block;background:#1f6feb;color:#fff;font-size:13px;font-weight:700;
      border-radius:6px;padding:2px 9px;margin-right:10px;vertical-align:middle}`,
  });
  await p.evaluate(() => {
    const d = document.createElement("div");
    d.id = "adcap";
    d.innerHTML = '<div class="t"></div><div class="s"></div>';
    document.body.appendChild(d);
  });
}
async function cap(mark, kicker, title, sub) {
  if (mark) marks.push({ name: mark, t: performance.now() - t0 });
  await p.evaluate(
    ([k, t, s]) => {
      const el = document.getElementById("adcap");
      el.querySelector(".t").innerHTML = (k ? `<span class="k">${k}</span>` : "") + t;
      el.querySelector(".s").textContent = s || "";
      el.style.opacity = "1";
    },
    [kicker, title, sub],
  );
}
async function capOff() {
  await p.evaluate(() => {
    const el = document.getElementById("adcap");
    if (el) el.style.opacity = "0";
  });
}
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

// --- stage a REAL pending approval (M2) -------------------------------------
// Drive a real Claude Code session to a gated `rm -rf` in a throwaway repo. The
// ActraDeck attach hook classifies it high-risk and BLOCKS it, creating a real
// pending approval in the inbox (no mock — the card only exists while a real
// agent is blocked). We deny it live; it also auto-denies safely after ~30s.
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
}

// --- record -----------------------------------------------------------------
await p.goto(URL, { waitUntil: "domcontentloaded" });
await p.waitForSelector('[data-testid="cockpit"]', { timeout: 30000 });
t0 = performance.now();
await hold(1500);
await installCap();

// The gated action is staged JUST BEFORE the inbox segment (below), not here, so the
// pending card is FRESH when we arrive regardless of the recording pace (the block
// auto-denies after ~30s, so staging at t0 desyncs on a slow run).
let claudeProc = null;

// 1. intro — shown over the clean Live Wall. (The board's session-workspace would
// briefly put the local recording command / path on camera, so we open the wall first.)
await click('[data-testid="open-wall"]');
await hold(1000);
await cap("intro", "ActraDeck", C.intro.t, C.intro.s);
await hold(4500);

// 2. Live Wall
await cap(null, "Live Wall", C.wall.t, C.wall.s);
await hold(5000);

// 3. Session detail — liveness as evidence (decomposed heartbeats)
await boardTab();
await click('[data-testid="toggle-history"]');
await hold(800);
if (!(await click(`[data-testid="session-row"]:has-text("${SESSION_HINT}")`))) {
  await click('[data-testid="session-row"]');
}
await hold(1200);
await p.evaluate(() => window.scrollTo(0, 0));
await cap(null, "Liveness", C.liveness.t, C.liveness.s);
await hold(5500);

// 4. Secret redaction — center the badge above the caption band
{
  const badge = p.getByText(BADGE).first();
  await badge.evaluate((e) => e.scrollIntoView({ block: "center" })).catch(() => {});
}
await hold(700);
await cap("redaction", "Redaction", C.redaction.t, C.redaction.s);
await hold(5500);

// Approval inbox (M2) — a REAL pending approval, denied live.
// Stage the gated rm -rf NOW so its card is FRESH when the inbox beat polls (it only
// exists while the agent is blocked, and auto-denies ~30s later). Give claude a few
// seconds to reach the blocked Bash call, then open the inbox and deny on camera.
claudeProc = stageApproval();
await hold(9000);
await boardTab();
await click('[data-testid="open-inbox"]');
await cap(null, "Approval Inbox", C.inbox.t, C.inbox.s);
let denyBtn = null;
for (let i = 0; i < 24; i++) {
  const btns = await p.$$('[data-testid="approval-deny"]');
  if (btns.length) {
    denyBtn = btns[0];
    break;
  }
  await hold(1500);
}
if (denyBtn) {
  await denyBtn
    .evaluate((e) => {
      e.scrollIntoView({ block: "center" });
      const card = e.closest('[data-testid="approval-card"], li') || e.parentElement;
      if (card) {
        card.style.outline = "3px solid #f85149";
        card.style.borderRadius = "8px";
      }
    })
    .catch(() => {});
  await cap("inbox", "Approval Inbox", C.inbox.t, C.inbox.s);
  await hold(2600);
  await denyBtn.click().catch(() => {});
  await hold(2800);
} else {
  // graceful: the card did not materialize in time; show the inbox with caption.
  await cap("inbox", "Approval Inbox", C.inbox.t, C.inbox.s);
  await hold(3000);
}

// 5. Audit — overview (totals + export)
await boardTab();
await click('[data-testid="open-audit"]');
await hold(700);
await click('[data-testid="audit-load"]');
await hold(1400);
// scope the audit to this repo so other local projects never appear on camera.
// (Under ACTRADECK_PROJECT_SCOPE the backend already narrows rows; pass
// CAST_AUDIT_FILTER="" to keep all in-scope rows visible.)
await p
  .locator('[data-testid="audit-filter-search"]')
  .first()
  .fill(AUDIT_FILTER)
  .catch(() => {});
await hold(1100);
await cap(null, "Audit", C.auditOverview.t, C.auditOverview.s);
await hold(4500);

// 6. Cross-vendor highlight: a real Codex session in the same audit log
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
    await hold(400);
    await cap("crossvendor", "Cross-vendor", C.crossvendor.t, C.crossvendor.s);
    await hold(5200);
    await codexRow.evaluate((e) => (e.style.outline = "")).catch(() => {});
  }
}

// 7. Audit detail — open EXACTLY ONE session modal (no open/close churn on camera).
// Pick, by reading the already-rendered approval badges (no clicking), the first row
// that has approval events so its modal timeline is non-empty; fall back to the first
// row (after the ActraDeck filter that is the rich main session). One smooth open.
await cap(null, "Audit", C.auditDetail.t, C.auditDetail.s);
{
  const APPROVAL = LANG === "ja" ? /許可|拒否|承認|却下/ : /Allow|Deny/;
  const withApproval = p.locator('[data-testid="audit-row"]').filter({ hasText: APPROVAL }).first();
  const target =
    (await withApproval.count()) > 0
      ? withApproval
      : p.locator('[data-testid="audit-row"]').first();
  await target.scrollIntoViewIfNeeded().catch(() => {});
  await target.click().catch(() => {});
}
await hold(5200);
await p.keyboard.press("Escape").catch(() => {});
await hold(500);

// 9. Replay
await boardTab();
await click('[data-testid="toggle-history"]');
await hold(600);
if (!(await click(`[data-testid="session-row"]:has-text("${SESSION_HINT}")`))) {
  await click('[data-testid="session-row"]');
}
await hold(900);
await click('[data-testid="open-replay"]');
await hold(1300);
await cap("replay", "Replay", C.replay.t, C.replay.s);
await hold(5500);

// 10. outro
await boardTab();
await capOff();
await hold(400);
await cap(null, "ActraDeck", C.outro.t, C.outro.s);
await hold(4500);
await capOff();
await hold(600);

await ctx.close();
const webm = resolve(
  videoDir,
  readdirSync(videoDir).find((f) => f.endsWith(".webm")),
);
await b.close();

// stop the staged agent (already denied) and clean the throwaway repo.
try {
  claudeProc.kill("SIGTERM");
} catch {
  /* ignore */
}
try {
  rmSync(DEMO_REPO, { recursive: true, force: true });
} catch {
  /* ignore */
}

// --- render -----------------------------------------------------------------
const ff = (args) =>
  execFileSync("ffmpeg", ["-y", ...args], { stdio: ["ignore", "ignore", "inherit"] });
mkdirSync(dirname(OUT_BASE), { recursive: true });
const mp4 = `${OUT_BASE}.mp4`;
const gif = `${OUT_BASE}.gif`;

console.log(`[record] mp4 -> ${mp4}`);
ff([
  "-i",
  webm,
  "-movflags",
  "+faststart",
  "-pix_fmt",
  "yuv420p",
  "-c:v",
  "libx264",
  "-crf",
  "24",
  "-preset",
  "slow",
  mp4,
]);

// Teaser GIF from the real recorded scene offsets (intro / redaction / cross-vendor / replay).
const at = (name) => marks.find((m) => m.name === name)?.t ?? null;
const seg = (name, lead, len) => {
  const t = at(name);
  return t == null ? null : [Math.max(0, t / 1000 - lead), len];
};
const segs = [
  seg("intro", -1, 3),
  seg("inbox", 1.5, 4.5),
  seg("redaction", 1.2, 4),
  seg("crossvendor", 0, 4.5),
].filter(Boolean);
const teaserSrc = resolve(tmp, "teaser.mp4");
if (segs.length) {
  const parts = segs.map(
    ([s, d], i) => `[0:v]trim=${s.toFixed(2)}:${(s + d).toFixed(2)},setpts=PTS-STARTPTS[v${i}]`,
  );
  const concat = segs.map((_, i) => `[v${i}]`).join("") + `concat=n=${segs.length}:v=1:a=0[out]`;
  ff([
    "-i",
    webm,
    "-filter_complex",
    `${parts.join(";")};${concat}`,
    "-map",
    "[out]",
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    "-crf",
    "22",
    teaserSrc,
  ]);
} else {
  copyFileSync(webm, teaserSrc); // fallback: whole thing
}
console.log(`[record] gif  -> ${gif}`);
const pal = resolve(tmp, "pal.png");
ff(["-i", teaserSrc, "-vf", "fps=9,scale=820:-1:flags=lanczos,palettegen=stats_mode=diff", pal]);
ff([
  "-i",
  teaserSrc,
  "-i",
  pal,
  "-lavfi",
  "fps=9,scale=820:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4",
  gif,
]);

rmSync(tmp, { recursive: true, force: true });
console.log("[record] done.");
