/**
 * PAL-v2 (ADR 019ee147): allowlist.request の inbound 制御チャネル認可ゲート INV (real WS)。
 *
 * INV-PAL-V2-AUTH: WsClient は allowlist.request を diff.request と同一の controlToken 境界で扱う。
 *  - token 無し / 誤 token の allowlist.request は破棄され allowlistRequest を emit しない (fail-safe deny)。
 *  - 正規 token の allowlist.request のみ emit される。
 * mutation (handleInbound の allowlist.request を token-check 集合から外す) で RED 化する。
 */
import { afterEach, describe, expect, it } from "vitest";

import { WebSocketServer, type WebSocket } from "ws";

import { EventStore } from "../src/store.js";
import { WsClient } from "../src/ws-client.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let server: WebSocketServer | undefined;
let client: WsClient | undefined;
let store: EventStore | undefined;

afterEach(async () => {
  client?.close();
  client = undefined;
  store?.close();
  store = undefined;
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
});

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

describe("INV-PAL-V2-AUTH: allowlist.request inbound auth gate (real WS)", () => {
  it("token 無し / 誤 token は allowlistRequest を emit しない・正規 token のみ emit する", async () => {
    const { port, conns } = await startServer();
    store = new EventStore(":memory:");
    const TOKEN = "real-control-token-pal-v2";
    client = new WsClient({ url: `ws://127.0.0.1:${port}`, store, controlToken: TOKEN });

    const seen: Array<{ request_id?: string; op?: string }> = [];
    client.on("allowlistRequest", (msg) => seen.push(msg));
    client.connect();
    for (let i = 0; i < 50 && conns.length === 0; i++) await sleep(10);
    expect(conns.length).toBe(1);

    // (a) token 無し → 破棄。
    conns[0]!.send(JSON.stringify({ type: "allowlist.request", request_id: "r1", op: "list" }));
    // (b) 誤 token → 破棄。
    conns[0]!.send(
      JSON.stringify({ type: "allowlist.request", request_id: "r2", op: "list", token: "wrong" }),
    );
    await sleep(40);
    expect(seen, "unauthorized allowlist.request must NOT emit").toHaveLength(0);

    // (c) 正規 token → emit。
    conns[0]!.send(
      JSON.stringify({ type: "allowlist.request", request_id: "r3", op: "list", token: TOKEN }),
    );
    for (let i = 0; i < 50 && seen.length === 0; i++) await sleep(10);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.request_id).toBe("r3");
    expect(seen[0]!.op).toBe("list");
  });
});
