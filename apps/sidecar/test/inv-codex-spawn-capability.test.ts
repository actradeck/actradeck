/**
 * ADR 019f4206 A段: spawn capability 広告 + 制御チャネル値ベース deny の INV (real WS)。
 *
 * INV-SPAWN-DAEMON-CAPABILITY: `spawn_capable` は buildHelloFrame 単一出所から connect/reannounce で一様広告
 *   される。既定 (spawnCapable=false) は **非広告** (out-of-box 安全)、opt-in (true) のみ connect+reannounce 両方で
 *   spawn_capable:true。AttachDaemon の enableCodexSpawn 配線 (env opt-in) も real WS で固定する。
 * INV-SPAWN-DENY-VALUE-BASED: codex.spawn.request は controlToken 境界で扱う。token 無し/誤りは spawnRequest を
 *   **emit しない** (fail-safe deny・非 throw)。AttachDaemon 経由の end-to-end では **NO-RAW** 応答 (prompt/cwd を
 *   echo せず closed enum error のみ)。
 *
 * 🔴 mutation: buildHelloFrame の spawn_capable を reannounce で落とすと reannounce 側 assert が RED。
 * 🔴 mutation: handleInbound の codex.spawn.request を token-check 集合から外すと deny assert が RED。
 */
import { afterEach, describe, expect, it } from "vitest";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WebSocketServer, type WebSocket as WsServerSocket, type RawData } from "ws";

import { AttachDaemon } from "../src/attach-daemon.js";
import { EventStore } from "../src/store.js";
import { WsClient } from "../src/ws-client.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let server: WebSocketServer | undefined;
const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
});

interface Rig {
  readonly port: number;
  readonly frames: unknown[];
  readonly conns: WsServerSocket[];
}

