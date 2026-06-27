/**
 * Deterministic hook-replay E2E — 実 HTTP / 実 SQLite / 実 WS を貫通させる。
 *
 * claude -p mode は hook 配信が非決定的 (PostToolUse が落ちる / SessionStart が出ない)
 * ため、ここでは「実際に claude が送る hook JSON 形状」(probe で採取) を実 HTTP で
 * receiver に POST し、全 hook 種別が NormalizedEvent へ正規化され redaction→SQLite→WS
 * sink まで到達することを決定的に検証する。payload は実形状・モックではない。
 *
 * 実行: pnpm --filter @actradeck/sidecar exec tsx e2e/run-hook-replay-e2e.mts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Sidecar } from "../src/sidecar.js";
import { HOOK_TOKEN_HEADER } from "../src/settings-injection.js";
import { VerificationWsSink } from "../src/ws-sink.js";

const FAKE = "AKIAIOSFODNN7EXAMPLE";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 実 claude が送る hook JSON 形状 (probe 2026-06 で採取した shape)。
// permission_mode: "bypassPermissions" — 実 claude セッションは全 hook に permission_mode を載せる。
// ここでは bypassPermissions (純観測モード) を再現する: approval-bridge は bypass のとき承認ゲートを
// defer する (decision 019eace6) ため、承認者不在の決定論的 replay でも PreToolUse が承認 timeout で
// deny されず command.started が emit される (承認カードは出ない)。redaction は permission_mode 非依存
// ゆえ FAKE secret のマスク検証はそのまま成立する。承認ゲート経路そのものの検証は approval-bridge の
// unit テストと inv-redaction-e2e.test.ts が担う (役割分担)。
const SESSION = "replay_sess_1";
const BYPASS = { permission_mode: "bypassPermissions" } as const;
const HOOK_SEQUENCE: Array<Record<string, unknown>> = [
  {
    session_id: SESSION,
    hook_event_name: "SessionStart",
    cwd: process.cwd(),
    source: "startup",
    model: "claude-sonnet-4-6",
    ...BYPASS,
  },
  {
    session_id: SESSION,
    hook_event_name: "UserPromptSubmit",
    cwd: process.cwd(),
    prompt: `echo ${FAKE}`,
    ...BYPASS,
  },
  {
    session_id: SESSION,
    hook_event_name: "PreToolUse",
    cwd: process.cwd(),
    tool_name: "Bash",
    tool_input: { command: `echo "${FAKE}"` },
    ...BYPASS,
  },
  {
    session_id: SESSION,
    hook_event_name: "PostToolUse",
    cwd: process.cwd(),
    tool_name: "Bash",
    tool_input: { command: `echo "${FAKE}"` },
    tool_response: `${FAKE}\n`,
    ...BYPASS,
  },
  { session_id: SESSION, hook_event_name: "Stop", cwd: process.cwd(), ...BYPASS },
  {
    session_id: SESSION,
    hook_event_name: "SessionEnd",
    cwd: process.cwd(),
    reason: "other",
    ...BYPASS,
  },
];

async function postHook(
  endpoint: string,
  body: Record<string, unknown>,
  token: string,
): Promise<unknown> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", [HOOK_TOKEN_HEADER]: token },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function main(): Promise<void> {
  const sink = new VerificationWsSink();
  await sink.listen();
  const dbDir = mkdtempSync(join(tmpdir(), "actradeck-replay-"));
  const sidecar = new Sidecar({
    sessionId: SESSION,
    wsUrl: sink.url,
    dbPath: join(dbDir, "sidecar.db"),
    cwd: process.cwd(),
  });
  const { hookEndpoint } = await sidecar.start();

  for (const h of HOOK_SEQUENCE) {
    const resp = await postHook(hookEndpoint, h, sidecar.hookAuthToken);
    console.error(`[replay] ${String(h.hook_event_name)} → resp=${JSON.stringify(resp)}`);
  }
  await sleep(500);
  await sidecar.shutdown();
  await sleep(300);

  const events = sink.received.map((r) => r.event as Record<string, unknown>);
  const types = events.map((e) => String(e.event_type));
  const allJson = sink.received.map((r) => r.raw).join("\n");

  console.log("\n========== HOOK-REPLAY E2E REPORT ==========");
  console.log("events at sink:", events.length);
  for (const e of events) {
    console.log(
      `  ${String(e.event_type).padEnd(28)} state=${String(e.state ?? "-")} :: ${String(e.summary ?? "")}`,
    );
  }
  const required = [
    "session.started",
    "turn.started",
    "command.started",
    "command.completed",
    "turn.completed",
    "session.ended",
  ];
  console.log("\n--- MINIMAL TIMELINE ---");
  for (const r of required)
    console.log(`  ${r.padEnd(20)} ${types.includes(r) ? "present ✅" : "MISSING ❌"}`);
  console.log("\n--- REDACTION ---");
  const leak = allJson.includes(FAKE);
  console.log(`fake secret at sink: ${leak ? "LEAK ❌" : "masked ✅"}`);
  console.log(`[REDACTED:*] present: ${allJson.includes("[REDACTED:") ? "yes ✅" : "no"}`);
  console.log("============================================\n");

  const allPresent = required.every((r) => types.includes(r));
  if (leak || !allPresent) process.exit(3);
  process.exit(0);
}

void main().catch((e: unknown) => {
  console.error("[replay] fatal:", e);
  process.exit(1);
});
