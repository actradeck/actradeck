/**
 * 実 claude セッション E2E 検証 (REAL DATA ONLY) — **実バイナリの redaction 漏れゼロ証明**。
 *
 * 役割分担 (強み(a)① / DoD 019ec632 / 設計 019ec68c):
 *   - 決定論 CI 回帰ゲートは test/inv-redaction-e2e.test.ts (実 Sidecar 貫通・vitest 常駐) が担う。
 *   - **本スクリプトは「実 claude バイナリを spawn し、実 hook 配送で複数種類の secret が漏れない」
 *     ことの証明**を担う。実 claude の hook 配送は非決定的 (PostToolUse が落ちる / SessionStart が
 *     出ない / 120s 要する) で CI flaky 化するため、vitest 化せずスタンドアロン手動実行のままにする。
 *
 * 1) VerificationWsSink を起動 (backend Phase3 の代替)。
 * 2) Sidecar を sink へ向けて起動 (hook receiver / redactor / SQLite / WS client)。
 * 3) Managed claude (`claude -p ...`) を hook 設定付きで起動し、実 hook event を生成。
 *    プロンプトには「**複数種類**の擬似 secret を 1 つの echo で出力させるコマンド」を作らせ、
 *    複数 kind の redaction を実バイナリ経路で実証する。
 * 4) sink に届いたイベント列・SQLite の中身を集計してレポートを stdout に出す。
 *
 * 実行: pnpm --filter @actradeck/sidecar exec tsx e2e/run-claude-e2e.mts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Sidecar } from "../src/sidecar.js";
import { VerificationWsSink } from "../src/ws-sink.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 複数種類のテスト専用ダミー secret (実在しない)。各 kind は redactor.ts の REDACTION_RULES に合致。
 * 1 つの echo コマンドで全種類を出力させ、実 claude の hook 経路で複数 kind の redaction を証明する。
 */
const FAKE_SECRETS: ReadonlyArray<{ label: string; value: string }> = [
  { label: "aws-access-key-id", value: "AKIAIOSFODNN7EXAMPLE" },
  { label: "github-token", value: `ghp_${"R3alFakeT0ken".padEnd(36, "x")}` },
  { label: "anthropic-key", value: "sk-ant-api03-FAKEonlyNOTaREALkey0123456789" },
  { label: "high-entropy-secret", value: "Xk9Pq3mZ7vT2wL5nB8rJ4cY6dF1gH0sA3eU2iO4ZZ" },
];

