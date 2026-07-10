/**
 * INV-GEMINI-OBSERVABILITY (ADR 019f47c2): gemini の turn 依頼/応答要約が ingest→projection→DTO を
 * 通って **subject として surface** し、かつ要約中の dummy secret が **ingress redaction 床で redact
 * される** ことを REAL PG で end-to-end 検証する。
 *
 * これは「payload に載っただけ」で満たさない (task の明示要件): 実 backend の HTTP POST /ingest →
 * store.ingest (ingress redaction 無条件適用) → session_state 投影 (current_action_subject) →
 * ReplayStore DTO (subject / display) までを実 DB で辿り、
 *  (1) turn.started→prompt_summary / turn.completed→response_summary が subject に出る (対象なし にならない)、
 *  (2) at-rest (events.payload) にも DTO subject にも **raw dummy secret が現れない** (redaction 床)、
 *  (3) 「依頼:」「応答:」の可視テキストは保たれる (KPI「何をしているか」)、
 * を pin する。DB 未到達なら skip。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { newEventId } from "@actradeck/event-model";
import { MAX_REDACT_INPUT, MAX_VALUE_LEN, PRE_REDACT_SLICE } from "@actradeck/redaction";
import type { FastifyInstance } from "fastify";
import { Pool } from "pg";

import { mapHookEvent } from "../../../docs/examples/gemini-adapter/adapter.mjs";
import { buildIngestionServer } from "../src/ingestion-server.js";
import { ReplayStore } from "../src/replay-store.js";
import { cleanupSessions, dbReachable } from "./helpers.js";

const DATABASE_URL = process.env.DATABASE_URL;
const reachable = DATABASE_URL ? await dbReachable(DATABASE_URL) : false;
const TOKEN = "test-ingest-token-1234567890";

// dummy github-token (実鍵ではない・redaction 床が github-token として捕捉する形)。
const DUMMY_SECRET = "ghp_FAKE0abcdefghij0123456789ABCDEFghij";

// --- straddle 系テスト共通ヘルパ (TDA-1: intra-file の padTo/genB64 逐語重複を module scope へ集約) ---
// NOTE (TDA-1): packages/redaction/test/redactor.test.ts も同型ヘルパを持つが、cross-package の相対
//   test import は脆く smell ゆえ **意図的複製** (ReDoS 計測基盤と同じ documented duplication)。両コピー同期。
const B64_STD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
// base64url charset (JWT の [A-Za-z0-9_-]: `+/` を `-_` へ置換)。JWT fixture は必ず本 charset で生成。
const B64_URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function genChars(n: number, alphabet: string): string {
  let out = "";
  for (let i = 0; i < n; i++) out += alphabet[(i * 2654435761) % alphabet.length];
  return out;
}
// 決定的 3-class base64 / base64url (合成 dummy 鍵素材・実鍵ではない)。
function genB64(n: number): string {
  return genChars(n, B64_STD);
}
function genB64Url(n: number): string {
  return genChars(n, B64_URL);
}
// 非空白 filler をちょうど n 字で作り末尾を空白にする (summarize の trim/collapse で geometry が崩れない)。
function padTo(n: number, filler = "lo "): string {
  let s = "";
  while (s.length < n) s += filler;
  s = s.slice(0, n);
  if (s[s.length - 1] !== " ") s = s.slice(0, n - 1) + " ";
  return s;
}
// straddle geometry を床の定数から導出 (TDA-2: magic offset 258000/14000 を廃止・redactor と単一出所)。
const STRADDLE_SECRET_START = MAX_REDACT_INPUT - MAX_VALUE_LEN; // < MAX_REDACT_INPUT (display 窓内)
const STRADDLE_BODY_LEN = PRE_REDACT_SLICE - STRADDLE_SECRET_START + MAX_VALUE_LEN; // terminator > PRE_REDACT_SLICE

describe.skipIf(!reachable)(
  "INV-GEMINI-OBSERVABILITY: turn 要約が subject に出る + redaction 床 (real PG)",
  () => {
    let pool: Pool;
    let app: FastifyInstance;
    let replay: ReplayStore;
    const sessions: string[] = [];

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
      app = await buildIngestionServer({ pool, ingestToken: TOKEN, maxPayloadBytes: 64 * 1024 });
      replay = new ReplayStore(pool);
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

    async function post(payload: unknown): Promise<void> {
      const res = await app.inject({
        method: "POST",
        url: "/ingest",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: payload as object,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { results: { ok: boolean }[] };
      for (const r of body.results) expect(r.ok).toBe(true);
    }

    it("gemini turn.started/completed の依頼/応答要約が subject に surface し dummy secret は at-rest/DTO で redact される", async () => {
      const sid = newSession("gemini_obs");
      const promptSummary = `依頼: run echo and use ${DUMMY_SECRET} to deploy`;
      const responseSummary = `応答: I used ${DUMMY_SECRET} then reported the result`;

      // source=external / provider=gemini の直 POST (adapter と同型・capture_mode 省略)。
      const started = {
        event_id: newEventId(),
        provider: "gemini",
        source: "external",
        session_id: sid,
        provider_session_id: sid,
        event_type: "turn.started",
        state: "running.model_wait",
        timestamp: "2026-07-09T08:00:00.000Z",
        summary: promptSummary,
        payload: { kind: "turn.started", prompt_summary: promptSummary },
      };
      const completed = {
        event_id: newEventId(),
        provider: "gemini",
        source: "external",
        session_id: sid,
        provider_session_id: sid,
        event_type: "turn.completed",
        state: "idle",
        timestamp: "2026-07-09T08:00:05.000Z",
        summary: responseSummary,
        payload: { kind: "turn.completed", response_summary: responseSummary },
      };
      await post([started, completed]);

      // ── (2a) at-rest (events.payload): raw secret 不在・redaction マーカー在 ──
      const { rows: evRows } = await pool.query<{
        event_type: string;
        prompt_summary: string | null;
        response_summary: string | null;
      }>(
        `SELECT event_type,
              payload->>'prompt_summary'   AS prompt_summary,
              payload->>'response_summary' AS response_summary
         FROM events WHERE session_id = $1 ORDER BY timestamp ASC`,
        [sid],
      );
      expect(evRows.length).toBe(2);
      const atRestStarted = evRows.find((r) => r.event_type === "turn.started")!;
      const atRestCompleted = evRows.find((r) => r.event_type === "turn.completed")!;
      // 要約は永続しているが secret は marker 化 (依頼/応答の可視テキストは保たれる)。
      expect(atRestStarted.prompt_summary).toContain("依頼:");
      expect(atRestStarted.prompt_summary).toContain("[REDACTED:github-token]");
      expect(atRestStarted.prompt_summary).not.toContain(DUMMY_SECRET);
      expect(atRestCompleted.response_summary).toContain("応答:");
      expect(atRestCompleted.response_summary).toContain("[REDACTED:github-token]");
      expect(atRestCompleted.response_summary).not.toContain(DUMMY_SECRET);
      // event 行全体を走査しても raw secret はどこにも無い。
      const { rows: rawScan } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM events
        WHERE session_id = $1 AND to_jsonb(events.*)::text LIKE '%' || $2 || '%'`,
        [sid, DUMMY_SECRET],
      );
      expect(rawScan[0]!.n).toBe(0);

      // ── (1)+(3) DTO subject: 対象なし にならず 依頼/応答が出る・raw secret 不在 ──
      const page = await replay.eventsPage({ sessionId: sid });
      const dtoStarted = page.events.find((e) => e.event_type === "turn.started")!;
      const dtoCompleted = page.events.find((e) => e.event_type === "turn.completed")!;
      // subject が非空 (「(対象なし)」回避) かつ prompt/response 要約由来。
      expect(dtoStarted.subject).toBeTruthy();
      expect(dtoStarted.subject).toContain("依頼:");
      expect(dtoCompleted.subject).toBeTruthy();
      expect(dtoCompleted.subject).toContain("応答:");
      // DTO subject にも raw secret は無い (redacted allowlist 由来)。
      expect(dtoStarted.subject).not.toContain(DUMMY_SECRET);
      expect(dtoCompleted.subject).not.toContain(DUMMY_SECRET);
      expect(JSON.stringify(page.events)).not.toContain(DUMMY_SECRET);

      // ── (1) session_state.current_action_subject: 最新 (turn.completed) の応答要約が投影される ──
      const { rows: ssRows } = await pool.query<{ current_action_subject: string | null }>(
        `SELECT current_action_subject FROM session_state WHERE session_id = $1`,
        [sid],
      );
      expect(ssRows.length).toBe(1);
      expect(ssRows[0]!.current_action_subject).toBeTruthy();
      expect(ssRows[0]!.current_action_subject).toContain("応答:");
      expect(ssRows[0]!.current_action_subject).not.toContain(DUMMY_SECRET);
    });
  },
);

/**
 * INV-REDACTION-SUMMARY-STRADDLE (SEC-1・ADR 019f47c2 CONDITIONAL 019f47f0 unblock):
 *   truncate-before-redact の境界 straddle leak を real PG で反証する。gemini adapter が prompt/response を
 *   **表示 bound で raw を切詰めてから** backend ingress redaction 床が redact する順序だと、secret の頭が
 *   bound 内に入り尾が切られたとき残った prefix が redaction ルールの最小長 (github {20,255} / high-entropy
 *   {40,}) を下回り床が非マッチ → **raw partial fragment が at-rest 残存**する (INV-REDACTION(P0) 違反)。
 *
 * 本テストは **実 adapter (`docs/examples/gemini-adapter/adapter.mjs` の mapHookEvent)** を通し、
 * secret を **表示 bound (=旧 200) を跨ぐ複数の位置・複数 kind** で置いて実 `/ingest` (source=external) に流し、
 *   (A) `to_jsonb(events.*)` 全行走査で raw fragment (prefix ≥ 8 字) が **0**、
 *   (B) `events.payload->>'prompt_summary'/'response_summary'` に raw fragment 0・redaction マーカー在、
 *   (C) `session_state.current_action_subject` に raw fragment 0、
 *   (D) ReplayStore DTO subject に raw fragment 0 かつ **有界 (≤~220)**、
 * を assert する。**8549bc4 (adapter が 200 で truncate してから床) で RED / redact-before-truncate 修正後で
 * GREEN** を byte 実証する契約テスト。
 *
 * 有界化は「床の後 (redacted 値に対して projection deriveActionSubject が slice)」で担保する
 *   (adapter は secret を分割しない sanity-cap のみ)。parseEvent は payload を looseObject passthrough する
 *   ため payload の zod transform は走らない → 有界化は共有 deriveActionSubject に置く (D の bound で pin)。
 */
