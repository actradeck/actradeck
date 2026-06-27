/**
 * INV-REPLAY-HISTORY — real PG replay history API.
 *
 * The route returns an ordered, paginated, allow-listed event timeline for Session Replay. It must
 * not expose raw payload keys while preserving enough fields for client-side projection replay.
 */
import { newEventId, type NormalizedEvent } from "@actradeck/event-model";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { buildIngestionServer } from "../src/ingestion-server.js";
import { IngestStore } from "../src/ingest-store.js";
import { MAX_REPLAY_LIMIT } from "../src/replay-store.js";
import { cleanupSessions, dbReachable, iso, makeEvent } from "./helpers.js";

import type { FastifyInstance } from "fastify";
import type { ReplayEventsPage } from "../src/replay-contract.js";

const DATABASE_URL = process.env.DATABASE_URL;
const reachable = DATABASE_URL ? await dbReachable(DATABASE_URL) : false;

const INGEST_TOKEN = "replay-history-ingest-token";
const REALTIME_TOKEN = "replay-history-realtime-token";

async function ingestAll(store: IngestStore, events: readonly NormalizedEvent[]): Promise<void> {
  for (const ev of events) await store.ingest(ev);
}

function auth(): { authorization: string } {
  return { authorization: `Bearer ${REALTIME_TOKEN}` };
}

