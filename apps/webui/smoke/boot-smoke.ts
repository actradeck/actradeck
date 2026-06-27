/**
 * Boot smoke (CI gate) — 実起動して endpoint が応答することを検証する.
 *
 * 監査の死角 (QA-3 "server.ts は 0 runtime coverage"): SEC/QA/TDA は pure fn + fake socket +
 * `next build` のみ検証し **サーバ実行時を一度も起動しなかった**。その結果「型/build/test 緑なのに
 * 実行時にサーバが起動しない」class の defect (webui server.ts の prepare 順 / backend index.ts の
 * main-guard 欠落) が committed/予定コードに残った。本 smoke は **実プロセスを実起動** して二度と
 * 見逃さないよう CI gate 化する。
 *
 * 何を実起動するか (REAL DATA ONLY — モック無し):
 *  - 実 PostgreSQL (DATABASE_URL)。
 *  - backend を **本番 start スクリプト** (`node --import tsx src/index.ts`, main-guard 経由) で
 *    空きポート (port=0) に実起動。`POST /ingest` 無認証 → **401** (認証ゲート生存)。
 *  - webui を **本番 server.ts** (`NODE_ENV=production`, app.prepare() → listen) で空きポートに
 *    実起動。`GET /` → **200** / 配信 HTML に REALTIME_TOKEN/Bearer が **出ない** /
 *    `ws://<webui>/realtime/ws` にブラウザ風 (認証ヘッダ無し) 接続 → BFF が Bearer 中継 →
 *    backend から `snapshot.list` フレーム受信。
 *
 * ポート衝突回避: 稼働中 dev サーバ (:55400/:55410) と衝突しないよう **port=0 (ephemeral)** で
 * 起動し、起動ログ/poll で実ポートを取得する (固定 sleep に頼りすぎない)。distDir も env で
 * 分離し dev の .next を壊さない。
 *
 * DB 不在: silent skip 禁止 (偽緑回避)。CI (CI=true) では明示 throw、ローカルは到達不能なら
 * 明示 throw して理由を出す (db/backend の既存 CI guard と同流儀: 走らせると決めたら実走させる)。
 *
 * teardown: backend/webui child を確実に kill しポートを解放する。DB は破壊しない (読み取りのみ)。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

import { WebSocket } from "ws";

const here = dirname(fileURLToPath(import.meta.url));
const webuiDir = resolve(here, ".."); // apps/webui
const repoRoot = resolve(webuiDir, "../.."); // repo root
const backendDir = resolve(repoRoot, "apps/backend");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  // silent skip 禁止: DB が無ければ smoke は意味を成さない。明示 throw で可視化する。
  throw new Error(
    "[boot-smoke] DATABASE_URL is required (real PostgreSQL). " +
      "Set it (CI provides it; locally use repo .env). Refusing to silently skip a runtime gate.",
  );
}

// ephemeral secrets (この実行限り)。secret は stdout に出さない。
const INGEST_TOKEN = randomBytes(32).toString("hex");
const REALTIME_TOKEN = randomBytes(32).toString("hex");

// redaction-first (SEC-1): 失敗時の err.message は子プロセスの stdout/stderr を内包し得る。
// 万一そこに ephemeral token が紛れても CI ログに出さないよう、ログ直前に値を伏せる。
const scrubSecrets = (s: string): string =>
  s.split(INGEST_TOKEN).join("[redacted]").split(REALTIME_TOKEN).join("[redacted]");

const children: ChildProcess[] = [];

/**
 * 空きポートを 1 つ確保して返す (loopback の :0 に bind → 割り当て port を読む → close)。
 * 稼働中 dev サーバ (:55400/:55410) との衝突を避けつつ、各サービスの port=0 解釈差
 * (webui の resolveWebuiPort は 0 を不正値として既定 55400 へ落とす) に依存しないため
 * 具体的な空きポートを smoke 側で決めて渡す。
 */
function findFreePort(): Promise<number> {
  return new Promise((resolveP, rejectP) => {
    const srv = createServer();
    srv.once("error", rejectP);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address() as AddressInfo;
      const port = addr.port;
      srv.close(() => resolveP(port));
    });
  });
}

/** child を spawn し、stdout/stderr を行配列に蓄積する (secret はログに出さない)。 */
function spawnService(
  name: string,
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): { child: ChildProcess; lines: string[] } {
  const lines: string[] = [];
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const onData = (buf: Buffer): void => {
    for (const line of buf.toString("utf8").split("\n")) {
      if (line.trim()) lines.push(`[${name}] ${line}`);
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.on("exit", (code, signal) => {
    lines.push(`[${name}] exited code=${code ?? "null"} signal=${signal ?? "null"}`);
  });
  return { child, lines };
}

/** ログ行から `http://host:port` を正規表現で待ち受け、実ポートを返す (固定 sleep に依存しない)。 */
async function waitForPort(
  lines: string[],
  re: RegExp,
  label: string,
  timeoutMs = 60_000,
): Promise<{ host: string; port: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const line of lines) {
      const m = re.exec(line);
      if (m && m[1] && m[2]) {
        return { host: m[1], port: Number(m[2]) };
      }
      // TDA-2: 失敗検知は実 console.error の marker (`[backend] failed to start:` /
      // `[webui] fatal:`) の `] <marker>:` 境界に限定する。素の `Error:` 部分文字列を拾うと
      // 将来の info ログで偽失敗 (flaky red) になりうるため広域マッチを避ける。
      if (/\] (?:failed to start|fatal):/.test(line)) {
        throw new Error(`[boot-smoke] ${label} reported failure before listening:\n${line}`);
      }
    }
    await delay(250);
  }
  throw new Error(
    `[boot-smoke] timed out waiting for ${label} to listen.\nlogs:\n${lines.join("\n")}`,
  );
}

