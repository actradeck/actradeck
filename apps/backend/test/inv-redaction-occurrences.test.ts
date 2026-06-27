/**
 * INV-REDACTION-OCCURRENCE — 強み(a) ガバナンス証跡 drill-down (real PG・decision 019f03cc)。
 *
 * 監査詳細の kind 別件数 (例 `aws-access-key-id ×N`) から「どのイベントで・いつ」その redaction が
 * 起きたかを辿る per-event 展開。本テストが固定する不変条件:
 *  - **INV-REDACTION-OCCURRENCE-COUNT (再導出の計数正当性)**: per-event 件数は events テーブルに
 *    カラムとして残らない (ingest 時に top-level redaction_count(_by_kind) を破棄し session_state へ
 *    fold するのみ)。drill-down は at-rest redacted な events 行全体 (`to_jsonb(e.*)::text`) に永続
 *    された安定マーカー `[REDACTED:<kind>]` から **ground truth** として再導出する。本テストは
 *    「宣言 redaction_count_by_kind == 永続マーカー数」な統制 fixture で `Σ(occurrence.count) ==
 *    fold` を pin し、SQL 再導出の**計数が正確**であることを保証する (canonical scanner と一致)。
 *    注: **実データでは drill-down >= fold** (drill-down が権威)。headline fold は ingest 時宣言値の
 *    running aggregate で feature ロールアウト過渡に歴史的過少計上しうる (例: 実 session で
 *    headline=136 vs 再導出=160)。等号は projection が過少計上していないイベントでのみ成立する。
 *  - **INV-AUDIT-EXPORT-NO-RAW**: occurrence にも原文秘匿は出ない。kind は closed-enum 検証・
 *    count は非負整数・command/path は at-rest redacted allow-list 投影のみ。非 allow-list キーの
 *    生 secret 形は応答に現れない (SELECT が固定 allow-list)。
 *  - route /realtime/audit/sessions/:id/redactions は REALTIME_TOKEN Bearer 認証背後・未知 kind は 400。
 */
import { type NormalizedEvent } from "@actradeck/event-model";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { buildIngestionServer } from "../src/ingestion-server.js";
import { IngestStore } from "../src/ingest-store.js";
import { AuditStore } from "../src/audit-store.js";
import { cleanupSessions, dbReachable, iso, makeEvent } from "./helpers.js";

import type { FastifyInstance } from "fastify";
import type { RedactionOccurrences } from "../src/audit-contract.js";

const DATABASE_URL = process.env.DATABASE_URL;
const reachable = DATABASE_URL ? await dbReachable(DATABASE_URL) : false;

const INGEST_TOKEN = "redocc-ingest-token";
const REALTIME_TOKEN = "redocc-realtime-token";

// 共有 DB 隔離のため遠未来の専用ウィンドウ + 一意 session。
const BASE = Date.parse("2099-07-20T12:00:00.000Z");
const RS = "sess_redocc_alpha";
// 非 allow-list キーに混ぜる生 secret 形 (応答に絶対出てはいけない)。
const RAW_LEAK = "ghp_RAWSECRETleak000000000000000000000";

function auth(): { authorization: string } {
  return { authorization: `Bearer ${REALTIME_TOKEN}` };
}

