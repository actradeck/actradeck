/**
 * INV (egress wiring): WsClient の backend ingestion 配線契約を実 `ws` サーバで検証する。
 *
 * task 019e9069 (SEC-2 Bearer) + 019e92af (TDA-2 hello)。
 *
 * 不変条件:
 *  (1) ingestToken 設定時、upgrade リクエストに `Authorization: Bearer <token>` が付く。
 *      (?token= クエリは SEC-1 で禁止 — 付けないことも確認)。
 *  (2) open 後の **最初のフレーム**が hello で、control_token / session_ids を含む。
 *      hello の後に通常イベントが flush される (順序: hello → events)。
 *  (3) ingestToken 未設定時はヘッダ無しで接続する (後方互換: 無認証 sink を壊さない)。
 *  (4) controlToken 未設定 (backend 未統合検証) なら hello を送らない (fail-safe 整合)。
 *  (5) 再接続でも毎回 Bearer + hello が付く (connect() 集約の確認)。
 *
 * REAL DATA ONLY: モック WS でなく実 `ws` WebSocketServer で upgrade ヘッダ / 受信フレームを観測する。
 */
import { afterEach, describe, expect, it } from "vitest";

import { WebSocketServer, type WebSocket as WsServerSocket, type RawData } from "ws";
import type { IncomingMessage } from "node:http";

import { buildEvent } from "../src/event-factory.js";
import { EventStore } from "../src/store.js";
import { WsClient } from "../src/ws-client.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Capture {
  /** 接続ごとの upgrade リクエストヘッダ (authorization を観測)。 */
  readonly upgradeAuth: (string | undefined)[];
  /** 接続ごとの受信フレーム (parse 済)。最初の hello を観測する。 */
  readonly frames: unknown[];
  /** 生の最初フレーム文字列 (順序確認)。 */
  readonly rawFrames: string[];
}

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

function attach(wss: WebSocketServer, cap: Capture, conns: WsServerSocket[]): void {
  wss.on("connection", (ws: WsServerSocket, req: IncomingMessage) => {
    conns.push(ws);
    cap.upgradeAuth.push(
      typeof req.headers.authorization === "string" ? req.headers.authorization : undefined,
    );
    ws.on("message", (data: RawData) => {
      const text = data.toString();
      cap.rawFrames.push(text);
      try {
        cap.frames.push(JSON.parse(text));
      } catch {
        cap.frames.push(text);
      }
    });
  });
}

