#!/usr/bin/env node
/** Local control plane for explicit anonymous telemetry consent. */
import { pathToFileURL } from "node:url";

import { backendOrigin } from "./lib/backend-origin.mjs";

const ACTIONS = new Set(["status", "preview", "enable", "disable", "reset-id", "flush"]);

export function parseArgs(argv) {
  const action = argv[0] ?? "status";
  if (!ACTIONS.has(action)) throw new Error(`unknown action: ${action}`);
  let endpoint;
  let json = false;
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") json = true;
    else if (arg === "--endpoint") {
      endpoint = argv[++index];
      if (!endpoint) throw new Error("--endpoint requires an HTTPS URL");
    } else if (arg.startsWith("--endpoint=")) endpoint = arg.slice("--endpoint=".length);
    else throw new Error(`unknown option: ${arg}`);
  }
  if (endpoint !== undefined && action !== "enable") {
    throw new Error("--endpoint is only valid with enable");
  }
  return { action, endpoint, json };
}

// 単一出所 (scripts/lib/backend-origin.mjs) から re-export (既存 import/テスト互換)。
export { backendOrigin };

function humanStatus(status) {
  const lines = [
    `Anonymous telemetry: ${status.mode === "anonymous" ? "enabled" : "off"}`,
    status.endpoint
      ? `Collector: ${status.endpoint}`
      : status.offered_endpoint
        ? `Collector offered on enable: ${status.offered_endpoint}`
        : "Collector: not configured",
    status.installation_id ? `Installation ID: ${status.installation_id}` : null,
    status.last_success_at ? `Last successful send: ${status.last_success_at}` : null,
    "",
    "Collected after opt-in:",
    ...(Array.isArray(status.collects) ? status.collects.map((item) => `  - ${item}`) : []),
    "Never collected:",
    ...(Array.isArray(status.excludes) ? status.excludes.map((item) => `  - ${item}`) : []),
  ].filter((line) => line !== null);
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const token = process.env.REALTIME_TOKEN;
  if (!token) throw new Error("REALTIME_TOKEN is missing; configure .env first");
  const suffix = args.action === "status" ? "" : `/${args.action}`;
  const method = args.action === "status" || args.action === "preview" ? "GET" : "POST";
  const response = await fetch(`${backendOrigin()}/realtime/telemetry${suffix}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
    },
    ...(method === "POST"
      ? { body: JSON.stringify(args.endpoint ? { endpoint: args.endpoint } : {}) }
      : {}),
    signal: AbortSignal.timeout(5_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
    throw new Error(reason);
  }
  if (args.json || args.action === "preview" || args.action === "flush") {
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
  } else {
    humanStatus(body);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      `actradeck telemetry: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
