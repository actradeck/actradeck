/**
 * QA-1 (egress#QA-1, task 019e942b-d0c3) — 実 sidecar WsClient ↔ 実 backend
 * buildIngestionServer を **1 本で貫通**する e2e (REAL DATA ONLY)。
 *
 * 背景 (ライブで捕捉された 3 class の回帰固定):
 *  - path 欠落 (decision 019e9440): cli `resolveWsUrl` が `/ingest/ws` を欠き backend ルートで
 *    404→0 送信。egress-handshake の throwaway ws サーバは任意 path を受理し見逃した。
 *  - session_id 分裂 (019e9489): 監視イベントと hook イベントが別 session に projection。
 *  - explicit-mode 分裂 (019e94c4): ACTRADECK_SESSION 明示で再分裂。
 * これらは「実 WsClient(resolveWsUrl 経由) → 実 buildIngestionServer → PG projection」を
 * 貫通する e2e があれば CI で捕捉できた。本テストがその唯一の貫通ゲートである。
 *
 * 検証 (必達 assertion):
 *  1. Bearer 認証(path 込み): cli `resolveWsUrl()` で URL を導出 (path 付与は cli 任せ
 *     = path 欠落回帰を赤にする)。(a)正 token → OPEN / (b)誤 token → upgrade 401。
 *  2. hello→relay: hello 送出後 backend が control_token + 所有 session を学習し
 *     (`SidecarRegistry.canRelay`=true)、**実 UI realtime WS** からの approve/interrupt が
 *     backend の relayApproval/relayInterrupt 経由で WsClient.approval/interrupt emitter まで到達。
 *     (relay は backend が握る内部 SidecarRegistry を realtime ルート越しに駆動する = 完全貫通。)
 *  3. 2→1 projection 集約: 実 SessionIdentity(learn-wait) で **確定前の監視イベントを hold**
 *     → hook イベントで learn(claude UUID 相当) → flush。WsClient で実 backend へ送信後、
 *     **PG(events/session_state) を直接 query** し『監視由来+hook 由来が単一 canonical
 *     session_id へ projection される』ことを assert (2 セッションに割れたら赤)。
 *  4. explicit-mode 回帰: cli `resolveManagedSession()` で ACTRADECK_SESSION 設定時も
 *     explicitSession=false を使う経路を通し、上記 2→1 が成立すること
 *     (explicit 即確定の再導入を赤にする)。
 *
 * REAL DATA ONLY: 実 backend(buildIngestionServer) + 実 PG + 実 ws + 実 WsClient/EventSink/
 * EventStore/SessionIdentity。mock は無い。DATABASE_URL 未供給時のみ describe.skipIf で skip
 * するが、CI(verify job)では実走を保証する (ci.yml の実走ガード step)。
 *
 * flaky 対策: ephemeral port (port:0) / 固定 sleep に頼らず ack・projection を poll /
 * teardown で listen 解放 + temp db 削除。各テストは固有 session_id/temp db で互いに干渉しない。
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { WebSocket } from "ws";
import { buildIngestionServer } from "@actradeck/backend";

import { resolveManagedSession, resolveWsUrl } from "../src/cli.js";
import { buildEvent } from "../src/event-factory.js";
import { SessionIdentity } from "../src/session-identity.js";
import { EventSink } from "../src/sink.js";
import { EventStore } from "../src/store.js";
import { type ApprovalDecisionMsg, type InterruptMsg, WsClient } from "../src/ws-client.js";

const DATABASE_URL = process.env.DATABASE_URL;

/** DB 到達可否 (skipIf 用)。helpers と同型だが sidecar からは backend test helpers を引かない。 */
async function dbReachable(connectionString: string): Promise<boolean> {
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 2_000, max: 1 });
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

const INGEST_TOKEN = "qa1-e2e-ingest-token-1234567890";
const WRONG_TOKEN = "qa1-e2e-ingest-token-WRONGWRONG0"; // 同長 (timingSafeEqual 経路を実走)
const REALTIME_TOKEN = "qa1-e2e-realtime-token-09876543210"; // UI 経路 (relay 駆動用・別認証)

