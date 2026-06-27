/**
 * INV-AUDIT — 強み(a) 監査ビュー (real PG)。
 *
 * AuditStore は sessions/session_state/events の **allow-list 投影**を集約し、backend は再 redaction
 * しない (sidecar choke が唯一の権威)。本テストが固定する不変条件:
 *  - 集約の正確性: redaction kind 別件数 / 承認 decision 別件数 / pending / high-risk / メタ。
 *  - **INV-AUDIT-EXPORT-NO-RAW**: 集約 DTO / CSV export に原文秘匿が出ない (kind 名 enum + 件数 +
 *    decision + メタのみ)。read 層 closed-enum gate が dirty な jsonb 行の未知/secret 形 kind を捨てる
 *    (SEC-1r の write-gate 単一依存に対する二重防御)。
 *  - route は REALTIME_TOKEN Bearer 認証背後 (/realtime/audit/*) で ?format=csv を返す。
 */
import { type NormalizedEvent } from "@actradeck/event-model";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { buildIngestionServer } from "../src/ingestion-server.js";
import { IngestStore } from "../src/ingest-store.js";
import { AuditStore } from "../src/audit-store.js";
import { auditReportToCsv } from "../src/audit-contract.js";
import { cleanupSessions, dbReachable, iso, makeEvent } from "./helpers.js";

import type { FastifyInstance } from "fastify";
import type { AuditRangeReport, AuditSessionSummary } from "../src/audit-contract.js";

const DATABASE_URL = process.env.DATABASE_URL;
const reachable = DATABASE_URL ? await dbReachable(DATABASE_URL) : false;

const INGEST_TOKEN = "audit-ingest-token";
const REALTIME_TOKEN = "audit-realtime-token";

// 共有 DB での range 集計を隔離するため、本テスト専用の遠未来タイムウィンドウを使う。
const BASE = Date.parse("2099-06-15T12:00:00.000Z");
const S1 = "sess_audit_alpha";
const S2 = "sess_audit_beta";
// S3 は range 窓 (to=BASE+10_000) の外 (BASE+50_000) に置き、range 集計テストへ干渉させない (QA-3 専用)。
const S3 = "sess_audit_gamma";
// S4 も窓外 (BASE+60_000)。command なし・path/file_path ありの承認で path 投影 + COALESCE フォールバックを固定 (QA-1)。
const S4 = "sess_audit_delta";
// write-gate を迂回した dirty by-kind を模す secret 形 phantom。test 間で共有し gate 健在性を route まで固定。
const PHANTOM_KIND = "ghp_FAKEphantomSECRETkind0123456789";

function auth(): { authorization: string } {
  return { authorization: `Bearer ${REALTIME_TOKEN}` };
}

