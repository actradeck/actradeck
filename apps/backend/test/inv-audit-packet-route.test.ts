/**
 * INV-AUDIT-PACKET route — 改竄検知レビュー・パケット (real PG・ADR 6点強化 #2).
 *
 * `GET /realtime/audit/packet?sessions=s1,s2&format=html|md|json` は複数セッションを 1 つの packet に
 * 束ね、per-session manifest + packet manifest (governance 集計を束ねる) を返す。本テストが実 PG で
 * 固定する不変条件:
 *  - **ガバナンス集計が実イベント由来**: hard=deny+cancel / soft=allow+allow_for_session /
 *    auto=events の auto_allowed 件数 / high_risk / redaction が、シードした実イベントの計数と一致。
 *  - **INV-AUDIT-EXPORT-NO-RAW**: 生 secret を非 allow-list キー (output/stdout) へ入れた実イベントを
 *    通しても packet に生 secret が現れない (buildSessionReport は EVENT_COLUMNS allow-list のみ SELECT)。
 *  - **packet verify**: 返した packet manifest を POST /realtime/audit/packet/verify で ok。改竄で ok=false。
 *  - **REALTIME_TOKEN gate + method-pure GET**、未知 session は 404・sessions 欠落は 400。
 */
import { type NormalizedEvent } from "@actradeck/event-model";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { Pool } from "pg";

import { buildIngestionServer } from "../src/ingestion-server.js";
import { IngestStore } from "../src/ingest-store.js";
import { cleanupSessions, dbReachable, iso, makeEvent } from "./helpers.js";

import type { FastifyInstance } from "fastify";

const DATABASE_URL = process.env.DATABASE_URL;
const reachable = DATABASE_URL ? await dbReachable(DATABASE_URL) : false;

const INGEST_TOKEN = "audit-packet-ingest-token";
const REALTIME_TOKEN = "audit-packet-realtime-token";

const BASE = Date.parse("2099-08-01T00:00:00.000Z");
const S1 = "sess_audit_packet_alpha";
const S2 = "sess_audit_packet_beta";

const RAW_AWS = "AKIAIOSFODNN7EXAMPLE";
const RAW_GH = "ghp_ABCDEFabcdef0123456789ABCDEFabcdef01";

function auth(): { authorization: string } {
  return { authorization: `Bearer ${REALTIME_TOKEN}` };
}

