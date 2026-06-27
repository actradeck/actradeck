/**
 * 段階2 (ADR 019ea4ba D2) 本文 pull endpoint の不変条件 — REAL PostgreSQL + REAL WS。
 *
 * 縛る不変条件 (falsifiable・mutation で赤):
 *  - INV-DETAIL-PULL-AUTH: `/diff` と command `/output` は REALTIME_TOKEN 必須 (no/wrong token→401)。
 *    diff は **登録済 session 限定** (未登録/未 handshake → 404、controlToken 無し → 404)。認可除去
 *    mutation で赤。
 *  - INV-DETAIL-REDACTION-TRANSPARENCY (round-trip 全経路): sidecar が返す redaction 済み diff 本文が
 *    backend を素通りして HTTP 応答に届き、秘匿 (ghp_) は raw で出ず redaction 済み。
 *  - stdout output read: redacted-at-rest な command.output.delta.delta を tail 連結して返す
 *    (backend 再 redaction なし・allow-list delta)。
 *
 * REAL DATA ONLY: 実 PG に永続して検証。DB 未到達なら skip。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import type { FastifyInstance } from "fastify";
import { Pool } from "pg";

import { newEventId } from "@actradeck/event-model";

import { buildIngestionServer } from "../src/ingestion-server.js";
import { cleanupSessions, dbReachable, makeEvent } from "./helpers.js";

const DATABASE_URL = process.env.DATABASE_URL;
const reachable = DATABASE_URL ? await dbReachable(DATABASE_URL) : false;
const INGEST_TOKEN = "test-ingest-token-pull-1234567890";
const REALTIME_TOKEN = "test-realtime-token-pull-abcdefghij";

interface Frame {
  type: string;
  [k: string]: unknown;
}

describe.skipIf(!reachable)("INV-DETAIL-PULL (real PG + real WS)", () => {
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

  /**
   * sidecar として /ingest/ws に接続し hello を送る。inbound (diff.request) を購読し、
   * 与えられた diff 本文で diff.response を返す (実 sidecar の redaction 済み応答を模す)。
   */
  function openSidecar(
    controlToken: string,
    sessionIds: string[],
    diffBody: string,
    opts: { secretDetected?: boolean; redactionCount?: number; truncated?: boolean } = {},
  ): Promise<{ close: () => void; lastRequest: () => Frame | undefined }> {
    return new Promise((resolve, reject) => {
      let lastRequest: Frame | undefined;
      const ws = new WebSocket(`${base}/ingest/ws`, {
        headers: { authorization: `Bearer ${INGEST_TOKEN}` },
      });
      const timer = setTimeout(() => reject(new Error("sidecar connect timeout")), 4_000);
      let resolved = false;
      ws.on("open", () => {
        ws.send(
          JSON.stringify({ type: "hello", control_token: controlToken, session_ids: sessionIds }),
        );
      });
      ws.on("message", (d: Buffer) => {
        const f = JSON.parse(d.toString("utf8")) as Frame;
        // hello ack を待ってから resolve する (backend が session 所有を learn 済みであることを保証)。
        if (!resolved && f.type === "ack" && f.ok === true) {
          resolved = true;
          clearTimeout(timer);
          resolve({ close: () => ws.close(), lastRequest: () => lastRequest });
          return;
        }
        if (f.type === "diff.request") {
          lastRequest = f;
          // controlToken 検証を模す (実 sidecar の fail-safe deny と同等)。
          if (f.token !== controlToken) return;
          ws.send(
            JSON.stringify({
              type: "diff.response",
              request_id: f.request_id,
              body: diffBody,
              truncated: opts.truncated ?? false,
              secret_detected: opts.secretDetected ?? false,
              redaction_count: opts.redactionCount ?? 0,
            }),
          );
        }
      });
      ws.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  // --- INV-DETAIL-PULL-AUTH: token gate (HTTP inject) -------------------
  it("diff endpoint: no token → 401", async () => {
    const res = await app.inject({ method: "GET", url: `/realtime/sessions/sess_x/diff` });
    expect(res.statusCode).toBe(401);
  });

  it("diff endpoint: wrong token → 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/realtime/sessions/sess_x/diff`,
      headers: { authorization: `Bearer wrong-token` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("output endpoint: no token → 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/realtime/sessions/sess_x/commands/e1/output`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("output endpoint: ingest token (separate auth boundary) → 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/realtime/sessions/sess_x/commands/e1/output`,
      headers: { authorization: `Bearer ${INGEST_TOKEN}` },
    });
    expect(res.statusCode).toBe(401);
  });

  // --- INV-DETAIL-PULL-AUTH: registered-session gate (SSRF 境界) ---------
  it("diff: unregistered session (valid token) → 404 (foreign/未登録は本文を出さない)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/realtime/sessions/sess_never_registered/diff`,
      headers: { authorization: `Bearer ${REALTIME_TOKEN}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "session not registered" });
  });

  it("diff: foreign session (other than the sidecar's owned set) → 404", async () => {
    const owned = newSession("pull_owned");
    const foreign = newSession("pull_foreign");
    const sc = await openSidecar("ctrl-token-aaaaaaaaaaaaaaaa", [owned], "diff --git a/x b/x\n");
    try {
      const res = await app.inject({
        method: "GET",
        url: `/realtime/sessions/${encodeURIComponent(foreign)}/diff`,
        headers: { authorization: `Bearer ${REALTIME_TOKEN}` },
      });
      expect(res.statusCode).toBe(404);
    } finally {
      sc.close();
    }
  });

  // --- INV-DETAIL-REDACTION-TRANSPARENCY (round-trip 全経路) -------------
  it("diff: registered session round-trips the sidecar's (redacted) body verbatim, raw secret absent", async () => {
    const sid = newSession("pull_diff_ok");
    // sidecar は **redaction 済み** body を返す (実 sidecar の diff-provider 透過後を模す)。
    const redactedBody = "diff --git a/a.txt b/a.txt\n+GITHUB_TOKEN=[REDACTED:github-token]\n";
    const sc = await openSidecar("ctrl-token-bbbbbbbbbbbbbbbb", [sid], redactedBody, {
      secretDetected: true,
      redactionCount: 1,
    });
    try {
      const res = await app.inject({
        method: "GET",
        url: `/realtime/sessions/${encodeURIComponent(sid)}/diff`,
        headers: { authorization: `Bearer ${REALTIME_TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        body: string;
        secret_detected: boolean;
        redaction_count: number;
      };
      // backend は本文を素通し (再 redaction も改変もしない)。
      expect(body.body).toBe(redactedBody);
      // raw secret prefix は応答に存在しない (sidecar choke の証跡)。
      expect(body.body).not.toContain("ghp_");
      expect(body.body).toContain("[REDACTED:github-token]");
      expect(body.secret_detected).toBe(true);
      expect(body.redaction_count).toBe(1);
      // 中継要求には controlToken が付いている (relayApproval と同じ認可境界)。
      const req = sc.lastRequest();
      expect(req?.token).toBe("ctrl-token-bbbbbbbbbbbbbbbb");
      expect(req?.session_id).toBe(sid);
    } finally {
      sc.close();
    }
  });

  // --- stdout output read (redacted-at-rest を tail 連結) -----------------
  it("output: concatenates command.output.delta.delta (redacted-at-rest) as tail", async () => {
    const sid = newSession("pull_out");
    const t0 = Date.now();
    const cmdId = newEventId();
    // command.started (anchor) + 2 つの output delta を ingest する (実 PG に永続)。
    await ingest(
      makeEvent({
        event_id: cmdId,
        session_id: sid,
        event_type: "command.started",
        state: "running.command_executing",
        timestamp: new Date(t0).toISOString(),
        payload: { kind: "command.started", command: "echo hi" },
      }),
    );
    await ingest(
      makeEvent({
        session_id: sid,
        event_type: "command.output.delta",
        timestamp: new Date(t0 + 10).toISOString(),
        payload: { kind: "command.output.delta", stream: "stdout", delta: "line-one\n" },
      }),
    );
    await ingest(
      makeEvent({
        session_id: sid,
        event_type: "command.output.delta",
        timestamp: new Date(t0 + 20).toISOString(),
        payload: { kind: "command.output.delta", stream: "stdout", delta: "line-two\n" },
      }),
    );
    const res = await app.inject({
      method: "GET",
      url: `/realtime/sessions/${encodeURIComponent(sid)}/commands/${cmdId}/output`,
      headers: { authorization: `Bearer ${REALTIME_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { output_excerpt: string; anchor_event_id: string };
    expect(body.output_excerpt).toBe("line-one\nline-two\n");
    expect(body.anchor_event_id).toBe(cmdId);
  });

  // --- SEC-1 (anchor-window 上限の真ゲート化) -----------------------------
  // 2 つの command を同 session に並べ、cmd1 の anchor が **次の command.started (cmd2) の
  // timestamp 未満** の window に絞られることを固定する。nextStartTs を drop する mutation
  // (上限なし = session-wide) では cmd2 の出力まで含まれ、この assert が RED になる。
  it("output: anchor window excludes the NEXT command's output (nextStartTs upper bound)", async () => {
    const sid = newSession("pull_out_window");
    const t0 = Date.now();
    const cmd1 = newEventId();
    const cmd2 = newEventId();
    await ingest(
      makeEvent({
        event_id: cmd1,
        session_id: sid,
        event_type: "command.started",
        timestamp: new Date(t0).toISOString(),
        payload: { kind: "command.started", command: "echo first" },
      }),
    );
    await ingest(
      makeEvent({
        session_id: sid,
        event_type: "command.output.delta",
        timestamp: new Date(t0 + 5).toISOString(),
        payload: { kind: "command.output.delta", stream: "stdout", delta: "FIRST-OUT\n" },
      }),
    );
    // 次の command.started (window 上限の境界)。
    await ingest(
      makeEvent({
        event_id: cmd2,
        session_id: sid,
        event_type: "command.started",
        timestamp: new Date(t0 + 10).toISOString(),
        payload: { kind: "command.started", command: "echo second" },
      }),
    );
    await ingest(
      makeEvent({
        session_id: sid,
        event_type: "command.output.delta",
        timestamp: new Date(t0 + 15).toISOString(),
        payload: { kind: "command.output.delta", stream: "stdout", delta: "SECOND-OUT\n" },
      }),
    );
    const res = await app.inject({
      method: "GET",
      url: `/realtime/sessions/${encodeURIComponent(sid)}/commands/${cmd1}/output`,
      headers: { authorization: `Bearer ${REALTIME_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { output_excerpt: string; anchor_event_id: string };
    // cmd1 の出力のみ。**cmd2 の出力は含まない** (上限 = 次 command.started timestamp)。
    expect(body.output_excerpt).toBe("FIRST-OUT\n");
    expect(body.output_excerpt).not.toContain("SECOND-OUT");
    expect(body.anchor_event_id).toBe(cmd1);
    // 逆向きの境界も確認: cmd2 anchor は SECOND-OUT のみ・FIRST-OUT を含まない。
    const res2 = await app.inject({
      method: "GET",
      url: `/realtime/sessions/${encodeURIComponent(sid)}/commands/${cmd2}/output`,
      headers: { authorization: `Bearer ${REALTIME_TOKEN}` },
    });
    const body2 = res2.json() as { output_excerpt: string };
    expect(body2.output_excerpt).toBe("SECOND-OUT\n");
    expect(body2.output_excerpt).not.toContain("FIRST-OUT");
  });

  // --- SEC-1 (fail-closed: 非一致 anchor は session-wide fallback を返さない) ---
  // eventId が当該 session の command.started に一致しない (typo / 別 event_type / 別 session の id)
  // とき、session 全体の redacted 出力を黙って開示せず、空 excerpt + not_found=true を返す。
  // fail-closed を session-wide fallback に戻す mutation で、この assert が RED になる。
  it("output: non-matching anchor eventId fails closed (empty + not_found, no session-wide disclosure)", async () => {
    const sid = newSession("pull_out_failclosed");
    const t0 = Date.now();
    const cmdId = newEventId();
    // 実際の command + 出力を ingest する (session-wide fallback だとこれが漏れる)。
    await ingest(
      makeEvent({
        event_id: cmdId,
        session_id: sid,
        event_type: "command.started",
        timestamp: new Date(t0).toISOString(),
        payload: { kind: "command.started", command: "echo hi" },
      }),
    );
    await ingest(
      makeEvent({
        session_id: sid,
        event_type: "command.output.delta",
        timestamp: new Date(t0 + 5).toISOString(),
        payload: { kind: "command.output.delta", stream: "stdout", delta: "SENSITIVE-WIDE-OUT\n" },
      }),
    );
    // 当該 session に存在しない eventId で問い合わせる。
    const res = await app.inject({
      method: "GET",
      url: `/realtime/sessions/${encodeURIComponent(sid)}/commands/${newEventId()}/output`,
      headers: { authorization: `Bearer ${REALTIME_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      output_excerpt: string;
      not_found: boolean;
      anchor_event_id?: string;
    };
    // session-wide の出力は **開示されない** (over-disclosure 防止)。
    expect(body.output_excerpt).toBe("");
    expect(body.output_excerpt).not.toContain("SENSITIVE-WIDE-OUT");
    expect(body.not_found).toBe(true);
    expect(body.anchor_event_id).toBeUndefined();
  });

  // 非 command.started の event_id を anchor にした場合も fail-closed (anchor は command.started 限定)。
  it("output: anchor eventId pointing at a non-command.started event fails closed", async () => {
    const sid = newSession("pull_out_wrongtype");
    const t0 = Date.now();
    const cmdId = newEventId();
    const deltaId = newEventId();
    await ingest(
      makeEvent({
        event_id: cmdId,
        session_id: sid,
        event_type: "command.started",
        timestamp: new Date(t0).toISOString(),
        payload: { kind: "command.started", command: "echo hi" },
      }),
    );
    await ingest(
      makeEvent({
        event_id: deltaId,
        session_id: sid,
        event_type: "command.output.delta",
        timestamp: new Date(t0 + 5).toISOString(),
        payload: { kind: "command.output.delta", stream: "stdout", delta: "WIDE-OUT\n" },
      }),
    );
    // delta イベントの id を anchor に渡す (command.started ではない)。
    const res = await app.inject({
      method: "GET",
      url: `/realtime/sessions/${encodeURIComponent(sid)}/commands/${deltaId}/output`,
      headers: { authorization: `Bearer ${REALTIME_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { output_excerpt: string; not_found: boolean };
    expect(body.output_excerpt).toBe("");
    expect(body.not_found).toBe(true);
  });

  // --- QA-2 (L, correctness 隣接・INV-EVENT-ORDER 隣接): 同一 timestamp tie-break ----
  // 同一 timestamp の output delta は event_id ASC で **決定的** に連結される。ORDER BY から
  // `event_id ASC` を drop しても (timestamp ASC のみ)、同一 ts の 2 行は順不同になり、ingest を
  // canonical と逆順で行うと連結が非 canonical になりこの assert が RED になる (tie-break pin)。
  it("output: same-timestamp deltas concatenate in canonical event_id ASC order (tie-break)", async () => {
    const sid = newSession("pull_out_tiebreak");
    const t0 = Date.now();
    const cmdId = newEventId();
    // 2 つの UUIDv7 を採番し、辞書順で canonical (event_id ASC) を確定する。
    const ids = [newEventId(), newEventId()].sort();
    const lowId = ids[0]!; // event_id ASC で先。
    const highId = ids[1]!; // event_id ASC で後。
    const sameTs = new Date(t0 + 10).toISOString(); // 2 delta は **同一 timestamp**。

    await ingest(
      makeEvent({
        event_id: cmdId,
        session_id: sid,
        event_type: "command.started",
        timestamp: new Date(t0).toISOString(),
        payload: { kind: "command.started", command: "echo hi" },
      }),
    );
    // **canonical と逆順** で ingest する (highId 先・lowId 後)。event_id ASC tie-break が
    //   効いていれば連結は "LOW...HIGH..." になり、drop すると ingest 順 ("HIGH...LOW...") に化ける。
    await ingest(
      makeEvent({
        event_id: highId,
        session_id: sid,
        event_type: "command.output.delta",
        timestamp: sameTs,
        payload: { kind: "command.output.delta", stream: "stdout", delta: "HIGH-DELTA\n" },
      }),
    );
    await ingest(
      makeEvent({
        event_id: lowId,
        session_id: sid,
        event_type: "command.output.delta",
        timestamp: sameTs,
        payload: { kind: "command.output.delta", stream: "stdout", delta: "LOW-DELTA\n" },
      }),
    );
    const res = await app.inject({
      method: "GET",
      url: `/realtime/sessions/${encodeURIComponent(sid)}/commands/${cmdId}/output`,
      headers: { authorization: `Bearer ${REALTIME_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { output_excerpt: string };
    // canonical: event_id ASC で lowId(LOW-DELTA) → highId(HIGH-DELTA)。
    expect(body.output_excerpt).toBe("LOW-DELTA\nHIGH-DELTA\n");
  });

  // --- permission_mode 投影 (右ペイン sandbox 表示・ADR 019ea4ba D3) ----
  it("permission_mode (sandbox) is projected into SessionDetail DTO", async () => {
    const { RealtimeStore } = await import("../src/realtime-store.js");
    const store = new RealtimeStore(pool);
    const sid = newSession("pull_perm");
    await ingest(
      makeEvent({
        session_id: sid,
        event_type: "session.started",
        state: "starting",
        permission_mode: "acceptEdits",
      }),
    );
    const detail = await store.detail(sid, () => true);
    expect(detail?.permission_mode).toBe("acceptEdits");
  });

  it("permission_mode is last-non-null-wins (later non-null updates, null does not clobber)", async () => {
    const { RealtimeStore } = await import("../src/realtime-store.js");
    const store = new RealtimeStore(pool);
    const sid = newSession("pull_perm2");
    await ingest(
      makeEvent({ session_id: sid, event_type: "session.started", permission_mode: "default" }),
    );
    // permission_mode を持たないイベントが来ても既存値を消さない (COALESCE)。
    await ingest(makeEvent({ session_id: sid, event_type: "heartbeat" }));
    let detail = await store.detail(sid, () => true);
    expect(detail?.permission_mode).toBe("default");
    // 新しい非 null 値で更新される。
    await ingest(
      makeEvent({
        session_id: sid,
        event_type: "heartbeat",
        permission_mode: "bypassPermissions",
      }),
    );
    detail = await store.detail(sid, () => true);
    expect(detail?.permission_mode).toBe("bypassPermissions");
  });

  // --- stdout transparency: redacted-at-rest delta は raw secret を含まない -----
  it("output read returns redacted-at-rest deltas (raw secret never persisted nor returned)", async () => {
    const sid = newSession("pull_out_redact");
    const t0 = Date.now();
    const cmdId = newEventId();
    await ingest(
      makeEvent({
        event_id: cmdId,
        session_id: sid,
        event_type: "command.started",
        timestamp: new Date(t0).toISOString(),
        payload: { kind: "command.started", command: "printenv" },
      }),
    );
    // 注: ingestion-server は backend で再 redaction しない (sidecar が choke)。よって delta は
    //   **既に redaction 済み** で届く前提。ここでは redaction 済みトークンが read で素通りし、
    //   read 層が新たな raw 露出を作らない (allow-list delta) ことを固定する。
    await ingest(
      makeEvent({
        session_id: sid,
        event_type: "command.output.delta",
        timestamp: new Date(t0 + 5).toISOString(),
        payload: {
          kind: "command.output.delta",
          stream: "stdout",
          delta: "GITHUB_TOKEN=[REDACTED:github-token]\n",
        },
      }),
    );
    const res = await app.inject({
      method: "GET",
      url: `/realtime/sessions/${encodeURIComponent(sid)}/commands/${cmdId}/output`,
      headers: { authorization: `Bearer ${REALTIME_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { output_excerpt: string };
    expect(body.output_excerpt).toContain("[REDACTED:github-token]");
    expect(body.output_excerpt).not.toContain("ghp_");
  });

  async function ingest(ev: unknown): Promise<void> {
    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      headers: { authorization: `Bearer ${INGEST_TOKEN}` },
      payload: ev as object,
    });
    if (res.statusCode !== 200) throw new Error(`ingest failed: ${res.statusCode} ${res.body}`);
  }
});