describe.skipIf(!reachable)("Replay history API (real PG)", () => {
  let pool: Pool;
  let app: FastifyInstance;
  let store: IngestStore;
  const sessions: string[] = [];

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    store = new IngestStore({ pool });
    app = await buildIngestionServer({
      pool,
      ingestToken: INGEST_TOKEN,
      realtimeToken: REALTIME_TOKEN,
    });
  });

  afterAll(async () => {
    await cleanupSessions(pool, sessions);
    await app.close();
    await pool.end();
  });

  it("requires REALTIME_TOKEN Bearer auth", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/realtime/sessions/sess_missing/events",
    });
    expect(res.statusCode).toBe(401);
  });

  it("orders by timestamp,event_id and paginates with a cursor", async () => {
    const sessionId = `sess_replay_order_${Date.now()}`;
    sessions.push(sessionId);
    const base = Date.parse("2026-06-06T00:00:00.000Z");
    const sameTimestamp = iso(base, 1000);
    const sameA = newEventId();
    const sameB = newEventId();
    const expectedSame = [sameA, sameB].sort();
    await ingestAll(store, [
      makeEvent({
        session_id: sessionId,
        event_type: "session.started",
        state: "starting",
        timestamp: iso(base, 0),
        summary: "start",
      }),
      makeEvent({
        event_id: sameA,
        session_id: sessionId,
        event_type: "command.started",
        state: "running.command_executing",
        timestamp: sameTimestamp,
        summary: "command A",
        payload: { command: "printf A" },
      }),
      makeEvent({
        event_id: sameB,
        session_id: sessionId,
        event_type: "command.completed",
        state: "running.model_wait",
        timestamp: sameTimestamp,
        summary: "command B",
        payload: { exit_code: 0 },
      }),
      makeEvent({
        session_id: sessionId,
        event_type: "turn.completed",
        state: "completed",
        timestamp: iso(base, 2000),
        summary: "done",
      }),
    ]);

    const first = await app.inject({
      method: "GET",
      url: `/realtime/sessions/${encodeURIComponent(sessionId)}/events?limit=2`,
      headers: auth(),
    });
    expect(first.statusCode).toBe(200);
    const p1 = first.json<ReplayEventsPage>();
    expect(p1.order).toBe("timestamp_event_id_asc");
    expect(p1.events).toHaveLength(2);
    expect(p1.has_more).toBe(true);
    expect(p1.next_cursor).toEqual(expect.any(String));
    expect(p1.events.map((e) => e.timestamp)).toEqual([iso(base, 0), sameTimestamp]);

    const second = await app.inject({
      method: "GET",
      url: `/realtime/sessions/${encodeURIComponent(sessionId)}/events?limit=10&cursor=${encodeURIComponent(
        p1.next_cursor ?? "",
      )}`,
      headers: auth(),
    });
    expect(second.statusCode).toBe(200);
    const p2 = second.json<ReplayEventsPage>();
    expect(p2.has_more).toBe(false);
    expect(p2.events).toHaveLength(2);
    expect(p2.events[0]?.event_id).toBe(expectedSame[1]);
    expect(p2.events[1]?.event_type).toBe("turn.completed");
  });

  it("keeps duplicate event_id idempotent and returns a single replay row", async () => {
    const sessionId = `sess_replay_idem_${Date.now()}`;
    sessions.push(sessionId);
    const ev = makeEvent({
      session_id: sessionId,
      event_type: "heartbeat",
      timestamp: "2026-06-06T00:00:00.000Z",
      summary: "alive",
      payload: { process_alive: true },
    });
    await store.ingest(ev);
    await store.ingest(ev);

    const res = await app.inject({
      method: "GET",
      url: `/realtime/sessions/${encodeURIComponent(sessionId)}/events`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const page = res.json<ReplayEventsPage>();
    expect(page.events.map((e) => e.event_id)).toEqual([ev.event_id]);
  });

  it("returns only allow-listed DTO fields and does not expose raw payload secrets", async () => {
    const sessionId = `sess_replay_redaction_${Date.now()}`;
    sessions.push(sessionId);
    const dummySecret = "ghp_" + "A".repeat(40);
    await store.ingest(
      makeEvent({
        session_id: sessionId,
        event_type: "command.started",
        state: "running.command_executing",
        timestamp: "2026-06-06T00:00:00.000Z",
        summary: "redacted command",
        payload: {
          command: "echo [REDACTED:github-token]",
          risk_level: "high",
          rogue_secret: dummySecret,
          diff: dummySecret,
          delta: dummySecret,
        },
      }),
    );

    const res = await app.inject({
      method: "GET",
      url: `/realtime/sessions/${encodeURIComponent(sessionId)}/events`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.body;
    expect(body).not.toContain(dummySecret);
    expect(body).not.toContain("rogue_secret");
    expect(body).not.toContain("diff");
    expect(body).not.toContain("delta");
    expect(body).toContain("[REDACTED:github-token]");
    const page = res.json<ReplayEventsPage>();
    expect(page.events[0]?.command).toBe("echo [REDACTED:github-token]");
    // P2 (ADR 019eeac6): subject も at-rest redacted な command 列から引かれ、marker のみが出る。
    expect(page.events[0]?.subject).toBe("echo [REDACTED:github-token]");
    expect(Object.keys(page.events[0] ?? {})).not.toContain("payload");
  });

  it("INV-REPLAY-SUBJECT-NO-LEAK: subject is derived from at-rest redacted columns, never raw secrets", async () => {
    // P2 (ADR 019eeac6): replay DTO.subject は projection と同一写像 (deriveActionSubject) で
    //   redacted payload allowlist 列から引く。redaction の choke は **sidecar** (backend ingest は
    //   再 redaction しない・既存 redaction テストと同方針) なので、ここでは sidecar 通過後の
    //   **at-rest 相当** (= marker 済) payload を流し、subject が (a) 構造列から引かれ summary
    //   (日本語) からは引かれない、(b) raw secret パターンを一切含まず marker のみを通す、ことを
    //   real PG で検証する (INV-CURRENT-ACTION-NO-LEAK と同型・load-bearing)。
    //   万一 backend 経路に raw 列が残る退行が起きた場合に備え、生 secret を **summary** に置いて
    //   「subject が summary を出所にしていない」も同時に pin する (summary は subject に出ない契約)。
    const sessionId = `sess_replay_subject_noleak_${Date.now()}`;
    sessions.push(sessionId);
    const ghpRaw = "ghp_" + "B".repeat(40);
    const skantRaw = "sk-ant-" + "C".repeat(40);
    const base = Date.parse("2026-06-07T00:00:00.000Z");
    await ingestAll(store, [
      makeEvent({
        session_id: sessionId,
        event_type: "command.started",
        state: "running.command_executing",
        timestamp: iso(base, 0),
        // summary に raw secret を置く: subject が summary 由来でないことの反証材料。
        summary: `コマンド実行 ${ghpRaw}`,
        // at-rest 相当 (sidecar redact 済) の command 列。subject = この marker 文字列。
        payload: { command: "export TOKEN=[REDACTED:github-token] && deploy" },
      }),
      makeEvent({
        session_id: sessionId,
        event_type: "web.search.started",
        state: "running.web_searching",
        timestamp: iso(base, 1000),
        summary: `検索 ${skantRaw}`,
        payload: { query: "how to use [REDACTED:anthropic-key]" },
      }),
    ]);

    const res = await app.inject({
      method: "GET",
      url: `/realtime/sessions/${encodeURIComponent(sessionId)}/events`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);

    const page = res.json<ReplayEventsPage>();
    const cmd = page.events.find((e) => e.event_type === "command.started");
    const web = page.events.find((e) => e.event_type === "web.search.started");
    // subject は存在し (kind+subject 表示の前提)、redacted 構造列から引かれている。
    expect(cmd?.subject).toBe("export TOKEN=[REDACTED:github-token] && deploy");
    expect(web?.subject).toBe("how to use [REDACTED:anthropic-key]");
    // subject に raw secret パターンが一切出ない (summary 由来の raw を引いていない load-bearing pin)。
    expect(cmd?.subject).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
    expect(cmd?.subject).not.toContain("コマンド実行");
    expect(web?.subject).not.toMatch(/sk-ant-[A-Za-z0-9-]{20,}/);
    expect(web?.subject).not.toContain("検索");
  });

  it("rejects malformed cursors and clamps excessive limits", async () => {
    const bad = await app.inject({
      method: "GET",
      url: "/realtime/sessions/sess_x/events?cursor=not-base64-json",
      headers: auth(),
    });
    expect(bad.statusCode).toBe(400);

    const ok = await app.inject({
      method: "GET",
      url: "/realtime/sessions/sess_x/events?limit=999999",
      headers: auth(),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<ReplayEventsPage>().limit).toBe(MAX_REPLAY_LIMIT);
  });
});
