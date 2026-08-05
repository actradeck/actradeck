/**
 * INV-LINEAGE-DTO (ADR 0014 Phase 3c・decision 019fd250, REAL PostgreSQL)。
 *
 * sessions の run lineage 列 + session_state.last_turn_outcome を SessionDetail DTO へ
 * 露出する read 面の契約を実 PG で固定する:
 *
 *  - round-trip: ingest した lineage (provider_session_id / start_kind / resumed_from /
 *    end_kind / recoverability) と last_turn_outcome が detail() に載る。
 *  - resumed_from_observed: 参照先 session の実在 (EXISTS)。宣言エッジ (Codex rollout の
 *    forked_from_id) は未観測でありうる → false = UI の linked-unknown 根拠。
 *  - lineage_runs: 同一 provider_session_id の run 兄弟 (started_at 昇順・自分含む)。
 *    単独 run はキー落とし (連結情報が無い = 何も主張しない)。
 *  - SEC-2 (裁定 019f8051): CHECK 無し TEXT の out-of-enum 値 (non-ingest writer / 手編集 DB)
 *    は read 時 closed-enum gate で **キー落とし** (UI へ通さない)。
 *  - list 経路 (listItem) は非拡張 (hot path に lineage を載せない)。
 *
 * DB 未到達なら skip (CI では実走必須。silent green 禁止)。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Pool } from "pg";

import { IngestStore } from "../src/ingest-store.js";
import { RealtimeStore } from "../src/realtime-store.js";
import { cleanupSessions, dbReachable, iso, makeEvent } from "./helpers.js";

const DATABASE_URL = process.env.DATABASE_URL;
const reachable = DATABASE_URL ? await dbReachable(DATABASE_URL) : false;

describe.skipIf(!reachable)("INV-LINEAGE-DTO (real Postgres)", () => {
  let pool: Pool;
  let ingest: IngestStore;
  let store: RealtimeStore;
  const sessions: string[] = [];

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
    ingest = new IngestStore({ pool });
    // projectScope を明示空にする (env 汚染に依存しない)。
    store = new RealtimeStore(pool, []);
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

  it("lineage round-trip: 2 run 系譜 + resumed_from_observed=true + lineage_runs 昇順", async () => {
    const psid = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const parent = newSession("sess_lin_parent");
    const child = newSession("sess_lin_child");
    const base = Date.now();

    await ingest.ingest(
      makeEvent({
        session_id: parent,
        state: "running.command_executing",
        event_type: "session.started",
        provider_session_id: psid,
        start_kind: "fresh",
        timestamp: iso(base, 0),
      }),
    );
    await ingest.ingest(
      makeEvent({
        session_id: child,
        state: "running.model_wait",
        event_type: "turn.started",
        provider_session_id: psid,
        start_kind: "resume",
        resumed_from_session_id: parent,
        timestamp: iso(base, 1_000),
      }),
    );
    await ingest.ingest(
      makeEvent({
        session_id: child,
        state: "idle",
        event_type: "turn.completed",
        timestamp: iso(base, 2_000),
      }),
    );
    await ingest.ingest(
      makeEvent({
        session_id: child,
        state: "suspended",
        event_type: "session.ended",
        end_kind: "unloaded",
        recoverability: "resumable",
        timestamp: iso(base, 3_000),
      }),
    );

    const detail = await store.detail(child);
    expect(detail).toBeDefined();
    expect(detail!.provider_session_id).toBe(psid);
    expect(detail!.start_kind).toBe("resume");
    expect(detail!.resumed_from_session_id).toBe(parent);
    // 参照先 (parent) は観測済み session として実在する → resolved。
    expect(detail!.resumed_from_observed).toBe(true);
    expect(detail!.end_kind).toBe("unloaded");
    expect(detail!.recoverability).toBe("resumable");
    expect(detail!.last_turn_outcome).toBe("completed");
    // run 系譜は started_at 昇順で自分を含む。
    expect(detail!.lineage_runs?.map((r) => r.session_id)).toEqual([parent, child]);
    expect(detail!.lineage_runs?.[0]?.start_kind).toBe("fresh");
    expect(detail!.lineage_runs?.[1]?.start_kind).toBe("resume");
  });

  it("QA-1: started_at 欠落 run 同士でも系譜順は時系列 (last_event_at 縮退・辞書順にしない)", async () => {
    const psid = `conv_nostart_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const base = Date.now();
    // 辞書順 (zz < ... は偽) と時系列が食い違うよう、後発 run に辞書順で先行する id を与える。
    const older = newSession("sess_lin_zz_older");
    const newer = newSession("sess_lin_aa_newer");
    // どちらも session.started を観測しない (turn.started 初観測 = started_at NULL)。
    await ingest.ingest(
      makeEvent({
        session_id: older,
        state: "running.model_wait",
        event_type: "turn.started",
        provider_session_id: psid,
        timestamp: iso(base, 0),
      }),
    );
    await ingest.ingest(
      makeEvent({
        session_id: newer,
        state: "running.model_wait",
        event_type: "turn.started",
        provider_session_id: psid,
        timestamp: iso(base, 60_000),
      }),
    );
    const { rows } = await pool.query(
      `SELECT started_at FROM sessions WHERE session_id = ANY($1::text[])`,
      [[older, newer]],
    );
    // 前提の実測: 両 run とも started_at 未設定 (縮退経路が実際に踏まれる)。
    for (const r of rows as { started_at: Date | null }[]) expect(r.started_at).toBeNull();
    const detail = await store.detail(newer);
    // 辞書順なら [newer(aa), older(zz)]。last_event_at 縮退で時系列 [older, newer] を保つ。
    expect(detail!.lineage_runs?.map((r) => r.session_id)).toEqual([older, newer]);
  });

  it("宣言エッジの参照先が未観測 → resumed_from_observed=false (linked-unknown 根拠)", async () => {
    const sid = newSession("sess_lin_declared");
    await ingest.ingest(
      makeEvent({
        session_id: sid,
        state: "running.command_executing",
        event_type: "session.started",
        provider_session_id: `conv_declared_${Date.now()}`,
        start_kind: "resume",
        // Codex rollout の forked_from_id 相当: 観測されていない宣言参照。
        resumed_from_session_id: "sess_never_observed_0000",
      }),
    );
    const detail = await store.detail(sid);
    expect(detail!.resumed_from_session_id).toBe("sess_never_observed_0000");
    expect(detail!.resumed_from_observed).toBe(false);
  });

  it("単独 run は lineage_runs キー落とし (連結情報が無い = 何も主張しない)", async () => {
    const sid = newSession("sess_lin_single");
    await ingest.ingest(
      makeEvent({
        session_id: sid,
        state: "running.command_executing",
        event_type: "session.started",
        provider_session_id: `conv_single_${Date.now()}`,
        start_kind: "fresh",
      }),
    );
    const detail = await store.detail(sid);
    expect(detail!.provider_session_id).toBeDefined();
    expect(detail!.lineage_runs).toBeUndefined();
  });

  it("lineage 列を持たない run (attach 大半) は全キー欠落 (over-claim しない)", async () => {
    const sid = newSession("sess_lin_bare");
    await ingest.ingest(
      makeEvent({ session_id: sid, state: "running.command_executing", event_type: "heartbeat" }),
    );
    const detail = await store.detail(sid);
    expect(detail!.provider_session_id).toBeUndefined();
    expect(detail!.start_kind).toBeUndefined();
    expect(detail!.resumed_from_session_id).toBeUndefined();
    expect(detail!.resumed_from_observed).toBeUndefined();
    expect(detail!.end_kind).toBeUndefined();
    expect(detail!.recoverability).toBeUndefined();
    expect(detail!.last_turn_outcome).toBeUndefined();
    expect(detail!.lineage_runs).toBeUndefined();
  });

  it("SEC-2: out-of-enum DB 値 (CHECK 無し TEXT) は read gate でキー落とし・UI へ通さない", async () => {
    const sid = newSession("sess_lin_bogus");
    await ingest.ingest(
      makeEvent({
        session_id: sid,
        state: "idle",
        event_type: "turn.completed",
        provider_session_id: `conv_bogus_${Date.now()}`,
        start_kind: "fresh",
        end_kind: "completed",
        recoverability: "not_resumable",
      }),
    );
    // non-ingest writer / 手編集 DB を模す: enum 外 TEXT を直接書き込む。
    await pool.query(
      `UPDATE sessions
          SET start_kind = 'bogus-start', end_kind = 'EVIL', recoverability = 'maybe'
        WHERE session_id = $1`,
      [sid],
    );
    await pool.query(
      `UPDATE session_state SET last_turn_outcome = 'exploded' WHERE session_id = $1`,
      [sid],
    );
    const detail = await store.detail(sid);
    // enum gate: out-of-enum は claimed 値として UI へ出ない (キー欠落)。
    expect(detail!.start_kind).toBeUndefined();
    expect(detail!.end_kind).toBeUndefined();
    expect(detail!.recoverability).toBeUndefined();
    expect(detail!.last_turn_outcome).toBeUndefined();
    // gate は enum 列のみ: id 列 (provider_session_id) は識別子としてそのまま。
    expect(detail!.provider_session_id).toBeDefined();
  });

  it("list 経路 (listItem) は lineage 非拡張 (hot path に EXISTS/lineage を載せない)", async () => {
    const sid = newSession("sess_lin_list");
    await ingest.ingest(
      makeEvent({
        session_id: sid,
        state: "running.command_executing",
        event_type: "session.started",
        provider_session_id: `conv_list_${Date.now()}`,
        start_kind: "fresh",
        end_kind: "completed",
        recoverability: "not_resumable",
      }),
    );
    const item = (await store.listItem(sid)) as Record<string, unknown> | undefined;
    expect(item).toBeDefined();
    for (const key of [
      "provider_session_id",
      "start_kind",
      "resumed_from_session_id",
      "resumed_from_observed",
      "end_kind",
      "recoverability",
      "last_turn_outcome",
      "lineage_runs",
    ]) {
      expect(item, `listItem must not carry ${key}`).not.toHaveProperty(key);
    }
  });
});