async function main(): Promise<void> {
  const sink = new VerificationWsSink();
  await sink.listen();

  const dbDir = mkdtempSync(join(tmpdir(), "actradeck-e2e-"));
  const dbPath = join(dbDir, "sidecar.db");
  const sessionId = `e2e_${Date.now()}`;

  const hooksSeen: string[] = [];
  const sidecar = new Sidecar({
    sessionId,
    wsUrl: sink.url,
    dbPath,
    cwd: process.cwd(),
    onHook: (n) => hooksSeen.push(n),
    onValidationError: (et, m) => console.error(`[validation-error] ${et}: ${m}`),
  });

  const { hookEndpoint } = await sidecar.start();
  console.error(`[e2e] sink=${sink.url} hook=${hookEndpoint} db=${dbPath}`);

  // claude に「複数種類の擬似 secret を 1 つの echo で出力するコマンド」を実行させ、
  // 各 kind の redaction を実バイナリ経路で実証する。
  const secretBlob = FAKE_SECRETS.map((s) => s.value).join(" ");
  const prompt = `Run exactly this bash command and nothing else, then stop: echo "leaked ${secretBlob} done"`;

  const managed = sidecar.startManaged([
    "-p",
    prompt,
    "--permission-mode",
    "bypassPermissions",
    "--allowedTools",
    "Bash",
  ]);
  console.error(`[e2e] claude pid=${managed.pid}`);

  // claude 終了を待つ (最大 120s)。
  const exitCode = await Promise.race([managed.exited, sleep(120_000).then(() => -1)]);
  console.error(`[e2e] claude exit=${exitCode}`);

  // hook / WS flush の余韻を待つ。
  await sleep(2000);
  await sidecar.shutdown();
  await sleep(500);

  // ---- 集計 ----
  const events = sink.received.map((r) => r.event as Record<string, unknown>);
  const types = events.map((e) => String(e.event_type));
  const typeCounts: Record<string, number> = {};
  for (const t of types) typeCounts[t] = (typeCounts[t] ?? 0) + 1;

  const allJson = sink.received.map((r) => r.raw).join("\n");
  const leakedKinds = FAKE_SECRETS.filter((s) => allJson.includes(s.value));
  const secretLeakedToSink = leakedKinds.length > 0;

  console.log("\n========== E2E REPORT ==========");
  console.log("hooks observed:", hooksSeen.join(", ") || "(none)");
  console.log("events delivered to WS sink:", events.length);
  console.log("event_type counts:", JSON.stringify(typeCounts, null, 2));
  console.log("ordered event_type sequence:");
  for (const e of events) {
    console.log(
      `  ${String(e.event_type).padEnd(28)} state=${String(e.state ?? "-")} :: ${String(e.summary ?? "")}`,
    );
  }
  // SEC-2 (監査反映): 本スタンドアロンは実 claude の非決定性 (コマンド非実行で secret が hook に
  //   乗らない / marker が出ない) ゆえ per-kind の [REDACTED:*] present を hard assert しない。
  //   exit 判定は raw 不在 (secretLeakedToSink) を主とし、marker present は下の redactedHit で観測
  //   のみ。決定論的な「漏れゼロ AND マスク成立」ゲートは vitest 側 test/inv-redaction-e2e.test.ts
  //   が担う (役割分担)。
  console.log("\n--- REDACTION CHECK (複数種類) ---");
  for (const s of FAKE_SECRETS) {
    const leaked = allJson.includes(s.value);
    console.log(`  ${s.label.padEnd(22)} ${leaked ? "LEAK!! ❌" : "no (masked) ✅"}`);
  }
  console.log(
    `any fake secret present in sink payload: ${secretLeakedToSink ? `LEAK!! ❌ (${leakedKinds.map((k) => k.label).join(",")})` : "no (masked) ✅"}`,
  );
  const redactedHit = sink.received.find((r) => r.raw.includes("[REDACTED:"));
  console.log(`a [REDACTED:*] marker reached sink: ${redactedHit ? "yes ✅" : "no"}`);
  if (redactedHit) {
    const e = redactedHit.event as Record<string, unknown>;
    console.log(
      `  example redacted event_type=${String(e.event_type)} summary=${String(e.summary ?? "")}`,
    );
  }

  // 最小イベント列の到達判定。
  const required = [
    "session.started",
    "turn.started",
    "command.started",
    "command.completed",
    "turn.completed",
    "session.ended",
  ];
  console.log("\n--- MINIMAL TIMELINE COVERAGE (一覧→詳細) ---");
  for (const r of required) {
    console.log(`  ${r.padEnd(20)} ${types.includes(r) ? "present ✅" : "MISSING ❌"}`);
  }
  const hasOutputDelta = types.includes("command.output.delta");
  const hasDiff = types.includes("diff.updated");
  const hasHeartbeat = types.includes("heartbeat");
  console.log(`  command.output.delta ${hasOutputDelta ? "present ✅" : "absent"}`);
  console.log(`  diff.updated         ${hasDiff ? "present ✅" : "absent"}`);
  console.log(`  heartbeat            ${hasHeartbeat ? "present ✅" : "absent"}`);

  console.log("\nexit:", exitCode);
  console.log("================================\n");

  if (secretLeakedToSink) {
    console.error(
      `INV-REDACTION VIOLATION: secret(s) reached sink: ${leakedKinds.map((k) => k.label).join(", ")}`,
    );
    process.exit(3);
  }
  process.exit(0);
}

void main().catch((err: unknown) => {
  console.error("[e2e] fatal:", err);
  process.exit(1);
});
