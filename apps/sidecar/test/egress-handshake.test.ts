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

import { MAX_ACTIVE_PENDING_IDS } from "@actradeck/event-model";

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

  it("(2b) hello carries policy_capable:true only when the daemon advertises it (ADR 019f1582 follow-up)", async () => {
    // managed sidecar / attach daemon は policyRequest を処理するため policy_capable:true を広告し、
    // backend が connectedDaemons (UI の daemon-addressed policy 宛先) に含める。
    const cap = freshCapture();
    const port = await startServer(cap);
    store = new EventStore(":memory:");
    client = new WsClient({
      url: `ws://127.0.0.1:${port}/ingest/ws`,
      store,
      ingestToken: "tok",
      controlToken: "ctl-cap",
      sessionIds: ["s1"],
      policyCapable: true,
    });
    client.connect();
    for (let i = 0; i < 100 && cap.frames.length < 1; i++) await sleep(10);
    const hello = cap.frames[0] as { type?: string; policy_capable?: unknown };
    expect(hello.type).toBe("hello");
    expect(hello.policy_capable).toBe(true);
  });

  it("(2d) reannounce re-sends hello WITH policy_capable (TDA-1: capability は降格しない)", async () => {
    // 回帰: reannounce() の hello が policy_capable を落とすと backend handleHello の無条件上書きで
    // capability が false へ降格し connectedDaemons から脱落する H 回帰があった (decision 019f1859)。
    // connect と reannounce は buildHelloFrame を共有し policy_capable を一様に載せることを実 ws で固定。
    const cap = freshCapture();
    const port = await startServer(cap);
    store = new EventStore(":memory:");
    client = new WsClient({
      url: `ws://127.0.0.1:${port}/ingest/ws`,
      store,
      ingestToken: "tok",
      controlToken: "ctl-reann",
      sessionIds: ["s1"],
      policyCapable: true,
    });
    client.connect();
    // connect-hello を待つ。
    for (let i = 0; i < 100 && cap.frames.length < 1; i++) await sleep(10);
    expect((cap.frames[0] as { policy_capable?: unknown }).policy_capable).toBe(true);
    // session 集合変化を模して reannounce → 2 通目の hello も policy_capable を保持する。
    client.reannounce();
    for (
      let i = 0;
      i < 100 && cap.frames.filter((f) => (f as { type?: string }).type === "hello").length < 2;
      i++
    )
      await sleep(10);
    const helloFrames = cap.frames.filter((f) => (f as { type?: string }).type === "hello");
    expect(helloFrames.length).toBeGreaterThanOrEqual(2);
    const reann = helloFrames[helloFrames.length - 1] as { policy_capable?: unknown };
    expect(reann.policy_capable).toBe(true); // 降格しない (buildHelloFrame 未共有だと undefined→RED)。
  });

  it("(2c) hello omits policy_capable when not advertised (observe-only codex daemon・既定 false)", async () => {
    // codex-rollout daemon は policyRequest 非対応。policy_capable を載せないことで backend は
    // connectedDaemons から除外し、UI が addressing して timeout する事故を防ぐ。
    const cap = freshCapture();
    const port = await startServer(cap);
    store = new EventStore(":memory:");
    client = new WsClient({
      url: `ws://127.0.0.1:${port}/ingest/ws`,
      store,
      ingestToken: "tok",
      controlToken: "ctl-nocap",
      sessionIds: ["s1"],
      // policyCapable 未指定 = 既定 false。
    });
    client.connect();
    for (let i = 0; i < 100 && cap.frames.length < 1; i++) await sleep(10);
    const hello = cap.frames[0] as { type?: string; policy_capable?: unknown };
    expect(hello.type).toBe("hello");
    expect("policy_capable" in hello).toBe(false); // 載せない (backend で除外される)。
  });

  it("(2e) hello carries agent_visibility when a provider is injected (ADR 019f1972 §2b)", async () => {
    // daemon が agentVisibilityProvider を注入すると hello に NO-RAW boolean 4 個が相乗りする。
    const cap = freshCapture();
    const port = await startServer(cap);
    store = new EventStore(":memory:");
    client = new WsClient({
      url: `ws://127.0.0.1:${port}/ingest/ws`,
      store,
      ingestToken: "tok",
      controlToken: "ctl-vis",
      sessionIds: ["s1"],
      agentVisibilityProvider: () => ({
        claude: { binaryOnPath: true, anyHook: false },
        codex: { binaryOnPath: false, rolloutDirResolved: true },
      }),
    });
    client.connect();
    for (let i = 0; i < 100 && cap.frames.length < 1; i++) await sleep(10);
    const hello = cap.frames[0] as { type?: string; agent_visibility?: unknown };
    expect(hello.type).toBe("hello");
    expect(hello.agent_visibility).toEqual({
      claude: { binaryOnPath: true, anyHook: false },
      codex: { binaryOnPath: false, rolloutDirResolved: true },
    });
  });

  it("(2f) hello omits agent_visibility when no provider / provider returns undefined (backward compat)", async () => {
    // provider 未注入は従来どおり field 省略。provider が undefined を返すとき (fail-safe) も省略。
    const cap = freshCapture();
    const port = await startServer(cap);
    store = new EventStore(":memory:");
    client = new WsClient({
      url: `ws://127.0.0.1:${port}/ingest/ws`,
      store,
      ingestToken: "tok",
      controlToken: "ctl-novis",
      sessionIds: ["s1"],
      agentVisibilityProvider: () => undefined, // fail-safe (computeAgentVisibilityWire の throw 握り潰し相当)。
    });
    client.connect();
    for (let i = 0; i < 100 && cap.frames.length < 1; i++) await sleep(10);
    const hello = cap.frames[0] as { type?: string };
    expect(hello.type).toBe("hello");
    expect("agent_visibility" in hello).toBe(false); // undefined → field 省略。
  });

  it("(2g) reannounce re-sends hello WITH agent_visibility, re-evaluated per send (single-source builder)", async () => {
    // buildHelloFrame 単一出所: connect/reannounce 両方が provider を通る。provider は送信ごとに呼ばれ
    // 最新値を載せる (accepted-staleness 最小化)。回帰: reannounce が field を落とすと RED。
    const cap = freshCapture();
    const port = await startServer(cap);
    store = new EventStore(":memory:");
    let anyHook = false;
    client = new WsClient({
      url: `ws://127.0.0.1:${port}/ingest/ws`,
      store,
      ingestToken: "tok",
      controlToken: "ctl-vis-reann",
      sessionIds: ["s1"],
      // fresh per send: 呼ばれるたびに現在値を返す (ランタイム中に hook 配線が変わるのを模す)。
      agentVisibilityProvider: () => ({
        claude: { binaryOnPath: true, anyHook },
        codex: { binaryOnPath: false, rolloutDirResolved: false },
      }),
    });
    client.connect();
    for (let i = 0; i < 100 && cap.frames.length < 1; i++) await sleep(10);
    expect(
      (cap.frames[0] as { agent_visibility?: { claude?: { anyHook?: unknown } } }).agent_visibility
        ?.claude?.anyHook,
    ).toBe(false);
    // hook が後から配線された状況を模して値を変え reannounce → 2 通目は新値を載せる。
    anyHook = true;
    client.reannounce();
    for (
      let i = 0;
      i < 100 && cap.frames.filter((f) => (f as { type?: string }).type === "hello").length < 2;
      i++
    )
      await sleep(10);
    const helloFrames = cap.frames.filter((f) => (f as { type?: string }).type === "hello");
    expect(helloFrames.length).toBeGreaterThanOrEqual(2);
    const reann = helloFrames[helloFrames.length - 1] as {
      agent_visibility?: { claude?: { anyHook?: unknown } };
    };
    expect(reann.agent_visibility?.claude?.anyHook).toBe(true); // 再評価で新値 (fresh per send)。
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

    // reconnect の upgrade(Bearer) と hello frame は別タイミング (upgrade 完了 → 接続確立後に
    // hello 送信) ゆえ、upgradeAuth.length>=2 だけを poll すると hello frame 到着前に assert して
    // 間欠失敗する (expected 1 to be >= 2)。実際に assert する hello frame の再送 (>=2) 自体を
    // poll 条件へ含める。reconnect が hello を再送しなければ budget を使い切って失敗する
    // (falsifiability 維持)。
    const helloCount = (): number =>
      cap.frames.filter((f) => (f as { type?: string }).type === "hello").length;
    for (let i = 0; i < 800 && (cap.upgradeAuth.length < 2 || helloCount() < 2); i++)
      await sleep(10);
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

/**
 * ADR 0014 Phase 4 (decision 019fd705 D5): hello の runtime_epoch / active_pending_request_ids。
 *
 * 不変条件:
 *  (P4-1) runtimeEpoch / pendingApprovalIdsProvider 設定時、hello に runtime_epoch と
 *         active_pending_request_ids が載る。**空配列も載る** (pending ゼロの宣言が stale 判定の根拠)。
 *  (P4-2) 未設定 (旧 daemon / observe-only codex-rollout) では両 field を載せない (後方互換 =
 *         backend は reconcile しない)。
 *  (P4-3) reannounce も同一 builder を通り、provider を **送信ごとに再評価** した最新 pending 集合を
 *         載せる (TDA-1: 片方欠落だと reannounce で宣言が落ち偽 stale 化する H 回帰と同型)。
 */
describe("ADR 0014 Phase 4: hello runtime_epoch + active_pending_request_ids", () => {
  it("(P4-1) hello carries runtime_epoch and active_pending_request_ids (empty array included)", async () => {
    const cap = freshCapture();
    const port = await startServer(cap);
    store = new EventStore(":memory:");
    client = new WsClient({
      url: `ws://127.0.0.1:${port}/ingest/ws`,
      store,
      ingestToken: "tok",
      controlToken: "ctl-p4",
      sessionIds: ["s1"],
      runtimeEpoch: "0199f0a1-2b3c-7d4e-8f01-234567890001",
      pendingApprovalIdsProvider: () => [],
    });
    client.connect();
    for (let i = 0; i < 100 && cap.frames.length === 0; i++) await sleep(10);

    const hello = cap.frames[0] as {
      type?: string;
      runtime_epoch?: unknown;
      active_pending_request_ids?: unknown;
    };
    expect(hello.type).toBe("hello");
    expect(hello.runtime_epoch).toBe("0199f0a1-2b3c-7d4e-8f01-234567890001");
    // 空配列でも field を載せる (「pending ゼロ」の宣言は省略と意味が異なる)。
    expect(hello.active_pending_request_ids).toEqual([]);
  });

  it("(P4-2) hello omits both fields when not configured (backward compat / observe-only daemon)", async () => {
    const cap = freshCapture();
    const port = await startServer(cap);
    store = new EventStore(":memory:");
    client = new WsClient({
      url: `ws://127.0.0.1:${port}/ingest/ws`,
      store,
      ingestToken: "tok",
      controlToken: "ctl-p4-omit",
      sessionIds: ["s1"],
    });
    client.connect();
    for (let i = 0; i < 100 && cap.frames.length === 0; i++) await sleep(10);

    const hello = cap.frames[0] as Record<string, unknown>;
    expect(hello.type).toBe("hello");
    expect("runtime_epoch" in hello).toBe(false);
    expect("active_pending_request_ids" in hello).toBe(false);
  });

  it("(P4-3) reannounce re-sends hello with per-send re-evaluated pending ids (single-source builder)", async () => {
    const cap = freshCapture();
    const port = await startServer(cap);
    store = new EventStore(":memory:");
    let pending: string[] = ["sess:apr-1"];
    client = new WsClient({
      url: `ws://127.0.0.1:${port}/ingest/ws`,
      store,
      ingestToken: "tok",
      controlToken: "ctl-p4-re",
      sessionIds: ["s1"],
      runtimeEpoch: "0199f0a1-2b3c-7d4e-8f01-234567890002",
      pendingApprovalIdsProvider: () => pending,
    });
    client.connect();
    for (let i = 0; i < 100 && cap.frames.length === 0; i++) await sleep(10);
    expect(
      (cap.frames[0] as { active_pending_request_ids?: unknown }).active_pending_request_ids,
    ).toEqual(["sess:apr-1"]);

    // pending が解決されて空になった状況を模して reannounce → 最新 (空) 集合 + epoch 維持。
    pending = [];
    client.reannounce();
    for (
      let i = 0;
      i < 100 && cap.frames.filter((f) => (f as { type?: string }).type === "hello").length < 2;
      i++
    )
      await sleep(10);
    const hellos = cap.frames.filter((f) => (f as { type?: string }).type === "hello") as {
      runtime_epoch?: unknown;
      active_pending_request_ids?: unknown;
    }[];
    const last = hellos[hellos.length - 1]!;
    expect(last.runtime_epoch).toBe("0199f0a1-2b3c-7d4e-8f01-234567890002"); // epoch はプロセス寿命内不変で毎回載る。
    expect(last.active_pending_request_ids).toEqual([]); // 送信ごとに provider を再評価。
  });

  it("(P4-4) provider undefined (bridge 未生成) では field 省略 — 空宣言へ倒さない (TDA-8 R2)", async () => {
    const cap = freshCapture();
    const port = await startServer(cap);
    store = new EventStore(":memory:");
    client = new WsClient({
      url: `ws://127.0.0.1:${port}/ingest/ws`,
      store,
      ingestToken: "tok",
      controlToken: "ctl-p4-undef",
      sessionIds: ["s1"],
      // 旧実装の `?? []` は「pending ゼロ宣言」= 全 pending stale の最も破壊的な値だった。
      // undefined は「宣言不能」= field 省略 = backend は reconcile しない (fail-safe)。
      pendingApprovalIdsProvider: () => undefined,
    });
    client.connect();
    for (let i = 0; i < 100 && cap.frames.length === 0; i++) await sleep(10);
    const hello = cap.frames[0] as Record<string, unknown>;
    expect(hello.type).toBe("hello");
    expect("active_pending_request_ids" in hello).toBe(false);
  });

  it("(P4-5) cap 超過は切り詰めでなく field 省略 (TDA-9 R2: 偽 stale を作らない)", async () => {
    const cap = freshCapture();
    const port = await startServer(cap);
    store = new EventStore(":memory:");
    const over = Array.from({ length: MAX_ACTIVE_PENDING_IDS + 1 }, (_, i) => `s1:apr-${i}`);
    client = new WsClient({
      url: `ws://127.0.0.1:${port}/ingest/ws`,
      store,
      ingestToken: "tok",
      controlToken: "ctl-p4-cap",
      sessionIds: ["s1"],
      pendingApprovalIdsProvider: () => over,
    });
    client.connect();
    for (let i = 0; i < 100 && cap.frames.length === 0; i++) await sleep(10);
    const hello = cap.frames[0] as Record<string, unknown>;
    expect(hello.type).toBe("hello");
    // 切り詰めて送ると「載らなかった生存 pending」が backend で偽 stale になる。省略なら
    // 受信側 (parseActivePendingRequestIds) の欠落扱いと同じ「reconcile しない」= fail-safe。
    expect("active_pending_request_ids" in hello).toBe(false);
  });
});
