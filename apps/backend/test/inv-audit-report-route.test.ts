/**
 * INV-AUDIT-EXPORT-NO-RAW — 単一セッション詳細レポート route (real PG・P2 ADR 019f2326).
 *
 * `GET /realtime/audit/sessions/:sessionId/report?format=html|md|json` は AuditStore.sessionSummary +
 * ReplayStore.eventsPage を合成し、command/exit_code/decision/risk/redaction by-kind/時刻を時系列で返す。
 * 本テストが実 PG で固定する不変条件:
 *  - **INV-AUDIT-EXPORT-NO-RAW (html/md/json)**: 合成 secret (AKIA…/ghp_…) を **at-rest な生 payload
 *    非 allow-list キー**へ入れた実イベントを通しても、export に生 secret が現れず `[REDACTED:kind]`
 *    マーカーのみが出る (report route は EVENT_COLUMNS allow-list しか SELECT しない = 構造継承)。
 *    DB 行が生 secret を実際に保持していることを別クエリで確認し、除外を load-bearing にする。
 *  - **timeline 描画**: command / exit_code / decision / risk / redaction by-kind / 時刻が出る。
 *  - **REALTIME_TOKEN gate + method-pure GET**、未知 session は 404。
 *  - **?diff=1 graceful**: sidecar 未登録 (切断) では 500 でなく本文へ「diff 取得不可 (session 切断)」。
 */
import { type NormalizedEvent } from "@actradeck/event-model";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { buildIngestionServer } from "../src/ingestion-server.js";
import { IngestStore } from "../src/ingest-store.js";
import { cleanupSessions, dbReachable, iso, makeEvent } from "./helpers.js";

import type { FastifyInstance } from "fastify";

const DATABASE_URL = process.env.DATABASE_URL;
const reachable = DATABASE_URL ? await dbReachable(DATABASE_URL) : false;

const INGEST_TOKEN = "audit-report-ingest-token";
const REALTIME_TOKEN = "audit-report-realtime-token";

// 本テスト専用の遠未来窓 + セッション id (共有 DB 隔離)。
const BASE = Date.parse("2099-07-01T00:00:00.000Z");
const SID = "sess_audit_report_alpha";

// 生 secret sentinel (redaction 済み DTO / export には決して現れてはならない)。
const RAW_AWS = "AKIAIOSFODNN7EXAMPLE";
const RAW_GH = "ghp_ABCDEFabcdef0123456789ABCDEFabcdef01";

function auth(): { authorization: string } {
  return { authorization: `Bearer ${REALTIME_TOKEN}` };
}

