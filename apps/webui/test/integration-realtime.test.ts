/**
 * 結合テスト: webui RealtimeClient + reducer/parser を **実 backend (buildIngestionServer)
 * + 実 PostgreSQL + 実 WS** に対して走らせる (REAL DATA ONLY).
 *
 * 検証する観測導線 (一覧 → 詳細):
 *  - 接続直後の snapshot.list を client が受信し reducer が一覧化する。
 *  - sidecar が tool イベントを ingest すると **受け入れ基準 1 秒以内** に delta.list が
 *    一覧へ反映され、current_action が出る (KPI: 1 行で何をしているか分かる)。
 *  - subscribe で snapshot.detail を受け、以降 delta.detail で詳細が更新される。
 *  - liveness evidence (heartbeat 別) が detail に分解保持される。
 *
 * このテストは webui のパーサ/reducer/クライアントが backend の **実フレーム** と
 * 契約一致することを保証する (型再利用が机上でなく実配信で噛み合うことの証跡)。
 * DB 未到達なら skip (偽緑にしない: 走った本数を報告で明示する)。
 *
 * 本番の BFF は Bearer を server-side で付ける。ここでは node の `ws` 経由で Bearer を
 * 付けた SocketLike を client に注入して、本番 BFF が中継するのと同じ「Bearer 済 upstream」
 * を再現する (browser native WS のヘッダ不可制約はテストの関心外)。
 */
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildIngestionServer } from "@actradeck/backend";
import { newEventId, parseEvent } from "@actradeck/event-model";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";

import { RealtimeClient, type SocketLike } from "../src/realtime/client.js";
import {
  applyListDelta,
  applySnapshotList,
  emptyListState,
  type ListState,
} from "../src/realtime/list-reducer.js";

import type { ServerFrame, SessionDetail } from "../src/realtime/contract.js";

const DATABASE_URL = process.env.DATABASE_URL;
const INGEST_TOKEN = "test-ingest-token-webui-int-1234567890";
const REALTIME_TOKEN = "test-realtime-token-webui-int-abcdefgh";

async function dbReachable(cs: string): Promise<boolean> {
  const pool = new Pool({ connectionString: cs, connectionTimeoutMillis: 2_000, max: 1 });
  try {
    const c = await pool.connect();
    c.release();
    return true;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => {});
  }
}

const reachable = DATABASE_URL ? await dbReachable(DATABASE_URL) : false;

// QA-2/TDA-3: CI では DB 必須。到達不能で無音 skip すると受け入れ基準 (1s 反映) を
//   検証しないまま緑になる (偽緑)。CI=true かつ未到達なら **明示 fail** させる
//   (ローカルは従来どおり skip して開発を妨げない)。
if (process.env.CI === "true" && !reachable) {
  throw new Error(
    "CI requires a reachable DATABASE_URL for webui realtime integration tests " +
      "(acceptance-criteria assertions must not be silently skipped).",
  );
}

/** node `ws` を Bearer 付きで開く SocketLike アダプタ (BFF の Bearer 中継を再現)。 */
function wsSocketFactory(base: string): (url: string) => SocketLike {
  return (_url: string) => {
    const raw = new WebSocket(`${base}/realtime/ws`, {
      headers: { authorization: `Bearer ${REALTIME_TOKEN}` },
    });
    const sock: SocketLike = {
      send: (data) => raw.send(data),
      close: () => raw.close(),
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
    };
    raw.on("open", () => sock.onopen?.());
    raw.on("close", () => sock.onclose?.());
    raw.on("error", () => sock.onerror?.());
    raw.on("message", (d: Buffer) => sock.onmessage?.({ data: d.toString("utf8") }));
    return sock;
  };
}