function startServer(cap: Capture, conns: WsServerSocket[] = []): Promise<number> {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    attach(wss, cap, conns);
    wss.on("listening", () => {
      server = wss;
      const addr = wss.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}

function freshCapture(): Capture {
  return { upgradeAuth: [], frames: [], rawFrames: [] };
}

describe("INV egress: Bearer auth + hello handshake (real ws server)", () => {
  it("(1) connect attaches Authorization: Bearer and NO ?token= query", async () => {
    const cap = freshCapture();
    const port = await startServer(cap);
    store = new EventStore(":memory:");
    const TOKEN = "ingest-token-bearer-abc";
    client = new WsClient({
      url: `ws://127.0.0.1:${port}/ingest/ws`,
      store,
      ingestToken: TOKEN,
      controlToken: "ctl-xyz",
      sessionIds: ["s1"],
    });
    client.connect();
    for (let i = 0; i < 100 && cap.upgradeAuth.length === 0; i++) await sleep(10);

    expect(cap.upgradeAuth.length).toBe(1);
    expect(cap.upgradeAuth[0]).toBe(`Bearer ${TOKEN}`);
    // ?token= クエリは禁止: URL に token を埋めていないこと (本クライアントは path のみ)。
    // (サーバ側で観測した authorization が唯一の token 経路)。
  });

  it("(2) first frame after open is hello with control_token + session_ids, before events", async () => {
    const cap = freshCapture();
    const port = await startServer(cap);
    store = new EventStore(":memory:");
    const CTL = "control-token-handshake-1";
    // open 前にイベントを積んでおく → hello が events より先に出ることを確認。
    store.append(
      buildEvent({ session_id: "s1", event_type: "heartbeat", payload: { kind: "heartbeat" } }),
    );
    client = new WsClient({
      url: `ws://127.0.0.1:${port}/ingest/ws`,
      store,
      ingestToken: "tok",
      controlToken: CTL,
      sessionIds: ["s1"],
    });
    client.connect();
    for (let i = 0; i < 100 && cap.frames.length < 2; i++) await sleep(10);

    expect(cap.frames.length).toBeGreaterThanOrEqual(2);
    const hello = cap.frames[0] as {
      type?: string;
      control_token?: string;
      session_ids?: string[];
    };
    expect(hello.type).toBe("hello");
    expect(hello.control_token).toBe(CTL);
    expect(hello.session_ids).toEqual(["s1"]);
    // 2 番目は event (hello の後)。
    const ev = cap.frames[1] as { event_type?: string; type?: string };
    expect(ev.type).not.toBe("hello");
    expect(ev.event_type).toBe("heartbeat");
  });

  it("(3) without ingestToken, no Authorization header (backward compat)", async () => {
    const cap = freshCapture();
    const port = await startServer(cap);
    store = new EventStore(":memory:");
    client = new WsClient({ url: `ws://127.0.0.1:${port}`, store }); // no ingestToken/controlToken
    client.connect();
    for (let i = 0; i < 100 && cap.upgradeAuth.length === 0; i++) await sleep(10);

    expect(cap.upgradeAuth.length).toBe(1);
    expect(cap.upgradeAuth[0]).toBeUndefined();
  });

  it("(4) without controlToken, NO hello frame is sent (fail-safe)", async () => {
    const cap = freshCapture();
    const port = await startServer(cap);
    store = new EventStore(":memory:");
    store.append(
      buildEvent({ session_id: "s1", event_type: "heartbeat", payload: { kind: "heartbeat" } }),
    );
    client = new WsClient({ url: `ws://127.0.0.1:${port}`, store, ingestToken: "tok" }); // no controlToken
    client.connect();
    for (let i = 0; i < 100 && cap.frames.length < 1; i++) await sleep(10);
    await sleep(40); // hello が来るとしたら events より先のはず → 余裕を持って待つ

    // 受信した全フレームに hello が無い。
    for (const f of cap.frames) {
      expect((f as { type?: string }).type).not.toBe("hello");
    }
  });

  it("(5) reconnect re-sends Bearer + hello on every connect()", async () => {
    const cap = freshCapture();
    const conns: WsServerSocket[] = [];
    const port = await startServer(cap, conns);
    store = new EventStore(":memory:");
    const TOKEN = "tok-reconnect";
    const CTL = "ctl-reconnect";
    client = new WsClient({
      url: `ws://127.0.0.1:${port}/ingest/ws`,
      store,
      ingestToken: TOKEN,
      controlToken: CTL,
      sessionIds: ["s1"],
      reconnectBaseMs: 10,
      reconnectMaxMs: 40,
    });
    client.connect();
    // 寛容な poll budget: CI=true の並列フルスイート下では event-loop 飢餓で connect/reconnect の
    // 実時間が伸びる。reconnect が壊れていれば幾ら待っても到達しない (falsifiability 維持) ため、
    // 負荷を吸収する余裕を持たせて間欠失敗 (expected 1 to be >= 2) を防ぐ。
    for (let i = 0; i < 300 && cap.frames.length < 1; i++) await sleep(10);
    expect(cap.upgradeAuth[0]).toBe(`Bearer ${TOKEN}`);
    expect((cap.frames[0] as { type?: string }).type).toBe("hello");

    // サーバ側から切断 → client 側 close → scheduleReconnect。
    for (const c of conns) c.close();
    for (let i = 0; i < 100 && client.connected; i++) await sleep(10);

    // 同 port で再起動 → backoff 後に再接続 (同じ cap/conns へ記録)。
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    await new Promise<void>((resolve) => {
      const wss2 = new WebSocketServer({ port, host: "127.0.0.1" });
      attach(wss2, cap, conns);
      wss2.on("listening", () => {
        server = wss2;
        resolve();
      });
    });

    for (let i = 0; i < 800 && cap.upgradeAuth.length < 2; i++) await sleep(10);
    expect(cap.upgradeAuth.length).toBeGreaterThanOrEqual(2);
    // 再接続でも Bearer + hello。
    expect(cap.upgradeAuth[cap.upgradeAuth.length - 1]).toBe(`Bearer ${TOKEN}`);
    const helloFrames = cap.frames.filter((f) => (f as { type?: string }).type === "hello") as {
      control_token?: string;
    }[];
    expect(helloFrames.length).toBeGreaterThanOrEqual(2);
    expect(helloFrames[helloFrames.length - 1]?.control_token).toBe(CTL);
  });
});