describe.skipIf(!reachable)("INV-AUDIT-REPORT: 単一セッション詳細レポート export (real PG)", () => {
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
    await cleanupSessions(pool, [SID]);

    const evs: NormalizedEvent[] = [
      makeEvent({
        session_id: SID,
        event_type: "session.started",
        state: "starting",
        timestamp: iso(BASE, 0),
        cwd: "/home/u/proj",
      }),
      // 高リスク承認要求 (Bash・command は redaction 済みマーカーを含む) → deny 解決。
      makeEvent({
        session_id: SID,
        event_type: "tool.permission.requested",
        state: "waiting.approval",
        timestamp: iso(BASE, 100),
        payload: {
          request_id: "rr1",
          tool_name: "Bash",
          risk_level: "high",
          command: "aws s3 cp [REDACTED:aws-access-key-id] s3://bucket/x",
        },
      }),
      makeEvent({
        session_id: SID,
        event_type: "tool.permission.resolved",
        timestamp: iso(BASE, 200),
        payload: { request_id: "rr1", decision: "deny" },
      }),
      // 実行コマンド: redacted command(マーカー) + **生 secret を非 allow-list キー (output/stdout)** へ
      //   at-rest 保持。report route は EVENT_COLUMNS しか SELECT しないので export へは漏れない。
      makeEvent({
        session_id: SID,
        event_type: "command.started",
        timestamp: iso(BASE, 300),
        redaction_count: 2,
        redaction_count_by_kind: { "aws-access-key-id": 1, "github-token": 1 },
        payload: {
          command: "curl -H 'Authorization: [REDACTED:github-token]' https://api",
          output: `${RAW_AWS} leaked-in-stdout`,
          stdout: RAW_GH,
        },
      }),
      makeEvent({
        session_id: SID,
        event_type: "command.completed",
        timestamp: iso(BASE, 400),
        payload: {
          // SEC-1: markup を含む redacted command。html/md 両 export で escape され raw タグが出ない
          //   ことを実 HTTP で load-bearing に固定する (mdCell/htmlEscape の <>/中和)。
          command: "<script>alert(1)</script> curl [REDACTED:github-token] https://api",
          exit_code: 7,
        },
      }),
    ];
    for (const ev of evs) await store.ingest(ev);
  }, 30_000);

  afterAll(async () => {
    await cleanupSessions(pool, [SID]);
    await app.close();
    await pool.end();
  });

  it("前提: 生 secret が at-rest (events.payload) に実在する (除外を load-bearing にする)", async () => {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM events
        WHERE session_id = $1 AND payload::text LIKE '%' || $2 || '%'`,
      [SID, RAW_AWS],
    );
    expect(rows[0]?.n).toBeGreaterThan(0);
  });

  it("route: REALTIME_TOKEN Bearer 認証必須 (未認証 401)", async () => {
    const res = await app.inject({ method: "GET", url: `/realtime/audit/sessions/${SID}/report` });
    expect(res.statusCode).toBe(401);
  });

  // ADR 6点強化 #1: tamper-evident manifest + verify route の実 HTTP E2E。
  it("report JSON に integrity manifest が載る (chain root + events)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/realtime/audit/sessions/${SID}/report`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { integrity?: { root?: string; event_count?: number } };
    expect(typeof body.integrity?.root).toBe("string");
    expect(body.integrity?.event_count).toBeGreaterThan(0);
  });

  it("verify route: 無改竄 manifest → ok=true・改竄 → ok=false", async () => {
    const rep = await app.inject({
      method: "GET",
      url: `/realtime/audit/sessions/${SID}/report`,
      headers: auth(),
    });
    const manifest = (rep.json() as { integrity: Record<string, unknown> }).integrity;

    const good = await app.inject({
      method: "POST",
      url: "/realtime/audit/verify",
      headers: { ...auth(), "content-type": "application/json" },
      payload: { manifest },
    });
    expect(good.statusCode).toBe(200);
    expect((good.json() as { ok: boolean }).ok).toBe(true);

    // events の 1 フィールドを書換える (deny→allow) → chain 破綻。
    const events = (manifest.events as Array<{ decision?: string; event_type?: string }>).map(
      (e) => (e.event_type === "tool.permission.resolved" ? { ...e, decision: "allow" } : e),
    );
    const bad = await app.inject({
      method: "POST",
      url: "/realtime/audit/verify",
      headers: { ...auth(), "content-type": "application/json" },
      payload: { manifest: { ...manifest, events } },
    });
    expect(bad.statusCode).toBe(200);
    expect((bad.json() as { ok: boolean; chain_valid: boolean }).ok).toBe(false);
  });

  it("verify route: manifest 欠落 → 400 / 未認証 → 401", async () => {
    const missing = await app.inject({
      method: "POST",
      url: "/realtime/audit/verify",
      headers: { ...auth(), "content-type": "application/json" },
      payload: {},
    });
    expect(missing.statusCode).toBe(400);
    const noauth = await app.inject({ method: "POST", url: "/realtime/audit/verify", payload: {} });
    expect(noauth.statusCode).toBe(401);
  });

  it("verify route: malformed object manifest → 500 でなく 200 ok=false (QA-2 堅牢化)", async () => {
    // events 欠落の object を渡す。構造ガードが無いと manifest.events.length で TypeError→500。
    const res = await app.inject({
      method: "POST",
      url: "/realtime/audit/verify",
      headers: { ...auth(), "content-type": "application/json" },
      payload: { manifest: { version: "actradeck-audit-manifest/v1", session_id: "x", root: "y" } },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toContain("malformed");
  });

  it("verify route: 1MiB 超の大型 manifest を受理 (AUDIT-VERIFY-SIZE: app 既定 1MiB を per-route override)", async () => {
    // report route は最大 10000 events(打ち切り)で ~5MB manifest を出す。app 既定 bodyLimit(1MiB)のままだと
    // verify が export の最大出力を受けられず、多忙/長時間セッションの report が再検証不能になる。verify route の
    // per-route bodyLimit override が効くことを実 HTTP で固定する (この test は route option を外すと 413 で赤化)。
    const rep = await app.inject({
      method: "GET",
      url: `/realtime/audit/sessions/${SID}/report`,
      headers: auth(),
    });
    const manifest = (rep.json() as { integrity: Record<string, unknown> }).integrity;
    // events を複製して body を app 既定 1MiB 超へ膨らませる。chain は壊れ ok=false になるが、検証すべきは
    // 「body が 413 で弾かれず route に到達する」= per-route bodyLimit override が効くこと。
    const first = (manifest.events as unknown[])[0] ?? {};
    const padded = Array.from({ length: 8000 }, (_, i) => ({
      ...(first as object),
      event_id: `pad-${i}`,
    }));
    const payload = JSON.stringify({ manifest: { ...manifest, events: padded } });
    expect(Buffer.byteLength(payload)).toBeGreaterThan(1024 * 1024); // 旧 app 既定 1MiB を超える
    const res = await app.inject({
      method: "POST",
      url: "/realtime/audit/verify",
      headers: { ...auth(), "content-type": "application/json" },
      payload,
    });
    // 413 でなく 200 (route bodyLimit override で受理)。chain は複製で壊れているので ok=false。
    expect(res.statusCode).toBe(200);
    expect((res.json() as { ok: boolean }).ok).toBe(false);
  });

  it("route: 未知 session は 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/realtime/audit/sessions/sess_missing_report/report",
      headers: auth(),
    });
    expect(res.statusCode).toBe(404);
  });

  it("format=json: timeline に command/exit/decision/risk・by-kind が出て生 secret 皆無", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/realtime/audit/sessions/${SID}/report`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      summary: {
        secret_redaction_count_by_kind: Record<string, number>;
        high_risk_op_count: number;
      };
      events: { event_type: string; command?: string; exit_code?: number; decision?: string }[];
    };
    expect(body.summary.secret_redaction_count_by_kind["aws-access-key-id"]).toBeGreaterThan(0);
    expect(body.summary.high_risk_op_count).toBeGreaterThan(0);
    const types = body.events.map((e) => e.event_type);
    expect(types).toContain("command.started");
    expect(types).toContain("tool.permission.resolved");
    const finished = body.events.find((e) => e.event_type === "command.completed");
    expect(finished?.exit_code).toBe(7);
    // NO-RAW: 生 secret は JSON へ出ない・[REDACTED:kind] マーカーは残る。
    expect(res.body).toContain("[REDACTED:github-token]");
    expect(res.body).not.toContain(RAW_AWS);
    expect(res.body).not.toContain(RAW_GH);
  });

  it("format=html: text/html・escape 済・by-kind/command 出力・生 secret 皆無", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/realtime/audit/sessions/${SID}/report?format=html`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-disposition"]).toContain(".html");
    expect(res.body).toContain("Audit Session Report");
    expect(res.body).toContain("[REDACTED:aws-access-key-id]");
    expect(res.body).toContain("command.completed");
    // redacted command 内の ' は escape される (属性境界安全)。生 secret は皆無。
    expect(res.body).not.toContain(RAW_AWS);
    expect(res.body).not.toContain(RAW_GH);
    // SEC-1: redacted command の markup は escape され raw タグが出ない (load-bearing・escape を外すと赤)。
    expect(res.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    // self-contained: 外部 script/CDN を参照しない (seeded <script> も escape 済で該当なし)。
    expect(res.body).not.toMatch(/<script[\s>]/i);
    expect(res.body).not.toContain('src="http');
  });

  it("format=md: text/markdown・timeline テーブル・生 secret 皆無", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/realtime/audit/sessions/${SID}/report?format=md`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/markdown");
    expect(res.headers["content-disposition"]).toContain(".md");
    expect(res.body).toContain("# Audit Session Report");
    expect(res.body).toContain("## Timeline");
    expect(res.body).toContain("[REDACTED:github-token]");
    expect(res.body).not.toContain(RAW_AWS);
    expect(res.body).not.toContain(RAW_GH);
    // SEC-1: markup を含む redacted command は md でも escape され raw タグが出ない (mdCell の <>/中和・
    //   非 sanitize renderer での inline-HTML 注入を封じる)。escape を外すと赤 (end-to-end falsifiability)。
    expect(res.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(res.body).not.toContain("<script>alert(1)</script>");
  });

  it("?diff=1: sidecar 未登録 (切断) は 500 でなく本文へ切断メッセージを明記 (graceful)", async () => {
    const html = await app.inject({
      method: "GET",
      url: `/realtime/audit/sessions/${SID}/report?format=html&diff=1`,
      headers: auth(),
    });
    expect(html.statusCode).toBe(200);
    expect(html.body).toContain("diff 取得不可 (session 切断)");
    const json = await app.inject({
      method: "GET",
      url: `/realtime/audit/sessions/${SID}/report?diff=1`,
      headers: auth(),
    });
    expect(json.statusCode).toBe(200);
    const body = json.json() as { diff?: { available: boolean } };
    expect(body.diff?.available).toBe(false);
  });

  it("range export html/md: /realtime/audit/sessions?format=html|md も生 secret 皆無で描画", async () => {
    const html = await app.inject({
      method: "GET",
      url: `/realtime/audit/sessions?from=${encodeURIComponent(iso(BASE, -1))}&to=${encodeURIComponent(iso(BASE, 10_000))}&format=html`,
      headers: auth(),
    });
    expect(html.statusCode).toBe(200);
    expect(html.headers["content-type"]).toContain("text/html");
    expect(html.body).toContain("Audit Range Report");
    expect(html.body).toContain(SID);
    expect(html.body).not.toContain(RAW_AWS);

    const md = await app.inject({
      method: "GET",
      url: `/realtime/audit/sessions?from=${encodeURIComponent(iso(BASE, -1))}&to=${encodeURIComponent(iso(BASE, 10_000))}&format=md`,
      headers: auth(),
    });
    expect(md.statusCode).toBe(200);
    expect(md.headers["content-type"]).toContain("text/markdown");
    expect(md.body).toContain("# Audit Range Report");
    expect(md.body).not.toContain(RAW_GH);
  });
});
