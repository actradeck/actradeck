#!/usr/bin/env node
/** Read aggregate local usage from the authenticated loopback backend. */
import { pathToFileURL } from "node:url";

import { backendOrigin } from "./lib/backend-origin.mjs";

export function parseArgs(argv) {
  let since = "30d";
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") json = true;
    else if (arg === "--since") {
      since = argv[++i];
      if (!since) throw new Error("--since requires 30d or YYYY-MM-DD");
    } else if (arg.startsWith("--since=")) since = arg.slice("--since=".length);
    else throw new Error(`unknown option: ${arg}`);
  }
  return { since, json };
}

function percent(part, whole) {
  return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "n/a";
}

function printHuman(report) {
  const t = report.totals;
  const lines = [
    `ActraDeck local usage (${report.from}..${report.to}, ${report.timezone})`,
    `Observed real sessions:   ${t.real_sessions}`,
    `Protected sessions:       ${t.protected_sessions} (${percent(t.protected_sessions, t.real_sessions)})`,
    `Approval requests:        ${t.approval_requests}`,
    `Operator decisions:       ${t.operator_decisions} (${percent(t.operator_decisions, t.approval_requests)})`,
    `Cockpit demos completed:  ${t.cockpit_demo_completed}/${t.cockpit_demo_started}`,
    "",
    "Counts are local aggregates, not users. Demo sessions are excluded from real/protected sessions.",
    "Protected counts only sessions whose start was observed with governance evidence;",
    "sessions from before the governance-mode upgrade (or discovered mid-flight) stay unclassified.",
    "The classification is start-time: a session switched to bypassPermissions mid-run keeps its",
    "protected count (over-count direction), and managed Codex declares enforcement as a constant.",
    "See docs/usage-metrics.md (Honest boundaries) for both directions.",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.REALTIME_TOKEN;
  if (!token) throw new Error("REALTIME_TOKEN is missing; configure .env first");
  const url = new URL(`${backendOrigin()}/realtime/usage`);
  url.searchParams.set("since", args.since);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
    throw new Error(`usage endpoint failed: ${reason}`);
  }
  if (args.json) process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  else printHuman(body);
}

// entrypoint guard (telemetry.mjs と同型): import (テスト) では実行しない。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      `actradeck usage: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
