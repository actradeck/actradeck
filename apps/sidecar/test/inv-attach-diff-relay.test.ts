/**
 * INV-ATTACH-DIFF-RELAY (task 019ea4db 残ギャップ / ユーザー報告バグ「diff 本文 → HTTP 503」)。
 *
 * attach-daemon に diff.request ハンドラを配線したことを縛る。managed (Sidecar) は既に
 * diffRequest を処理するが、attach-daemon には listener が無く attach session 宛 diff 要求が
 * 全て無応答 → backend timeout → HTTP 503 だった。本スイートは attach 経路でも:
 *
 *  (a) registry 登録済 session 宛 diff.request → redaction 済み diff.response が request_id 対応で返る。
 *  (b) unknown / reaped session 宛 → 応答なし (黙殺)。
 *  (c) request_id 欠落 → 黙殺。
 *  (d) 生成失敗 (repoRoot 例外注入) → 空応答 (body ""・secret_detected false)。
 *  (e) redaction 実効: repo の diff に ghp_ secret を仕込み response.body でマスクされる
 *      (managed と同一 generateRedactedDiff choke を attach も透過する end-to-end)。
 *
 * REAL DATA: 実 HTTP hook 受信 + 実 git repo + 実 SQLite。(a)/(e) は実 WS server で egress を受ける。
 * mutation 自己検証: ハンドラの registry session 解決 (this.registry.get) を外すと (a) が赤化することを
 * 別 it で擬似する (解決 short-circuit を直接呼ぶのでなく、解決経路を介した応答有無で固定)。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { AttachDaemon } from "../src/attach-daemon.js";
import { HOOK_TOKEN_HEADER } from "../src/settings-injection.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const GH_SECRET = "ghp_" + "C".repeat(36);

let dir: string;
let daemon: AttachDaemon | undefined;
let server: WebSocketServer | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "actradeck-attach-diffrelay-"));
});
afterEach(async () => {
  await daemon?.shutdown();
  daemon = undefined;
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
  rmSync(dir, { recursive: true, force: true });
});

/** 実 git repo を初期化し、working tree に secret 入りの変更を書く。 */
function initRepoWithSecret(): string {
  const repo = mkdtempSync(join(dir, "repo-"));
  const run = (args: string[]): void => {
    execFileSync("git", args, { cwd: repo });
  };
  run(["init", "-q"]);
  run(["config", "user.email", "t@example.com"]);
  run(["config", "user.name", "t"]);
  writeFileSync(join(repo, "a.txt"), "hello\n");
  run(["add", "."]);
  run(["commit", "-q", "-m", "init"]);
  // 未コミットの working tree 変更 (secret 入り) → generateRedactedDiff が拾う。
  writeFileSync(join(repo, "a.txt"), `hello\nGITHUB_TOKEN=${GH_SECRET}\n`);
  return repo;
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

function makeDaemon(wsUrl: string): AttachDaemon {
  return new AttachDaemon({
    wsUrl,
    dbPath: join(dir, "sidecar.db"),
    hookToken: "tok-fixed",
    host: "127.0.0.1",
  });
}

function port(d: AttachDaemon): number {
  return Number(new URL(d.hookEndpoint).port);
}

async function postSessionStart(p: number, sessionId: string, cwd: string): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${p}/hook`, {
    method: "POST",
    headers: { "content-type": "application/json", [HOOK_TOKEN_HEADER]: "tok-fixed" },
    body: JSON.stringify({
      session_id: sessionId,
      hook_event_name: "SessionStart",
      cwd,
      source: "startup",
    }),
  });
  await res.text();
  return res.status;
}

/** conn から次の diff.response を待つ (期限内・なければ undefined)。 */
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

/** repoRoot が解決されるまで registry entry を待つ (GitWatcher 起動は非同期 best-effort)。 */
async function waitForRepoRoot(
  d: AttachDaemon,
  sessionId: string,
  ms = 2000,
): Promise<string | undefined> {
  for (let i = 0; i < ms / 10; i++) {
    const root = d.registry.get(sessionId)?.repoRoot;
    if (root !== undefined) return root;
    await sleep(10);
  }
  return d.registry.get(sessionId)?.repoRoot;
}

describe("INV-ATTACH-DIFF-RELAY (real WS + real git + real SQLite)", () => {
  it("(a)(e) registry 登録済 session 宛 diff.request に redaction 済み diff を返す (ghp_ は [REDACTED:*])", async () => {
    const repo = initRepoWithSecret();
    const { port: wsPort, conns } = await startServer();
    daemon = makeDaemon(`ws://127.0.0.1:${wsPort}`);
    await daemon.start();
    const p = port(daemon);
    // SessionStart で registry 登録 + GitWatcher 起動 → repoRoot 解決。
    expect(await postSessionStart(p, "sessA", repo)).toBe(200);
    const root = await waitForRepoRoot(daemon, "sessA");
    expect(root).toBeDefined();

    // egress WS 接続 (= backend 役) が来るまで待つ。
    for (let i = 0; i < 100 && conns.length === 0; i++) await sleep(10);
    expect(conns.length).toBeGreaterThan(0);
    await sleep(30); // hello 猶予

    const token = daemon.controlAuthToken;
    const respP = nextDiffResponse(conns[0]!);
    conns[0]!.send(
      JSON.stringify({ type: "diff.request", request_id: "r1", session_id: "sessA", token }),
    );
    const resp = await respP;

    expect(resp).toBeDefined();
    expect(resp!.request_id).toBe("r1");
    const body = String(resp!.body);
    // (e) redaction 実効: 生 secret は応答に出ず [REDACTED:*] になる (choke 透過)。
    expect(body).not.toContain(GH_SECRET);
    expect(body).not.toContain("ghp_");
    expect(body).toContain("[REDACTED:");
    expect(resp!.secret_detected).toBe(true);
  });

  it("(b) unknown session 宛 diff.request には応答しない (registry 不在 → 黙殺)", async () => {
    const { port: wsPort, conns } = await startServer();
    daemon = makeDaemon(`ws://127.0.0.1:${wsPort}`);
    await daemon.start();
    for (let i = 0; i < 100 && conns.length === 0; i++) await sleep(10);
    expect(conns.length).toBeGreaterThan(0);
    await sleep(30);

    const token = daemon.controlAuthToken;
    const respP = nextDiffResponse(conns[0]!, 500);
    conns[0]!.send(
      JSON.stringify({
        type: "diff.request",
        request_id: "r1",
        session_id: "never-registered",
        token,
      }),
    );
    expect(await respP).toBeUndefined();
  });

  it("(c) request_id 欠落の diff.request は黙殺 (registry 登録済でも respondDiff を呼ばない)", async () => {
    const repo = initRepoWithSecret();
    daemon = makeDaemon("ws://127.0.0.1:1/ingest/ws"); // WS 不要 (直接 emit + spy)
    await daemon.start();
    const p = port(daemon);
    expect(await postSessionStart(p, "sessC", repo)).toBe(200);
    await waitForRepoRoot(daemon, "sessC");

    const spy = vi.spyOn(daemon.wsClient, "respondDiff");
    // request_id 欠落: 登録済 session でも黙殺。
    daemon.wsClient.emit("diffRequest", { session_id: "sessC" });
    await sleep(50);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('(d) 生成失敗時は raw を載せない空応答に倒す (body ""・secret_detected false)', async () => {
    const repo = initRepoWithSecret();
    daemon = makeDaemon("ws://127.0.0.1:1/ingest/ws");
    await daemon.start();
    const p = port(daemon);
    expect(await postSessionStart(p, "sessD", repo)).toBe(200);
    await waitForRepoRoot(daemon, "sessD");
    // generateRedactedDiff が throw する状況を再現する。registry.get が返す entry の repoRoot を
    // 読むと throw する偽 entry を被せる (実 entry は汚さない → GitWatcher の後続解決と競合しない)。
    vi.spyOn(daemon.registry, "get").mockReturnValue({
      sessionId: "sessD",
      lastHookAt: Date.now(),
      get repoRoot(): string {
        throw new Error("boom");
      },
    } as never);

    const spy = vi.spyOn(daemon.wsClient, "respondDiff");
    daemon.wsClient.emit("diffRequest", { request_id: "rd", session_id: "sessD" });
    await sleep(50);
    expect(spy).toHaveBeenCalledTimes(1);
    const arg = spy.mock.calls[0]![0];
    expect(arg.request_id).toBe("rd");
    expect(arg.body).toBe("");
    expect(arg.secret_detected).toBe(false);
    expect(arg.truncated).toBe(false);
    expect(arg.redaction_count).toBe(0);
    spy.mockRestore();
  });

  it("mutation: registry session 解決を外すと (a) が赤化する (登録済でも foreign 扱いされ無応答)", async () => {
    // ハンドラが registry.get を介して登録済 session のみ応答することを、解決を奪うと黙殺になる
    // 形で固定する。registry.get を常時 undefined にする stub = 「session 解決を外す」mutation の写像。
    const repo = initRepoWithSecret();
    daemon = makeDaemon("ws://127.0.0.1:1/ingest/ws");
    await daemon.start();
    const p = port(daemon);
    expect(await postSessionStart(p, "sessM", repo)).toBe(200);
    await waitForRepoRoot(daemon, "sessM");

    const spy = vi.spyOn(daemon.wsClient, "respondDiff");
    const getStub = vi.spyOn(daemon.registry, "get").mockReturnValue(undefined);
    // 正規 request_id + 登録済 session でも、解決 (registry.get) を外すと応答が出ない。
    daemon.wsClient.emit("diffRequest", { request_id: "rm", session_id: "sessM" });
    await sleep(50);
    expect(spy).not.toHaveBeenCalled(); // 解決を外す = (a) の応答が消える (赤化の写像)

    // 解決を戻すと応答が復活する (対照)。
    getStub.mockRestore();
    daemon.wsClient.emit("diffRequest", { request_id: "rm2", session_id: "sessM" });
    await sleep(50);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