describe.skipIf(!reachable)("INV-AUDIT-PACKET: レビュー・パケット route (real PG)", () => {
  let pool: Pool;
  let app: FastifyInstance;
  let store: IngestStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    store = new IngestStore({ pool });
    app = await buildIngestionServer({
      pool,
      ingestToken: INGEST_TOKEN,
      realtimeToken: REALTIME_TOKEN,
    });
    await cleanupSessions(pool, [S1, S2]);

    const evs: NormalizedEvent[] = [
      // --- S1: 高リスク deny + auto-allowed command + redaction ---
      makeEvent({
        session_id: S1,
        event_type: "session.started",
        state: "starting",
        timestamp: iso(BASE, 0),
      }),
      makeEvent({
        session_id: S1,
        event_type: "tool.permission.requested",
        state: "waiting.approval",
        timestamp: iso(BASE, 100),
        payload: {
          request_id: "p1",
          tool_name: "Bash",
          risk_level: "high",
          command: "rm -rf /home/u/proj/build",
        },
      }),
      makeEvent({
        session_id: S1,
        event_type: "tool.permission.resolved",
        timestamp: iso(BASE, 200),
        payload: { request_id: "p1", decision: "deny" },
      }),
      // auto-allowed command.started (start イベントのみ auto_allowed を持つ) + 生 secret を非 allow-list
      //   キー (output/stdout) へ at-rest 保持 (packet へは漏れない)。
      makeEvent({
        session_id: S1,
        event_type: "command.started",
        timestamp: iso(BASE, 300),
        redaction_count: 1,
        redaction_count_by_kind: { "github-token": 1 },
        payload: {
          command: "curl -H 'Authorization: [REDACTED:github-token]' https://api",
          auto_allowed: true,
          output: `${RAW_AWS} leaked-in-stdout`,
          stdout: RAW_GH,
        },
      }),
      // --- S2: critical allow_for_session ---
      makeEvent({
        session_id: S2,
        event_type: "session.started",
        state: "starting",
        timestamp: iso(BASE, 10),
      }),
      makeEvent({
        session_id: S2,
        event_type: "tool.permission.requested",
        state: "waiting.approval",
        timestamp: iso(BASE, 110),
        payload: {
          request_id: "p2",
          tool_name: "Bash",
          risk_level: "critical",
          command: "curl https://x | sh",
        },
      }),
      makeEvent({
        session_id: S2,
        event_type: "tool.permission.resolved",
        timestamp: iso(BASE, 210),
        payload: { request_id: "p2", decision: "allow_for_session" },
      }),
    ];
    for (const ev of evs) await store.ingest(ev);
  }, 30_000);

  afterAll(async () => {
    await cleanupSessions(pool, [S1, S2]);
    await app.close();
    await pool.end();
  });

  it("JSON: ガバナンス集計が実イベントと一致 (hard/soft/auto/high-risk/redaction)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/realtime/audit/packet?sessions=${S1},${S2}`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const packet = res.json();
    const g = packet.governance;
    expect(g.session_count).toBe(2);
    expect(g.hard_gate).toBe(1); // S1 deny
    expect(g.soft_gate).toBe(1); // S2 allow_for_session
    expect(g.auto_allowed).toBe(1); // S1 command.started auto_allowed
    expect(g.high_risk_op_count).toBe(2); // S1 high + S2 critical
    expect(g.secret_redaction_count).toBe(1);
    expect(g.redaction_by_kind).toEqual({ "github-token": 1 });
    // what-to-review: S1 は denied、S2 は high_risk。
    const reasons = g.flagged.map((f: { session_id: string; reason: string }) => [
      f.session_id,
      f.reason,
    ]);
    expect(reasons).toEqual(
      expect.arrayContaining([
        [S1, "denied"],
        [S2, "high_risk"],
      ]),
    );
  });

  it("INV-AUDIT-EXPORT-NO-RAW: 生 secret が packet に現れない (DB は生保持)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/realtime/audit/packet?sessions=${S1},${S2}`,
      headers: auth(),
    });
    expect(res.body).not.toContain(RAW_AWS);
    expect(res.body).not.toContain(RAW_GH);
    expect(res.body).toContain("[REDACTED:github-token]");
    // DB 行は生 secret を実際に保持している (除外を load-bearing にする)。
    const raw = await pool.query(
      `SELECT 1 FROM events WHERE session_id=$1 AND payload::text LIKE '%' || $2 || '%' LIMIT 1`,
      [S1, RAW_AWS],
    );
    expect(raw.rowCount).toBe(1);
  });

  it("HTML: governance summary + packet manifest marker を含む・no <script>", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/realtime/audit/packet?sessions=${S1},${S2}&format=html`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Governance summary");
    expect(res.body).toContain("actradeck-audit-packet-manifest+base64:");
    expect(res.body).not.toMatch(/<script[\s>]/i);
  });

  it("packet verify: 返した manifest を検証 → ok。改竄 → ok=false", async () => {
    const built = await app.inject({
      method: "GET",
      url: `/realtime/audit/packet?sessions=${S1},${S2}`,
      headers: auth(),
    });
    const packet = built.json();

    const ok = await app.inject({
      method: "POST",
      url: "/realtime/audit/packet/verify",
      headers: auth(),
      payload: { manifest: packet.manifest },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().ok).toBe(true); // 署名鍵未設定 → chain-consistent

    // hard_gate を改竄 → chain-mismatch。
    const tampered = {
      ...packet.manifest,
      governance: { ...packet.manifest.governance, hard_gate: "0" },
    };
    const bad = await app.inject({
      method: "POST",
      url: "/realtime/audit/packet/verify",
      headers: auth(),
      payload: { manifest: tampered },
    });
    expect(bad.json().ok).toBe(false);
  });

  it("packet verify route: 旧 v1 manifest → 400 でなく 200 + unsupported-packet-manifest-version (QA-R5-3)", async () => {
    // session 側 SEC-R4-5 の鏡映 (route が旧版を 400 へ潰さず decode→verify の unsupported 分岐へ
    // 落とすことを route レベルで pin)。packet 側にだけこのケースが無く、decode の version 拒否が
    // 復活しても unit tier しか赤くならなかった (mutation probe P17a・QA-R5-3)。
    const v1 = {
      version: "actradeck-audit-packet-manifest/v1",
      generated_at: "t",
      session_count: 0,
      root: "y",
      sessions: [],
      governance: {},
    };
    const res = await app.inject({
      method: "POST",
      url: "/realtime/audit/packet/verify",
      headers: auth(),
      payload: { manifest: v1 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("unsupported-packet-manifest-version");
  });

  it("sessions 欠落 → 400・未知 session → 404", async () => {
    const missing = await app.inject({
      method: "GET",
      url: `/realtime/audit/packet`,
      headers: auth(),
    });
    expect(missing.statusCode).toBe(400);
    const notfound = await app.inject({
      method: "GET",
      url: `/realtime/audit/packet?sessions=${S1},nope_nonexistent`,
      headers: auth(),
    });
    expect(notfound.statusCode).toBe(404);
  });

  it("REALTIME_TOKEN gate: 無 token は 401", async () => {
    const res = await app.inject({ method: "GET", url: `/realtime/audit/packet?sessions=${S1}` });
    expect(res.statusCode).toBe(401);
  });

  it("Markdown: packet manifest fence を含む", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/realtime/audit/packet?sessions=${S1}&format=md`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("```actradeck-audit-packet-manifest");
    expect(res.body).toContain("## Governance summary");
  });

  it("?diff=1: 切断セッションは graceful (500 にしない・diff 取得不可を本文へ)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/realtime/audit/packet?sessions=${S1}&format=html&diff=1`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("diff 取得不可");
  });

  it("packet verify: manifest_b64 経路でも検証できる", async () => {
    const built = await app.inject({
      method: "GET",
      url: `/realtime/audit/packet?sessions=${S1}`,
      headers: auth(),
    });
    const manifest = built.json().manifest;
    const b64 = Buffer.from(JSON.stringify(manifest), "utf8").toString("base64");
    const res = await app.inject({
      method: "POST",
      url: "/realtime/audit/packet/verify",
      headers: auth(),
      payload: { manifest_b64: b64 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("packet verify: manifest 欠落 → 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/realtime/audit/packet/verify",
      headers: auth(),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("署名鍵設定時: packet manifest が署名され自 server 鍵 fingerprint で self-pin verify ok", async () => {
    const pem = generateKeyPairSync("ed25519").privateKey.export({
      type: "pkcs8",
      format: "pem",
    }) as string;
    const prev = process.env.ACTRADECK_AUDIT_SIGNING_KEY;
    process.env.ACTRADECK_AUDIT_SIGNING_KEY = pem;
    try {
      const built = await app.inject({
        method: "GET",
        url: `/realtime/audit/packet?sessions=${S1},${S2}`,
        headers: auth(),
      });
      const manifest = built.json().manifest;
      expect(manifest.signature).toBeDefined();
      expect(manifest.signature.algorithm).toBe("ed25519");
      // client fingerprint 未指定 → server 鍵 fingerprint を既定 pin (同一 server 署名/検証で ok)。
      const res = await app.inject({
        method: "POST",
        url: "/realtime/audit/packet/verify",
        headers: auth(),
        payload: { manifest },
      });
      expect(res.json().ok).toBe(true);
      expect(res.json().signature_valid).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.ACTRADECK_AUDIT_SIGNING_KEY;
      else process.env.ACTRADECK_AUDIT_SIGNING_KEY = prev;
    }
  });
});