describe.skipIf(!reachable)("INV-REDACTION-OCCURRENCE: 証跡 drill-down (real PG)", () => {
  let pool: Pool;
  let app: FastifyInstance;
  let store: IngestStore;
  let audit: AuditStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    store = new IngestStore({ pool });
    audit = new AuditStore(pool);
    app = await buildIngestionServer({
      pool,
      ingestToken: INGEST_TOKEN,
      realtimeToken: REALTIME_TOKEN,
    });
    await cleanupSessions(pool, [RS]); // 前回残骸を除去 (冪等)。

    // リアルなパイプライン挙動を模す: 宣言 redaction_count_by_kind と **永続 payload/summary の
    // マーカー数が一致** する (sink が同一走査で算出・redacted を永続→fold するため)。これにより
    // 再導出 (drill-down) と fold (session_state) の一致が検証可能になる。
    const evs: NormalizedEvent[] = [
      // E1: aws ×1 (command 内)。
      makeEvent({
        session_id: RS,
        event_type: "command.started",
        timestamp: iso(BASE, 0),
        redaction_count: 1,
        redaction_count_by_kind: { "aws-access-key-id": 1 },
        payload: {
          command: "aws configure set aws_access_key_id [REDACTED:aws-access-key-id]",
        },
      }),
      // E2: aws ×2 (command 内 2 箇所)。
      makeEvent({
        session_id: RS,
        event_type: "command.started",
        timestamp: iso(BASE, 100),
        redaction_count: 2,
        redaction_count_by_kind: { "aws-access-key-id": 2 },
        payload: {
          command: "echo [REDACTED:aws-access-key-id] && echo [REDACTED:aws-access-key-id]",
        },
      }),
      // E3: github-token ×1 だが **マーカーは summary 側**・command は無マーカー。
      //   → drill-down が payload だけでなく summary も走査することを固定。occurrence.command は
      //     文脈として redacted command を投影する (マーカーが別フィールドでも文脈は出す)。
      makeEvent({
        session_id: RS,
        event_type: "command.started",
        timestamp: iso(BASE, 200),
        summary: "git push using [REDACTED:github-token]",
        redaction_count: 1,
        redaction_count_by_kind: { "github-token": 1 },
        payload: { command: "git push origin main" },
      }),
      // E4: github-token ×1 (command 内) + 非 allow-list キーに生 secret 形 (NO-RAW 検証)。
      makeEvent({
        session_id: RS,
        event_type: "command.started",
        timestamp: iso(BASE, 300),
        redaction_count: 1,
        redaction_count_by_kind: { "github-token": 1 },
        payload: {
          command: "git push https://[REDACTED:github-token]@github.com/o/r",
          // 非 allow-list キー。SELECT が固定 allow-list ゆえ応答に出てはいけない。
          note_should_not_leak: RAW_LEAK,
        },
      }),
      // E5: マーカーなし (非該当イベントの除外を固定)。
      makeEvent({
        session_id: RS,
        event_type: "heartbeat",
        timestamp: iso(BASE, 400),
        payload: { process_alive: true },
      }),
      // E6: aws ×1 だがマーカーは **cwd** 側 (payload/summary 以外)。to_jsonb(e.*) が cwd も走査する
      //   ことを固定 (QA-2: blob の cwd フィールドを load-bearing 化)。
      makeEvent({
        session_id: RS,
        event_type: "command.started",
        timestamp: iso(BASE, 500),
        cwd: "/work/[REDACTED:aws-access-key-id]/repo",
        redaction_count: 1,
        redaction_count_by_kind: { "aws-access-key-id": 1 },
        payload: { command: "ls -la" },
      }),
      // E7: aws ×1 だがマーカーは **thread_id** (id 列・旧 blob では非走査だった死角)。
      //   to_jsonb(e.*) が events 行全体を走査することで fold と一致することを固定 (SEC-1/QA-1)。
      //   旧実装 (payload/summary/cwd/metrics のみ) ではこの marker を取りこぼし Σ<fold で赤になる。
      makeEvent({
        session_id: RS,
        event_type: "command.started",
        timestamp: iso(BASE, 600),
        thread_id: "[REDACTED:aws-access-key-id]",
        redaction_count: 1,
        redaction_count_by_kind: { "aws-access-key-id": 1 },
        payload: { command: "aws sts get-caller-identity" },
      }),
    ];
    for (const ev of evs) await store.ingest(ev);
  });

  afterAll(async () => {
    await cleanupSessions(pool, [RS]);
    await app.close();
    await pool.end();
  });

  it("再導出の計数正当性: 統制 fixture (宣言==マーカー) で Σ(occurrence.count) == fold", async () => {
    const summary = await audit.sessionSummary(RS);
    expect(summary).toBeDefined();
    const foldAws = summary!.secret_redaction_count_by_kind["aws-access-key-id"];
    const foldGh = summary!.secret_redaction_count_by_kind["github-token"];
    expect(foldAws).toBe(5); // E1(1)+E2(2)+E6(cwd 1)+E7(thread_id 1)
    expect(foldGh).toBe(2); // E3(1)+E4(1)

    const occAws = await audit.redactionOccurrences({
      sessionId: RS,
      kind: "aws-access-key-id",
      limit: 1000,
    });
    // 統制 fixture (宣言 redaction_count_by_kind == 永続マーカー数) では再導出 Σ == fold。
    // E6(cwd)/E7(thread_id) の id/path 列マーカーまで to_jsonb(e.*) が拾うことを pin (= 計数正当性)。
    // 実データでは drill-down >= fold (headline は projection の歴史的過少計上を含みうる)。
    expect(occAws.total).toBe(foldAws);
    expect(occAws.occurrences.map((o) => o.count)).toEqual([1, 2, 1, 1]); // E1,E2,E6,E7 timestamp ASC
    expect(occAws.has_more).toBe(false);

    const occGh = await audit.redactionOccurrences({
      sessionId: RS,
      kind: "github-token",
      limit: 1000,
    });
    expect(occGh.total).toBe(foldGh);
    expect(occGh.occurrences.map((o) => o.count)).toEqual([1, 1]); // E3,E4
  });

  it("occurrence: command/path/event_type/timestamp を投影・summary 内マーカーも検出", async () => {
    const occGh = await audit.redactionOccurrences({
      sessionId: RS,
      kind: "github-token",
      limit: 1000,
    });
    const [e3, e4] = occGh.occurrences;
    // E3: マーカーは summary 側だが detect され、文脈として redacted command を投影。
    expect(e3?.event_type).toBe("command.started");
    expect(e3?.command).toBe("git push origin main");
    expect(typeof e3?.timestamp).toBe("string");
    // E4: マーカーは command 内。redacted command を投影。
    expect(e4?.command).toBe("git push https://[REDACTED:github-token]@github.com/o/r");
  });

  it("kind に該当 occurrence が無ければ空 (非該当イベントを混ぜない)", async () => {
    const none = await audit.redactionOccurrences({
      sessionId: RS,
      kind: "private-key",
      limit: 1000,
    });
    expect(none.occurrences).toEqual([]);
    expect(none.total).toBe(0);
    expect(none.has_more).toBe(false);
  });

  it("limit 切り詰め: occurrences は limit 件・total はページ内部分和・has_more=true (QA-3 境界)", async () => {
    // aws は 4 occurrence。limit=1 で off-by-one なく 1 件のみ返し、total はページ内合算 (部分和)。
    const page = await audit.redactionOccurrences({
      sessionId: RS,
      kind: "aws-access-key-id",
      limit: 1,
    });
    expect(page.occurrences.length).toBe(1);
    expect(page.has_more).toBe(true);
    expect(page.total).toBe(page.occurrences[0]!.count); // total はページ内 count 合算 (= E1 の 1)
    expect(page.limit).toBe(1);
  });

  it("payload 外 (cwd/thread_id) のマーカーも occurrence として検出 (文脈 command を投影)", async () => {
    const occ = await audit.redactionOccurrences({
      sessionId: RS,
      kind: "aws-access-key-id",
      limit: 1000,
    });
    // E6 (cwd マーカー) / E7 (thread_id マーカー) は command にマーカーが無くても occurrence 化し、
    // 文脈用 command を投影する (マーカーが別フィールドでも「いつ・どのイベントか」を出す)。
    const e6 = occ.occurrences.find((o) => o.command === "ls -la");
    const e7 = occ.occurrences.find((o) => o.command === "aws sts get-caller-identity");
    expect(e6?.count).toBe(1);
    expect(e7?.count).toBe(1);
  });

  it("route: REALTIME_TOKEN Bearer 認証必須 (未認証 401)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/realtime/audit/sessions/${RS}/redactions?kind=github-token`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("route: 未知/欠落 kind は 400 (phantom をスキャンしない)", async () => {
    const unknown = await app.inject({
      method: "GET",
      url: `/realtime/audit/sessions/${RS}/redactions?kind=not-a-real-kind`,
      headers: auth(),
    });
    expect(unknown.statusCode).toBe(400);
    const missing = await app.inject({
      method: "GET",
      url: `/realtime/audit/sessions/${RS}/redactions`,
      headers: auth(),
    });
    expect(missing.statusCode).toBe(400);
  });

  it("route: 既知 kind は 200 + occurrences・NO-RAW (生 secret 形が応答に出ない)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/realtime/audit/sessions/${RS}/redactions?kind=github-token`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as RedactionOccurrences;
    expect(body.kind).toBe("github-token");
    expect(body.total).toBe(2);
    expect(body.occurrences.length).toBe(2);
    // INV-AUDIT-EXPORT-NO-RAW: 非 allow-list キーの生 secret 形 (E4.note_should_not_leak) は
    //   固定 allow-list SELECT ゆえ応答 (生本文) に現れない。whole-payload 投影へ退行したら赤。
    expect(res.body).not.toContain(RAW_LEAK);
    expect(res.body).not.toContain("note_should_not_leak");
  });

  it("route: limit で has_more 判定 (有界化)", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/realtime/audit/sessions/${RS}/redactions?kind=github-token&limit=1`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as RedactionOccurrences;
    expect(body.occurrences.length).toBe(1);
    expect(body.has_more).toBe(true);
  });

  it("route: redactionOccurrences が throw したら 500 (catch path・原文非露出)", async () => {
    // build 後に pool を閉じて以降の query を throw させ、route の try/catch (500) を実カバーする。
    const brokenPool = new Pool({ connectionString: DATABASE_URL, max: 1 });
    const brokenApp = await buildIngestionServer({
      pool: brokenPool,
      ingestToken: INGEST_TOKEN,
      realtimeToken: REALTIME_TOKEN,
    });
    await brokenPool.end();
    try {
      const res = await brokenApp.inject({
        method: "GET",
        url: `/realtime/audit/sessions/${RS}/redactions?kind=github-token`,
        headers: auth(),
      });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: "internal error" }); // 原文/詳細を漏らさない。
    } finally {
      await brokenApp.close();
    }
  });
});
