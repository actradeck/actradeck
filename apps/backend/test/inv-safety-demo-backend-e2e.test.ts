/**
 * INV-SAFETY-DEMO-BACKEND-E2E — backend 内 **native-free 単一 driver** (safety-demo-driver.ts) を
 * **実 backend + 実 PostgreSQL** で貫通検証する (REAL DATA ONLY・モック無し・decision 019f387f)。
 *
 * 証明したい契約 (Docker cockpit self-run の実体):
 *   driver が backend ingestion WS (/ingest/ws) へ実 `ws` で接続し NormalizedEvent を直接 emit したとき:
 *     (i)   高リスク操作 (`rm -rf …/build`) が tool.permission.requested(risk=high) として hold され、
 *           session_state.pending_approvals に承認カードが **出現**する (INV-APPROVAL: 自動実行しない)。
 *     (ii)  **timeout→deny** (auto-deny) と **UI relay Deny** (realtime WS approve frame) の両経路で
 *           resolved(deny) が PG events に着地し、pending_approvals から当該カードが **消滅**する。
 *     (iii) command.completed の dummy secret (AKIA…/ghp_…) が **保存前 redact** され、
 *           session_state.secret_redaction_count_by_kind に aws-access-key-id≥1 / github-token≥1 が乗り、
 *           **生 secret が PG events に一切残らない** (backend ingress redaction floor = REAL)。
 *     (iv)  events 各行が正典列 (provider/source/session_id/event_type/state/timestamp/payload) を永続する。
 *
 * REAL DATA ONLY: 実 buildIngestionServer + 実 PG + 実 driver + 実 ws (relay も実 realtime WS approve)。
 * DATABASE_URL 未到達時のみ describe.skipIf で skip するが、CI(verify job) では実走を保証する。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { WebSocket } from "ws";

import { deriveDemoApprovalRequestId } from "@actradeck/event-model";

import { buildIngestionServer } from "../src/index.js";
import { runSafetyDemoDriver, type DemoDriverResult } from "../src/safety-demo-driver.js";
import { DEMO_AWS_ACCESS_KEY_ID, DEMO_GITHUB_TOKEN } from "../src/safety-demo-script.js";
import { cleanupSessions, dbReachable } from "./helpers.js";

const DATABASE_URL = process.env.DATABASE_URL;
const reachable = DATABASE_URL ? await dbReachable(DATABASE_URL) : false;

// 偽緑防止: CI では DB 必須。到達不能で無音 skip すると承認 hold/deny + redaction (load-bearing) を
// 検証しないまま緑になる (既存 inv-safety-demo-e2e / inv-realtime-server と同規約)。
if (process.env.CI === "true" && !reachable) {
  throw new Error(
    "CI requires a reachable DATABASE_URL for INV-SAFETY-DEMO-BACKEND-E2E " +
      "(safety-demo driver approval/redaction assertions must not be silently skipped).",
  );
}

const INGEST_TOKEN = "safety-demo-backend-ingest-token-1234567890";
const REALTIME_TOKEN = "safety-demo-backend-realtime-token-0987654321";

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  { timeoutMs = 8_000, stepMs = 25 }: { timeoutMs?: number; stepMs?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

describe.skipIf(!reachable)(
  "INV-SAFETY-DEMO-BACKEND-E2E: native-free driver → real ingestion → event store",
  () => {
    let pool: Pool;
    let app: FastifyInstance;
    let port: number;
    // auto-deny 経路の結果。
    let autoResult: DemoDriverResult;
    // hold + UI relay Deny 経路の結果 + hold 中の pending スナップショット。
    let relayResult: DemoDriverResult;
    let pendingDuringHold: unknown;
    // hold + UI relay Allow 経路の結果 (QA-1: relay 経路と allow 分岐に一意の teeth)。
    let allowResult: DemoDriverResult;
    const createdSessions: string[] = [];

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
      if (addr === null || typeof addr === "string") throw new Error("no ephemeral port");
      port = addr.port;
      const wsUrl = `ws://127.0.0.1:${port}/ingest/ws`;

      // ── 経路A: auto-deny (UI 無応答 → 短 timeout → 安全側 deny) ────────────────────
      autoResult = await runSafetyDemoDriver({
        wsUrl,
        ingestToken: INGEST_TOKEN,
        approvalMode: "auto-deny",
        approvalTimeoutMs: 400,
        sessionId: `demo-safety-auto-${Date.now().toString(16)}`,
        pacingMs: 0,
        onLog: () => {},
      });
      createdSessions.push(autoResult.sessionId);
      await waitFor(async () => {
        const { rows } = await pool.query<{ n: string }>(
          `SELECT count(*)::int AS n FROM events WHERE session_id = $1 AND event_type = 'session.ended'`,
          [autoResult.sessionId],
        );
        return Number(rows[0]?.n ?? 0) >= 1;
      });

      // ── 経路B: hold + UI relay Deny (realtime WS approve frame) ───────────────────
      const holdSessionId = `demo-safety-relay-${Date.now().toString(16)}`;
      createdSessions.push(holdSessionId);
      const holdRequestId = deriveDemoApprovalRequestId(holdSessionId); // driver の決定論的 request_id (正準採番)。
      // driver を hold で起動 (await しない・relay を待つ)。timeout は十分長く取り relay で解決させる。
      const driverPromise = runSafetyDemoDriver({
        wsUrl,
        ingestToken: INGEST_TOKEN,
        approvalMode: "hold",
        approvalTimeoutMs: 20_000,
        sessionId: holdSessionId,
        pacingMs: 10,
        onLog: () => {},
      });

      // 承認要求が PG に着地するまで待つ (= カード出現の前提)。
      await waitFor(
        async () => {
          const { rows } = await pool.query<{ n: string }>(
            `SELECT count(*)::int AS n FROM events
               WHERE session_id = $1 AND event_type = 'tool.permission.requested'`,
            [holdSessionId],
          );
          return Number(rows[0]?.n ?? 0) >= 1;
        },
        { timeoutMs: 15_000 },
      );
      // hold 中の pending_approvals スナップショット (カード出現の証跡)。
      {
        const { rows } = await pool.query<{ pending: unknown }>(
          `SELECT pending_approvals AS pending FROM session_state WHERE session_id = $1`,
          [holdSessionId],
        );
        pendingDuringHold = rows[0]?.pending;
      }

      // 実 realtime WS を開き、UI と同じ approve(deny) フレームを relay する (backend が driver へ中継)。
      await relayDecision(port, holdSessionId, holdRequestId, "deny");

      relayResult = await driverPromise;
      await waitFor(async () => {
        const { rows } = await pool.query<{ n: string }>(
          `SELECT count(*)::int AS n FROM events WHERE session_id = $1 AND event_type = 'session.ended'`,
          [holdSessionId],
        );
        return Number(rows[0]?.n ?? 0) >= 1;
      });

      // ── 経路C: hold + UI relay ALLOW (QA-1 teeth) ─────────────────────────────────
      //   allow は timeout からは決して生成されない (timeout→deny) ため、relay 受信 + allow 分岐
      //   (state override running.tool_preparing) に一意の teeth が付く。relay 無視化 mutation で RED。
      const allowSessionId = `demo-safety-allow-${Date.now().toString(16)}`;
      createdSessions.push(allowSessionId);
      const allowRequestId = deriveDemoApprovalRequestId(allowSessionId);
      const allowPromise = runSafetyDemoDriver({
        wsUrl,
        ingestToken: INGEST_TOKEN,
        approvalMode: "hold",
        approvalTimeoutMs: 20_000,
        sessionId: allowSessionId,
        pacingMs: 10,
        onLog: () => {},
      });
      await waitFor(
        async () => {
          const { rows } = await pool.query<{ n: string }>(
            `SELECT count(*)::int AS n FROM events
               WHERE session_id = $1 AND event_type = 'tool.permission.requested'`,
            [allowSessionId],
          );
          return Number(rows[0]?.n ?? 0) >= 1;
        },
        { timeoutMs: 15_000 },
      );
      await relayDecision(port, allowSessionId, allowRequestId, "allow");
      allowResult = await allowPromise;
      await waitFor(async () => {
        const { rows } = await pool.query<{ n: string }>(
          `SELECT count(*)::int AS n FROM events WHERE session_id = $1 AND event_type = 'session.ended'`,
          [allowSessionId],
        );
        return Number(rows[0]?.n ?? 0) >= 1;
      });
    }, 90_000);

    afterAll(async () => {
      if (createdSessions.length > 0) await cleanupSessions(pool, createdSessions);
      if (app) await app.close();
      if (pool) await pool.end();
    });

    /** 実 realtime WS (/realtime/ws) を開き UI と同じ approve フレーム (任意 decision) を relay して閉じる。 */
    async function relayDecision(
      p: number,
      sessionId: string,
      requestId: string,
      decision: "allow" | "allow_for_session" | "deny" | "cancel",
    ): Promise<void> {
      const ws = new WebSocket(`ws://127.0.0.1:${p}/realtime/ws`, {
        headers: { Authorization: `Bearer ${REALTIME_TOKEN}` },
      });
      await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", (e: Error) => reject(e));
      });
      ws.send(
        JSON.stringify({ type: "approve", session_id: sessionId, request_id: requestId, decision }),
      );
      // relay が driver へ届き resolved が emit されるまで少し待ってから閉じる。
      await new Promise((r) => setTimeout(r, 400));
      ws.close();
    }

    // ── (i) 承認カード出現 (hold 中の pending_approvals) ────────────────────────────
    it("(i) hold 中に session_state.pending_approvals へ承認カードが出現する (risk=high・INV-APPROVAL)", () => {
      expect(Array.isArray(pendingDuringHold)).toBe(true);
      const arr = pendingDuringHold as Array<Record<string, unknown>>;
      expect(arr.length).toBeGreaterThanOrEqual(1);
      const card = arr.find(
        (c) => c.request_id === deriveDemoApprovalRequestId(relayResult.sessionId),
      );
      expect(card, "pending card が当該 request_id で存在する").toBeTruthy();
      expect(card?.risk_level).toBe("high");
    });

    it("(i) requested イベントが risk=high として PG events に hold される (両経路)", async () => {
      for (const sid of [autoResult.sessionId, relayResult.sessionId]) {
        const { rows } = await pool.query<{ n: string }>(
          `SELECT count(*)::int AS n FROM events
             WHERE session_id = $1 AND event_type = 'tool.permission.requested'
               AND payload->>'risk_level' = 'high'`,
          [sid],
        );
        expect(Number(rows[0]?.n ?? 0), `requested(high) for ${sid}`).toBeGreaterThanOrEqual(1);
      }
    });

    // ── (ii) timeout→deny と relay Deny の両方で resolved(deny) 永続 + カード消滅 ──────
    it("(ii) auto-deny (timeout) と relay Deny の両経路で resolved(deny) が PG に着地する", async () => {
      expect(autoResult.approvalDecision).toBe("deny");
      expect(relayResult.approvalDecision).toBe("deny");
      for (const sid of [autoResult.sessionId, relayResult.sessionId]) {
        const deny = await pool.query<{ n: string }>(
          `SELECT count(*)::int AS n FROM events
             WHERE session_id = $1 AND event_type = 'tool.permission.resolved'
               AND payload->>'decision' = 'deny'`,
          [sid],
        );
        expect(Number(deny.rows[0]?.n ?? 0), `resolved(deny) for ${sid}`).toBeGreaterThanOrEqual(1);
        // 自動 allow が 1 件も無い (INV-APPROVAL の肝)。
        const allow = await pool.query<{ n: string }>(
          `SELECT count(*)::int AS n FROM events
             WHERE session_id = $1 AND event_type = 'tool.permission.resolved'
               AND payload->>'decision' = 'allow'`,
          [sid],
        );
        expect(Number(allow.rows[0]?.n ?? 0), `no auto-allow for ${sid}`).toBe(0);
      }
    });

    // QA-2 (正直な題目): この e2e は resolved(deny) 着地後に session.ended まで走らせるため、pending が空に
    //   なるのは **terminal 掃除 (projection の session.ended → pending_approvals:[])** でも充足しうる。ここでは
    //   その終端不変条件 (「session 終了で pending が空になる」) を実 PG で固定するに留める。resolved(同
    //   request_id) → pending 除去の linkage 自体は projection の純テストが決定的に担保する:
    //   packages/projection/src/index.test.ts「resolved (同 request_id) で pending が消える」+
    //   apps/backend/test/inv-approval-projection.test.ts。決定的 pre-ended snapshot は driver の pacing レース
    //   ゆえ避け、flaky を作らない (timing 緩和で塗り潰さない)。
    it("(ii) session 終了で pending_approvals が空になる (terminal・実 PG)", async () => {
      for (const sid of [autoResult.sessionId, relayResult.sessionId]) {
        const ok = await waitFor(async () => {
          const { rows } = await pool.query<{ pending: unknown }>(
            `SELECT pending_approvals AS pending FROM session_state WHERE session_id = $1`,
            [sid],
          );
          const arr = Array.isArray(rows[0]?.pending) ? (rows[0]?.pending as unknown[]) : [];
          return arr.length === 0;
        });
        expect(ok, `pending_approvals empty for ${sid}`).toBe(true);
      }
    });

    // ── QA-1: relay-allow に一意の teeth (relay 受信 + allow 分岐 + state override) ──────────
    //   allow は timeout からは決して生成されない (timeout→deny) ため、この assert は relay 経路と
    //   driver の allow 分岐 (state running.tool_preparing) が実行されないと成立しない。relay 受信を
    //   全無視化する mutation で RED になる (mutation probe で実証済)。
    it("(QA-1) relay Allow → driver approvalDecision=allow・resolved(allow)・state running.tool_preparing", async () => {
      expect(allowResult.approvalDecision).toBe("allow");
      const { rows } = await pool.query<{ n: string; state: string | null }>(
        `SELECT count(*)::int AS n, max(state) AS state FROM events
           WHERE session_id = $1 AND event_type = 'tool.permission.resolved'
             AND payload->>'decision' = 'allow'`,
        [allowResult.sessionId],
      );
      expect(Number(rows[0]?.n ?? 0), "resolved(allow) persisted").toBeGreaterThanOrEqual(1);
      // allow 分岐の state override (hook-receiver.ts:367 parity)。deny 経路 (running.model_wait) と区別。
      expect(rows[0]?.state).toBe("running.tool_preparing");
    });

    // ── (iii) redaction: kind 別件数が乗り・生 secret は PG に残らない ─────────────────
    it("(iii) session_state.secret_redaction_count_by_kind に aws-access-key-id≥1 / github-token≥1 が乗る (両経路)", async () => {
      for (const sid of [autoResult.sessionId, relayResult.sessionId]) {
        const ok = await waitFor(async () => {
          const { rows } = await pool.query<{
            by_kind: Record<string, number> | null;
            detected: boolean | null;
          }>(
            `SELECT secret_redaction_count_by_kind AS by_kind, secret_detected AS detected
               FROM session_state WHERE session_id = $1`,
            [sid],
          );
          const byKind = rows[0]?.by_kind ?? {};
          return (
            rows[0]?.detected === true &&
            (byKind["aws-access-key-id"] ?? 0) >= 1 &&
            (byKind["github-token"] ?? 0) >= 1
          );
        });
        expect(ok, `by_kind both kinds for ${sid}`).toBe(true);
      }
    });

    it("(iii) 生 secret が PG events (payload/summary) に一切残らない (redaction-before-persist)", async () => {
      for (const sid of [autoResult.sessionId, relayResult.sessionId]) {
        const { rows } = await pool.query<{ n: string }>(
          `SELECT count(*)::int AS n FROM events
             WHERE session_id = $1
               AND (payload::text LIKE '%' || $2 || '%'
                 OR payload::text LIKE '%' || $3 || '%'
                 OR coalesce(summary,'') LIKE '%' || $2 || '%'
                 OR coalesce(summary,'') LIKE '%' || $3 || '%')`,
          [sid, DEMO_AWS_ACCESS_KEY_ID, DEMO_GITHUB_TOKEN],
        );
        expect(Number(rows[0]?.n ?? 0), `raw secret leaked into PG events for ${sid}`).toBe(0);
      }
      // redaction が実際に走った証跡: command.completed の payload に kind マーカーが乗る。
      const { rows } = await pool.query<{ txt: string }>(
        `SELECT payload::text AS txt FROM events
           WHERE session_id = $1 AND event_type = 'command.completed' LIMIT 1`,
        [autoResult.sessionId],
      );
      expect(rows[0]?.txt ?? "").toContain("[REDACTED:aws-access-key-id]");
      expect(rows[0]?.txt ?? "").toContain("[REDACTED:github-token]");
    });

    // ── (iv) 正典列の永続 ─────────────────────────────────────────────────────────
    it("(iv) events 各行が正典列 (provider/source/session_id/event_type/state/timestamp/payload) を永続する", async () => {
      const { rows } = await pool.query<{
        provider: string | null;
        source: string | null;
        session_id: string | null;
        event_type: string | null;
        state: string | null;
        timestamp: string | null;
        payload: unknown;
      }>(
        // 正典 replay 順で読む: `timestamp ASC, event_id ASC` (migration 1780704000000 +
        //   covering index events_session_id_timestamp_event_id_index が固定する T1 契約)。
        //   driver は pacingMs=0 で resolved→command.completed→ended を **同一ミリ秒**に emit しうる
        //   (timestamp は ms 解像度)。ゆえに `ORDER BY timestamp` 単独は等値キーの tie を持ち、SQL は
        //   等値行間の順序を規定しない → CI 並走/大テーブル regime で tie が非因果順に配送され間欠 fail
        //   した (「expected 4 to be less than 2」= ended が resolved の前に来る逆転)。event_id は
        //   UUIDv7 (uuid@11 は同一プロセス内で厳密単調) ゆえ因果 emit 順を忠実に encode し、tiebreak として
        //   全順序を与える。イベントは正しい因果順で永続済 (runtime バグではなく test の sort key 不足)。
        `SELECT provider, source, session_id, event_type, state, timestamp, payload
           FROM events WHERE session_id = $1 ORDER BY timestamp ASC, event_id ASC`,
        [autoResult.sessionId],
      );
      expect(rows.length).toBeGreaterThanOrEqual(5); // started/requested/resolved/command.completed/ended
      for (const r of rows) {
        expect(r.provider).toBe("claude_code");
        expect(r.source).toBe("hooks");
        expect(r.session_id).toBe(autoResult.sessionId);
        expect(typeof r.event_type).toBe("string");
        expect(typeof r.state).toBe("string"); // driver は全ステップで state を載せる。
        expect(r.timestamp).not.toBeNull();
        expect(r.payload).not.toBeNull();
      }
      // イベント列の意味順序 (session.started → requested → resolved → command.completed → session.ended)。
      const types = rows.map((r) => r.event_type);
      expect(types).toContain("session.started");
      expect(types.indexOf("tool.permission.requested")).toBeLessThan(
        types.indexOf("tool.permission.resolved"),
      );
      expect(types.indexOf("tool.permission.resolved")).toBeLessThan(
        types.indexOf("session.ended"),
      );
    });
  },
);
