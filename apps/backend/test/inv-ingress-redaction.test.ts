/**
 * INV-INGRESS-REDACTION (P0・ADR 019f2d2c D3・REAL PostgreSQL)。
 *
 * redaction choke は sidecar sink + backend ingress の二層。INGEST_TOKEN 保持アダプタが
 * sidecar を経由せず /ingest へ直 POST した場合でも、backend の ingress redaction 床
 * (ingestOne → redactEventWithAuthoritativeCounts → parseEvent → store.ingest) が
 * store.ingest の**前**に無条件 redaction を適用し、raw secret が PG に着地しないことを固定する。
 *
 * 4 アーム:
 *  (a) raw secret 直 POST → PG 到達行 (events.summary / payload) に marker 有り・raw 無し。
 *  (b) count spoof → 実 secret 無しで redaction_count:999 申告 → session_state の権威 count は 0。
 *  (c) 冪等 → 既 redacted (marker 入り) を POST → marker 文字列不変・二重マスク無し・count=マーカー数。
 *  (d) sidecar 経路対称性 → 通常の clean イベントは挙動不変で ingest される (回帰)。
 *
 * falsifiability: ingestOne の redaction 配線を revert (mutant) すると (a) が RED になる
 *   (raw が PG へ着地)。手動 mutant 検証は PR-1 の報告に添付する。
 *
 * REAL DATA ONLY: 実 PG に永続化して検証する。DB 未到達なら skip。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newEventId } from "@actradeck/event-model";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";

import { buildIngestionServer } from "../src/ingestion-server.js";
import { cleanupSessions, dbReachable } from "./helpers.js";

const DATABASE_URL = process.env.DATABASE_URL;
const reachable = DATABASE_URL ? await dbReachable(DATABASE_URL) : false;
const TOKEN = "test-ingest-token-1234567890";

// 擬似 secret (実鍵ではない)。github-token ルール (\bghp_[A-Za-z0-9_]{20,255}\b) にマッチする形。
const GH_SECRET = "ghp_1234567890abcdefABCDEF1234567890abcd";

interface Ack {
  type: string;
  ok: boolean;
  inserted?: boolean;
  duplicate?: boolean;
  error?: string;
  event_id?: string;
  state?: string;
}

describe.skipIf(!reachable)(
  "INV-INGRESS-REDACTION: backend 直 POST の redaction 床 (real PG)",
  () => {
    let pool: Pool;
    let app: FastifyInstance;
    const sessions: string[] = [];

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
      app = await buildIngestionServer({ pool, ingestToken: TOKEN, maxPayloadBytes: 64 * 1024 });
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

    /** 直 POST /ingest (Bearer INGEST_TOKEN)。makeEvent を通さず raw payload をそのまま送る。
     *  POST /ingest は単体/バッチとも `{ results: IngestAck[] }` を返す。 */
    async function postIngest(event: Record<string, unknown>): Promise<Ack> {
      const res = await app.inject({
        method: "POST",
        url: "/ingest",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: event,
      });
      const body = res.json() as { results: Ack[] };
      expect(body.results, "POST /ingest did not return results[]").toHaveLength(1);
      return body.results[0]!;
    }

    function rawEvent(
      sessionId: string,
      over: Partial<Record<string, unknown>> = {},
    ): Record<string, unknown> {
      // provider/source は PR-1 時点の closed enum の有効値を使う ("external" 追加は PR-2)。
      //   ingress redaction 床は provider 非依存 (全イベント無条件) ゆえ検証の一般性は失われない。
      //   直 POST 経路は HTTP /ingest を直接叩くことで (sidecar sink を経由せず) 表現する。
      return {
        event_id: newEventId(),
        provider: "claude_code",
        source: "hooks",
        session_id: sessionId,
        event_type: "command.output.delta",
        timestamp: new Date().toISOString(),
        summary: "clean summary",
        payload: { kind: "command.output.delta", stream: "stdout", delta: "clean" },
        metrics: {},
        ...over,
      };
    }

    async function eventRow(eventId: string): Promise<{ summary: string | null; payload: string }> {
      const { rows } = await pool.query<{ summary: string | null; payload: string }>(
        `SELECT summary, payload::text AS payload FROM events WHERE event_id = $1`,
        [eventId],
      );
      expect(rows.length, "event row not persisted").toBe(1);
      return rows[0]!;
    }

    async function sessionSecret(sessionId: string): Promise<{ detected: boolean; count: number }> {
      const { rows } = await pool.query<{
        secret_detected: boolean;
        secret_redaction_count: number;
      }>(
        `SELECT secret_detected, secret_redaction_count FROM session_state WHERE session_id = $1`,
        [sessionId],
      );
      expect(rows.length, "session_state row missing").toBe(1);
      return { detected: rows[0]!.secret_detected, count: rows[0]!.secret_redaction_count };
    }

    it("(a) raw secret 直 POST → PG 行に marker 有り・raw 無し (summary + payload)", async () => {
      const sid = newSession("sess_ingress_a");
      const ev = rawEvent(sid, {
        summary: `leaked ${GH_SECRET} in summary`,
        payload: {
          kind: "command.output.delta",
          stream: "stdout",
          delta: `export GH=${GH_SECRET}`,
        },
      });
      const ack = await postIngest(ev);
      expect(ack.ok, ack.error).toBe(true);
      expect(ack.inserted).toBe(true);

      const row = await eventRow(ev.event_id as string);
      // 権威: raw secret は PG のどのフィールドにも残らない。
      expect(row.summary, "raw secret persisted in summary").not.toContain(GH_SECRET);
      expect(row.payload, "raw secret persisted in payload").not.toContain(GH_SECRET);
      // redaction marker が着地している。
      expect(row.summary).toContain("[REDACTED:");
      expect(row.payload).toContain("[REDACTED:");

      // session_state の権威 count は実マーカー数 (>=1) で secret_detected。
      const s = await sessionSecret(sid);
      expect(s.detected).toBe(true);
      expect(s.count).toBeGreaterThanOrEqual(1);
    });

    it("(b) count spoof → 実 secret 無しで redaction_count:999 申告 → 権威 count は 0", async () => {
      const sid = newSession("sess_ingress_b");
      const ev = rawEvent(sid, {
        summary: "no secrets here at all",
        payload: { kind: "command.output.delta", stream: "stdout", delta: "just plain output" },
        redaction_count: 999,
        redaction_count_by_kind: { "github-token": 999 },
      });
      const ack = await postIngest(ev);
      expect(ack.ok, ack.error).toBe(true);

      // backend が client 申告の 999 を実マーカー数 (0) で権威上書きする。
      const s = await sessionSecret(sid);
      expect(s.count, "client-declared redaction_count 999 was not overwritten").toBe(0);
      expect(s.detected).toBe(false);
    });

    it("(c) 冪等 → 既 redacted (marker 入り) を POST → marker 不変・二重マスク無し・count=マーカー数", async () => {
      const sid = newSession("sess_ingress_c");
      const marker = "[REDACTED:github-token]";
      const ev = rawEvent(sid, {
        summary: `already redacted ${marker} here`,
        payload: { kind: "command.output.delta", stream: "stdout", delta: marker },
      });
      const ack = await postIngest(ev);
      expect(ack.ok, ack.error).toBe(true);

      const row = await eventRow(ev.event_id as string);
      // marker 文字列は不変 (二重マスク [REDACTED:[REDACTED:...]] にならない)。
      expect(row.summary).toContain(marker);
      expect(row.summary).not.toContain("[REDACTED:[REDACTED:");
      expect(row.payload).not.toContain("[REDACTED:[REDACTED:");

      // 権威 count は marker 数 (summary 1 + payload 1 = 2)。二重計上で膨らまない。
      const s = await sessionSecret(sid);
      expect(s.count).toBe(2);
      expect(s.detected).toBe(true);
    });

    it("(d) sidecar 経路対称性 → 通常の clean イベントは挙動不変で ingest される (回帰)", async () => {
      const sid = newSession("sess_ingress_d");
      const ev = rawEvent(sid, {
        event_type: "session.started",
        state: "starting",
        summary: "session started",
        payload: { kind: "session.started" },
      });
      const ack = await postIngest(ev);
      expect(ack.ok, ack.error).toBe(true);
      expect(ack.inserted).toBe(true);

      const row = await eventRow(ev.event_id as string);
      expect(row.summary).toBe("session started");
      // clean イベントは marker を持たず、secret_detected も立たない。
      const s = await sessionSecret(sid);
      expect(s.detected).toBe(false);
      expect(s.count).toBe(0);
    });
  },
);
