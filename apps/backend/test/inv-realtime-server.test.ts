/**
 * INV-REALTIME (e2e): /realtime/ws を REAL PostgreSQL + REAL WS で検証する。
 *
 * 縛る不変条件:
 *  - INV-REALTIME-AUTH: 認証なし/誤 token の UI 接続を拒否 (401, upgrade させない)。
 *  - INV-REALTIME-PUSH: 接続直後に list snapshot、ingest 後に delta が受け入れ時間内に届く
 *    (tool call → push 反映)。
 *  - INV-REALTIME-DETAIL: subscribe で detail snapshot、以降 delta.detail を購読者へ push。
 *  - INV-REALTIME-STALLED: 60s 無活動 + process dead が evidence 分解付きで push される。
 *  - INV-REALTIME-RELAY (INV-APPROVAL): UI 承認が登録済 sidecar (real WS /ingest/ws + hello)
 *    へ controlToken 付きで中継される。未登録 session への承認は relay されない。
 *  - 既存 INV-EVENT-ORDER を壊さない: ingest 冪等・session 内順序は別テストが担保。
 *
 * REAL DATA ONLY: 実 PG に永続して検証。DB 未到達なら skip。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import type { FastifyInstance } from "fastify";
import { Pool } from "pg";

import { buildIngestionServer } from "../src/ingestion-server.js";
import { cleanupSessions, dbReachable, iso, makeEvent } from "./helpers.js";

const DATABASE_URL = process.env.DATABASE_URL;
const reachable = DATABASE_URL ? await dbReachable(DATABASE_URL) : false;
const INGEST_TOKEN = "test-ingest-token-realtime-1234567890";
const REALTIME_TOKEN = "test-realtime-token-abcdefghijklmnop";

interface Frame {
  type: string;
  [k: string]: unknown;
}

describe.skipIf(!reachable)("Realtime /realtime/ws (real PG + real WS)", () => {
  let pool: Pool;
  let app: FastifyInstance;
  let base: string;
  const sessions: string[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
    app = await buildIngestionServer({
      pool,
      ingestToken: INGEST_TOKEN,
      realtimeToken: REALTIME_TOKEN,
      maxPayloadBytes: 256 * 1024,
      // stalled をテスト時間内に観測するため staleMs を短縮 (60s の挙動は別 unit で固定)。
      livenessOptions: { staleMs: 50 },
      // presence grace をテスト時間内に観測するため短縮 (5s の既定は inv-live-presence で固定)。
      presenceGraceMs: 150,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (addr === null || typeof addr === "string") throw new Error("no port");
    base = `ws://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await cleanupSessions(pool, sessions);
    if (app) await app.close();
    if (pool) await pool.end();
  });

  function newSession(prefix: string): string {
    const sid = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    sessions.push(sid);
    return sid;
  }

  /** UI realtime 接続を開く。token をヘッダで渡す。frames は順次蓄積。 */
  function openUi(token = REALTIME_TOKEN): Promise<{
    ws: WebSocket;
    frames: Frame[];
    next: (pred: (f: Frame) => boolean, ms?: number) => Promise<Frame>;
    send: (o: unknown) => void;
    close: () => void;
  }> {
    return new Promise((resolve, reject) => {
      const frames: Frame[] = [];
      const waiters: Array<{ pred: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];
      const ws = new WebSocket(`${base}/realtime/ws`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const timer = setTimeout(() => reject(new Error("ui connect timeout")), 4_000);
      ws.on("open", () => {
        clearTimeout(timer);
        resolve({
          ws,
          frames,
          next: (pred, ms = 3_000) =>
            new Promise<Frame>((res, rej) => {
              const existing = frames.find(pred);
              if (existing) return res(existing);
              const t = setTimeout(() => rej(new Error("frame wait timeout")), ms);
              waiters.push({
                pred,
                resolve: (f) => {
                  clearTimeout(t);
                  res(f);
                },
              });
            }),
          send: (o: unknown) => ws.send(JSON.stringify(o)),
          close: () => ws.close(),
        });
      });
      ws.on("message", (d: Buffer) => {
        const f = JSON.parse(d.toString("utf8")) as Frame;
        frames.push(f);
        const idx = waiters.findIndex((w) => w.pred(f));
        if (idx >= 0) {
          const [w] = waiters.splice(idx, 1);
          w.resolve(f);
        }
      });
      ws.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  /**
   * sidecar として /ingest/ws に接続し hello を送る (UI→Sidecar 中継先)。
   *
   * 注意 (TDA-2): この hello フレームは **テストハーネスが自前で送って** いる。実 sidecar
   * (apps/sidecar) はまだ hello を emit しない (controlToken 配達は sidecar-engineer 領域の
   * 追跡項目)。よって本 e2e は backend の relay **プロトコル形状**を固定するものであり、
   * sidecar 側の conformance を保証するものではない。
   */
  function openSidecar(
    controlToken: string,
    sessionIds: string[],
  ): Promise<{
    received: Frame[];
    next: (pred: (f: Frame) => boolean, ms?: number) => Promise<Frame>;
    ingest: (ev: unknown) => Promise<Frame>;
    close: () => void;
  }> {
    return new Promise((resolve, reject) => {
      const received: Frame[] = [];
      const waiters: Array<{ pred: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];
      const ws = new WebSocket(`${base}/ingest/ws`, {
        headers: { authorization: `Bearer ${INGEST_TOKEN}` },
      });
      const timer = setTimeout(() => reject(new Error("sidecar connect timeout")), 4_000);
      ws.on("open", () => {
        clearTimeout(timer);
        ws.send(
          JSON.stringify({ type: "hello", control_token: controlToken, session_ids: sessionIds }),
        );
        resolve({
          received,
          next: (pred, ms = 3_000) =>
            new Promise<Frame>((res, rej) => {
              const existing = received.find(pred);
              if (existing) return res(existing);
              const t = setTimeout(() => rej(new Error("sidecar frame wait timeout")), ms);
              waiters.push({
                pred,
                resolve: (f) => {
                  clearTimeout(t);
                  res(f);
                },
              });
            }),
          ingest: (ev: unknown) =>
            new Promise<Frame>((res, rej) => {
              const t = setTimeout(() => rej(new Error("ingest ack timeout")), 3_000);
              const onAck = (d: Buffer) => {
                const f = JSON.parse(d.toString("utf8")) as Frame;
                if (f.type === "ack" && f.ok !== undefined && "inserted" in f) {
                  clearTimeout(t);
                  ws.off("message", onAck);
                  res(f);
                }
              };
              ws.on("message", onAck);
              ws.send(JSON.stringify(ev));
            }),
          close: () => ws.close(),
        });
      });
      ws.on("message", (d: Buffer) => {
        const f = JSON.parse(d.toString("utf8")) as Frame;
        // hello ack / ingest ack は received に入れつつ、relay (approval/interrupt) を待てる。
        received.push(f);
        const idx = waiters.findIndex((w) => w.pred(f));
        if (idx >= 0) {
          const [w] = waiters.splice(idx, 1);
          w.resolve(f);
        }
      });
      ws.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  // --- INV-REALTIME-AUTH ------------------------------------------------
  it("rejects UI WS without a valid realtime token (401, no upgrade)", async () => {
    const res = await new Promise<{ code?: number; upgraded: boolean }>((resolve) => {
      const ws = new WebSocket(`${base}/realtime/ws`); // token 無し
      let upgraded = false;
      ws.on("open", () => {
        upgraded = true;
        ws.close();
        resolve({ upgraded });
      });
      ws.on("unexpected-response", (_r, r) => resolve({ code: r.statusCode, upgraded }));
      ws.on("error", () => resolve({ upgraded }));
    });
    expect(res.upgraded).toBe(false);
    expect(res.code).toBe(401);
  });

  it("rejects UI WS with the ingest token (separate auth boundary)", async () => {
    const res = await new Promise<{ code?: number; upgraded: boolean }>((resolve) => {
      const ws = new WebSocket(`${base}/realtime/ws`, {
        headers: { authorization: `Bearer ${INGEST_TOKEN}` }, // ingest token は UI に通らない
      });
      let upgraded = false;
      ws.on("open", () => {
        upgraded = true;
        ws.close();
        resolve({ upgraded });
      });
      ws.on("unexpected-response", (_r, r) => resolve({ code: r.statusCode, upgraded }));
      ws.on("error", () => resolve({ upgraded }));
    });
    expect(res.upgraded).toBe(false);
    expect(res.code).toBe(401);
  });

  // --- INV-REALTIME-PUSH: connect snapshot + ingest delta ---------------
  it("sends a list snapshot on connect and a list delta after ingest (tool call → push)", async () => {
    const sid = newSession("rt_push");
    const ui = await openUi();
    const snap = await ui.next((f) => f.type === "snapshot.list");
    expect(Array.isArray(snap.sessions)).toBe(true);

    const sc = await openSidecar("ctl-push", [sid]);
    await sc.next((f) => f.type === "ack" && f.ok === true); // hello ack

    // tool.started を ingest → delta.list が当該 session で届く。
    await sc.ingest(
      makeEvent({
        session_id: sid,
        state: "running.command_executing",
        event_type: "tool.started",
        summary: "Bash: npm test",
        payload: { kind: "tool.started", tool_name: "Bash" },
      }),
    );
    const delta = await ui.next(
      (f) => f.type === "delta.list" && (f.session as Record<string, unknown>)?.session_id === sid,
    );
    const item = delta.session as Record<string, unknown>;
    expect(item.state).toBe("running.command_executing");
    expect(item.current_action).toBe("Bash: npm test");

    ui.close();
    sc.close();
  });

  // --- INV-PRESENCE-DELTA: 接続在席 delta (ADR 019ea2bf) ----------------
  it("INV-PRESENCE-DELTA: connected=true on sidecar connect+ingest, then connected=false after disconnect grace", async () => {
    const sid = newSession("rt_presence");
    const ui = await openUi();
    await ui.next((f) => f.type === "snapshot.list");

    const sc = await openSidecar("ctl-presence", [sid]);
    await sc.next((f) => f.type === "ack" && f.ok === true); // hello ack

    // ingest → 当該 session の delta.list が connected=true(sidecar 在席)で届く。
    await sc.ingest(
      makeEvent({ session_id: sid, state: "running.model_wait", event_type: "turn.started" }),
    );
    const up = await ui.next(
      (f) => f.type === "delta.list" && (f.session as Record<string, unknown>)?.session_id === sid,
    );
    expect((up.session as Record<string, unknown>).connected).toBe(true);

    // sidecar 切断 → grace(150ms) 満了 → 同 session の delta.list が connected=false で届く。
    sc.close();
    const down = await ui.next(
      (f) =>
        f.type === "delta.list" &&
        (f.session as Record<string, unknown>)?.session_id === sid &&
        (f.session as Record<string, unknown>)?.connected === false,
      3_000,
    );
    expect((down.session as Record<string, unknown>).connected).toBe(false);

    ui.close();
  });

  // --- INV-REALTIME-DETAIL: subscribe snapshot + detail delta -----------
  it("subscribe yields a detail snapshot then detail deltas for subscribers only", async () => {
    const sid = newSession("rt_detail");
    const sc = await openSidecar("ctl-detail", [sid]);
    await sc.next((f) => f.type === "ack" && f.ok === true);
    await sc.ingest(
      makeEvent({ session_id: sid, state: "starting", event_type: "session.started" }),
    );

    const ui = await openUi();
    await ui.next((f) => f.type === "snapshot.list");
    ui.send({ type: "subscribe", session_id: sid });

    const snap = await ui.next((f) => f.type === "snapshot.detail" && f.session_id === sid);
    expect((snap.detail as Record<string, unknown>).session_id).toBe(sid);
    await ui.next((f) => f.type === "ack" && f.action === "subscribe" && f.ok === true);

    // 以降の ingest で delta.detail が届く。
    await sc.ingest(
      makeEvent({ session_id: sid, state: "running.model_wait", event_type: "turn.started" }),
    );
    const d = await ui.next((f) => f.type === "delta.detail" && f.session_id === sid);
    expect((d.detail as Record<string, unknown>).state).toBe("running.model_wait");

    ui.close();
    sc.close();
  });

  // --- INV-REALTIME-STALLED: evidence-decomposed stalled push -----------
  // 注意 (QA-4): 「単一シグナルで stalled を断定しない」over-assertion ガードの正典は
  //   inv-stalled.test.ts。本 e2e は process dead を固定して push 経路を検証するため、
  //   idle→stalled の誤断定 mutation はここでは赤化しない (inv-stalled が担保)。
  it("pushes stalled with decomposed liveness evidence", async () => {
    const sid = newSession("rt_stalled");
    const sc = await openSidecar("ctl-stalled", [sid]);
    await sc.next((f) => f.type === "ack" && f.ok === true);
    const ui = await openUi();
    await ui.next((f) => f.type === "snapshot.list");
    ui.send({ type: "subscribe", session_id: sid });
    await ui.next((f) => f.type === "ack" && f.action === "subscribe");

    const past = Date.now() - 10_000; // staleMs=50 を十分超える古さ
    await sc.ingest(
      makeEvent({
        session_id: sid,
        state: "starting",
        event_type: "session.started",
        timestamp: iso(past),
      }),
    );
    // process dead heartbeat (古い) → 全シグナル stale + processDead で stalled。
    await sc.ingest(
      makeEvent({
        session_id: sid,
        event_type: "heartbeat",
        timestamp: iso(past, 10),
        payload: { kind: "heartbeat", process_alive: false },
      }),
    );

    const d = await ui.next(
      (f) =>
        f.type === "delta.detail" &&
        f.session_id === sid &&
        (f.detail as Record<string, unknown>)?.liveness_state === "stalled",
    );
    const det = d.detail as Record<string, unknown>;
    expect(det.stalled_suspected).toBe(true);
    const ev = det.liveness_evidence as Record<string, unknown>;
    // 根拠が分解保持されている (process が alive=false で観測されている)。
    expect(ev.process).toBeDefined();
    expect((ev.process as Record<string, unknown>).alive).toBe(false);

    ui.close();
    sc.close();
  });

  // --- INV-REALTIME-RELAY / INV-APPROVAL --------------------------------
  it("relays UI approval to the owning sidecar with the control token", async () => {
    const sid = newSession("rt_relay");
    const sc = await openSidecar("ctl-relay-secret", [sid]);
    await sc.next((f) => f.type === "ack" && f.ok === true); // hello ack

    const ui = await openUi();
    await ui.next((f) => f.type === "snapshot.list");

    ui.send({
      type: "approve",
      session_id: sid,
      request_id: `${sid}:apr-xyz`,
      decision: "allow",
      reason: "user clicked allow",
    });

    // sidecar が approval を controlToken 付きで受信する。
    const relayed = await sc.next((f) => f.type === "approval");
    expect(relayed.request_id).toBe(`${sid}:apr-xyz`);
    expect(relayed.decision).toBe("allow");
    expect(relayed.token).toBe("ctl-relay-secret");

    const ack = await ui.next((f) => f.type === "ack" && f.action === "approve");
    expect(ack.ok).toBe(true);

    ui.close();
    sc.close();
  });

  it("does not relay approval for an unregistered session (safe default)", async () => {
    const ui = await openUi();
    await ui.next((f) => f.type === "snapshot.list");
    ui.send({
      type: "approve",
      session_id: "no_such_session_registered",
      request_id: "r1",
      decision: "allow",
    });
    const ack = await ui.next((f) => f.type === "ack" && f.action === "approve");
    expect(ack.ok).toBe(false);
    expect(String(ack.error)).toMatch(/not registered/i);
    ui.close();
  });

  it("relays UI interrupt to the owning sidecar with the control token", async () => {
    const sid = newSession("rt_interrupt");
    const sc = await openSidecar("ctl-int-secret", [sid]);
    await sc.next((f) => f.type === "ack" && f.ok === true);
    const ui = await openUi();
    await ui.next((f) => f.type === "snapshot.list");

    ui.send({ type: "interrupt", session_id: sid });
    const relayed = await sc.next((f) => f.type === "interrupt");
    expect(relayed.session_id).toBe(sid);
    expect(relayed.token).toBe("ctl-int-secret");
    const ack = await ui.next((f) => f.type === "ack" && f.action === "interrupt");
    expect(ack.ok).toBe(true);
    ui.close();
    sc.close();
  });

  it("does not relay interrupt for an unregistered session", async () => {
    const ui = await openUi();
    await ui.next((f) => f.type === "snapshot.list");
    ui.send({ type: "interrupt", session_id: "ghost_interrupt_session" });
    const ack = await ui.next((f) => f.type === "ack" && f.action === "interrupt");
    expect(ack.ok).toBe(false);
    expect(String(ack.error)).toMatch(/not registered/i);
    ui.close();
  });

  it("acks unsubscribe and stops detail deltas", async () => {
    const sid = newSession("rt_unsub");
    const sc = await openSidecar("ctl-unsub", [sid]);
    await sc.next((f) => f.type === "ack" && f.ok === true);
    await sc.ingest(
      makeEvent({ session_id: sid, state: "starting", event_type: "session.started" }),
    );
    const ui = await openUi();
    await ui.next((f) => f.type === "snapshot.list");
    ui.send({ type: "subscribe", session_id: sid });
    await ui.next((f) => f.type === "ack" && f.action === "subscribe");
    ui.send({ type: "unsubscribe", session_id: sid });
    const ack = await ui.next((f) => f.type === "ack" && f.action === "unsubscribe");
    expect(ack.ok).toBe(true);
    ui.close();
    sc.close();
  });

  it("rejects subscribe with a missing session_id", async () => {
    const ui = await openUi();
    await ui.next((f) => f.type === "snapshot.list");
    ui.send({ type: "subscribe", session_id: "" });
    const ack = await ui.next((f) => f.type === "ack" && f.action === "subscribe");
    expect(ack.ok).toBe(false);
    ui.close();
  });

  it("rejects an approval with an invalid decision (T1 ApprovalDecision)", async () => {
    const sid = newSession("rt_baddec");
    const sc = await openSidecar("ctl-baddec", [sid]);
    await sc.next((f) => f.type === "ack" && f.ok === true);
    const ui = await openUi();
    await ui.next((f) => f.type === "snapshot.list");
    ui.send({ type: "approve", session_id: sid, request_id: "r1", decision: "yolo" });
    const ack = await ui.next((f) => f.type === "ack" && f.action === "approve");
    expect(ack.ok).toBe(false);
    expect(String(ack.error)).toMatch(/invalid approval/i);
    // sidecar には不正 decision が一切届かない。
    await expect(sc.next((f) => f.type === "approval", 300)).rejects.toThrow();
    ui.close();
    sc.close();
  });

  it("rejects an approval with non-string session_id/request_id (omits them from the ack)", async () => {
    // 不正承認 ack 整形の分岐 (realtime-server.ts:280-281 の `typeof ===\"string\"` 偽枝): session_id /
    // request_id が文字列でない承認は中継せず、ack には両キーを **付けず** ok:false で返す。
    const ui = await openUi();
    await ui.next((f) => f.type === "snapshot.list");
    // session_id/request_id を数値で送る (T1 検証が文字列でないため reject)。
    ui.send({ type: "approve", session_id: 123, request_id: 456, decision: "allow" });
    const ack = await ui.next((f) => f.type === "ack" && f.action === "approve");
    expect(ack.ok).toBe(false);
    expect(String(ack.error)).toMatch(/invalid approval/i);
    // 非文字列の session_id / request_id は ack に混入しない (条件付き spread の偽枝)。
    expect("session_id" in ack).toBe(false);
    expect("request_id" in ack).toBe(false);
    ui.close();
  });

  it("acks unsubscribe with a non-string session_id without unsubscribing (fail-safe)", async () => {
    // unsubscribe ガード (realtime-server.ts:239 の `typeof ===\"string\"` 偽枝): session_id が
    // 文字列でなければ handle.unsubscribe を呼ばず、ack だけ ok:true で返す (接続維持)。
    const ui = await openUi();
    await ui.next((f) => f.type === "snapshot.list");
    ui.send({ type: "unsubscribe", session_id: 999 });
    const ack = await ui.next((f) => f.type === "ack" && f.action === "unsubscribe");
    expect(ack.ok).toBe(true);
    ui.close();
  });

  it("rejects an interrupt with a missing session_id (QA-2: fail-safe ack)", async () => {
    const ui = await openUi();
    await ui.next((f) => f.type === "snapshot.list");
    ui.send({ type: "interrupt", session_id: "" });
    const ack = await ui.next((f) => f.type === "ack" && f.action === "interrupt");
    expect(ack.ok).toBe(false);
    expect(String(ack.error)).toMatch(/missing session_id/i);
    ui.close();
  });

  it("survives invalid JSON and unknown frame types without dropping the connection (QA-2)", async () => {
    const ui = await openUi();
    await ui.next((f) => f.type === "snapshot.list");
    // 不正 JSON (parse 失敗パス) と未知 type (default パス) は黙殺され接続は維持される。
    ui.ws.send("this is not json {");
    ui.send({ type: "totally-unknown-frame", foo: 1 });
    // 続く正当な frame に ack が返る = 上記2フレームで接続が落ちていない証跡。
    ui.send({ type: "subscribe", session_id: "" });
    const ack = await ui.next((f) => f.type === "ack" && f.action === "subscribe");
    expect(ack.ok).toBe(false);
    ui.close();
  });
});