/** 条件が真になるまで poll する (固定 sleep を避け flaky を防ぐ)。 */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 5_000, stepMs = 20 }: { timeoutMs?: number; stepMs?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/**
 * 一意な session_id を生成 (テスト間の PG 干渉防止)。
 * **redaction 安全**な形にする: redactor は長い高エントロピー連結を secret 視するため、
 * 区切りを保ち短い乱数のみ付ける (probe で `sess_<prefix>_<digits>_<6char>` は非 redact を確認)。
 */
function uniqueSession(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * canonical(= claude hook session_id 相当)。**実 claude の session_id は UUID** で、redactor は
 * UUID 形を保持する (probe 確認)。canonical を UUID にすることで、emit 経路の redaction を通っても
 * session_id が保たれ、PG projection で 1 セッションに集約されることを正しく assert できる。
 */
function canonicalSession(): string {
  return randomUUID();
}

describe.skipIf(!reachable)(
  "INV-EGRESS-E2E: real WsClient ↔ real buildIngestionServer (real PG)",
  () => {
    let pool: Pool;
    let app: FastifyInstance;
    let port: number;
    const createdSessions: string[] = [];
    /**
     * 各テストで作る WsClient / store / SessionIdentity / temp dir を teardown で確実に解放。
     * **LIFO** で実行する: makeStore() を先に呼び store disposer を積み、その後 client disposer を
     * 積むため、LIFO だと client(close→flush 停止) が store(close) より先に走り、flush 中の
     * store close レース ("database connection is not open") を防ぐ。
     */
    const disposers: Array<() => void | Promise<void>> = [];

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
      // realtimeToken を設定し /realtime/ws を mount する。relay (approve/interrupt) は
      // backend が握る **内部 SidecarRegistry** を realtime ルート越しに駆動する (production 非変更)。
      app = await buildIngestionServer({
        pool,
        ingestToken: INGEST_TOKEN,
        realtimeToken: REALTIME_TOKEN,
        maxPayloadBytes: 256 * 1024,
      });
      await app.listen({ port: 0, host: "127.0.0.1" });
      const addr = app.server.address();
      if (addr === null || typeof addr === "string") throw new Error("no ephemeral port");
      port = addr.port;
    });

    afterEach(async () => {
      // LIFO: 後から積んだ client を先に閉じ、in-flight flush を止めてから store を閉じる。
      for (const d of disposers.splice(0).reverse()) {
        try {
          await d();
        } catch {
          /* teardown best-effort */
        }
      }
    });

    afterAll(async () => {
      if (createdSessions.length > 0) {
        await pool
          .query(`DELETE FROM sessions WHERE session_id = ANY($1::text[])`, [createdSessions])
          .catch(() => {});
      }
      if (app) await app.close();
      if (pool) await pool.end();
    });

    /**
     * cli `resolveWsUrl()` で ephemeral backend へ向けた URL を導出する。
     * **ACTRADECK_WS_URL に path 無し base を渡し、`/ingest/ws` 付与は resolveWsUrl 任せ**にする
     * (これが path 欠落回帰を赤にする load-bearing 点)。
     */
    function deriveWsUrl(): string {
      const prev = process.env.ACTRADECK_WS_URL;
      process.env.ACTRADECK_WS_URL = `ws://127.0.0.1:${port}`; // base のみ (path 無し)
      try {
        return resolveWsUrl();
      } finally {
        if (prev === undefined) delete process.env.ACTRADECK_WS_URL;
        else process.env.ACTRADECK_WS_URL = prev;
      }
    }

    /** 実 EventStore(temp better-sqlite3) を作り teardown 登録する。 */
    function makeStore(): EventStore {
      const dir = mkdtempSync(join(tmpdir(), "qa1-e2e-"));
      const store = new EventStore(join(dir, "sidecar.db"));
      disposers.push(() => {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      });
      return store;
    }

    /**
     * 実 WsClient を作り teardown 登録する (LIFO で store より先に close)。
     * close 後に in-flight な async flush(send→markSent) を 1 tick drain してから次へ進み、
     * store close レースを防ぐ。
     */
    function makeClient(opts: ConstructorParameters<typeof WsClient>[0]): WsClient {
      const client = new WsClient(opts);
      disposers.push(async () => {
        client.close();
        await new Promise((r) => setTimeout(r, 30)); // in-flight send/markSent を流し切る
      });
      return client;
    }

    // --- 1. Bearer 認証 (path 込み) -----------------------------------------
    it("(1a) connects to /ingest/ws with the correct INGEST_TOKEN (Bearer, path via resolveWsUrl)", async () => {
      const store = makeStore();
      const url = deriveWsUrl();
      // path 欠落回帰の核心: resolveWsUrl が /ingest/ws を付けていること。bare base なら
      // backend ルートに upgrade して 404→未 OPEN となり、下の OPEN assert が赤になる。
      expect(url).toBe(`ws://127.0.0.1:${port}/ingest/ws`);

      const client = makeClient({ url, store, ingestToken: INGEST_TOKEN });
      client.connect();
      const opened = await waitFor(() => client.connected);
      expect(opened).toBe(true);
    });

    it("(1b) wrong INGEST_TOKEN is rejected at upgrade (401, never OPEN)", async () => {
      const store = makeStore();
      const url = deriveWsUrl();
      const client = makeClient({ url, store, ingestToken: WRONG_TOKEN });
      client.connect();
      // 誤 token は upgrade 401 で OPEN しない。短時間待っても connected にならないこと。
      const opened = await waitFor(() => client.connected, { timeoutMs: 800 });
      expect(opened).toBe(false);
      expect(client.connected).toBe(false);
    });

    /**
     * 実 UI realtime WS を開き、1 フレーム送って対応する ack を待つ。
     * relay 経路 (UI→backend relayApproval/relayInterrupt→sidecar) を完全貫通で駆動する。
     */
    function uiSendAwaitAck(
      frame: Record<string, unknown>,
      action: string,
    ): Promise<{ ok: boolean; error?: string }> {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/realtime/ws`, {
          headers: { authorization: `Bearer ${REALTIME_TOKEN}` },
        });
        const timer = setTimeout(() => {
          ws.terminate();
          reject(new Error("ui ws ack timeout"));
        }, 4_000);
        ws.on("open", () => ws.send(JSON.stringify(frame)));
        ws.on("message", (data: Buffer) => {
          let msg: { type?: string; action?: string; ok?: boolean; error?: string };
          try {
            msg = JSON.parse(data.toString("utf8")) as typeof msg;
          } catch {
            return;
          }
          // 接続直後に list snapshot が来るので、対象 action の ack のみ拾う。
          if (msg.type === "ack" && msg.action === action) {
            clearTimeout(timer);
            resolve({ ok: msg.ok === true, ...(msg.error ? { error: msg.error } : {}) });
            ws.close();
          }
        });
        ws.on("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
      });
    }

    // --- 2. hello → relay (control_token 往復, 実 UI realtime WS 駆動) -------
    it("(2) after hello, UI approve/interrupt relay reaches WsClient.approval/interrupt emitters (canRelay=true)", async () => {
      const store = makeStore();
      const url = deriveWsUrl();
      const sid = uniqueSession("sess_relay");
      createdSessions.push(sid);
      const CONTROL = "ctl-token-relay-roundtrip-abcdef";

      const client = new WsClient({
        url,
        store,
        ingestToken: INGEST_TOKEN,
        controlToken: CONTROL,
        sessionIds: [sid], // hello.session_ids に載る → backend が control_token + 所有を学習
      });
      disposers.push(() => client.close());

      const approvals: ApprovalDecisionMsg[] = [];
      const interrupts: InterruptMsg[] = [];
      client.on("approval", (m) => approvals.push(m));
      client.on("interrupt", (m) => interrupts.push(m));

      client.connect();
      expect(await waitFor(() => client.connected)).toBe(true);

      // hello が backend に届き control_token + 所有 session を学習するまで待つ
      // (canRelay の内部状態は外から直接読めないため、relay ack=ok を成立条件として poll する)。
      const approveAck = await waitFor(
        async () =>
          (
            await uiSendAwaitAck(
              { type: "approve", session_id: sid, request_id: "req-1", decision: "allow" },
              "approve",
            )
          ).ok,
      );
      // relay が backend で成立 (canRelay=true ⇔ relayApproval ok=true) し、
      expect(approveAck).toBe(true);
      // sidecar WsClient の approval emitter まで control_token 往復で到達したこと。
      expect(await waitFor(() => approvals.length >= 1)).toBe(true);
      expect(approvals[0]?.decision).toBe("allow");
      expect(approvals[0]?.request_id).toBe("req-1");

      const interruptAck = await uiSendAwaitAck(
        { type: "interrupt", session_id: sid },
        "interrupt",
      );
      expect(interruptAck.ok).toBe(true);
      expect(await waitFor(() => interrupts.length >= 1)).toBe(true);
      expect(interrupts[0]?.session_id).toBe(sid);
    });

    // --- 3. 2→1 projection 集約 (QA-2 fold, learn-wait) ---------------------
    it("(3) hold (monitoring) → learn (hook) → flush projects BOTH into ONE canonical session_id (real PG)", async () => {
      const store = makeStore();
      const url = deriveWsUrl();

      // cli `resolveManagedSession()`: managed mode は常に explicitSession=false (learn-wait)。
      // fallback id は自動採番 (ACTRADECK_SESSION 未設定)。
      const prevSession = process.env.ACTRADECK_SESSION;
      delete process.env.ACTRADECK_SESSION;
      const { sessionId: fallbackId, explicitSession } = resolveManagedSession();
      if (prevSession === undefined) delete process.env.ACTRADECK_SESSION;
      else process.env.ACTRADECK_SESSION = prevSession;
      expect(explicitSession).toBe(false); // 即確定でないこと (回帰固定)。

      // canonical = claude UUID 相当 (hook 由来)。fallback とは別 id。
      const canonical = canonicalSession();
      createdSessions.push(canonical);
      createdSessions.push(fallbackId);

      const client = makeClient({
        url,
        store,
        ingestToken: INGEST_TOKEN,
        // hello は送信時点で identity.currentSessionId() を動的解決 (確定前は fallback)。
      });

      const identity = new SessionIdentity({ fallbackSessionId: fallbackId });
      disposers.push(() => identity.dispose());
      const sink = new EventSink({ store, wsClient: client });

      client.connect();
      expect(await waitFor(() => client.connected)).toBe(true);

      // (a) 確定前: 監視イベント (heartbeat/diff/output 相当) を emit → hold される。
      let monitoringEmitted = 0;
      identity.emitMonitoring("heartbeat", (cid) => {
        sink.emit(
          buildEvent({ session_id: cid, event_type: "heartbeat", payload: { kind: "heartbeat" } }),
        );
        monitoringEmitted += 1;
      });
      identity.emitMonitoring("diff", (cid) => {
        sink.emit(
          buildEvent({
            session_id: cid,
            event_type: "diff.updated",
            payload: { kind: "diff.updated", changed_files: 1, added: 2, removed: 0 },
          }),
        );
        monitoringEmitted += 1;
      });
      // hold 中は build を呼ばない契約 → まだ emit されていない。
      expect(monitoringEmitted).toBe(0);
      expect(identity.heldCount).toBe(2);
      expect(identity.isResolved()).toBe(false);

      // (b) hook イベントで learn(canonical) → held が canonical id で flush される。
      const learned = identity.learn(canonical);
      expect(learned).toBe(true);
      expect(identity.resolvedSessionId()).toBe(canonical);
      expect(monitoringEmitted).toBe(2); // flush 済 (canonical id で emit)。

      // hook 由来イベントも canonical session_id で emit。
      sink.emit(
        buildEvent({ session_id: canonical, event_type: "session.started", state: "starting" }),
      );

      // store(local SQLite) に積まれた 3 件は全て canonical session_id を持つこと。
      const localRows = store.allRows();
      expect(localRows).toHaveLength(3);
      for (const r of localRows) expect(r.session_id).toBe(canonical);

      // (c) WsClient が backend へ flush → PG に 3 件・単一 canonical session で projection。
      const allInPg = await waitFor(async () => {
        const { rows } = await pool.query<{ n: string }>(
          `SELECT count(*)::int AS n FROM events WHERE session_id = $1`,
          [canonical],
        );
        return Number(rows[0]?.n ?? 0) >= 3;
      });
      expect(allInPg).toBe(true);

      // **2→1 集約の核心**: fallback id では projection されていない (分裂していない)。
      const { rows: splitRows } = await pool.query<{ n: string }>(
        `SELECT count(*)::int AS n FROM events WHERE session_id = $1`,
        [fallbackId],
      );
      expect(Number(splitRows[0]?.n ?? 0)).toBe(0);

      // session_state も canonical 1 行のみ (監視+hook が単一 session に key される)。
      const { rows: stateRows } = await pool.query<{ session_id: string }>(
        `SELECT session_id FROM session_state WHERE session_id = ANY($1::text[])`,
        [[canonical, fallbackId]],
      );
      expect(stateRows.map((s) => s.session_id).sort()).toEqual([canonical]);
    });

    // --- 4. explicit-mode 回帰 (ACTRADECK_SESSION 明示でも learn-wait) -------
    it("(4) ACTRADECK_SESSION explicit STILL uses learn-wait (explicitSession=false) and 2→1 holds", async () => {
      const store = makeStore();
      const url = deriveWsUrl();

      // ACTRADECK_SESSION を **明示設定** しても resolveManagedSession は explicitSession=false。
      const labelSession = uniqueSession("sess_explicit_label");
      const prevSession = process.env.ACTRADECK_SESSION;
      process.env.ACTRADECK_SESSION = labelSession;
      let resolved: { sessionId: string; explicitSession: false };
      try {
        resolved = resolveManagedSession();
      } finally {
        if (prevSession === undefined) delete process.env.ACTRADECK_SESSION;
        else process.env.ACTRADECK_SESSION = prevSession;
      }
      // 回帰固定: 明示でも explicit 即確定にしない。fallback として ACTRADECK_SESSION を採る。
      expect(resolved.explicitSession).toBe(false);
      expect(resolved.sessionId).toBe(labelSession);

      const canonical = canonicalSession();
      createdSessions.push(canonical, labelSession);

      const client = makeClient({ url, store, ingestToken: INGEST_TOKEN });
      const identity = new SessionIdentity({ fallbackSessionId: resolved.sessionId });
      disposers.push(() => identity.dispose());
      const sink = new EventSink({ store, wsClient: client });

      client.connect();
      expect(await waitFor(() => client.connected)).toBe(true);

      // 確定前監視 (= ACTRADECK_SESSION ラベル時代の分裂源) を hold。
      identity.emitMonitoring("heartbeat", (cid) =>
        sink.emit(
          buildEvent({ session_id: cid, event_type: "heartbeat", payload: { kind: "heartbeat" } }),
        ),
      );
      expect(identity.heldCount).toBe(1);

      // hook learn → canonical へ flush。
      identity.learn(canonical);
      sink.emit(
        buildEvent({ session_id: canonical, event_type: "session.started", state: "starting" }),
      );

      // PG: canonical に 2 件、ACTRADECK_SESSION ラベルには 0 件 (= 明示でも分裂しない)。
      expect(
        await waitFor(async () => {
          const { rows } = await pool.query<{ n: string }>(
            `SELECT count(*)::int AS n FROM events WHERE session_id = $1`,
            [canonical],
          );
          return Number(rows[0]?.n ?? 0) >= 2;
        }),
      ).toBe(true);

      const { rows: labelRows } = await pool.query<{ n: string }>(
        `SELECT count(*)::int AS n FROM events WHERE session_id = $1`,
        [labelSession],
      );
      expect(Number(labelRows[0]?.n ?? 0)).toBe(0);
    });
  },
);