function startServer(frames: unknown[], conns: WsServerSocket[]): Promise<number> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    wss.on("connection", (ws: WsServerSocket) => {
      conns.push(ws);
      ws.on("message", (data: RawData) => {
        try {
          frames.push(JSON.parse(data.toString()));
        } catch {
          /* 非 JSON は無視。 */
        }
      });
    });
    wss.on("listening", () => {
      server = wss;
      const addr = wss.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}

async function startRig(): Promise<Rig> {
  const frames: unknown[] = [];
  const conns: WsServerSocket[] = [];
  const port = await startServer(frames, conns);
  return { port, frames, conns };
}

function helloFrames(frames: unknown[]): Record<string, unknown>[] {
  return frames.filter(
    (f): f is Record<string, unknown> => (f as { type?: string })?.type === "hello",
  );
}

async function waitFor<T>(fn: () => T | undefined, tries = 100): Promise<T | undefined> {
  for (let i = 0; i < tries; i++) {
    const v = fn();
    if (v !== undefined) return v;
    await sleep(10);
  }
  return undefined;
}

describe("INV-SPAWN-DAEMON-CAPABILITY (WsClient hello)", () => {
  it("spawnCapable=false → hello に spawn_capable を載せない (既定 OFF・非広告)", async () => {
    const rig = await startRig();
    const store = new EventStore(":memory:");
    const client = new WsClient({
      url: `ws://127.0.0.1:${rig.port}`,
      store,
      controlToken: "tok-cap-off",
      spawnCapable: false,
    });
    cleanup.push(() => {
      client.close();
      store.close();
    });
    client.connect();
    const hello = await waitFor(() => helloFrames(rig.frames)[0]);
    expect(hello).toBeDefined();
    expect("spawn_capable" in (hello ?? {})).toBe(false);
  });

  it("spawnCapable=true → connect と reannounce の両方で spawn_capable:true (単一出所・一様広告)", async () => {
    const rig = await startRig();
    const store = new EventStore(":memory:");
    const client = new WsClient({
      url: `ws://127.0.0.1:${rig.port}`,
      store,
      controlToken: "tok-cap-on",
      spawnCapable: true,
    });
    cleanup.push(() => {
      client.close();
      store.close();
    });
    client.connect();
    const first = await waitFor(() => helloFrames(rig.frames)[0]);
    expect(first?.spawn_capable).toBe(true);

    // reannounce も同一 builder を通り spawn_capable を落とさない (TDA-1 教訓の spawn 版)。
    client.reannounce();
    const second = await waitFor(() => helloFrames(rig.frames)[1]);
    expect(second, "reannounce must send a second hello").toBeDefined();
    expect(second?.spawn_capable).toBe(true);
  });
});

describe("INV-SPAWN-DENY-VALUE-BASED (WsClient inbound auth)", () => {
  it("token 無し/誤りの codex.spawn.request は spawnRequest を emit しない・正規 token のみ emit", async () => {
    const rig = await startRig();
    const store = new EventStore(":memory:");
    const TOKEN = "real-spawn-control-token";
    const client = new WsClient({ url: `ws://127.0.0.1:${rig.port}`, store, controlToken: TOKEN });
    cleanup.push(() => {
      client.close();
      store.close();
    });
    const seen: Array<{ request_id?: string }> = [];
    client.on("spawnRequest", (m) => seen.push(m));
    client.connect();
    await waitFor(() => (rig.conns.length > 0 ? true : undefined));

    // (a) token 無し → 破棄。(b) 誤 token → 破棄。
    rig.conns[0]!.send(
      JSON.stringify({ type: "codex.spawn.request", request_id: "s1", prompt: "p", cwd: "/r" }),
    );
    rig.conns[0]!.send(
      JSON.stringify({
        type: "codex.spawn.request",
        request_id: "s2",
        prompt: "p",
        cwd: "/r",
        token: "wrong",
      }),
    );
    await sleep(40);
    expect(seen, "unauthorized spawn.request must NOT emit").toHaveLength(0);

    // (c) 正規 token → emit。
    rig.conns[0]!.send(
      JSON.stringify({
        type: "codex.spawn.request",
        request_id: "s3",
        prompt: "p",
        cwd: "/r",
        token: TOKEN,
      }),
    );
    const got = await waitFor(() => (seen.length > 0 ? seen[0] : undefined));
    expect(got?.request_id).toBe("s3");
  });
});

describe("AttachDaemon spawn wiring + NO-RAW (real WS end-to-end)", () => {
  function mkDaemon(
    port: number,
    enableCodexSpawn: boolean,
  ): { daemon: AttachDaemon; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), "ad-spawn-e2e-"));
    const daemon = new AttachDaemon({
      wsUrl: `ws://127.0.0.1:${port}/ingest/ws`,
      dbPath: join(dir, "s.db"),
      hookToken: "tok",
      host: "127.0.0.1",
      approvalTimeoutMs: 30,
      enableCodexSpawn,
    });
    return { daemon, dir };
  }

  it("enableCodexSpawn=true → hello spawn_capable:true・spawn.request の応答は NO-RAW (prompt/cwd 非 echo)", async () => {
    const rig = await startRig();
    const { daemon, dir } = mkDaemon(rig.port, true);
    cleanup.push(async () => {
      await daemon.shutdown();
      rmSync(dir, { recursive: true, force: true });
    });
    await daemon.start();

    const hello = await waitFor(() => helloFrames(rig.frames)[0]);
    expect(hello?.spawn_capable).toBe(true);

    // 制御チャネルで spawn.request を送る (daemon の controlToken を提示)。非 git cwd → cwd_out_of_scope deny。
    const SENTINEL_PROMPT = "E2E_SPAWN_PROMPT_SENTINEL";
    const SENTINEL_CWD = join(dir, "E2E_SPAWN_CWD_SENTINEL");
    rig.conns[0]!.send(
      JSON.stringify({
        type: "codex.spawn.request",
        request_id: "e1",
        prompt: SENTINEL_PROMPT,
        cwd: SENTINEL_CWD,
        token: daemon.controlAuthToken,
      }),
    );
    const resp = await waitFor(() =>
      rig.frames.find(
        (f): f is Record<string, unknown> =>
          (f as { type?: string })?.type === "codex.spawn.response",
      ),
    );
    expect(resp, "daemon must respond to spawn.request").toBeDefined();
    expect(resp?.request_id).toBe("e1");
    expect(resp?.ok).toBe(false);
    // closed enum error のみ (原文非依存)。
    expect(resp?.error).toBe("cwd_out_of_scope");
    // NO-RAW: 応答フレーム全体に prompt/cwd の sentinel が一切載らない。
    const json = JSON.stringify(resp);
    expect(json).not.toContain("E2E_SPAWN_PROMPT_SENTINEL");
    expect(json).not.toContain("E2E_SPAWN_CWD_SENTINEL");
  });

  it("enableCodexSpawn=false → 非広告・spawn.request は値ベース spawn_disabled deny", async () => {
    const rig = await startRig();
    const { daemon, dir } = mkDaemon(rig.port, false);
    cleanup.push(async () => {
      await daemon.shutdown();
      rmSync(dir, { recursive: true, force: true });
    });
    await daemon.start();

    const hello = await waitFor(() => helloFrames(rig.frames)[0]);
    expect(hello?.type).toBe("hello");
    expect("spawn_capable" in (hello ?? {})).toBe(false); // 既定 OFF → 非広告。

    rig.conns[0]!.send(
      JSON.stringify({
        type: "codex.spawn.request",
        request_id: "d1",
        prompt: "p",
        cwd: join(dir, "x"),
        token: daemon.controlAuthToken,
      }),
    );
    const resp = await waitFor(() =>
      rig.frames.find(
        (f): f is Record<string, unknown> =>
          (f as { type?: string })?.type === "codex.spawn.response",
      ),
    );
    expect(resp?.ok).toBe(false);
    expect(resp?.error).toBe("spawn_disabled"); // 受信しても値ベース deny (out-of-box 安全)。
  });
});