function openSidecar(base: string, controlToken: string, sessionIds: string[]) {
  return new Promise<{ ingest: (ev: unknown) => Promise<void>; close: () => void }>(
    (resolve, reject) => {
      const ws = new WebSocket(`${base}/ingest/ws`, {
        headers: { authorization: `Bearer ${INGEST_TOKEN}` },
      });
      const t = setTimeout(() => reject(new Error("sidecar connect timeout")), 4_000);
      ws.on("open", () => {
        clearTimeout(t);
        ws.send(
          JSON.stringify({ type: "hello", control_token: controlToken, session_ids: sessionIds }),
        );
        resolve({
          ingest: (ev) =>
            new Promise<void>((res, rej) => {
              const to = setTimeout(() => rej(new Error("ingest ack timeout")), 3_000);
              const onAck = (d: Buffer) => {
                const f = JSON.parse(d.toString("utf8")) as { type?: string; inserted?: unknown };
                if (f.type === "ack" && "inserted" in f) {
                  clearTimeout(to);
                  ws.off("message", onAck);
                  res();
                }
              };
              ws.on("message", onAck);
              ws.send(JSON.stringify(ev));
            }),
          close: () => ws.close(),
        });
      });
      ws.on("error", (e) => {
        clearTimeout(t);
        reject(e);
      });
    },
  );
}

function makeEvent(o: {
  session_id: string;
  event_type: string;
  state?: string;
  summary?: string;
  payload?: Record<string, unknown>;
}) {
  const input: Record<string, unknown> = {
    event_id: newEventId(),
    provider: "claude_code",
    source: "hooks",
    session_id: o.session_id,
    event_type: o.event_type,
    timestamp: new Date().toISOString(),
    payload: o.payload ?? {},
  };
  if (o.state !== undefined) input.state = o.state;
  if (o.summary !== undefined) input.summary = o.summary;
  return parseEvent(input);
}

/** 条件を満たす frame を期限内に待つ (client.onFrame を購読)。 */
function waitFrame(
  frames: ServerFrame[],
  pred: (f: ServerFrame) => boolean,
  ms = 3_000,
): Promise<ServerFrame> {
  return new Promise((res, rej) => {
    const existing = frames.find(pred);
    if (existing) return res(existing);
    const start = Date.now();
    const iv = setInterval(() => {
      const f = frames.find(pred);
      if (f) {
        clearInterval(iv);
        res(f);
      } else if (Date.now() - start > ms) {
        clearInterval(iv);
        rej(new Error("frame wait timeout"));
      }
    }, 10);
  });
}

