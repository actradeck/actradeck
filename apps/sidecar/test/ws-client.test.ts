/**
 * WsClient 単体 — reconnect/backoff・error 経路・inbound 解釈・emit 送信経路/close。
 *
 * INV-EVENT-ORDER 関連の再送経路 (ネット断→再接続 flush) は ws-resend.test.ts が
 * 実 WS sink で担保する。本ファイルは reconnect スケジューリング/エラー/受信ディスパッチ
 * の分岐 (ws-client.ts:78-108,100-109) を実 WS server で固定する。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { WebSocketServer, type WebSocket } from "ws";

import { buildEvent } from "../src/event-factory.js";
import { EventSink } from "../src/sink.js";
import { EventStore } from "../src/store.js";
import { WsClient } from "../src/ws-client.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let server: WebSocketServer | undefined;
let client: WsClient | undefined;
afterEach(async () => {
  client?.close();
  client = undefined;
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

describe("WsClient: connect / reconnect / backoff", () => {
  it("connects and emits 'connected'", async () => {
    const { port } = await startServer();
    const store = new EventStore(":memory:");
    client = new WsClient({ url: `ws://127.0.0.1:${port}`, store, reconnectBaseMs: 10 });
    const onConnected = vi.fn();
    client.on("connected", onConnected);
    client.connect();
    for (let i = 0; i < 50 && !client.connected; i++) await sleep(10);
    expect(client.connected).toBe(true);
    expect(onConnected).toHaveBeenCalled();
    store.close();
  });

  it("reconnects with backoff after the server drops the connection (89-108)", async () => {
    const first = await startServer();
    const store = new EventStore(":memory:");
    client = new WsClient({
      url: `ws://127.0.0.1:${first.port}`,
      store,
      reconnectBaseMs: 10,
      reconnectMaxMs: 40,
    });
    const onDisconnected = vi.fn();
    client.on("disconnected", onDisconnected);
    client.connect();
    for (let i = 0; i < 50 && !client.connected; i++) await sleep(10);
    expect(client.connected).toBe(true);

    // サーバ側から切断 → disconnected + scheduleReconnect 経路。
    for (const c of first.conns) c.close();
    for (let i = 0; i < 50 && client.connected; i++) await sleep(10);
    expect(onDisconnected).toHaveBeenCalled();

    // 同 port で再起動 → backoff 後に再接続する。
    await new Promise<void>((r) => server!.close(() => r()));
    const again = await new Promise<{ wss: WebSocketServer }>((resolve) => {
      const wss = new WebSocketServer({ port: first.port, host: "127.0.0.1" });
      wss.on("listening", () => resolve({ wss }));
    });
    server = again.wss;
    for (let i = 0; i < 80 && !client.connected; i++) await sleep(10);
    expect(client.connected).toBe(true);
    store.close();
  });

  it("error on a bad URL does not throw; close() stops reconnection", async () => {
    const store = new EventStore(":memory:");
    // 接続先なし (即 error→close)。reconnect がスケジュールされるが close で止める。
    client = new WsClient({ url: "ws://127.0.0.1:1/none", store, reconnectBaseMs: 10 });
    expect(() => client!.connect()).not.toThrow();
    await sleep(30);
    client.close();
    // close 後は connect が no-op (closed フラグ)。
    expect(() => client!.connect()).not.toThrow();
    expect(client.connected).toBe(false);
    store.close();
  });
});

describe("WsClient: inbound dispatch + publish", () => {
  // 3#SEC-1: controlToken を設定したクライアントは、一致 token のメッセージのみ dispatch する。
  it("dispatches approval / interrupt ONLY with a matching control token (3#SEC-1)", async () => {
    const { port, conns } = await startServer();
    const store = new EventStore(":memory:");
    const TOKEN = "test-control-token-abc123";
    client = new WsClient({ url: `ws://127.0.0.1:${port}`, store, controlToken: TOKEN });
    const approval = vi.fn();
    const interrupt = vi.fn();
    client.on("approval", approval);
    client.on("interrupt", interrupt);
    client.connect();
    for (let i = 0; i < 50 && conns.length === 0; i++) await sleep(10);
    expect(conns.length).toBe(1);

    conns[0]!.send(
      JSON.stringify({ type: "approval", request_id: "r1", decision: "allow", token: TOKEN }),
    );
    conns[0]!.send(JSON.stringify({ type: "interrupt", session_id: "s1", token: TOKEN }));
    conns[0]!.send("not json {{{"); // 無視される (例外なし)
    conns[0]!.send(JSON.stringify({ type: "unknown" })); // dispatch されない
    await sleep(40);

    expect(approval).toHaveBeenCalledTimes(1);
    expect(interrupt).toHaveBeenCalledTimes(1);
    store.close();
  });

  // 3#SEC-1 (fail-safe): token 未設定クライアント (= backend 未統合) は inbound 制御を全破棄。
  it("drops ALL inbound approval/interrupt when no control token is configured (fail-safe)", async () => {
    const { port, conns } = await startServer();
    const store = new EventStore(":memory:");
    client = new WsClient({ url: `ws://127.0.0.1:${port}`, store }); // controlToken 未指定
    const approval = vi.fn();
    const interrupt = vi.fn();
    client.on("approval", approval);
    client.on("interrupt", interrupt);
    client.connect();
    for (let i = 0; i < 50 && conns.length === 0; i++) await sleep(10);

    conns[0]!.send(JSON.stringify({ type: "approval", request_id: "r1", decision: "allow" }));
    conns[0]!.send(
      JSON.stringify({ type: "approval", request_id: "r1", decision: "allow", token: "guess" }),
    );
    conns[0]!.send(JSON.stringify({ type: "interrupt", session_id: "s1" }));
    await sleep(40);

    expect(approval, "no token configured → drop all approval").not.toHaveBeenCalled();
    expect(interrupt, "no token configured → drop all interrupt").not.toHaveBeenCalled();
    store.close();
  });

  // SEC-R2-1 (decision 019f0d22) 構造 backstop: 制御 handler の同期 throw が handleInbound の emit を貫通
  // して ws message コールバック → uncaughtException → daemon crash になるのを防ぐ。throw する handler の
  // 後も後続の制御メッセージが処理されることで、handleInbound が throw で死んでいないことを固定する。
  // mutation: handleInbound の emit try/catch を外すと policy.request の throw が貫通し RED。
  it("a throwing control handler does not break handleInbound (SEC-R2-1 backstop)", async () => {
    const { port, conns } = await startServer();
    const store = new EventStore(":memory:");
    const TOKEN = "test-control-token-boom";
    client = new WsClient({ url: `ws://127.0.0.1:${port}`, store, controlToken: TOKEN });
    client.on("policyRequest", () => {
      throw new Error("handler boom (e.g. disk persist failure)");
    });
    const interrupt = vi.fn();
    client.on("interrupt", interrupt);
    client.connect();
    for (let i = 0; i < 50 && conns.length === 0; i++) await sleep(10);
    expect(conns.length).toBe(1);

    // throw する policy.request → chokepoint が捕捉 (daemon は生存)。
    conns[0]!.send(
      JSON.stringify({ type: "policy.request", request_id: "r1", op: "get", token: TOKEN }),
    );
    // 後続の制御メッセージが依然 dispatch される (handleInbound が貫通 throw で死んでいない)。
    conns[0]!.send(JSON.stringify({ type: "interrupt", session_id: "s1", token: TOKEN }));
    await sleep(40);

    expect(interrupt, "throw する handler の後も後続制御が処理される").toHaveBeenCalledTimes(1);
    store.close();
  });

  // 再#SEC-2: publish() は削除済み。emit 経路 (EventSink → store.append → notifyAppended → flush)
  // のみで store/WS へ到達する。store.append の唯一の本番 caller が sink であることをこの
  // 経路テストで固定する (publish の迂回路は存在しない)。
  it("EventSink.emit appends to store and notifies WsClient (sends when connected)", async () => {
    const { port, conns } = await startServer();
    const store = new EventStore(":memory:");
    const received: string[] = [];
    client = new WsClient({ url: `ws://127.0.0.1:${port}`, store });
    const sink = new EventSink({ store, wsClient: client });
    client.connect();
    for (let i = 0; i < 50 && conns.length === 0; i++) await sleep(10);
    conns[0]!.on("message", (d: Buffer) => received.push(d.toString("utf8")));

    sink.emit(
      buildEvent({ session_id: "s1", event_type: "heartbeat", payload: { kind: "heartbeat" } }),
    );
    for (let i = 0; i < 50 && received.length === 0; i++) await sleep(10);
    expect(received.length).toBe(1);
    expect(store.totalCount()).toBe(1);
    expect(store.unsentCount()).toBe(0); // 送信済みマーク
    store.close();
  });
});