/** HTTP リクエストを投げ status/body を返す最小ヘルパ (依存追加しない)。 */
function httpGet(
  host: string,
  port: number,
  path: string,
  method = "GET",
  body?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolveP, rejectP) => {
    const req = request(
      { host, port, path, method, headers: body ? { "content-type": "application/json" } : {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolveP({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", rejectP);
    if (body) req.write(body);
    req.end();
  });
}

const assertions: string[] = [];
function check(label: string, cond: boolean, detail = ""): void {
  if (!cond) throw new Error(`[boot-smoke] FAIL: ${label} ${detail}`);
  assertions.push(`PASS: ${label}${detail ? ` (${detail})` : ""}`);
}

async function teardown(): Promise<void> {
  for (const child of children) {
    if (child.exitCode === null && !child.killed) {
      child.kill("SIGTERM");
    }
  }
  // SIGTERM が効かない場合の保険 (短い猶予 → SIGKILL)。
  await delay(500);
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
  }
}

async function main(): Promise<void> {
  // 稼働中 dev サーバ (:55400/:55410) と衝突しない空きポートを smoke 側で確保する。
  const backendPort = await findFreePort();
  const webuiPort = await findFreePort();

  // --- backend: 本番 start スクリプト形 (main-guard 経由) で起動 ---
  const backend = spawnService("backend", backendDir, ["--import", "tsx", "src/index.ts"], {
    ...process.env,
    DATABASE_URL,
    INGEST_TOKEN,
    REALTIME_TOKEN,
    ACTRADECK_BACKEND_PORT: String(backendPort),
    ACTRADECK_BACKEND_HOST: "127.0.0.1",
  });
  // index.ts の "[backend] ingestion server ready on http://host:port"
  const be = await waitForPort(
    backend.lines,
    /\[backend\] ingestion server ready on http:\/\/([^:]+):(\d+)/,
    "backend",
  );
  check("backend main-guard fired and listened", be.port > 0, `port=${be.port}`);

  // (a) POST /ingest 無認証 → 401 (認証ゲート生存)
  const ingestNoAuth = await httpGet(be.host, be.port, "/ingest", "POST", "{}");
  check(
    "POST /ingest without auth → 401",
    ingestNoAuth.status === 401,
    `got ${ingestNoAuth.status}`,
  );

  // --- webui: 本番 server.ts (prepare → listen) を port=0 起動 ---
  const backendWsUrl = `ws://${be.host}:${be.port}/realtime/ws`;
  const webui = spawnService("webui", webuiDir, ["--import", "tsx", "server.ts"], {
    ...process.env,
    NODE_ENV: "production",
    REALTIME_TOKEN, // server-side のみ。HTML に出ないことを後で検証
    BACKEND_REALTIME_WS_URL: backendWsUrl,
    ACTRADECK_WEBUI_PORT: String(webuiPort),
    ACTRADECK_WEBUI_HOST: "127.0.0.1",
    ACTRADECK_WEBUI_DIST_DIR: process.env.ACTRADECK_WEBUI_DIST_DIR ?? ".next-smoke",
  });
  // server.ts の "[webui] ready on http://host:port"
  const web = await waitForPort(
    webui.lines,
    /\[webui\] ready on http:\/\/([^:]+):(\d+)/,
    "webui",
    120_000, // prepare() の初回コンパイルを許容
  );
  check("webui prepare() completed and listened", web.port > 0, `port=${web.port}`);

  // (b) GET / → 200
  const home = await httpGet(web.host, web.port, "/");
  check("GET / → 200", home.status === 200, `got ${home.status}`);

  // (c) 配信 HTML に REALTIME_TOKEN / Bearer が出ない (token 非露出)
  const tokenInHtml = home.body.includes(REALTIME_TOKEN);
  const bearerInHtml = /bearer/i.test(home.body);
  check("served HTML does NOT contain REALTIME_TOKEN", !tokenInHtml);
  check("served HTML does NOT contain 'Bearer'", !bearerInHtml);

  // (d) ブラウザ風 (認証ヘッダ無し) で /realtime/ws に接続 → BFF が Bearer 中継 →
  //     backend から snapshot.list を受信
  const snapshot = await new Promise<{ type: string }>((resolveP, rejectP) => {
    // 認証ヘッダを **付けない** (ブラウザ native WS を模す)。BFF が server-side で Bearer を足す。
    const ws = new WebSocket(`ws://${web.host}:${web.port}/realtime/ws`);
    const to = setTimeout(() => {
      ws.close();
      rejectP(new Error("timed out waiting for snapshot.list frame from BFF relay"));
    }, 15_000);
    ws.on("message", (data: Buffer) => {
      try {
        const frame = JSON.parse(data.toString("utf8")) as { type: string };
        if (frame.type === "snapshot.list") {
          clearTimeout(to);
          ws.close();
          resolveP(frame);
        }
      } catch {
        // 非 JSON は無視
      }
    });
    ws.on("error", (err) => {
      clearTimeout(to);
      rejectP(err);
    });
  });
  check(
    "headerless browser WS → BFF Bearer relay → backend snapshot.list received",
    snapshot.type === "snapshot.list",
  );

  console.log("[boot-smoke] all assertions passed:");
  for (const a of assertions) console.log(`  ${scrubSecrets(a)}`);
}

main()
  .then(async () => {
    await teardown();
    console.log("[boot-smoke] OK");
    process.exit(0);
  })
  .catch(async (err: unknown) => {
    console.error("[boot-smoke]", scrubSecrets((err as Error).message));
    await teardown();
    process.exit(1);
  });
