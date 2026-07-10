#!/usr/bin/env node
/**
 * ActraDeck 公開取込コントラクト — 最小の実働アダプタ例 (ADR 019f2d2c D6)。
 *
 * 任意の外部コーディングツール/CLI の **stdout 行**を ActraDeck の NormalizedEvent へ写像し、
 * backend の `POST /ingest` へ直接送る、依存ゼロ (Node 組込みのみ) の単一ファイル実装。
 *
 * これは公開契約 (docs/ingestion-contract.md) に沿った「自分でツールを ActraDeck に載せる」
 * 最小テンプレートです。provider は自分のツールの **slug** (WHO)、source は **external** (HOW) を使います。
 *
 * 使い方 (詳細は README.md):
 *   export INGEST_TOKEN=...            # backend の INGEST_TOKEN と一致させる
 *   export ACTRADECK_INGEST_URL=http://127.0.0.1:PORT
 *   export ACTRADECK_PROVIDER=my_tool  # 省略時 example_tool (slug ^[a-z][a-z0-9_-]{0,31}$)
 *   my-cli --do-stuff | node adapter.mjs "my-cli --do-stuff"
 *
 * 写像:
 *   起動時         -> session.started + command.started
 *   stdout 1 行毎  -> command.output.delta
 *   EOF (正常/失敗) -> command.completed + session.ended
 *
 * NOTE: これはあくまで最小例です。ActraDeck 側の ingress redaction 床が保存前に secret を
 * マスクしますが (docs/ingestion-contract.md §5)、アダプタ側でも不要な機微情報は送らないのが安全です。
 */
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";

// --- 設定 (環境変数) --------------------------------------------------------
const INGEST_URL = (process.env.ACTRADECK_INGEST_URL ?? "http://127.0.0.1:55410").replace(/\/$/, "");
const INGEST_TOKEN = process.env.INGEST_TOKEN ?? "";
const PROVIDER = process.env.ACTRADECK_PROVIDER ?? "example_tool";
const COMMAND_LABEL = process.argv[2] ?? "external tool run";
const SESSION_ID =
  process.env.ACTRADECK_SESSION ?? `${PROVIDER}-${Date.now()}-${randomBytes(3).toString("hex")}`;

const PROVIDER_SLUG_RE = /^[a-z][a-z0-9_-]{0,31}$/;
if (!PROVIDER_SLUG_RE.test(PROVIDER)) {
  console.error(
    `[adapter] provider "${PROVIDER}" は slug ^[a-z][a-z0-9_-]{0,31}$ を満たしません。ActraDeck に reject されます。`,
  );
  process.exit(2);
}
if (!INGEST_TOKEN) {
  console.error("[adapter] INGEST_TOKEN が未設定です (backend の Bearer トークンを指定してください)。");
  process.exit(2);
}

// --- UUIDv7 採番 (event_id 必須・依存ゼロ実装) ------------------------------
// ActraDeck の event_id は UUIDv7 のみ受理 (crypto.randomUUID は v4 で reject される)。
// 相互参照: UUIDv7 自前実装はリポジトリ内 4 箇所 (opencode / gemini / 本 ingest adapter + packages/event-model/src/id.ts・T1 正典)。
function uuidv7() {
  const ms = Date.now();
  const b = randomBytes(16);
  b[0] = Math.floor(ms / 2 ** 40) & 0xff;
  b[1] = Math.floor(ms / 2 ** 32) & 0xff;
  b[2] = Math.floor(ms / 2 ** 24) & 0xff;
  b[3] = Math.floor(ms / 2 ** 16) & 0xff;
  b[4] = Math.floor(ms / 2 ** 8) & 0xff;
  b[5] = ms & 0xff;
  b[6] = (b[6] & 0x0f) | 0x70; // version 7
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// --- NormalizedEvent 組み立て + 送信 ---------------------------------------
/** 共通フィールドを持つ NormalizedEvent を作る (provider=slug / source=external)。 */
function makeEvent(eventType, extra = {}) {
  return {
    event_id: uuidv7(),
    provider: PROVIDER,
    source: "external",
    session_id: SESSION_ID,
    event_type: eventType,
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

/** 1 イベントを POST /ingest へ送る。ack を返す (失敗時は throw)。 */
async function ingest(event) {
  const res = await fetch(`${INGEST_URL}/ingest`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify(event),
  });
  const body = await res.json().catch(() => ({}));
  const ack = Array.isArray(body?.results) ? body.results[0] : undefined;
  if (!res.ok || !ack?.ok) {
    throw new Error(`ingest failed (HTTP ${res.status}): ${ack?.error ?? JSON.stringify(body)}`);
  }
  return ack;
}

// --- メイン: stdin を読み、行を event へ写像して送る ------------------------
async function main() {
  await ingest(makeEvent("session.started", { summary: `${PROVIDER} セッション開始` }));
  await ingest(
    makeEvent("command.started", {
      state: "running.command_executing",
      summary: COMMAND_LABEL,
      payload: { kind: "command.started", command: COMMAND_LABEL, risk_level: "low" },
    }),
  );

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let lines = 0;
  for await (const line of rl) {
    lines += 1;
    // 各行 = ツール stdout の 1 チャンク。delta として流す (原文は保存前に redaction される)。
    process.stdout.write(line + "\n"); // pass-through: 端末表示は保つ
    await ingest(
      makeEvent("command.output.delta", {
        payload: { kind: "command.output.delta", stream: "stdout", delta: line },
      }),
    );
  }

  await ingest(
    makeEvent("command.completed", {
      state: "running.model_wait",
      summary: `${COMMAND_LABEL} 完了 (${lines} 行)`,
      payload: { kind: "command.completed", exit_code: 0 },
    }),
  );
  await ingest(
    makeEvent("session.ended", { state: "completed", summary: `${PROVIDER} セッション終了` }),
  );

  console.error(`[adapter] done: session=${SESSION_ID} provider=${PROVIDER} lines=${lines}`);
}

main().catch((err) => {
  console.error(`[adapter] error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
