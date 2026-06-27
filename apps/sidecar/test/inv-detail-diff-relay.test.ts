/**
 * 段階2 (ADR 019ea4ba D2-B) diff 本文 round-trip relay の不変条件 — REAL WS + REAL git。
 *
 * 縛る不変条件:
 *  - INV-DETAIL-PULL-AUTH (sidecar 側 fail-safe deny): inbound `diff.request` は controlToken 必須。
 *    token 無し/誤 token は WsClient で破棄され diffRequest emit に至らない (= diff.response を返さない)。
 *  - 自セッション限定: foreign session_id の diff.request には応答しない (interrupt と同じ PID/session
 *    スコープ; 他セッションの diff を盗み見させない)。
 *  - INV-DETAIL-REDACTION-TRANSPARENCY (Sidecar 全経路): 正規 token + 自セッションの diff.request に対し、
 *    Sidecar が **実 git repo の作業ツリー** から diff を生成 → redactDeep 透過 → diff.response を返す。
 *    秘匿 (ghp_) は raw で応答に出ず `[REDACTED:*]` になる。redaction choke を bypass する変異で赤。
 *
 * REAL DATA: 実 WS server で sidecar の egress 接続を受け、実 git repo に実ファイル (秘匿入り) を書く。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { Sidecar } from "../src/sidecar.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "actradeck-diffrelay-"));
  const run = (args: string[]) => execFileSync("git", args, { cwd: dir });
  run(["init", "-q"]);
  run(["config", "user.email", "t@example.com"]);
  run(["config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "hello\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "init"]);
  return dir;
}

function startServer(): Promise<{ port: number; conns: WebSocket[] }> {
  return new Promise((resolve) => {
    const conns: WebSocket[] = [];
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    wss.on("connection", (ws) => conns.push(ws));
    wss.on("listening", () => {
      server = wss;
      const addr = wss.address();
      resolve({ port: typeof addr === "object" && addr ? addr.port : 0, conns });
    });
  });
}

let server: WebSocketServer | undefined;
let sidecar: Sidecar | undefined;
afterEach(async () => {
  await sidecar?.shutdown();
  sidecar = undefined;
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
});

const GH_SECRET = "ghp_" + "B".repeat(36);

/** sidecar を起動し egress WS の最初の接続が来るまで待つ。 */
async function startSidecar(port: number, repoRoot: string, conns: WebSocket[]): Promise<Sidecar> {
  const sc = new Sidecar({
    sessionId: "s1",
    explicitSession: true, // canonical = s1 即確定。
    wsUrl: `ws://127.0.0.1:${port}`,
    dbPath: ":memory:",
    cwd: repoRoot,
    hookPort: 0,
  });
  await sc.start();
  for (let i = 0; i < 80 && conns.length === 0; i++) await sleep(10);
  // hello が届く猶予。
  await sleep(30);
  return sc;
}

/** conn から次の diff.response を待つ (期限内)。 */
function nextDiffResponse(
  conn: WebSocket,
  ms = 1500,
): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      conn.off("message", onMsg);
      resolve(undefined);
    }, ms);
    const onMsg = (d: Buffer): void => {
      const f = JSON.parse(d.toString("utf8")) as Record<string, unknown>;
      if (f.type === "diff.response") {
        clearTimeout(t);
        conn.off("message", onMsg);
        resolve(f);
      }
    };
    conn.on("message", onMsg);
  });
}

describe("INV-DETAIL-DIFF-RELAY (real WS + real git)", () => {
  it("正規 token + 自セッションの diff.request に redaction 済み diff を返す (ghp_ は [REDACTED:*])", async () => {
    const repo = initRepo();
    writeFileSync(join(repo, "a.txt"), `hello\nGITHUB_TOKEN=${GH_SECRET}\n`);
    const { port, conns } = await startServer();
    sidecar = await startSidecar(port, repo, conns);
    const token = sidecar.controlAuthToken;

    const respP = nextDiffResponse(conns[0]!);
    conns[0]!.send(
      JSON.stringify({ type: "diff.request", request_id: "r1", session_id: "s1", token }),
    );
    const resp = await respP;
    expect(resp).toBeDefined();
    expect(resp!.request_id).toBe("r1");
    const body = String(resp!.body);
    expect(body).not.toContain(GH_SECRET);
    expect(body).not.toContain("ghp_");
    expect(body).toContain("[REDACTED:");
    expect(resp!.secret_detected).toBe(true);
  });

  it("token 無しの diff.request は破棄され応答しない (fail-safe deny)", async () => {
    const repo = initRepo();
    writeFileSync(join(repo, "a.txt"), "hello\nchange\n");
    const { port, conns } = await startServer();
    sidecar = await startSidecar(port, repo, conns);

    const respP = nextDiffResponse(conns[0]!, 600);
    conns[0]!.send(JSON.stringify({ type: "diff.request", request_id: "r1", session_id: "s1" }));
    expect(await respP).toBeUndefined();
  });

  it("誤 token の diff.request は破棄され応答しない", async () => {
    const repo = initRepo();
    writeFileSync(join(repo, "a.txt"), "hello\nchange\n");
    const { port, conns } = await startServer();
    sidecar = await startSidecar(port, repo, conns);

    const respP = nextDiffResponse(conns[0]!, 600);
    conns[0]!.send(
      JSON.stringify({ type: "diff.request", request_id: "r1", session_id: "s1", token: "wrong" }),
    );
    expect(await respP).toBeUndefined();
  });

  it("foreign session_id の diff.request には応答しない (自セッション限定)", async () => {
    const repo = initRepo();
    writeFileSync(join(repo, "a.txt"), "hello\nchange\n");
    const { port, conns } = await startServer();
    sidecar = await startSidecar(port, repo, conns);
    const token = sidecar.controlAuthToken;

    const respP = nextDiffResponse(conns[0]!, 600);
    conns[0]!.send(
      JSON.stringify({
        type: "diff.request",
        request_id: "r1",
        session_id: "other-session",
        token,
      }),
    );
    expect(await respP).toBeUndefined();
  });
});
