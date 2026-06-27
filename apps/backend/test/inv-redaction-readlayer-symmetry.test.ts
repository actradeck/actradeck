/**
 * INV-REDACTION-READLAYER-SYMMETRY (SEC-1r) — task 019ec752 / 強み(a)③ defense-in-depth。
 *
 * 背景: redaction の "種類 (kind)" closed-enum 契約は **write-choke**
 *   (projection `mergeRedactionCountByKind` の incoming gate) で守られている。しかし read/carry 層
 *   — `parseRedactionCountByKind` (ingest-store: fold の prev 入力 / no-op 返却 projection の素) /
 *   `toRedactionCountByKind` (realtime-store: SessionDetail DTO → WS の最終面) /
 *   `mergeRedactionCountByKind` の prev コピー — が key を gate しないと、
 *   (a) 第二 writer 追加 (b) ops backfill / 手動 SQL (c) restore-from-backup (d) gate デプロイ前の
 *   既存行 のいずれかで session_state jsonb に紛れた **phantom kind** が、read 経路を素通りして
 *   security 可視化 DTO/WS へ「秘匿の種類」として恒久 launder される (SEC-3 と同型の transitive 死角)。
 *
 * 本 INV は write-choke と read/carry を **同一の closed-enum allowlist (REDACTION_KINDS_SET)** で
 * 対称化したことを固定する。phantom kind を (純) prev projection / (real-PG) session_state へ
 * **直接 seed** し、read 3 経路すべてで除外されることを assert する。
 *
 * falsifiable: 3 read/carry 関数いずれかの key gate (`REDACTION_KINDS_SET.has(k)`) を外すと赤化する。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyEvent, initialProjection, type SessionProjection } from "@actradeck/projection";
import { Pool } from "pg";

import { IngestStore } from "../src/ingest-store.js";
import { RealtimeStore } from "../src/realtime-store.js";
import { cleanupSessions, dbReachable, makeEvent } from "./helpers.js";

const PHANTOM = "phantom-evil-kind"; // 正典語彙 (REDACTION_KINDS) に無い偽の "種類"。
const KNOWN = "github-token"; // 正典語彙に在る既知 kind。

describe("INV-REDACTION-READLAYER-SYMMETRY: merge の prev は closed-enum で gate される (純関数)", () => {
  it("prev jsonb に紛れた phantom kind を fold で持ち越さない (write-choke と対称)", () => {
    // prev = DB 由来の永続 projection を模す。known + phantom + prototype 名 key を仕込む。
    const prev: SessionProjection = {
      ...initialProjection("s-pure"),
      state: "running.model_wait",
      last_event_id: "e0",
      secret_detected: true,
      secret_redaction_count: 2,
      // phantom / prototype 名 key は write-choke を経ずに jsonb へ入った想定 (ops backfill 等)。
      secret_redaction_count_by_kind: { [KNOWN]: 2, [PHANTOM]: 9, constructor: 7 },
    };
    // incoming に state を載せない (incoming === undefined 経路) ことで遷移検証を避けつつ
    //   baseNext の by-kind merge を発火させる。known を +1 する。
    const ev = makeEvent({
      session_id: "s-pure",
      redaction_count: 1,
      redaction_count_by_kind: { [KNOWN]: 1 },
    });

    const out = applyEvent(prev, ev).projection.secret_redaction_count_by_kind;

    // known のみ持ち越され合算される。phantom / constructor は prev コピーから除外。
    expect(out).toEqual({ [KNOWN]: 3 });
    expect(Object.prototype.hasOwnProperty.call(out, PHANTOM)).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(out, "constructor")).toBe(false);
  });
});

const DATABASE_URL = process.env.DATABASE_URL;
const reachable = DATABASE_URL ? await dbReachable(DATABASE_URL) : false;

describe.skipIf(!reachable)(
  "INV-REDACTION-READLAYER-SYMMETRY: session_state jsonb の phantom kind を read 層が除外する (real Postgres)",
  () => {
    let pool: Pool;
    const sessions: string[] = [];

    beforeAll(() => {
      pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
    });

    afterAll(async () => {
      if (pool) {
        await cleanupSessions(pool, sessions);
        await pool.end();
      }
    });

    function newSession(prefix: string): string {
      const sid = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      sessions.push(sid);
      return sid;
    }

    // ops backfill / restore-from-backup / 第二 writer を模し、jsonb へ phantom を直接注入する。
    async function injectPhantom(sid: string): Promise<void> {
      await pool.query(
        `UPDATE session_state
           SET secret_redaction_count_by_kind = $2::jsonb
         WHERE session_id = $1`,
        [sid, JSON.stringify({ [KNOWN]: 2, [PHANTOM]: 9 })],
      );
    }

    it("realtime DTO (toRedactionCountByKind) が phantom kind を落とす", async () => {
      const store = new IngestStore({ pool });
      const sid = newSession("sess_readlayer_dto");
      // 正規経路で known kind を 1 つ確立 → session_state 行を作る。
      await store.ingest(
        makeEvent({
          session_id: sid,
          state: "running.model_wait",
          event_type: "heartbeat",
          redaction_count: 2,
          redaction_count_by_kind: { [KNOWN]: 2 },
        }),
      );
      await injectPhantom(sid); // jsonb に phantom を直接混入。

      const detail = await new RealtimeStore(pool).detail(sid);
      expect(detail?.secret_redaction_count_by_kind).toEqual({ [KNOWN]: 2 });
      expect(
        Object.prototype.hasOwnProperty.call(detail!.secret_redaction_count_by_kind ?? {}, PHANTOM),
      ).toBe(false);
    });

    it("次の ingest 再投影 (parseRedactionCountByKind + merge prev) が phantom を恒久 scrub する", async () => {
      const store = new IngestStore({ pool });
      const sid = newSession("sess_readlayer_carry");
      await store.ingest(
        makeEvent({
          session_id: sid,
          state: "running.model_wait",
          event_type: "heartbeat",
          redaction_count: 2,
          redaction_count_by_kind: { [KNOWN]: 2 },
        }),
      );
      await injectPhantom(sid); // jsonb に phantom を直接混入。

      // 新規イベントを 1 件投入 → readProjection(prev) → merge fold → 再永続。
      await store.ingest(
        makeEvent({
          session_id: sid,
          state: "running.command_executing",
          event_type: "command.started",
          payload: { kind: "command.started", command: "npm test" },
          redaction_count: 1,
          redaction_count_by_kind: { [KNOWN]: 1 },
        }),
      );

      const { rows } = await pool.query<{ secret_redaction_count_by_kind: unknown }>(
        `SELECT secret_redaction_count_by_kind FROM session_state WHERE session_id = $1`,
        [sid],
      );
      const persisted = rows[0]?.secret_redaction_count_by_kind as Record<string, number>;
      // known は合算 (2+1=3)。phantom は read 層 (parse) + merge prev フィルタで永続から消える。
      expect(persisted[KNOWN]).toBe(3);
      expect(Object.prototype.hasOwnProperty.call(persisted, PHANTOM)).toBe(false);
    });
  },
);