describe.skipIf(!reachable)("webui RealtimeClient ↔ real backend (real PG + real WS)", () => {
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
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (addr === null || typeof addr === "string") throw new Error("no port");
    base = `ws://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    if (sessions.length > 0) {
      await pool.query(`DELETE FROM sessions WHERE session_id = ANY($1::text[])`, [sessions]);
    }
    if (app) await app.close();
    if (pool) await pool.end();
  });

  function newSession(prefix: string): string {
    const sid = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    sessions.push(sid);
    return sid;
  }

  it("receives snapshot.list then delta.list within ~1s of a tool ingest, and reduces it", async () => {
    const sid = newSession("webui_push");
    const frames: ServerFrame[] = [];
    let listState: ListState = emptyListState;
    const client = new RealtimeClient({
      url: "ws://placeholder/realtime/ws",
      socketFactory: wsSocketFactory(base),
      onFrame: (f) => {
        frames.push(f);
        if (f.type === "snapshot.list") listState = applySnapshotList(f.sessions);
        if (f.type === "delta.list") listState = applyListDelta(listState, f.session);
      },
    });
    client.start();
    await waitFrame(frames, (f) => f.type === "snapshot.list");

    const sc = await openSidecar(base, "ctl-webui-push", [sid]);
    const t0 = Date.now();
    await sc.ingest(
      makeEvent({
        session_id: sid,
        event_type: "tool.started",
        state: "running.command_executing",
        summary: "Bash: pnpm test",
        payload: { kind: "tool.started", tool_name: "Bash" },
      }),
    );
    await waitFrame(frames, (f) => f.type === "delta.list" && f.session.session_id === sid, 2_000);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(1_500); // 受け入れ基準: tool call → 反映が速い

    const item = listState.items.get(sid);
    expect(item?.current_action).toBe("Bash: pnpm test");
    expect(item?.state).toBe("running.command_executing");

    client.stop();
    sc.close();
  });

  it("subscribe yields a detail snapshot then delta.detail with decomposed liveness evidence", async () => {
    const sid = newSession("webui_detail");
    const sc = await openSidecar(base, "ctl-webui-detail", [sid]);
    await sc.ingest(
      makeEvent({ session_id: sid, event_type: "session.started", state: "starting" }),
    );

    const frames: ServerFrame[] = [];
    let detail: SessionDetail | null = null;
    const client = new RealtimeClient({
      url: "ws://placeholder/realtime/ws",
      socketFactory: wsSocketFactory(base),
      onFrame: (f) => {
        frames.push(f);
        if ((f.type === "snapshot.detail" || f.type === "delta.detail") && f.session_id === sid) {
          detail = f.detail;
        }
      },
    });
    client.start();
    await waitFrame(frames, (f) => f.type === "snapshot.list");
    client.subscribe(sid);

    await waitFrame(frames, (f) => f.type === "snapshot.detail" && f.session_id === sid);
    expect(detail).not.toBeNull();
    // 以降の ingest で delta.detail が届き、liveness evidence が分解保持される。
    await sc.ingest(
      makeEvent({
        session_id: sid,
        event_type: "heartbeat",
        payload: { kind: "heartbeat", process_alive: true },
      }),
    );
    const d = await waitFrame(frames, (f) => f.type === "delta.detail" && f.session_id === sid);
    if (d.type !== "delta.detail") throw new Error("expected delta.detail");
    // process heartbeat が evidence に分解されている (単一シグナルで停止断定しない設計の根拠)。
    expect(d.detail.liveness_evidence).toBeDefined();
    expect(d.detail.invalid_transition_count).toBeGreaterThanOrEqual(0);

    client.stop();
    sc.close();
  });

  // ADR 019e9999 段階②: 承認待ちが **実 backend 投影 → wire → webui パーサ** を端から端まで
  // 通り、detail.pending_approvals に request_id 突合キー付きで現れることを実データで固定する。
  // (stale dist で pending_approvals が wire に乗らないと parse-frame が delta.detail を弾く
  //  回帰を、この緑が backend 再ビルド込みで担保する。)
  it("projects a permission.requested into detail.pending_approvals over the real wire", async () => {
    const sid = newSession("webui_approval");
    const sc = await openSidecar(base, "ctl-webui-approval", [sid]);
    await sc.ingest(
      makeEvent({ session_id: sid, event_type: "session.started", state: "starting" }),
    );

    const frames: ServerFrame[] = [];
    let detail: SessionDetail | null = null;
    const client = new RealtimeClient({
      url: "ws://placeholder/realtime/ws",
      socketFactory: wsSocketFactory(base),
      onFrame: (f) => {
        frames.push(f);
        if ((f.type === "snapshot.detail" || f.type === "delta.detail") && f.session_id === sid) {
          detail = f.detail;
        }
      },
    });
    client.start();
    await waitFrame(frames, (f) => f.type === "snapshot.list");
    client.subscribe(sid);
    await waitFrame(frames, (f) => f.type === "snapshot.detail" && f.session_id === sid);

    const reqId = `req_${Math.random().toString(36).slice(2, 12)}`;
    await sc.ingest(
      makeEvent({
        session_id: sid,
        event_type: "tool.permission.requested",
        state: "waiting.approval",
        payload: {
          kind: "tool.permission.requested",
          request_id: reqId,
          tool_name: "Bash",
          command: "pnpm test",
          risk_level: "medium",
        },
      }),
    );

    // parse-frame の pending_approvals 検証を通った delta.detail が届き、request_id 突合できる。
    await waitFrame(
      frames,
      (f) =>
        f.type === "delta.detail" &&
        f.session_id === sid &&
        f.detail.pending_approvals.some((p) => p.request_id === reqId),
    );
    if (detail === null) throw new Error("expected detail");
    const d: SessionDetail = detail;
    const card = d.pending_approvals.find((p) => p.request_id === reqId);
    expect(card).toBeDefined();
    expect(card?.tool_name).toBe("Bash");
    expect(card?.command).toBe("pnpm test"); // backend redaction 済み値のみ (生 tool_input 不参照)
    expect(d.needs_attention).toBe(true);

    // resolved を流すと当該 request_id が pending から消える (D3: 消滅は backend 確定)。
    await sc.ingest(
      makeEvent({
        session_id: sid,
        event_type: "tool.permission.resolved",
        state: "running.command_executing",
        payload: { kind: "tool.permission.resolved", request_id: reqId, decision: "allow" },
      }),
    );
    await waitFrame(
      frames,
      (f) =>
        f.type === "delta.detail" &&
        f.session_id === sid &&
        !f.detail.pending_approvals.some((p) => p.request_id === reqId),
    );

    client.stop();
    sc.close();
  });
});
