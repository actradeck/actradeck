/**
 * Approval Inbox 段階1 (ADR 019ead14 D1) の不変条件 — REAL PostgreSQL + REAL WS。
 *
 * 縛る不変条件 (falsifiable・mutation で赤):
 *  - INV-INBOX-AGGREGATE: `GET /realtime/approvals` は **connected(接続在席)かつ pending_approvals
 *    非空** の全 session の承認待ちを横断集約する。connected でない session(pending あり)や
 *    pending 空の session(connected)は含めない。connected フィルタ(isLive)や非空フィルタを外す
 *    mutation で赤。
 *  - INV-INBOX-RELAY-AUTH: `/realtime/approvals` は REALTIME_TOKEN 必須 (no/wrong/ingest token→401)。
 *    onRequest gate を外す mutation で赤。
 *  - INV-INBOX-REDACTION: 集約応答は **redaction 済みの allow-list 7 キーのみ**で、raw secret prefix
 *    (ghp_) は出ない。session_state.pending_approvals(sidecar redaction 済 jsonb)を再利用するだけ
 *    で backend は再 redaction も raw 露出もしない。allow-list 以外の生フィールドが応答に出ない。
 *
 * REAL DATA ONLY: 実 PG に永続して検証。DB 未到達なら skip。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import type { FastifyInstance } from "fastify";
import { Pool } from "pg";

import { buildIngestionServer } from "../src/ingestion-server.js";
import { cleanupSessions, dbReachable, makeEvent } from "./helpers.js";

const DATABASE_URL = process.env.DATABASE_URL;
const reachable = DATABASE_URL ? await dbReachable(DATABASE_URL) : false;
const INGEST_TOKEN = "test-ingest-token-inbox-1234567890";
const REALTIME_TOKEN = "test-realtime-token-inbox-abcdefghij";

interface Frame {
  type: string;
  ok?: boolean;
}

interface ApprovalsResponse {
  approvals: Array<{
    session_id: string;
    provider: string;
    cwd?: string;
    pending_approvals: Array<Record<string, unknown>>;
  }>;
}

describe.skipIf(!reachable)("INV-INBOX (real PG + real WS)", () => {
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
      maxPayloadBytes: 512 * 1024,
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

  /** sidecar として hello を送り、与えた session 群を **connected(在席)** にする (ack で確定待ち)。 */
  function openOwner(controlToken: string, sessionIds: string[]): Promise<{ close: () => void }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${base}/ingest/ws`, {
        headers: { authorization: `Bearer ${INGEST_TOKEN}` },
      });
      const timer = setTimeout(() => reject(new Error("sidecar connect timeout")), 4_000);
      ws.on("open", () => {
        ws.send(
          JSON.stringify({ type: "hello", control_token: controlToken, session_ids: sessionIds }),
        );
      });
      ws.on("message", (d: Buffer) => {
        const f = JSON.parse(d.toString("utf8")) as Frame;
        if (f.type === "ack" && f.ok === true) {
          clearTimeout(timer);
          resolve({ close: () => ws.close() });
        }
      });
      ws.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  async function ingest(ev: unknown): Promise<void> {
    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      headers: { authorization: `Bearer ${INGEST_TOKEN}` },
      payload: ev as object,
    });
    if (res.statusCode !== 200) throw new Error(`ingest failed: ${res.statusCode} ${res.body}`);
  }

  /** 当該 session に 1 件の pending approval を投影する (reducer foldPendingApprovals 経由)。 */
  async function requestApproval(
    sid: string,
    requestId: string,
    command: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await ingest(
      makeEvent({
        session_id: sid,
        event_type: "tool.permission.requested",
        state: "waiting.approval",
        payload: {
          request_id: requestId,
          tool_name: "Bash",
          command,
          risk_level: "high",
          ...extra,
        },
      }),
    );
  }

  async function getApprovals(token = REALTIME_TOKEN): Promise<{
    status: number;
    body: ApprovalsResponse;
    rawText: string;
  }> {
    const res = await app.inject({
      method: "GET",
      url: "/realtime/approvals",
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: res.statusCode, body: res.json() as ApprovalsResponse, rawText: res.body };
  }

  // --- INV-INBOX-RELAY-AUTH: token gate (新 route も既存 onRequest gate を継承) -------
  it("approvals endpoint: no token → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/realtime/approvals" });
    expect(res.statusCode).toBe(401);
  });

  it("approvals endpoint: wrong token → 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/realtime/approvals",
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("approvals endpoint: ingest token (separate auth boundary) → 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/realtime/approvals",
      headers: { authorization: `Bearer ${INGEST_TOKEN}` },
    });
    expect(res.statusCode).toBe(401);
  });

  // --- INV-INBOX-AGGREGATE: connected ∧ pending 非空 を横断集約 ---------------------
  it("aggregates pending approvals across connected sessions; excludes disconnected & empty", async () => {
    const s1 = newSession("inbox_c1"); // connected + pending
    const s2 = newSession("inbox_c2"); // connected + pending (2 件)
    const s3 = newSession("inbox_disc"); // pending あるが disconnected
    const s4 = newSession("inbox_nopend"); // connected だが pending 無し

    // s1/s2/s4 を connected にする (1 daemon が複数 session を所有する=attach 多重化と同形)。
    const owner = await openOwner("ctrl-token-inbox-aaaaaaaaaa", [s1, s2, s4]);
    try {
      await requestApproval(s1, "req-s1-1", "rm -rf /tmp/x");
      await requestApproval(s2, "req-s2-1", "git push --force");
      await requestApproval(s2, "req-s2-2", "chmod 777 /etc");
      await requestApproval(s3, "req-s3-1", "rm -rf /tmp/y"); // disconnected → 除外されるべき
      // s4 は connected だが pending を作らない (session.started のみ)。
      await ingest(makeEvent({ session_id: s4, event_type: "session.started", state: "starting" }));

      const { status, body } = await getApprovals();
      expect(status).toBe(200);

      const bySession = new Map(body.approvals.map((g) => [g.session_id, g]));
      // connected + pending の s1/s2 は含まれる。
      expect(bySession.has(s1)).toBe(true);
      expect(bySession.has(s2)).toBe(true);
      // disconnected (s3) と pending 空 (s4) は含まれない。
      expect(bySession.has(s3)).toBe(false);
      expect(bySession.has(s4)).toBe(false);
      // pending の件数と request_id が一意に集約される。
      expect(bySession.get(s1)?.pending_approvals.map((p) => p.request_id)).toEqual(["req-s1-1"]);
      const s2ids = bySession
        .get(s2)
        ?.pending_approvals.map((p) => p.request_id)
        .sort();
      expect(s2ids).toEqual(["req-s2-1", "req-s2-2"]);
    } finally {
      owner.close();
    }
  });

  it("returns empty approvals when no session is connected (disconnected pending is not disclosed)", async () => {
    const s = newSession("inbox_offline");
    await requestApproval(s, "req-offline-1", "rm -rf /tmp/z");
    // sidecar を開かない → isLive=false → この pending は出ない。
    const { status, body } = await getApprovals();
    expect(status).toBe(200);
    expect(body.approvals.some((g) => g.session_id === s)).toBe(false);
  });

  // QA-2: 非空 jsonb だが parse 後空 (request_id 欠落要素のみ) の行は、SQL jsonb_array_length>0 を
  //   通り抜けるため、除外は approvalsSnapshot の JS guard (pending.length===0 continue) だけが担う。
  //   この経路を独立 pin する (JS guard を外すと当該 session が空 pending で漏出し赤)。ingestion では
  //   作れない malformed at-rest を test-session への直接 UPDATE で再現 (実 PG・afterAll で cleanup)。
  it("excludes connected session whose pending jsonb is non-empty but parses to empty (JS guard, QA-2)", async () => {
    const sid = newSession("inbox_malformed");
    const owner = await openOwner("ctrl-token-inbox-cccccccccc", [sid]);
    try {
      // session_state / sessions 行を作る (connected だが pending は session.started で空)。
      await ingest(
        makeEvent({ session_id: sid, event_type: "session.started", state: "starting" }),
      );
      // at-rest を直接破損: 非空配列だが request_id を持たない = parsePendingApprovals で空に潰れる。
      await pool.query(
        `UPDATE session_state SET pending_approvals = $1::jsonb WHERE session_id = $2`,
        [JSON.stringify([{ tool_name: "Bash", command: "ls" }]), sid],
      );

      const { status, body } = await getApprovals();
      expect(status).toBe(200);
      expect(body.approvals.some((g) => g.session_id === sid)).toBe(false);
    } finally {
      owner.close();
    }
  });

  // --- INV-INBOX-REDACTION: redacted-at-rest を素通し + allow-list 限定 -------------
  it("returns redacted-at-rest values only (raw secret absent, allow-list keys only)", async () => {
    const sid = newSession("inbox_redact");
    const owner = await openOwner("ctrl-token-inbox-bbbbbbbbbb", [sid]);
    try {
      // sidecar は redaction 済みで ingest する (backend は再 redaction しない=sidecar choke)。
      // 加えて allow-list 外の生フィールド(secret_env)を payload に混ぜ、read が allow-list へ
      // 限定して raw を素通りさせないことを固定する。
      await requestApproval(sid, "req-redact-1", "export TOKEN=[REDACTED:github-token]", {
        secret_env: "ghp_SHOULD_NOT_LEAK_0123456789",
      });

      const { status, body, rawText } = await getApprovals();
      expect(status).toBe(200);
      const group = body.approvals.find((g) => g.session_id === sid);
      expect(group).toBeDefined();
      const pending = group!.pending_approvals[0]!;

      // redaction 済み値は素通り、raw secret prefix は応答全体に存在しない。
      expect(String(pending.command)).toContain("[REDACTED:github-token]");
      expect(rawText).not.toContain("ghp_");
      expect(rawText).not.toContain("SHOULD_NOT_LEAK");
      // 各キーは allow-list 7 キーの **部分集合** であること (JSON は undefined を省くため
      // 省略可能キーは出ないことがある。本質は「allow-list 外の生フィールドが出ない」)。
      // QA-4: この allow-list の最終固定 (raw spread 不在の field-by-field 再射影) は canonical
      //   parsePendingApprovals (packages/projection) が担保する。本ケースは read 面でその choke を
      //   素通り検証するもので、allow-list 自体の mutation sentinel は projection のテストが持つ。
      const ALLOW = new Set([
        "request_id",
        "tool_name",
        "command",
        "path",
        "risk_level",
        "requested_at",
        "session_id",
      ]);
      for (const k of Object.keys(pending)) {
        expect(ALLOW.has(k), `unexpected (non-allow-list) field leaked: ${k}`).toBe(true);
      }
      expect(pending).not.toHaveProperty("secret_env");
    } finally {
      owner.close();
    }
  });
});
