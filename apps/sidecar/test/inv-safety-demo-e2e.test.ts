/**
 * INV-SAFETY-DEMO-E2E — 初回セーフティデモ (ADR 019f22a7 P1) の seed ドライバを
 * **実 backend + 実 PostgreSQL** で貫通検証する (REAL DATA ONLY・モック無し)。
 *
 * 契約 (証明したい強み — plan.md 最重要 KPI「観測された実際の作業状態」):
 *   `run-safety-demo.mts` の `runSafetyDemo()` が、使い捨てデモセッションを **実パイプライン
 *   (sidecar HookReceiver → Sink redact → 実 WsClient → 実 backend /ingest/ws → IngestStore の
 *   INSERT INTO events → session_state projection)** で駆動したとき:
 *     (i)   ダミー高リスク操作 (`rm -rf …/build`) が実 approval gate で承認要求 (tool.permission.requested,
 *           risk_level=high) として **hold** される (自動実行されない = INV-APPROVAL)。
 *     (ii)  auto-deny モードで **resolved(deny)** が event store (PG) に着地する (安全側)。
 *     (iii) ダミー secret (AKIA…/ghp_…) が **保存前に redact** され、session_state の
 *           secret_redaction_count_by_kind に aws-access-key-id≥1 / github-token≥1 が乗り、
 *           **生 secret が sidecar SQLite にも PG events にも一切残らない** (INV-REDACTION)。
 *
 * 既存テストとの非重複:
 *   - inv-redaction-e2e.test.ts     : VerificationWsSink 止まり (実 backend 非到達)・redaction のみ。
 *   - inv-approval-roundtrip-e2e.ts : 実 backend + UI relay の承認往復 (driver 非経由)。
 *   本テストは **seed ドライバそのもの** が実 backend/PG まで貫通し、承認 hold/deny と redaction を
 *   1 本のデモ経路で同時に固定する (P1 デモ基盤の回帰ゲート)。
 *
 * REAL DATA ONLY: 実 buildIngestionServer + 実 PG + 実 Sidecar(全構成要素) + 実 WsClient。
 * DATABASE_URL 未到達時のみ describe.skipIf で skip するが、CI(verify job) では実走を保証する。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { FastifyInstance } from "fastify";
import { Pool } from "pg";
import { buildIngestionServer } from "@actradeck/backend";

import { classifyCommandWithCategories } from "../src/normalize.js";
import {
  runSafetyDemo,
  DEMO_AWS_ACCESS_KEY_ID,
  DEMO_GITHUB_TOKEN,
  type SafetyDemoResult,
} from "../e2e/run-safety-demo.mjs";

const DATABASE_URL = process.env.DATABASE_URL;

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

// 偽緑防止: CI では DB 必須。到達不能で無音 skip すると承認 hold/deny + redaction (load-bearing) を
// 検証しないまま緑になる (既存 inv-approval-roundtrip と同規約)。
if (process.env.CI === "true" && !reachable) {
  throw new Error(
    "CI requires a reachable DATABASE_URL for INV-SAFETY-DEMO e2e " +
      "(safety-demo approval/redaction assertions must not be silently skipped).",
  );
}

const INGEST_TOKEN = "safety-demo-ingest-token-1234567890";
const REALTIME_TOKEN = "safety-demo-realtime-token-09876543210";

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
  "INV-SAFETY-DEMO-E2E: seed driver drives real sidecar→ingestion→event store (approval + redaction)",
  () => {
    let pool: Pool;
    let app: FastifyInstance;
    let port: number;
    let result: SafetyDemoResult;
    let tmpBase: string;
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

      tmpBase = mkdtempSync(join(tmpdir(), "safety-demo-e2e-"));
      // auto-deny モードで 1 本駆動する (ヘッドレス・決定論的に安全側 deny へ倒す)。
      result = await runSafetyDemo({
        wsUrl: `ws://127.0.0.1:${port}/ingest/ws`,
        ingestToken: INGEST_TOKEN,
        approvalMode: "auto-deny",
        approvalTimeoutMs: 800,
        demoCwd: join(tmpBase, "actradeck-demo"),
        dbPath: join(tmpBase, "sidecar.db"),
        onLog: () => {}, // テスト中はログ抑制。
      });
      createdSessions.push(result.sessionId);

      // event store への到達を待つ (session.ended + resolved が PG に着地するまで)。
      await waitFor(async () => {
        const { rows } = await pool.query<{ n: string }>(
          `SELECT count(*)::int AS n FROM events
             WHERE session_id = $1 AND event_type = 'session.ended'`,
          [result.sessionId],
        );
        return Number(rows[0]?.n ?? 0) >= 1;
      });
    }, 60_000);

    afterAll(async () => {
      if (createdSessions.length > 0) {
        await pool
          .query(`DELETE FROM sessions WHERE session_id = ANY($1::text[])`, [createdSessions])
          .catch(() => {});
      }
      if (app) await app.close();
      if (pool) await pool.end();
      if (tmpBase) rmSync(tmpBase, { recursive: true, force: true });
    });

    it("デモセッション id は削除可能な demo-safety- prefix を持つ (識別・後始末可能)", () => {
      expect(result.sessionId).toMatch(/^demo-safety-[0-9a-f]+$/);
    });

    // --- 承認分類 (canonical source): rm -rf → high / recursive-rm --------------
    // tool.permission.requested wire payload は risk_level を載せるが category は載せない (既定
    // ゲートモード)。category recursive-rm は分類器の正準ソースで固定する (承認ゲートの唯一の根拠)。
    it("(classifier) 高リスクコマンドは risk=high かつ category=recursive-rm に分類される", () => {
      const { risk, categories } = classifyCommandWithCategories(`rm -rf ${result.demoCwd}/build`);
      expect(risk).toBe("high");
      expect(categories.has("recursive-rm")).toBe(true);
    });

    // --- (i) 承認要求が hold される (自動実行されない) ---------------------------
    it("(i) 高リスク操作は tool.permission.requested(risk=high) として event store に hold される", async () => {
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*)::int AS n FROM events
           WHERE session_id = $1 AND event_type = 'tool.permission.requested'
             AND payload->>'risk_level' = 'high'`,
        [result.sessionId],
      );
      expect(Number(rows[0]?.n ?? 0)).toBeGreaterThanOrEqual(1);
    });

    // --- (ii) auto-deny → resolved(deny) が event store に着地 -------------------
    it("(ii) auto-deny モードで permissionDecision=deny + resolved(deny) が PG に着地する", async () => {
      // hook 応答 (blocking POST) が deny で解けたこと。
      expect(result.approvalDecision).toBe("deny");
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*)::int AS n FROM events
           WHERE session_id = $1 AND event_type = 'tool.permission.resolved'
             AND payload->>'decision' = 'deny'`,
        [result.sessionId],
      );
      expect(Number(rows[0]?.n ?? 0)).toBeGreaterThanOrEqual(1);
    });

    // --- (iii-a) redaction_count_by_kind が乗る (session_state projection) -------
    it("(iii) session_state.secret_redaction_count_by_kind に aws-access-key-id≥1 / github-token≥1 が乗る", async () => {
      const ok = await waitFor(async () => {
        const { rows } = await pool.query<{
          by_kind: Record<string, number> | null;
          detected: boolean | null;
        }>(
          `SELECT secret_redaction_count_by_kind AS by_kind, secret_detected AS detected
             FROM session_state WHERE session_id = $1`,
          [result.sessionId],
        );
        const byKind = rows[0]?.by_kind ?? {};
        return (
          rows[0]?.detected === true &&
          (byKind["aws-access-key-id"] ?? 0) >= 1 &&
          (byKind["github-token"] ?? 0) >= 1
        );
      });
      expect(ok, "secret_redaction_count_by_kind に両 kind が乗ること").toBe(true);
    });

    // --- (iii-b) sidecar SQLite にも PG events にも生 secret が残らない -----------
    it("(iii) 生 secret が sidecar SQLite (storedRows) に一切残らない (redaction-before-persist)", () => {
      expect(result.storedRows.length).toBeGreaterThan(0);
      for (const row of result.storedRows) {
        expect(
          row.event_json.includes(DEMO_AWS_ACCESS_KEY_ID),
          `AWS key leak to SQLite in ${row.event_type}`,
        ).toBe(false);
        expect(
          row.event_json.includes(DEMO_GITHUB_TOKEN),
          `GitHub token leak to SQLite in ${row.event_type}`,
        ).toBe(false);
      }
      // 少なくとも 1 行に kind 別マーカーが記録されていること (redaction が実際に走った証跡)。
      const joined = result.storedRows.map((r) => r.event_json).join("\n");
      expect(joined.includes("[REDACTED:aws-access-key-id]")).toBe(true);
      expect(joined.includes("[REDACTED:github-token]")).toBe(true);
    });

    it("(iii) 生 secret が PG events (payload/summary) に一切残らない (redaction-before-emit)", async () => {
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*)::int AS n FROM events
           WHERE session_id = $1
             AND (payload::text LIKE '%' || $2 || '%'
               OR payload::text LIKE '%' || $3 || '%'
               OR coalesce(summary,'') LIKE '%' || $2 || '%'
               OR coalesce(summary,'') LIKE '%' || $3 || '%')`,
        [result.sessionId, DEMO_AWS_ACCESS_KEY_ID, DEMO_GITHUB_TOKEN],
      );
      expect(Number(rows[0]?.n ?? 0), "raw secret leaked into PG events").toBe(0);
    });
  },
);

// ── QA-2: 本番既定 (hold) の無応答 timeout→deny 安全側縮退を決定論で pin ──────────────
//   safety-demo.ts (backend launcher) は本番で ACTRADECK_DEMO_APPROVAL="hold" 固定で子を起こす。
//   hold は UI relay の Deny を待つが、unattended (UI 無応答) では既存の安全側 timeout → deny に
//   縮退しなければならない (INV-APPROVAL の肝・自動 allow は厳禁)。上の suite は auto-deny のみを
//   カバーするため、ここでは **hold モード + 短縮 approvalTimeoutMs 注入** で UI relay 無しでも
//   「hold → timeout → resolved(deny) が実 PG に着地」を決定論的に固定する (30s 実待ちは不要)。
describe.skipIf(!reachable)(
  "INV-SAFETY-DEMO-E2E hold-mode: 無応答 hold → timeout → deny (安全側縮退・INV-APPROVAL)",
  () => {
    let pool: Pool;
    let app: FastifyInstance;
    let port: number;
    let result: SafetyDemoResult;
    let tmpBase: string;
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

      tmpBase = mkdtempSync(join(tmpdir(), "safety-demo-hold-e2e-"));
      // 本番既定の hold モードで駆動する。UI relay は接続しない (unattended) ため、注入した短縮
      // approvalTimeoutMs 経過で bridge が安全側 deny へ倒すはず (force-allow が無いことを固定)。
      result = await runSafetyDemo({
        wsUrl: `ws://127.0.0.1:${port}/ingest/ws`,
        ingestToken: INGEST_TOKEN,
        approvalMode: "hold",
        approvalTimeoutMs: 800, // 30s 実待ち不要・決定論的に timeout→deny を観測する。
        demoCwd: join(tmpBase, "actradeck-demo"),
        dbPath: join(tmpBase, "sidecar.db"),
        onLog: () => {},
      });
      createdSessions.push(result.sessionId);

      await waitFor(async () => {
        const { rows } = await pool.query<{ n: string }>(
          `SELECT count(*)::int AS n FROM events
             WHERE session_id = $1 AND event_type = 'session.ended'`,
          [result.sessionId],
        );
        return Number(rows[0]?.n ?? 0) >= 1;
      });
    }, 60_000);

    afterAll(async () => {
      if (createdSessions.length > 0) {
        await pool
          .query(`DELETE FROM sessions WHERE session_id = ANY($1::text[])`, [createdSessions])
          .catch(() => {});
      }
      if (app) await app.close();
      if (pool) await pool.end();
      if (tmpBase) rmSync(tmpBase, { recursive: true, force: true });
    });

    it("hold + UI 無応答 → hook 応答は deny で解ける (自動 allow しない = 安全側縮退)", () => {
      expect(result.approvalMode).toBe("hold");
      // hold でも UI relay が無ければ timeout で安全側 deny に倒れる (allow ではない)。
      expect(result.approvalDecision).toBe("deny");
    });

    it("resolved(deny) が実 event store (PG) に着地し・allow は 1 件も無い (INV-APPROVAL)", async () => {
      const denyRes = await pool.query<{ n: string }>(
        `SELECT count(*)::int AS n FROM events
           WHERE session_id = $1 AND event_type = 'tool.permission.resolved'
             AND payload->>'decision' = 'deny'`,
        [result.sessionId],
      );
      expect(Number(denyRes.rows[0]?.n ?? 0)).toBeGreaterThanOrEqual(1);

      // force-allow が無いこと: hold の unattended 縮退は deny のみ (allow の resolved は皆無)。
      const allowRes = await pool.query<{ n: string }>(
        `SELECT count(*)::int AS n FROM events
           WHERE session_id = $1 AND event_type = 'tool.permission.resolved'
             AND payload->>'decision' = 'allow'`,
        [result.sessionId],
      );
      expect(Number(allowRes.rows[0]?.n ?? 0), "hold timeout must never auto-allow").toBe(0);
    });

    it("高リスク操作は risk=high の承認要求として記録される (hold 経路でもゲートが出る)", async () => {
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*)::int AS n FROM events
           WHERE session_id = $1 AND event_type = 'tool.permission.requested'
             AND payload->>'risk_level' = 'high'`,
        [result.sessionId],
      );
      expect(Number(rows[0]?.n ?? 0)).toBeGreaterThanOrEqual(1);
    });
  },
);
