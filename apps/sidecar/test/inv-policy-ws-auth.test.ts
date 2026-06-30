/**
 * ADR 019f0c3e Phase 2: policy.request の inbound 制御チャネル認可ゲート INV (real WS)。
 *
 * INV-POLICY-AUTH: WsClient は policy.request を allowlist.request と同一の controlToken 境界で扱う。
 *  - token 無し / 誤 token の policy.request は破棄され policyRequest を emit しない (fail-safe deny)。
 *  - 正規 token の policy.request のみ emit される。
 * mutation (handleInbound の policy.request を token-check 集合から外す) で RED 化する。
 * 重要: policy mutation は認証必須。無認証 WS peer が set を注入できると bypass ゲートを無効化できるため。
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

describe("INV-POLICY-AUTH: policy.request inbound auth gate (real WS)", () => {
  it("token 無し / 誤 token は policyRequest を emit しない・正規 token のみ emit する", async () => {
    const { port, conns } = await startServer();
    store = new EventStore(":memory:");
    const TOKEN = "real-control-token-policy-p2";
    client = new WsClient({ url: `ws://127.0.0.1:${port}`, store, controlToken: TOKEN });

    const seen: Array<{ request_id?: string; op?: string }> = [];
    client.on("policyRequest", (msg) => seen.push(msg));
    client.connect();
    for (let i = 0; i < 50 && conns.length === 0; i++) await sleep(10);
    expect(conns.length).toBe(1);

    // (a) token 無し → 破棄 (set 注入を構造的に遮断)。
    conns[0]!.send(
      JSON.stringify({ type: "policy.request", request_id: "r1", op: "set", enabled: false }),
    );
    // (b) 誤 token → 破棄。
    conns[0]!.send(
      JSON.stringify({ type: "policy.request", request_id: "r2", op: "get", token: "wrong" }),
    );
    await sleep(40);
    expect(seen, "unauthorized policy.request must NOT emit").toHaveLength(0);

    // (c) 正規 token → emit。
    conns[0]!.send(
      JSON.stringify({ type: "policy.request", request_id: "r3", op: "get", token: TOKEN }),
    );
    for (let i = 0; i < 50 && seen.length === 0; i++) await sleep(10);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.request_id).toBe("r3");
    expect(seen[0]!.op).toBe("get");
  });
});
