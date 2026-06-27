/**
 * INV-REDACTION-BACKFILL — headline backfill (real PG・decision 019f0405 / 019f0414)。
 *
 * session_state の running fold は ingest 時宣言値の積算で、feature ロールアウト過渡 (sidecar が by_kind を
 * 出す前 / backend が by_kind projection を持つ前に取り込んだイベント) で**歴史的に過少計上**しうる。
 * backfill (`backfillRedactionCounts`) は drill-down (redactionOccurrences) と**同一の at-rest 走査・同一の
 * 計数式**で 3 列 (secret_redaction_count / secret_redaction_count_by_kind / secret_detected) を再導出し、
 * headline == drill-down == ground truth へ揃える。本テストが固定する不変条件:
 *  - **RECONCILE (headline == drill-down)**: backfill 後、各 known kind の session_state.by_kind[kind] ==
 *    redactionOccurrences(kind).total。fold が落とした rollout-gap イベント (宣言欠落) と id 列マーカーまで
 *    at-rest から拾い直す。
 *  - **INVARIANT (sum(by_kind) <= scalar)**: scalar = 全マーカー数 (known∪unknown)、by_kind = known 部分集合
 *    ゆえ phantom kind があると sum(by_kind) < scalar (strict)。closed-enum gate で phantom は by_kind に
 *    入らないが scalar には数える。
 *  - **IDEMPOTENT**: 全 backfill 後の再実行は plan 空・applied 0・値不変。
 *  - **NO-RAW**: session_state.by_kind は件数 + closed-enum kind のみ。生 secret 形 / 未知 kind 名は載らない。
 *  - **APPEND-ONLY / ADDITIVE-COLUMNS-ONLY**: events 件数は不変。backfill は 3 列のみ更新し state 等を不触。
 *  - **ORPHAN-SAFE**: events にマーカーがあるが session_state 行が無い session は更新せず報告のみ (INSERT しない)。
 */
import { isKnownRedactionKind, type NormalizedEvent } from "@actradeck/event-model";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

import { IngestStore } from "../src/ingest-store.js";
import { AuditStore } from "../src/audit-store.js";
import { backfillRedactionCounts } from "../src/audit-backfill.js";
import { cleanupSessions, dbReachable, iso, makeEvent } from "./helpers.js";

const DATABASE_URL = process.env.DATABASE_URL;
const reachable = DATABASE_URL ? await dbReachable(DATABASE_URL) : false;

// 共有 DB 隔離のため遠未来の専用ウィンドウ + 一意 session。
const BASE = Date.parse("2099-08-10T12:00:00.000Z");
const BS = "sess_backfill_alpha";
const ORPHAN = "sess_backfill_orphan";
// 宣言ありマーカーなし (crafted/legacy): fold > at-rest → 減少方向 (TDA-1/QA-1)。
const DEC = "sess_backfill_decrease";
// 敵対的マーカー混在: SQL 機構 (regexp_count vs literal markerCountExpr) の parity 検証 (TDA-2)。
const PARITY = "sess_backfill_parity";
// digit を含む kind マーカー: backend ALL_MARKERS_REGEX の charset⊇[0-9] を実 PG で pin (TDA-2 単一化)。
const DIGIT = "sess_backfill_digit";
const NONEXISTENT = "sess_backfill_nonexistent";
// 非 allow-list キーに混ぜる生 secret 形 (session_state に絶対出てはいけない)。
const RAW_LEAK = "ghp_RAWSECRETleak000000000000000000000";
const PHANTOM = "not-a-real-kind"; // 未知 kind: scalar には数えるが by_kind には入れない。

interface StateRow {
  state: string | null;
  secret_redaction_count: number;
  secret_redaction_count_by_kind: Record<string, number>;
  secret_detected: boolean;
}

