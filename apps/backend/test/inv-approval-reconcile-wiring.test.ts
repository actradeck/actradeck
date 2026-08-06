/**
 * INV-APPROVAL-RECONCILE-WIRING (TDA-3 R2・ADR 0014 Phase 4・REAL PostgreSQL + REAL WS)。
 *
 * inv-approval-reconcile.test.ts の A/B/C 層が個別に正しくても、**本番の配線点**
 * (ingestion-server: `sidecarRegistry.onApprovalReconcile(...)` → ApprovalReconciler →
 * `ingestOne` + `pushAfterIngest`) が繋がっている保証にはならない。本テストは
 * buildIngestionServer を丸ごと起動し、実 WS で requested → hello (pending ゼロ宣言) を送り、
 * 合成 cancel が実 PG の pending_approvals を fold で消すことを end-to-end で固定する。
 * falsifiability: ingestion-server の onApprovalReconcile 登録行を削除するとここが RED になる
 * (INV-WORKITEMS-WIRING と同型の配線ゲート)。
 *
 * REAL DATA ONLY: 実 PG + 実 WS。DB 未到達なら skip (CI では実走必須・tripwire 対象)。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { newEventId } from "@actradeck/event-model";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";

import { buildIngestionServer } from "../src/ingestion-server.js";
import { cleanupSessions, dbReachable } from "./helpers.js";

const DATABASE_URL = process.env.DATABASE_URL;
const reachable = DATABASE_URL ? await dbReachable(DATABASE_URL) : false;
const TOKEN = "test-ingest-token-1234567890";

describe.skipIf(!reachable)(
  "INV-APPROVAL-RECONCILE-WIRING: hello 宣言 → 合成 cancel の本番配線 (real PG + real WS)",
  () => {
    let pool: Pool;
    let app: FastifyInstance;
    let wsBase: string;
    const sessions: string[] = [];

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
      app = await buildIngestionServer({ pool, ingestToken: TOKEN, maxPayloadBytes: 64 * 1024 });
      await app.listen({ port: 0, host: "127.0.0.1" });
      const addr = app.server.address();
      if (addr === null || typeof addr === "string") throw new Error("no port");
      wsBase = `ws://127.0.0.1:${addr.port}`;
    });

    afterAll(async () => {
      await cleanupSessions(pool, sessions);
      if (app) await app.close();
      if (pool) await pool.end();
    });

    // QA-R2-7: vitest 既定 testTimeout (5s) より小さい予算にし、失敗時は生 timeout でなく
    // waitFor の診断メッセージへ到達させる。
    async function waitFor(cond: () => Promise<boolean>, ms = 4_000): Promise<void> {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (await cond()) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("waitFor timeout");
    }

    it("requested → 再接続 hello (pending ゼロ宣言) → 合成 cancel が fold され pending が消える", async () => {
      const sid = `sess_wiring_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      sessions.push(sid);
      const requestId = "s0123456789ab:apr-WiringStaleToken01"; // mint 形 (redaction-stable)

      const ws = new WebSocket(`${wsBase}/ingest/ws`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      try {
        await new Promise<void>((resolve, reject) => {
          ws.on("open", () => resolve());
          ws.on("error", reject);
        });

        // 1) 真に stale な requested (watermark を跨ぐ過去 timestamp) を通常 ingest 経路で永続。
        const ackWait = new Promise<Record<string, unknown>>((resolve) => {
          ws.once("message", (d: Buffer) =>
            resolve(JSON.parse(d.toString("utf8")) as Record<string, unknown>),
          );
        });
        ws.send(
          JSON.stringify({
            event_id: newEventId(),
            provider: "claude_code",
            source: "hooks",
            session_id: sid,
            event_type: "tool.permission.requested",
            state: "waiting.approval",
            timestamp: new Date(Date.now() - 60_000).toISOString(),
            payload: {
              kind: "tool.permission.requested",
              request_id: requestId,
              tool_name: "Bash",
              command: "rm -rf /tmp/x",
              risk_level: "high",
            },
          }),
        );
        const ack = await ackWait;
        expect(ack.ok).toBe(true);

        const pendingCount = async (): Promise<number> => {
          const { rows } = await pool.query<{ n: number }>(
            `SELECT jsonb_array_length(pending_approvals)::int AS n
               FROM session_state WHERE session_id = $1`,
            [sid],
          );
          return rows[0]?.n ?? 0;
        };
        expect(await pendingCount()).toBe(1);

        // 2) sidecar 再起動を模す: 同一接続から pending ゼロ宣言の hello。
        //    (registry は ingest 観測で当該 session を既に本接続へ claim 済み)
        ws.send(
          JSON.stringify({
            type: "hello",
            control_token: "t",
            session_ids: [sid],
            active_pending_request_ids: [],
          }),
        );

        // 3) 本番配線 (onApprovalReconcile → reconciler → ingestOne) が合成 cancel を fold し、
        //    pending が DB から消えるまで待つ (fire-and-forget ゆえ poll)。
        await waitFor(async () => (await pendingCount()) === 0);

        // 4) 監査トレイル: 合成 resolved が通常 ingest 経路で永続され正直メタデータを持つ。
        const { rows } = await pool.query(
          `SELECT payload FROM events
            WHERE session_id = $1 AND event_type = 'tool.permission.resolved'`,
          [sid],
        );
        expect(rows).toHaveLength(1);
        const payload = rows[0].payload as Record<string, unknown>;
        expect(payload.request_id).toBe(requestId);
        expect(payload.decision).toBe("cancel");
        expect(payload.resolution_origin).toBe("relay_lost");
        expect(payload.delivery_status).toBe("not_sent");
      } finally {
        ws.close();
      }
    });
  },
);