describe.skipIf(!reachable)(
  "INV-REDACTION-SUMMARY-STRADDLE: 表示 bound を跨ぐ secret が床の後で raw 0 (real PG)",
  () => {
    let pool: Pool;
    let app: FastifyInstance;
    let replay: ReplayStore;
    const sessions: string[] = [];

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
      app = await buildIngestionServer({ pool, ingestToken: TOKEN, maxPayloadBytes: 256 * 1024 });
      replay = new ReplayStore(pool);
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

    // padTo は module scope の共通ヘルパを使う (TDA-1)。

    // 合成 dummy secret のみ (実鍵ではない)。github(39) / high-entropy(44)。
    const GH = "ghp_FAKE0abcdefghij0123456789ABCDEFghij"; // 39 字・github-token {20,255}
    const HE = "Zk9fP2mQ7xR4tW1nB6vC3jL8sH5dG0aY2eU4iO7pQw3B"; // 44 字・high-entropy {40,}

    // secret の raw prefix (≥ len) が対象文字列に残っていないか (8 字以上を漏洩とみなす)。
    function longestRawPrefix(haystack: string, secret: string): number {
      for (let L = secret.length; L >= 4; L--) {
        if (haystack.includes(secret.slice(0, L))) return L;
      }
      return 0;
    }

    async function postHooks(hooks: unknown[]): Promise<void> {
      const events = hooks.flatMap((h) => mapHookEvent(h));
      const res = await app.inject({
        method: "POST",
        url: "/ingest",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: events as object,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { results: { ok: boolean }[] };
      for (const r of body.results) expect(r.ok).toBe(true);
    }

    it("(A/B/C) github token が表示 bound (185) を跨いでも 3 層すべてで raw fragment 0", async () => {
      const sid = newSession("straddle_gh");
      // BeforeAgent.prompt に github token を start=185 で置く (旧 200-cap だと token 尾が切られ 15 字 < 20 残留)。
      await postHooks([
        {
          session_id: sid,
          hook_event_name: "BeforeAgent",
          prompt: padTo(185) + GH,
          timestamp: "2026-07-10T09:00:00.000Z",
          cwd: "/tmp/straddle",
        },
      ]);

      // (B) events.payload->>'prompt_summary'
      const { rows: ev } = await pool.query<{ ps: string | null }>(
        `SELECT payload->>'prompt_summary' AS ps FROM events WHERE session_id=$1 AND event_type='turn.started'`,
        [sid],
      );
      expect(ev.length).toBe(1);
      const ps = ev[0]!.ps ?? "";
      expect(
        longestRawPrefix(ps, GH),
        `prompt_summary に github raw prefix 残留: ${ps.slice(-40)}`,
      ).toBeLessThan(8);
      expect(ps).toContain("[REDACTED:github-token]");

      // (A) to_jsonb(events.*) 全行走査 (summary 列 + payload 込み) で raw prefix 0。
      for (const L of [39, 20, 15, 12, 8]) {
        const frag = GH.slice(0, L);
        const { rows } = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM events WHERE session_id=$1 AND to_jsonb(events.*)::text LIKE '%'||$2||'%'`,
          [sid, frag],
        );
        expect(rows[0]!.n, `to_jsonb(events.*) に raw prefix(${L})="${frag}" が残留`).toBe(0);
      }

      // (C) session_state.current_action_subject
      const { rows: ss } = await pool.query<{ current_action_subject: string | null }>(
        `SELECT current_action_subject FROM session_state WHERE session_id=$1`,
        [sid],
      );
      expect(ss.length).toBe(1);
      const cas = ss[0]!.current_action_subject ?? "";
      expect(
        longestRawPrefix(cas, GH),
        `current_action_subject に raw 残留: ${cas.slice(-40)}`,
      ).toBeLessThan(8);

      // (D) DTO subject: raw 0 かつ非空 (subject が出る)。
      const page = await replay.eventsPage({ sessionId: sid });
      const dto = page.events.find((e) => e.event_type === "turn.started")!;
      expect(dto.subject).toBeTruthy();
      expect(longestRawPrefix(String(dto.subject ?? ""), GH)).toBeLessThan(8);
      expect(JSON.stringify(page.events)).not.toContain(GH.slice(0, 15));
    });

    it("(A/B/C) high-entropy 44 字 secret が response の bound (170) を跨いでも 3 層すべてで raw fragment 0", async () => {
      const sid = newSession("straddle_he");
      await postHooks([
        {
          session_id: sid,
          hook_event_name: "AfterAgent",
          prompt_response: padTo(170) + HE,
          timestamp: "2026-07-10T09:01:00.000Z",
          cwd: "/tmp/straddle",
        },
      ]);

      const { rows: ev } = await pool.query<{ rs: string | null }>(
        `SELECT payload->>'response_summary' AS rs FROM events WHERE session_id=$1 AND event_type='turn.completed'`,
        [sid],
      );
      expect(ev.length).toBe(1);
      const rs = ev[0]!.rs ?? "";
      expect(
        longestRawPrefix(rs, HE),
        `response_summary に high-entropy raw 残留: ${rs.slice(-50)}`,
      ).toBeLessThan(8);
      expect(rs).toContain("[REDACTED:");

      for (const L of [44, 40, 30, 20, 12, 8]) {
        const frag = HE.slice(0, L);
        const { rows } = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM events WHERE session_id=$1 AND to_jsonb(events.*)::text LIKE '%'||$2||'%'`,
          [sid, frag],
        );
        expect(rows[0]!.n, `to_jsonb(events.*) に high-entropy raw prefix(${L}) が残留`).toBe(0);
      }

      const { rows: ss } = await pool.query<{ current_action_subject: string | null }>(
        `SELECT current_action_subject FROM session_state WHERE session_id=$1`,
        [sid],
      );
      const cas = ss[0]!.current_action_subject ?? "";
      expect(longestRawPrefix(cas, HE)).toBeLessThan(8);

      const page = await replay.eventsPage({ sessionId: sid });
      const dto = page.events.find((e) => e.event_type === "turn.completed")!;
      expect(longestRawPrefix(String(dto.subject ?? ""), HE)).toBeLessThan(8);
    });

    it("(D) 表示 subject は床の後で有界 (≤~220)・adapter が small-cap を捨てても projection が再有界化する", async () => {
      const sid = newSession("straddle_bound");
      // secret 無しの長文 (> 500 字) を prompt に。adapter は sanity-cap のみで truncate しない → 床通過後の
      //   payload は長いまま。projection deriveActionSubject が subject を bound へ slice する (post-floor)。
      const longPrompt = "step ".repeat(200); // 1000 字
      await postHooks([
        {
          session_id: sid,
          hook_event_name: "BeforeAgent",
          prompt: longPrompt,
          timestamp: "2026-07-10T09:02:00.000Z",
          cwd: "/tmp/straddle",
        },
      ]);

      // current_action_subject は有界 (projection slice)。
      const { rows: ss } = await pool.query<{ current_action_subject: string | null }>(
        `SELECT current_action_subject FROM session_state WHERE session_id=$1`,
        [sid],
      );
      const cas = ss[0]!.current_action_subject ?? "";
      expect(
        cas.length,
        `current_action_subject が有界化されていない (${cas.length} 字)`,
      ).toBeLessThanOrEqual(220);

      // DTO subject も有界 (subjectOf → 同一 deriveActionSubject)。
      const page = await replay.eventsPage({ sessionId: sid });
      const dto = page.events.find((e) => e.event_type === "turn.started")!;
      expect(
        String(dto.subject ?? "").length,
        "DTO subject が有界化されていない",
      ).toBeLessThanOrEqual(220);

      // DTO summary / display_text も有界 (turn 経路の DTO 搬送 bound・gemini-obs SEC-3=TDA-3)。
      //   at-rest の redacted summary は uncapped (この fixture では 1000 字超) のまま着地するが、
      //   rowToReplayEvent が boundTurnSummary (200+…) で搬送有界化する (unbounded 搬送を省く)。
      expect(
        String(dto.summary ?? "").length,
        "DTO summary が有界化されていない (turn 経路の unbounded 搬送)",
      ).toBeLessThanOrEqual(220);
      expect(
        dto.display_text.length,
        "DTO display_text が有界化されていない (turn 経路の unbounded 搬送)",
      ).toBeLessThanOrEqual(220);
    });
  },
);

/**
 * INV-REDACTION-PEM-STRADDLE (SEC-2・ADR 019f482a / task 019f482c-0904):
 *   MAX_REDACT_INPUT / PRE_REDACT_SLICE 境界を跨ぐ **巨大 PEM private-key** が、実 adapter →
 *   実 `/ingest` (source=external) → 実 PG の床を通って **raw fragment 0** で at-rest に着地することを
 *   real PG で反証する (単体は packages/redaction/test/redactor.test.ts の同名 describe)。
 *
 * 旧 private-key ルールは literal `-----END-----` terminator 依存で、床の先行 slice (PRE_REDACT_SLICE)
 *   が terminator を切り落とすと match 全体が失敗し、露出した base64 本体が high-entropy にもマッチせず
 *   **raw 鍵本体が events.payload に残存**した (SEC 監査 abf34765・単一行本体 PEM で raw 616 字)。
 *   修正 (approach b: terminator 欠落時 head→window 末尾 greedy マスク) 後は raw 0。
 *
 * adapter の summarize は空白畳み + trim + sanity-cap(512KiB) のみで secret を分割しないため、
 *   PEM は床が全体を見る (床の redactString が PRE_REDACT_SLICE へ slice → rules → MAX_REDACT_INPUT へ slice)。
 *   payload は 256KiB を超える (BEGIN を STRADDLE_SECRET_START = MAX_REDACT_INPUT - MAX_VALUE_LEN に
 *   置き END を PRE_REDACT_SLICE 超へ) ため、本 describe は専用に maxPayloadBytes を 768KiB へ広げた
 *   ingestion server を使う (他 describe の 256KiB とは別 app)。
 */
describe.skipIf(!reachable)(
  "INV-REDACTION-PEM-STRADDLE: 境界跨ぎ巨大 PEM private-key が床の後で raw 0 (real PG)",
  () => {
    let pool: Pool;
    let app: FastifyInstance;
    let replay: ReplayStore;
    const sessions: string[] = [];

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
      // PEM straddle は payload > 256KiB を要する (BEGIN<MAX_REDACT_INPUT かつ END>PRE_REDACT_SLICE)。
      app = await buildIngestionServer({ pool, ingestToken: TOKEN, maxPayloadBytes: 768 * 1024 });
      replay = new ReplayStore(pool);
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

    // padTo / genB64 / STRADDLE_* は module scope の共通ヘルパを使う (TDA-1/TDA-2)。

    it("(A/B/C/D) 単一行本体 PEM が MAX_REDACT_INPUT を跨いでも 3 層 + DTO すべてで raw fragment 0", async () => {
      const sid = newSession("pem_straddle");
      const header = "-----BEGIN RSA PRIVATE KEY----- ";
      const body = genB64(STRADDLE_BODY_LEN); // 単一行連続 run
      // BEGIN を MAX_REDACT_INPUT 手前 (STRADDLE_SECRET_START) へ、END を PRE_REDACT_SLICE 超へ (旧床は body raw 残存)。
      const prompt =
        padTo(STRADDLE_SECRET_START) + header + body + " -----END RSA PRIVATE KEY-----";

      const events = mapHookEvent({
        session_id: sid,
        hook_event_name: "BeforeAgent",
        prompt,
        timestamp: "2026-07-10T10:00:00.000Z",
        cwd: "/tmp/pem",
      });
      const res = await app.inject({
        method: "POST",
        url: "/ingest",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: events as object,
      });
      expect(res.statusCode).toBe(200);
      const rbody = res.json() as { results: { ok: boolean }[] };
      for (const r of rbody.results) expect(r.ok).toBe(true);

      // (B) events.payload->>'prompt_summary' に private-key マーカー在・body raw 断片 0。
      const { rows: ev } = await pool.query<{ ps: string | null }>(
        `SELECT payload->>'prompt_summary' AS ps FROM events WHERE session_id=$1 AND event_type='turn.started'`,
        [sid],
      );
      expect(ev.length).toBe(1);
      const ps = ev[0]!.ps ?? "";
      expect(ps).toContain("[REDACTED:private-key]");

      // (A) to_jsonb(events.*) 全行走査で body の生断片 (表示窓に露出しうる複数箇所) が 0。
      for (const off of [0, 1000, 2000, 4000]) {
        const frag = body.slice(off, off + 32);
        const { rows } = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM events WHERE session_id=$1 AND to_jsonb(events.*)::text LIKE '%'||$2||'%'`,
          [sid, frag],
        );
        expect(rows[0]!.n, `to_jsonb(events.*) に PEM body raw 断片(off=${off}) が残留`).toBe(0);
      }

      // (C) session_state.current_action_subject に body raw 断片 0。
      const { rows: ss } = await pool.query<{ current_action_subject: string | null }>(
        `SELECT current_action_subject FROM session_state WHERE session_id=$1`,
        [sid],
      );
      const cas = ss[0]?.current_action_subject ?? "";
      expect(cas.includes(body.slice(0, 16))).toBe(false);

      // (D) ReplayStore DTO (subject / summary / display_text 込みの全 events DTO) に body raw 断片 0
      //   (JWT straddle 側の D 層と parity・TDA-3r backfill)。
      const page = await replay.eventsPage({ sessionId: sid });
      expect(JSON.stringify(page.events).includes(body.slice(0, 16))).toBe(false);
    });
  },
);

/**
 * INV-REDACTION-JWT-STRADDLE (SEC-1・task 019f4c0d / decision 019f4c09):
 *   MAX_REDACT_INPUT / PRE_REDACT_SLICE 境界を跨ぐ **長尺 JWT** (header.payload.signature) が、実 adapter →
 *   実 `/ingest` (source=external) → 実 PG の床を通って **raw payload 断片 0** で at-rest に着地することを
 *   real PG で反証する (単体は packages/redaction/test/redactor.test.ts の同名 describe)。
 *
 * 旧 jwt ルールは無界 `{8,}` セグメント + 必須 literal `.` delimiter 依存で、床の先行 slice (PRE_REDACT_SLICE)
 *   が 2 個目の `.` + signature を切り落とすと 3-segment match が全体失敗し、露出した raw payload が
 *   high-entropy にもマッチせず **raw payload が events.payload に残存**した (private-key と同型・実 PG で raw
 *   ~4117 字)。修正 (approach b: `eyJ...\.eyJ` anchor 後 head→window 末尾 greedy マスク) 後は raw 0。
 *
 * payload は 256KiB を超える (JWT start を STRADDLE_SECRET_START に置き 2 個目の `.` を PRE_REDACT_SLICE 超へ)
 *   ため、本 describe は専用に maxPayloadBytes を 768KiB へ広げた ingestion server を使う。3 層 (to_jsonb /
 *   current_action_subject / DTO subject) + prompt_summary marker で raw payload 断片 0 を pin する。
 */
describe.skipIf(!reachable)(
  "INV-REDACTION-JWT-STRADDLE: 境界跨ぎ長尺 JWT が床の後で raw 0 (real PG)",
  () => {
    let pool: Pool;
    let app: FastifyInstance;
    let replay: ReplayStore;
    const sessions: string[] = [];

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
      // JWT straddle は payload > 256KiB を要する (JWT start < MAX_REDACT_INPUT かつ 2nd dot > PRE_REDACT_SLICE)。
      app = await buildIngestionServer({ pool, ingestToken: TOKEN, maxPayloadBytes: 768 * 1024 });
      replay = new ReplayStore(pool);
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

    it("(A/B/C/D) 長尺 JWT が MAX_REDACT_INPUT を跨いでも 3 層 + DTO すべてで raw payload 断片 0", async () => {
      const sid = newSession("jwt_straddle");
      // header (eyJ + base64url + .) を STRADDLE_SECRET_START へ、payload を大きく取り 2 個目の `.` を
      //   PRE_REDACT_SLICE 超へ落とす。payload body (claims) が秘匿対象の raw。
      const header = "eyJ" + genB64Url(30) + ".";
      const payloadBody = genB64Url(STRADDLE_BODY_LEN);
      const prompt =
        padTo(STRADDLE_SECRET_START) + header + "eyJ" + payloadBody + "." + genB64Url(40);
      // 前提: JWT start は display 窓内、2 個目の `.` は pre-redact 窓外 (straddle 成立)。
      const jwtStart = prompt.indexOf("eyJ");
      const secondDot = prompt.indexOf(".", jwtStart + header.length + 3);
      expect(jwtStart).toBeLessThan(MAX_REDACT_INPUT);
      expect(secondDot).toBeGreaterThan(PRE_REDACT_SLICE);

      const events = mapHookEvent({
        session_id: sid,
        hook_event_name: "BeforeAgent",
        prompt,
        timestamp: "2026-07-10T10:00:00.000Z",
        cwd: "/tmp/jwt",
      });
      const res = await app.inject({
        method: "POST",
        url: "/ingest",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: events as object,
      });
      expect(res.statusCode).toBe(200);
      const rbody = res.json() as { results: { ok: boolean }[] };
      for (const r of rbody.results) expect(r.ok).toBe(true);

      // (B) events.payload->>'prompt_summary' に jwt マーカー在・payload raw 断片 0。
      const { rows: ev } = await pool.query<{ ps: string | null }>(
        `SELECT payload->>'prompt_summary' AS ps FROM events WHERE session_id=$1 AND event_type='turn.started'`,
        [sid],
      );
      expect(ev.length).toBe(1);
      const ps = ev[0]!.ps ?? "";
      expect(ps).toContain("[REDACTED:jwt]");
      expect(ps.includes(payloadBody.slice(0, 16))).toBe(false);

      // (A) to_jsonb(events.*) 全行走査で payload の生断片 (表示窓に露出しうる複数箇所) が 0。
      for (const off of [0, 1000, 2000, 4000]) {
        const frag = payloadBody.slice(off, off + 32);
        const { rows } = await pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM events WHERE session_id=$1 AND to_jsonb(events.*)::text LIKE '%'||$2||'%'`,
          [sid, frag],
        );
        expect(rows[0]!.n, `to_jsonb(events.*) に JWT payload raw 断片(off=${off}) が残留`).toBe(0);
      }

      // (C) session_state.current_action_subject に payload raw 断片 0。
      const { rows: ss } = await pool.query<{ current_action_subject: string | null }>(
        `SELECT current_action_subject FROM session_state WHERE session_id=$1`,
        [sid],
      );
      const cas = ss[0]?.current_action_subject ?? "";
      expect(cas.includes(payloadBody.slice(0, 16))).toBe(false);

      // (D) ReplayStore DTO subject に payload raw 断片 0。
      const page = await replay.eventsPage({ sessionId: sid });
      expect(JSON.stringify(page.events).includes(payloadBody.slice(0, 16))).toBe(false);
    });
  },
);
