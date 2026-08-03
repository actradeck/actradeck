/**
 * INV-WORKITEMS-WIRING (ADR 0015 §D4・受入14 backend 側, REAL PostgreSQL)。
 *
 * backend の増分 work_items 投影 wiring を実 PG で検証する (REAL DATA ONLY: モック DB 無し):
 *  - 受入14 (fold parity): ingest 後の work_items テーブル行 == `reduceWorkItems` を同一
 *    canonical イベント列へ適用した結果 (増分 == 一括)。
 *  - 冪等: 同一 event_id 再送で work_items を二重 fold しない (inserted ゲート整合)。
 *  - lazy 再 fold: 新 IngestStore (空キャッシュ = backend 再起動相当) が、当該 session の
 *    work-relevant イベント到着時に events から transient fold 状態 (claim / tree_fp / pending_check)
 *    を再構成し、テーブルを正しく継続更新する (migration 追加なしの rebuild-from-events)。
 *  - gate: work-relevant でないイベントは work_items 行を作らない (zero-cost skip)。
 *
 * DB 未到達なら describe.skipIf で skip (CI では実走必須。silent green 禁止)。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { reduceWorkItems, type WorkItem } from "@actradeck/projection";
import type { NormalizedEvent } from "@actradeck/event-model";
import { Pool } from "pg";

import { IngestStore } from "../src/ingest-store.js";
import { cleanupSessions, dbReachable, iso, makeEvent } from "./helpers.js";

const DATABASE_URL = process.env.DATABASE_URL;
const reachable = DATABASE_URL ? await dbReachable(DATABASE_URL) : false;

interface WorkItemRow {
  work_item_id: string;
  id_scheme: string | null;
  subject: string | null;
  status: string;
  ordinal: number | null;
  claimed_at: Date | null;
  claim_event_id: string | null;
  verification_state: string;
  verified_at: Date | null;
  check_kind: string | null;
  check_exit_code: number | null;
  verified_tree_fp: string | null;
  run_dirty: boolean;
  stale_at: Date | null;
}

function msOrNull(d: Date | null): number | null {
  return d === null ? null : d.getTime();
}
function isoMsOrNull(s: string | undefined): number | null {
  return s === undefined ? null : new Date(s).getTime();
}

describe.skipIf(!reachable)("INV-WORKITEMS-WIRING (real Postgres)", () => {
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

  async function fetchRows(sid: string): Promise<Map<string, WorkItemRow>> {
    const { rows } = await pool.query<WorkItemRow>(
      `SELECT work_item_id, id_scheme, subject, status, ordinal, claimed_at, claim_event_id,
              verification_state, verified_at, check_kind, check_exit_code, verified_tree_fp,
              run_dirty, stale_at
         FROM work_items WHERE session_id = $1`,
      [sid],
    );
    return new Map(rows.map((r) => [r.work_item_id, r]));
  }

  /** テーブル行 == fold item の主要フィールド一致を assert (受入14)。 */
  function assertParity(rows: Map<string, WorkItemRow>, items: readonly WorkItem[]): void {
    expect(rows.size).toBe(items.length);
    for (const it of items) {
      const row = rows.get(it.work_item_id);
      expect(row, `row for ${it.work_item_id}`).toBeDefined();
      if (!row) continue;
      expect(row.id_scheme).toBe(it.id_scheme);
      expect(row.status).toBe(it.status);
      expect(row.ordinal).toBe(it.ordinal ?? null);
      expect(row.verification_state).toBe(it.verification_state);
      expect(row.check_kind).toBe(it.check_kind ?? null);
      expect(row.check_exit_code).toBe(it.check_exit_code ?? null);
      expect(row.verified_tree_fp).toBe(it.verified_tree_fp ?? null);
      expect(row.run_dirty).toBe(it.run_dirty);
      expect(msOrNull(row.claimed_at)).toBe(isoMsOrNull(it.claimed_at));
      expect(msOrNull(row.verified_at)).toBe(isoMsOrNull(it.verified_at));
      expect(msOrNull(row.stale_at)).toBe(isoMsOrNull(it.stale_at));
    }
  }

  const base = Date.UTC(2026, 7, 3, 12, 0, 0);

  function planCompleted(sid: string, offset: number): NormalizedEvent {
    return makeEvent({
      session_id: sid,
      event_type: "turn.plan.updated",
      state: "running.planning",
      timestamp: iso(base, offset),
      payload: {
        kind: "turn.plan.updated",
        items: [{ step: "build feature", status: "completed" }],
        steps: ["build feature"],
      },
    });
  }

  it("受入14: incremental work_items table == reduceWorkItems over the same canonical events", async () => {
    const store = new IngestStore({ pool });
    const sid = newSession("wi_parity");
    const events: NormalizedEvent[] = [
      makeEvent({
        session_id: sid,
        state: "starting",
        event_type: "session.started",
        timestamp: iso(base, 0),
      }),
      planCompleted(sid, 10), // claim
      makeEvent({
        session_id: sid,
        event_type: "diff.updated",
        state: "running.file_editing",
        timestamp: iso(base, 20),
        payload: { kind: "diff.updated", diff_hash: "h1", head_sha: "sha1" },
      }),
      makeEvent({
        session_id: sid,
        event_type: "command.started",
        state: "running.command_executing",
        timestamp: iso(base, 30),
        payload: {
          kind: "command.started",
          command: "vitest run",
          check_kind: "test",
          check_match: "program",
          request_id: "r1",
        },
      }),
      makeEvent({
        session_id: sid,
        event_type: "command.completed",
        state: "running.model_wait",
        timestamp: iso(base, 40),
        payload: {
          kind: "command.completed",
          exit_code: 0,
          check_kind: "test",
          check_match: "program",
          request_id: "r1",
        },
      }),
      makeEvent({
        session_id: sid,
        event_type: "diff.updated",
        state: "running.file_editing",
        timestamp: iso(base, 50),
        payload: { kind: "diff.updated", diff_hash: "h2", head_sha: "sha1" }, // fingerprint change → stale
      }),
    ];
    for (const ev of events) await store.ingest(ev);

    const expected = reduceWorkItems(sid, events);
    const item = expected.items[0]!;
    // 中身の健全性 (受入8 の live 経路確認): claim → passed → stale。
    expect(item.status).toBe("completed");
    expect(item.verification_state).toBe("stale");
    expect(item.check_kind).toBe("test");
    expect(item.check_exit_code).toBe(0);
    expect(item.verified_tree_fp).toBeDefined();

    assertParity(await fetchRows(sid), expected.items);
  });

  it("冪等: re-ingesting the same event_id does not double-fold work_items", async () => {
    const store = new IngestStore({ pool });
    const sid = newSession("wi_idem");
    await store.ingest(
      makeEvent({
        session_id: sid,
        state: "starting",
        event_type: "session.started",
        timestamp: iso(base, 0),
      }),
    );
    const planEv = planCompleted(sid, 10);
    const r1 = await store.ingest(planEv);
    const r2 = await store.ingest(planEv);
    const r3 = await store.ingest(planEv);
    expect(r1.inserted).toBe(true);
    expect(r2.inserted).toBe(false);
    expect(r3.inserted).toBe(false);

    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM work_items WHERE session_id = $1`,
      [sid],
    );
    expect(rows[0]!.n).toBe(1); // 1 item のみ (二重 fold で複製されない)。
    assertParity(await fetchRows(sid), reduceWorkItems(sid, [planEv]).items);
  });

  it("lazy 再 fold: a fresh IngestStore (empty cache) reconstructs claim/tree_fp/pending from events", async () => {
    const store1 = new IngestStore({ pool });
    const sid = newSession("wi_rebuild");
    const priorEvents: NormalizedEvent[] = [
      makeEvent({
        session_id: sid,
        state: "starting",
        event_type: "session.started",
        timestamp: iso(base, 0),
      }),
      planCompleted(sid, 10),
      makeEvent({
        session_id: sid,
        event_type: "diff.updated",
        state: "running.file_editing",
        timestamp: iso(base, 20),
        payload: { kind: "diff.updated", diff_hash: "h1", head_sha: "sha1" },
      }),
    ];
    for (const ev of priorEvents) await store1.ingest(ev);

    // backend 再起動相当: 新インスタンス = 空 work-items キャッシュ。
    const store2 = new IngestStore({ pool });
    expect(store2.workItemsTrackedSessions).toBe(0);

    // 新 check が到着。store2 は events から claim (claimed_at t10) と tree_fp (t20) を再構成し、
    //   claimed_at ≤ check 完了時刻ゆえ束縛 → 失敗 check で failed になる (rebuild 成功の判別条件)。
    const startEv = makeEvent({
      session_id: sid,
      event_type: "command.started",
      state: "running.command_executing",
      timestamp: iso(base, 30),
      payload: {
        kind: "command.started",
        command: "tsc",
        check_kind: "typecheck",
        check_match: "program",
        request_id: "r9",
      },
    });
    const doneEv = makeEvent({
      session_id: sid,
      event_type: "command.completed",
      state: "running.model_wait",
      timestamp: iso(base, 40),
      payload: {
        kind: "command.completed",
        exit_code: 2,
        check_kind: "typecheck",
        check_match: "program",
        request_id: "r9",
      },
    });
    await store2.ingest(startEv);
    await store2.ingest(doneEv);

    const allEvents = [...priorEvents, startEv, doneEv];
    const expected = reduceWorkItems(sid, allEvents);
    expect(expected.items[0]!.verification_state).toBe("failed"); // rebuild が claim を復元したから束縛できた
    expect(expected.items[0]!.check_exit_code).toBe(2);
    assertParity(await fetchRows(sid), expected.items);
  });

  it("no-op work event (unchanged fingerprint) does not rewrite unchanged rows", async () => {
    const store = new IngestStore({ pool });
    const sid = newSession("wi_noop");
    await store.ingest(
      makeEvent({
        session_id: sid,
        state: "starting",
        event_type: "session.started",
        timestamp: iso(base, 0),
      }),
    );
    await store.ingest(planCompleted(sid, 10));
    const diff = (offset: number) =>
      makeEvent({
        session_id: sid,
        event_type: "diff.updated",
        state: "running.file_editing",
        timestamp: iso(base, offset),
        payload: { kind: "diff.updated", diff_hash: "same", head_sha: "sha" },
      });
    await store.ingest(diff(20));
    const before = await pool.query<{ updated_at: Date }>(
      `SELECT updated_at FROM work_items WHERE session_id = $1`,
      [sid],
    );
    // 同一 fingerprint の diff.updated → fold no-op → item 参照不変 → upsert skip (行 updated_at 不変)。
    await store.ingest(diff(30));
    const after = await pool.query<{ updated_at: Date }>(
      `SELECT updated_at FROM work_items WHERE session_id = $1`,
      [sid],
    );
    expect(after.rows[0]!.updated_at.getTime()).toBe(before.rows[0]!.updated_at.getTime());
  });

  it("LRU: workItemsCacheMax bounds tracked sessions (eviction is correctness-neutral)", async () => {
    const store = new IngestStore({ pool, workItemsCacheMax: 1 });
    const a = newSession("wi_lru_a");
    const b = newSession("wi_lru_b");
    for (const sid of [a, b]) {
      await store.ingest(
        makeEvent({
          session_id: sid,
          state: "starting",
          event_type: "session.started",
          timestamp: iso(base, 0),
        }),
      );
      await store.ingest(planCompleted(sid, 10));
    }
    // 上限 1 ゆえ最古 (a) は evict 済み・現在は 1 セッションのみ保持。
    expect(store.workItemsTrackedSessions).toBe(1);
    // eviction 後も両 session のテーブル行は正しい (a は次アクセスで rebuild される)。
    assertParity(await fetchRows(a), reduceWorkItems(a, [planCompleted(a, 10)]).items);
    assertParity(await fetchRows(b), reduceWorkItems(b, [planCompleted(b, 10)]).items);
  });

  it("lazy rebuild skips a contract-invalid event row (T1 gate) without polluting the fold", async () => {
    const store1 = new IngestStore({ pool });
    const sid = newSession("wi_badrow");
    const plan = planCompleted(sid, 10);
    await store1.ingest(
      makeEvent({
        session_id: sid,
        state: "starting",
        event_type: "session.started",
        timestamp: iso(base, 0),
      }),
    );
    await store1.ingest(plan);
    // 別経路/破損を模擬: parseEvent 境界を回避して不正 event_type の行を直接 INSERT。
    await pool.query(
      `INSERT INTO events (id, event_id, provider, source, session_id, event_type, timestamp, payload, metrics)
       VALUES (gen_random_uuid(), $1, 'codex', 'rollout', $2, 'not.a.real.type', $3, '{}'::jsonb, '{}'::jsonb)`,
      [`bad_${sid}`, sid, iso(base, 15)],
    );
    // fresh store = 空キャッシュ → rebuild が全 events を読む。不正行は T1 で skip され fold を汚さない。
    const store2 = new IngestStore({ pool });
    const diffEv = makeEvent({
      session_id: sid,
      event_type: "diff.updated",
      state: "running.file_editing",
      timestamp: iso(base, 20),
      payload: { kind: "diff.updated", diff_hash: "h1", head_sha: "sha1" },
    });
    await store2.ingest(diffEv);
    // 不正行を除いた canonical 列と一致 (bad row は fold に含めない)。
    const expected = reduceWorkItems(sid, [plan, diffEv]);
    assertParity(await fetchRows(sid), expected.items);
  });

  it("gate: non-work-relevant events create no work_items rows", async () => {
    const store = new IngestStore({ pool });
    const sid = newSession("wi_gate");
    await store.ingest(
      makeEvent({
        session_id: sid,
        state: "starting",
        event_type: "session.started",
        timestamp: iso(base, 0),
      }),
    );
    await store.ingest(
      makeEvent({
        session_id: sid,
        event_type: "agent.message.delta",
        state: "running.model_streaming",
        timestamp: iso(base, 10),
        payload: { kind: "agent.message.delta", delta: "hello" },
      }),
    );
    await store.ingest(
      makeEvent({
        session_id: sid,
        event_type: "heartbeat",
        timestamp: iso(base, 20),
        payload: { kind: "heartbeat", process_alive: true },
      }),
    );
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM work_items WHERE session_id = $1`,
      [sid],
    );
    expect(rows[0]!.n).toBe(0);
  });
});
