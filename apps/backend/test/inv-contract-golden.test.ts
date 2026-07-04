/**
 * INV-CONTRACT-GOLDEN (backend・REAL PostgreSQL・ADR 019f2d2c D5)。
 *
 * docs/ingestion-contract.md の golden example が **実際に /ingest へ通る** ことを固定する:
 * doc から抽出した JSON をそのまま backend の POST /ingest (Bearer INGEST_TOKEN) へ送り、
 *  - ack が ok/inserted であること、
 *  - PG の events 行に provider = 未知 slug (my_tool) / source = external で着地すること、
 *  - ingress redaction 床が valid な golden を誤って壊さない (clean のまま挿入) こと、
 * を検証する。schema 変更 or ingress 配線変更で doc example が通らなくなれば RED になる。
 *
 * anti-drift: doc の実バイト列を single source として読む (event-model 側は schema pin)。
 * REAL DATA ONLY: 実 PG に永続化して検証。DB 未到達なら skip。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newEventId } from "@actradeck/event-model";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";

import { buildIngestionServer } from "../src/ingestion-server.js";
import { cleanupSessions, dbReachable } from "./helpers.js";

const DATABASE_URL = process.env.DATABASE_URL;
const reachable = DATABASE_URL ? await dbReachable(DATABASE_URL) : false;
const TOKEN = "test-ingest-token-golden-1234567890";

const HERE = dirname(fileURLToPath(import.meta.url));
const DOC_PATH = resolve(HERE, "../../../docs/ingestion-contract.md");
const GOLDEN_RE =
  /<!--\s*GOLDEN-EVENT:START\s*-->\s*```json\s*([\s\S]*?)\s*```\s*<!--\s*GOLDEN-EVENT:END\s*-->/;

/** docs/ingestion-contract.md から golden example を抽出する (event-model 側の抽出と同じ marker)。 */
function extractGolden(): Record<string, unknown> {
  const md = readFileSync(DOC_PATH, "utf8");
  const m = GOLDEN_RE.exec(md);
  if (!m || !m[1]) throw new Error("GOLDEN-EVENT marker/json not found in ingestion-contract.md");
  return JSON.parse(m[1]) as Record<string, unknown>;
}

interface Ack {
  type: string;
  ok: boolean;
  inserted?: boolean;
  duplicate?: boolean;
  error?: string;
  event_id?: string;
}

describe.skipIf(!reachable)("INV-CONTRACT-GOLDEN: doc golden が実 /ingest へ通る (real PG)", () => {
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

  /** run 毎にユニークな session_id を採る (cleanup 独立性)。 */
  function uniqSession(golden: Record<string, unknown>, tag = ""): string {
    const sid = `${String(golden.session_id)}${tag}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    sessions.push(sid);
    return sid;
  }

  it("golden (provider=slug / source=external) が ack ok/inserted で /ingest へ通る", async () => {
    const golden = extractGolden();
    // event_id は run 毎に fresh な UUIDv7 へ (テスト間の冪等衝突を避ける)。他フィールドは doc verbatim。
    const sessionId = uniqSession(golden);
    const res = await app.inject({
      method: "POST",
      url: "/ingest",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { ...golden, session_id: sessionId, event_id: newEventId() },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { results: Ack[] };
    const ack = body.results[0]!;
    expect(ack.ok, `ack not ok: ${ack.error ?? ""}`).toBe(true);
    expect(ack.inserted).toBe(true);

    // PG 行に provider = 未知 slug / source = external で着地する。
    const { rows } = await pool.query<{ provider: string; source: string; event_type: string }>(
      `SELECT provider, source, event_type FROM events WHERE event_id = $1`,
      [ack.event_id],
    );
    expect(rows.length, "golden event row not persisted").toBe(1);
    expect(rows[0]!.provider).toBe("my_tool");
    expect(rows[0]!.source).toBe("external");
    expect(rows[0]!.event_type).toBe("command.started");
  });

  it("再送は冪等 (同一 event_id → duplicate・二重挿入なし)", async () => {
    const golden = extractGolden();
    const sessionId = uniqSession(golden, "_dup");
    const payload = { ...golden, session_id: sessionId, event_id: newEventId() };
    const first = await app.inject({
      method: "POST",
      url: "/ingest",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/ingest",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload,
    });
    const a1 = (first.json() as { results: Ack[] }).results[0]!;
    const a2 = (second.json() as { results: Ack[] }).results[0]!;
    expect(a1.inserted).toBe(true);
    expect(a2.inserted).toBe(false);
    expect(a2.duplicate).toBe(true);
  });
});