describe.skipIf(!reachable)("INV-AUDIT: 監査ビュー集約 + export (real PG)", () => {
  let pool: Pool;
  let app: FastifyInstance;
  let store: IngestStore;
  let audit: AuditStore;
  const sessions = [S1, S2, S3, S4];

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    store = new IngestStore({ pool });
    audit = new AuditStore(pool);
    app = await buildIngestionServer({
      pool,
      ingestToken: INGEST_TOKEN,
      realtimeToken: REALTIME_TOKEN,
    });
    await cleanupSessions(pool, sessions); // 前回残骸を除去 (冪等)。

    const evs: NormalizedEvent[] = [
      // S1: redaction 2 件 (github-token) + 承認 2 要求 (1 高リスク) + 1 解決(allow)。
      makeEvent({
        session_id: S1,
        event_type: "heartbeat",
        timestamp: iso(BASE, 0),
        redaction_count: 2,
        redaction_count_by_kind: { "github-token": 2 },
      }),
      makeEvent({
        session_id: S1,
        event_type: "tool.permission.requested",
        state: "waiting.approval",
        timestamp: iso(BASE, 100),
        payload: {
          request_id: "r1",
          tool_name: "Bash",
          risk_level: "high",
          // command は at-rest で redaction 済み (sidecar choke)。audit はこの allow-list 列を投影する。
          command: "git grep [REDACTED:github-token] -- targets.txt",
          // 非 allow-list キーは SELECT に無く投影されない (漏洩したら下の assert が赤)。
          note_should_not_leak: "RAWLEAK_ghp_shouldnotappear",
        },
      }),
      makeEvent({
        session_id: S1,
        event_type: "tool.permission.requested",
        state: "waiting.approval",
        timestamp: iso(BASE, 200),
        payload: { request_id: "r2", tool_name: "Edit", risk_level: "low" },
      }),
      makeEvent({
        session_id: S1,
        event_type: "tool.permission.resolved",
        timestamp: iso(BASE, 300),
        payload: { request_id: "r1", decision: "allow" },
      }),
      // S2: redaction 1 件 (aws) + 承認 1 解決(deny)。
      makeEvent({
        session_id: S2,
        event_type: "heartbeat",
        timestamp: iso(BASE, 1000),
        redaction_count: 1,
        redaction_count_by_kind: { "aws-access-key-id": 1 },
      }),
      makeEvent({
        session_id: S2,
        event_type: "tool.permission.requested",
        state: "waiting.approval",
        timestamp: iso(BASE, 1100),
        payload: { request_id: "r3", tool_name: "Bash", risk_level: "critical" },
      }),
      makeEvent({
        session_id: S2,
        event_type: "tool.permission.resolved",
        timestamp: iso(BASE, 1200),
        payload: { request_id: "r3", decision: "deny" },
      }),
      // S3 (range 窓外): 承認 1 要求 r4 を 2 回 resolve (resolved>requested) → pending clamp≥0 検証 (QA-3)。
      makeEvent({
        session_id: S3,
        event_type: "tool.permission.requested",
        state: "waiting.approval",
        timestamp: iso(BASE, 50_000),
        payload: { request_id: "r4", tool_name: "Bash", risk_level: "high" },
      }),
      makeEvent({
        session_id: S3,
        event_type: "tool.permission.resolved",
        timestamp: iso(BASE, 50_100),
        payload: { request_id: "r4", decision: "allow" },
      }),
      makeEvent({
        session_id: S3,
        event_type: "tool.permission.resolved",
        timestamp: iso(BASE, 50_200),
        payload: { request_id: "r4", decision: "allow" },
      }),
      // S4 (窓外): command 無し・path / file_path 有りの承認。path 投影 + COALESCE(file_path) を固定 (QA-1)。
      makeEvent({
        session_id: S4,
        event_type: "tool.permission.requested",
        state: "waiting.approval",
        timestamp: iso(BASE, 60_000),
        payload: { request_id: "p1", tool_name: "Edit", risk_level: "low", path: "src/app.ts" },
      }),
      makeEvent({
        session_id: S4,
        event_type: "tool.permission.requested",
        state: "waiting.approval",
        timestamp: iso(BASE, 60_100),
        // path 不在で file_path のみ → COALESCE(path, file_path) が file_path を採る分岐。
        payload: {
          request_id: "p2",
          tool_name: "Write",
          risk_level: "low",
          file_path: "dist/out.js",
        },
      }),
      makeEvent({
        session_id: S4,
        event_type: "tool.permission.requested",
        state: "waiting.approval",
        timestamp: iso(BASE, 60_200),
        // path と file_path 両方 → COALESCE 順序 (path 優先) を固定 (順序入替の退行を赤化)。
        payload: {
          request_id: "p3",
          tool_name: "NotebookEdit",
          risk_level: "low",
          path: "nb.ipynb",
          file_path: "should-not-win.js",
        },
      }),
    ];
    for (const ev of evs) await store.ingest(ev);
  });

  afterAll(async () => {
    await cleanupSessions(pool, sessions);
    await app.close();
    await pool.end();
  });

  it("sessionSummary: redaction kind 別 / 承認 decision 別 / pending / high-risk を正確に集約", async () => {
    const s = await audit.sessionSummary(S1, { detail: true });
    expect(s).toBeDefined();
    const sum = s as AuditSessionSummary;
    expect(sum.secret_detected).toBe(true);
    expect(sum.secret_redaction_count).toBe(2);
    expect(sum.secret_redaction_count_by_kind["github-token"]).toBe(2);
    expect(sum.approvals.total).toBe(2); // r1 + r2
    expect(sum.approvals.by_decision.allow).toBe(1); // r1 resolved
    expect(sum.approvals.by_decision.deny).toBe(0);
    expect(sum.approvals.pending).toBe(1); // r2 未解決
    expect(sum.high_risk_op_count).toBe(1); // r1=high (r2=low は除外)
    // 承認エントリ (allow-list): decision は request_id 突合で補完。
    expect(sum.entries).toBeDefined();
    expect(sum.entries!.length).toBe(2);
    const r1 = sum.entries!.find((e) => e.tool_name === "Bash" && e.risk_level === "high");
    expect(r1?.decision).toBe("allow");
    // command (redaction 済み at-rest) を「何を承認したか」として投影する (detail のみ・range/CSV 非載せ)。
    expect(r1?.command).toBe("git grep [REDACTED:github-token] -- targets.txt");
    const r2 = sum.entries!.find((e) => e.tool_name === "Edit");
    expect(r2?.decision).toBeUndefined(); // 未解決
    // INV-AUDIT-EXPORT-NO-RAW: SELECT は固定 allow-list。非 allow-list の payload キー/値は投影しない
    // (whole-payload 投影へ退行したら RAWLEAK が現れて赤)。
    const entriesJson = JSON.stringify(sum.entries);
    expect(entriesJson).not.toContain("RAWLEAK");
    expect(entriesJson).not.toContain("note_should_not_leak");
  });

  it("approvalEntries: command 無し承認は path を投影し file_path にフォールバックする (QA-1)", async () => {
    const s = await audit.sessionSummary(S4, { detail: true });
    expect(s).toBeDefined();
    const entries = (s as AuditSessionSummary).entries!;
    expect(entries.length).toBe(3);
    const edit = entries.find((e) => e.tool_name === "Edit");
    expect(edit?.command).toBeUndefined();
    expect(edit?.path).toBe("src/app.ts"); // payload->>'path' を投影
    const write = entries.find((e) => e.tool_name === "Write");
    expect(write?.command).toBeUndefined();
    expect(write?.path).toBe("dist/out.js"); // path 不在 → COALESCE(path, file_path) で file_path 採用
    // path と file_path 両方 → COALESCE は path を優先 (順序入替 COALESCE(file_path, path) なら赤)。
    const nb = entries.find((e) => e.tool_name === "NotebookEdit");
    expect(nb?.path).toBe("nb.ipynb");
  });

  it("rangeReport: 期間窓で複数セッションを集計し totals を合算 (has_more)", async () => {
    const report = await audit.rangeReport({
      from: iso(BASE, -1),
      to: iso(BASE, 10_000),
      now: "2099-06-16T00:00:00.000Z",
    });
    // 専用窓ゆえ S1/S2 のみが入る。
    const ids = report.sessions.map((s) => s.session_id).sort();
    expect(ids).toEqual([S1, S2].sort());
    expect(report.session_count).toBe(2);
    expect(report.totals.secret_redaction_count).toBe(3); // 2 + 1
    expect(report.totals.secret_redaction_count_by_kind["github-token"]).toBe(2);
    expect(report.totals.secret_redaction_count_by_kind["aws-access-key-id"]).toBe(1);
    expect(report.totals.approvals_by_decision.allow).toBe(1);
    expect(report.totals.approvals_by_decision.deny).toBe(1);
    expect(report.totals.approval_total).toBe(3); // r1 r2 r3
    expect(report.totals.high_risk_op_count).toBe(2); // r1 high + r3 critical
    expect(report.totals.sessions_with_secret).toBe(2);

    // limit=1 で has_more=true (窓内 2 セッション)。
    const page = await audit.rangeReport({
      from: iso(BASE, -1),
      to: iso(BASE, 10_000),
      limit: 1,
      now: "2099-06-16T00:00:00.000Z",
    });
    expect(page.sessions.length).toBe(1);
    expect(page.has_more).toBe(true);
  });

  it("from>to は空結果 (over-fetch しない)", async () => {
    const report = await audit.rangeReport({
      from: iso(BASE, 10_000),
      to: iso(BASE, -10_000),
      now: "2099-06-16T00:00:00.000Z",
    });
    expect(report.session_count).toBe(0);
    expect(report.sessions).toEqual([]);
  });

  it("pending は clamp≥0 (resolved>requested の二重 resolve でも負にしない) [QA-3]", async () => {
    const s = (await audit.sessionSummary(S3)) as AuditSessionSummary;
    expect(s.approvals.total).toBe(1); // r4 requested 1 件
    expect(s.approvals.by_decision.allow).toBe(2); // r4 を二重 resolve
    expect(s.approvals.pending).toBe(0); // Math.max(0, 1 - 2) = 0 (負にしない)
    expect(s.high_risk_op_count).toBe(1); // r4 = high
  });

  it("INV-AUDIT-EXPORT-NO-RAW: read 層 closed-enum gate が dirty な未知/secret 形 kind を捨てる", async () => {
    // write-gate を迂回して session_state に直接 dirty な by-kind を注入 (migration backfill / 手動 SQL
    // / gate 回帰 を模す)。AuditStore は read 層で既知 kind 以外を捨てるべき (SEC-1r 二重防御)。
    const phantom = PHANTOM_KIND;
    await pool.query(
      `UPDATE session_state SET secret_redaction_count_by_kind = $1::jsonb WHERE session_id = $2`,
      [JSON.stringify({ "github-token": 2, [phantom]: 9 }), S1],
    );
    const s = (await audit.sessionSummary(S1)) as AuditSessionSummary;
    // 既知 kind は残り、phantom (secret 形) は gate で除去。
    expect(s.secret_redaction_count_by_kind["github-token"]).toBe(2);
    expect(Object.keys(s.secret_redaction_count_by_kind)).not.toContain(phantom);
    // CSV export にも phantom は出ない (INV-AUDIT-EXPORT-NO-RAW)。
    const report: AuditRangeReport = {
      from: undefined,
      to: undefined,
      generated_at: "2099-06-16T00:00:00.000Z",
      session_count: 1,
      totals: {
        secret_redaction_count: s.secret_redaction_count,
        secret_redaction_count_by_kind: s.secret_redaction_count_by_kind,
        approvals_by_decision: s.approvals.by_decision,
        approval_total: s.approvals.total,
        high_risk_op_count: s.high_risk_op_count,
        sessions_with_secret: s.secret_detected ? 1 : 0,
      },
      sessions: [s],
      limit: 1,
      has_more: false,
    };
    const csv = auditReportToCsv(report);
    expect(csv).not.toContain(phantom);
    expect(csv).toContain("github-token:2");
  });

  it("route /realtime/audit/sessions: REALTIME_TOKEN Bearer 認証必須", async () => {
    const res = await app.inject({ method: "GET", url: "/realtime/audit/sessions" });
    expect(res.statusCode).toBe(401);
  });

  it("route: JSON と ?format=csv (text/csv) を返す・原文非載せ", async () => {
    // QA-7/TDA-4r2: 順序非依存化 — 本テスト内で S1 に dirty phantom を注入し、先行テストへの
    //   暗黙依存を断つ (これにより下の not.toContain(PHANTOM_KIND) が単独で load-bearing になる)。
    await pool.query(
      `UPDATE session_state SET secret_redaction_count_by_kind = $1::jsonb WHERE session_id = $2`,
      [JSON.stringify({ "github-token": 2, [PHANTOM_KIND]: 9 }), S1],
    );
    const json = await app.inject({
      method: "GET",
      url: `/realtime/audit/sessions?from=${encodeURIComponent(iso(BASE, -1))}&to=${encodeURIComponent(iso(BASE, 10_000))}`,
      headers: auth(),
    });
    expect(json.statusCode).toBe(200);
    const body = json.json() as AuditRangeReport;
    expect(body.sessions.map((s) => s.session_id).sort()).toEqual([S1, S2].sort());
    // QA-4: test4 で S1 に注入した dirty phantom kind は read 層 gate で route JSON にも出ない (e2e)。
    expect(json.body).not.toContain(PHANTOM_KIND);

    const csv = await app.inject({
      method: "GET",
      url: `/realtime/audit/sessions?from=${encodeURIComponent(iso(BASE, -1))}&to=${encodeURIComponent(iso(BASE, 10_000))}&format=csv`,
      headers: auth(),
    });
    expect(csv.statusCode).toBe(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["content-disposition"]).toContain("attachment");
    expect(csv.body).toContain(S1);
    expect(csv.body).toContain("session_id,provider"); // header 行
    // QA-4: route→CSV 経路でも NO-RAW を e2e で固定 (sendCsv 組み立て段の raw 混入回帰を捕捉)。
    expect(csv.body).not.toContain(PHANTOM_KIND);
  });

  it("route /realtime/audit/sessions/:id: 未知 session は 404・既知は detail", async () => {
    const missing = await app.inject({
      method: "GET",
      url: "/realtime/audit/sessions/sess_does_not_exist",
      headers: auth(),
    });
    expect(missing.statusCode).toBe(404);

    const ok = await app.inject({
      method: "GET",
      url: `/realtime/audit/sessions/${S2}`,
      headers: auth(),
    });
    expect(ok.statusCode).toBe(200);
    const sum = ok.json() as AuditSessionSummary;
    expect(sum.session_id).toBe(S2);
    expect(sum.approvals.by_decision.deny).toBe(1);
    expect(sum.entries).toBeDefined();
  });
});