async function readState(pool: Pool, sessionId: string): Promise<StateRow | undefined> {
  const { rows } = await pool.query<{
    state: string | null;
    secret_redaction_count: number | null;
    secret_redaction_count_by_kind: unknown;
    secret_detected: boolean | null;
  }>(
    `SELECT state, secret_redaction_count, secret_redaction_count_by_kind, secret_detected
       FROM session_state WHERE session_id = $1`,
    [sessionId],
  );
  const r = rows[0];
  if (!r) return undefined;
  const bk =
    r.secret_redaction_count_by_kind &&
    typeof r.secret_redaction_count_by_kind === "object" &&
    !Array.isArray(r.secret_redaction_count_by_kind)
      ? (r.secret_redaction_count_by_kind as Record<string, number>)
      : {};
  return {
    state: r.state,
    secret_redaction_count:
      typeof r.secret_redaction_count === "number" ? r.secret_redaction_count : 0,
    secret_redaction_count_by_kind: bk,
    secret_detected: r.secret_detected === true,
  };
}

async function eventCount(pool: Pool, sessionId: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM events WHERE session_id = $1`,
    [sessionId],
  );
  return Number(rows[0]?.n ?? "0");
}

describe.skipIf(!reachable)("INV-REDACTION-BACKFILL: headline backfill (real PG)", () => {
  let pool: Pool;
  let store: IngestStore;
  let audit: AuditStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
    store = new IngestStore({ pool });
    audit = new AuditStore(pool);
    await cleanupSessions(pool, [BS, ORPHAN, DEC, PARITY, DIGIT, NONEXISTENT]);

    // rollout-gap を再現: 一部イベントは payload に [REDACTED:<kind>] マーカーを**持つが**
    // redaction_count(_by_kind) を**宣言しない** → fold が過少計上 (at-rest にはマーカーが残る)。
    const evs: NormalizedEvent[] = [
      // E1 (gap): aws ×2 を command に持つが宣言なし → fold は aws を計上しない。
      makeEvent({
        session_id: BS,
        event_type: "command.started",
        timestamp: iso(BASE, 0),
        payload: {
          command: "echo [REDACTED:aws-access-key-id] && echo [REDACTED:aws-access-key-id]",
        },
      }),
      // E2 (現行スタック): github ×1 を宣言込みで → fold が正しく計上。
      makeEvent({
        session_id: BS,
        event_type: "command.started",
        timestamp: iso(BASE, 100),
        redaction_count: 1,
        redaction_count_by_kind: { "github-token": 1 },
        payload: { command: "git push https://[REDACTED:github-token]@github.com/o/r" },
      }),
      // E3 (gap + 行全体走査): aws ×1 を **thread_id** (id 列) に持つが宣言なし。to_jsonb(e.*) が
      //   行全体を走査するため backfill が拾う (fold は取りこぼし)。
      makeEvent({
        session_id: BS,
        event_type: "command.started",
        timestamp: iso(BASE, 200),
        thread_id: "[REDACTED:aws-access-key-id]",
        payload: { command: "aws sts get-caller-identity" },
      }),
      // E4 (phantom kind + NO-RAW): 未知 kind マーカー ×1 (scalar には数える/by_kind には入れない) と
      //   非 allow-list キーに生 secret 形 (session_state に出てはいけない)。
      makeEvent({
        session_id: BS,
        event_type: "command.started",
        timestamp: iso(BASE, 300),
        payload: {
          command: `echo [REDACTED:${PHANTOM}]`,
          note_should_not_leak: RAW_LEAK,
        },
      }),
      // E5: マーカーなし (非該当の除外)。
      makeEvent({
        session_id: BS,
        event_type: "heartbeat",
        timestamp: iso(BASE, 400),
        payload: { process_alive: true },
      }),
      // ORPHAN session: マーカーを持つ単一イベント (後で session_state 行を削除して orphan 化)。
      makeEvent({
        session_id: ORPHAN,
        event_type: "command.started",
        timestamp: iso(BASE, 500),
        payload: { command: "echo [REDACTED:github-token]" },
      }),
      // DEC session: github×5 を**宣言するが at-rest にマーカーが無い** (crafted/legacy)。
      //   fold = {github:5}/scalar 5・at-rest = 0 → backfill は減少方向 (既定では適用しない)。
      makeEvent({
        session_id: DEC,
        event_type: "command.started",
        timestamp: iso(BASE, 600),
        redaction_count: 5,
        redaction_count_by_kind: { "github-token": 5 },
        payload: { command: "echo no markers here" }, // [REDACTED:*] を含まない。
      }),
      // PARITY session: 敵対的マーカー混在 (隣接 / 複数 kind / phantom / truncated)。
      //   known: github×1, aws×2, jwt×1, cookie×1 (sum=5) / unknown(phantom)×1 / truncated は非マーカー。
      //   → scalar(全マーカー)=6, sum(by_kind known)=5 < scalar (strict)。
      makeEvent({
        session_id: PARITY,
        event_type: "command.started",
        timestamp: iso(BASE, 700),
        payload: {
          command:
            "a [REDACTED:github-token] b [REDACTED:aws-access-key-id] c [REDACTED:aws-access-key-id] " +
            "d [REDACTED:jwt][REDACTED:cookie] e [REDACTED:not-a-real-kind] f [REDACT-TRUNCATED:50]",
        },
      }),
      // DIGIT session: digit を含む kind マーカー ×1 (unknown)。backend ALL_MARKERS_REGEX が
      //   event-model 正典 source 由来で charset⊇[0-9] であることを実 PG で pin (TDA-2 単一化)。
      makeEvent({
        session_id: DIGIT,
        event_type: "command.started",
        timestamp: iso(BASE, 800),
        payload: { command: "echo [REDACTED:oauth2-token]" },
      }),
    ];
    for (const ev of evs) await store.ingest(ev);
  });

  afterAll(async () => {
    await cleanupSessions(pool, [BS, ORPHAN, DEC, PARITY, DIGIT, NONEXISTENT]);
    await pool.end();
  });

  it("前提: fold は rollout-gap を過少計上 (aws 欠落・github のみ)", async () => {
    const pre = await readState(pool, BS);
    expect(pre).toBeDefined();
    // 宣言したのは E2 の github のみ → by_kind に aws は無い。
    expect(pre!.secret_redaction_count_by_kind["github-token"]).toBe(1);
    expect(pre!.secret_redaction_count_by_kind["aws-access-key-id"]).toBeUndefined();
    expect(pre!.secret_redaction_count).toBe(1); // E2 のみ宣言 redaction_count=1
  });

  it("drill-down は ground truth (at-rest 実体): aws=3 / github=1", async () => {
    const aws = await audit.redactionOccurrences({
      sessionId: BS,
      kind: "aws-access-key-id",
      limit: 1000,
    });
    const gh = await audit.redactionOccurrences({
      sessionId: BS,
      kind: "github-token",
      limit: 1000,
    });
    expect(aws.total).toBe(3); // E1(2) + E3(thread_id 1)
    expect(gh.total).toBe(1); // E2(1)
  });

  it("DRY-RUN: apply=false は plan を出すが書き込まない (既定モードの安全契約・QA-2)", async () => {
    // この時点で BS は gap 状態 (RECONCILE の apply より前)。
    const before = await readState(pool, BS);
    const result = await backfillRedactionCounts(pool, { apply: false, sessionId: BS });
    // 計画は正しく算出される。
    expect(result.plan.length).toBe(1);
    expect(result.plan[0]!.session_id).toBe(BS);
    expect(result.plan[0]!.to.scalar).toBe(5);
    // しかし 1 行も書き込まない。
    expect(result.applied).toBe(0);
    const after = await readState(pool, BS);
    expect(after).toEqual(before); // 状態完全不変 (write ゼロ)。
  });

  it("RECONCILE + INVARIANT + APPEND-ONLY: backfill 後 headline == drill-down、sum(by_kind) < scalar", async () => {
    const eventsBefore = await eventCount(pool, BS);
    const preState = await readState(pool, BS);

    const result = await backfillRedactionCounts(pool, { apply: true, sessionId: BS });
    // 計画は BS の 1 件のみ・実際に 1 行更新・orphan/decrease なし。
    expect(result.plan.length).toBe(1);
    expect(result.plan[0]!.session_id).toBe(BS);
    expect(result.applied).toBe(1);
    expect(result.orphans.length).toBe(0);
    expect(result.decreases.length).toBe(0);

    const post = await readState(pool, BS);
    expect(post).toBeDefined();

    // headline == drill-down (各 known kind)。
    const aws = await audit.redactionOccurrences({
      sessionId: BS,
      kind: "aws-access-key-id",
      limit: 1000,
    });
    const gh = await audit.redactionOccurrences({
      sessionId: BS,
      kind: "github-token",
      limit: 1000,
    });
    expect(post!.secret_redaction_count_by_kind["aws-access-key-id"]).toBe(aws.total);
    expect(post!.secret_redaction_count_by_kind["github-token"]).toBe(gh.total);
    expect(post!.secret_redaction_count_by_kind["aws-access-key-id"]).toBe(3);
    expect(post!.secret_redaction_count_by_kind["github-token"]).toBe(1);

    // scalar = 全マーカー数 (aws 3 + github 1 + phantom 1 = 5)。
    expect(post!.secret_redaction_count).toBe(5);
    expect(post!.secret_detected).toBe(true);

    // INVARIANT: sum(by_kind) = 4 <= scalar = 5。phantom があるので strict (<)。
    const sumByKind = Object.values(post!.secret_redaction_count_by_kind).reduce(
      (a, b) => a + b,
      0,
    );
    expect(sumByKind).toBe(4);
    expect(sumByKind).toBeLessThan(post!.secret_redaction_count);

    // APPEND-ONLY: events 件数は不変。
    expect(await eventCount(pool, BS)).toBe(eventsBefore);
    // ADDITIVE-COLUMNS-ONLY: state 列は不触。
    expect(post!.state).toBe(preState!.state);
  });

  it("NO-RAW: session_state.by_kind は closed-enum kind + 件数のみ (生 secret / 未知 kind 名は載らない)", async () => {
    const post = await readState(pool, BS);
    const json = JSON.stringify(post!.secret_redaction_count_by_kind);
    expect(json).not.toContain(RAW_LEAK);
    expect(json).not.toContain("note_should_not_leak");
    expect(json).not.toContain(PHANTOM); // 未知 kind は by_kind に入らない。
    for (const k of Object.keys(post!.secret_redaction_count_by_kind)) {
      expect(isKnownRedactionKind(k)).toBe(true);
    }
  });

  it("IDEMPOTENT: 再実行は plan 空・applied 0・値不変", async () => {
    const before = await readState(pool, BS);
    const result = await backfillRedactionCounts(pool, { apply: true, sessionId: BS });
    expect(result.plan.length).toBe(0);
    expect(result.applied).toBe(0);
    const after = await readState(pool, BS);
    expect(after).toEqual(before);
  });

  it("ORPHAN-SAFE: session_state 行が無い session は更新せず報告のみ (INSERT しない)", async () => {
    // session_state 行を削除して orphan 化 (events は append-only ゆえ残る)。
    await pool.query(`DELETE FROM session_state WHERE session_id = $1`, [ORPHAN]);
    expect(await readState(pool, ORPHAN)).toBeUndefined();
    expect(await eventCount(pool, ORPHAN)).toBeGreaterThan(0);

    const result = await backfillRedactionCounts(pool, { apply: true, sessionId: ORPHAN });
    // orphan として報告・適用 0・session_state 行は再作成されない。
    expect(result.orphans.map((o) => o.session_id)).toContain(ORPHAN);
    expect(result.applied).toBe(0);
    expect(result.plan.length).toBe(0);
    expect(await readState(pool, ORPHAN)).toBeUndefined();
  });

  it("DECREASE-GUARD + MONOTONIC: fold>at-rest は既定で適用せず報告のみ・secret_detected は降格しない (TDA-1/QA-1)", async () => {
    const before = await readState(pool, DEC);
    expect(before!.secret_redaction_count_by_kind["github-token"]).toBe(5); // 宣言 fold
    expect(before!.secret_redaction_count).toBe(5);
    expect(before!.secret_detected).toBe(true);

    // 既定 (allowDecrease=false): 減少は plan 除外・decreases に報告・適用しない。
    const def = await backfillRedactionCounts(pool, { apply: true, sessionId: DEC });
    expect(def.decreases.map((d) => d.session_id)).toContain(DEC);
    expect(def.plan.length).toBe(0); // 減少は plan に入らない。
    expect(def.applied).toBe(0);
    const afterDefault = await readState(pool, DEC);
    expect(afterDefault).toEqual(before); // 無警告のカウント降格をしない (状態不変)。

    // allowDecrease=true: 適用するが secret_detected は単調に true を維持 (セキュリティ信号は降格しない)。
    const allow = await backfillRedactionCounts(pool, {
      apply: true,
      sessionId: DEC,
      allowDecrease: true,
    });
    expect(allow.plan.map((p) => p.session_id)).toContain(DEC);
    expect(allow.applied).toBe(1);
    const afterAllow = await readState(pool, DEC);
    expect(afterAllow!.secret_redaction_count).toBe(0); // at-rest ground truth (マーカー0)
    expect(afterAllow!.secret_redaction_count_by_kind).toEqual({});
    expect(afterAllow!.secret_detected).toBe(true); // MONOTONIC: 降格しない。
  });

  it("SQL-PARITY: regexp_count(scalar) と literal markerCountExpr(by_kind) が敵対的マーカーで整合 (TDA-2)", async () => {
    // PARITY fixture: known github×1/aws×2/jwt×1/cookie×1 (sum=5) + phantom×1 + truncated(非マーカー)。
    const re = await audit.rederiveRedactionCounts({ sessionId: PARITY });
    expect(re.length).toBe(1);
    const r = re[0]!;
    // by_kind は known closed-enum のみ (literal markerCountExpr 機構)。
    expect(r.byKind).toEqual({
      "github-token": 1,
      "aws-access-key-id": 2,
      jwt: 1,
      cookie: 1,
    });
    const sumByKind = Object.values(r.byKind).reduce((a, b) => a + b, 0);
    expect(sumByKind).toBe(5);
    // scalar は全マーカー (regexp_count 機構): known 5 + phantom 1 = 6。
    expect(r.scalar).toBe(6);
    // 2 機構の整合: 差は phantom 1 件ぴったり (regexp_count が known を多重計上していない)。
    expect(r.scalar - sumByKind).toBe(1);
    // 不変条件 sum(by_kind) <= scalar (phantom があるので strict)。
    expect(sumByKind).toBeLessThan(r.scalar);
    // drill-down (同一 markerCountExpr) と by_kind が一致 (機構統合の pin)。
    for (const kind of ["github-token", "aws-access-key-id", "jwt", "cookie"] as const) {
      const occ = await audit.redactionOccurrences({ sessionId: PARITY, kind, limit: 1000 });
      expect(occ.total).toBe(r.byKind[kind]);
    }
  });

  it("CHARSET: backend regexp_count が digit-kind マーカーを scalar に数える (TDA-2 single-source forward-drift gate)", async () => {
    // DIGIT fixture: [REDACTED:oauth2-token] (digit 含む unknown kind)。ALL_MARKERS_REGEX が
    // event-model 正典 source (charset⊇[0-9]) 由来なら scalar=1。backend だけ [a-z-]+ に狭めると
    // `2` で途切れ regexp_count 非マッチ → scalar=0 で赤化 (sidecar/backend の charset 単一化 pin)。
    const re = await audit.rederiveRedactionCounts({ sessionId: DIGIT });
    expect(re.length).toBe(1);
    expect(re[0]!.scalar).toBe(1); // 全マーカー regexp_count が digit-kind を捕捉
    expect(re[0]!.byKind).toEqual({}); // unknown kind は by_kind に入らない (closed-enum gate)
  });

  it("EMPTY: events を持たない session は plan 空・applied 0 (no-op)", async () => {
    const result = await backfillRedactionCounts(pool, { apply: true, sessionId: NONEXISTENT });
    expect(result.rederivedSessions).toBe(0);
    expect(result.plan.length).toBe(0);
    expect(result.orphans.length).toBe(0);
    expect(result.applied).toBe(0);
  });
});
