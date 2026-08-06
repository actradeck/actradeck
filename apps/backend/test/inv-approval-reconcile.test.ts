/**
 * INV-APPROVAL-RECONCILE (ADR 0014 Phase 4・decision 019fd705 D6):
 * sidecar 再接続 hello の `active_pending_request_ids` 宣言に基づく stale pending の非 actionable 化。
 *
 * 3 層で固定する:
 *  A. SidecarRegistry: hello 宣言の検証と ApprovalReconcileSignal 発火 (欠落/malformed は fail-safe
 *     スキップ・所有 session 限定)。
 *  B. ApprovalReconciler 単体: stale → 合成 cancel (decision=cancel / resolution_origin=relay_lost /
 *     delivery_status=not_sent・provider は実 session の値・NO-RAW)、active → 維持、二重合成防止。
 *  C. REAL PostgreSQL 受入:
 *     - 受入#7: sidecar 再起動 (宣言に無い pending) → 合成 cancel が fold され pending_approvals から
 *       消える (= UI カード非表示 = 非操作可)。
 *     - 受入#6: backend 再起動跨ぎ (宣言に在る pending) → pending は維持され、同一 request_id の実
 *       resolved で一度だけ解決される (合成は発生しない)。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseEvent } from "@actradeck/event-model";
import { redactEventWithAuthoritativeCounts } from "@actradeck/redaction";
import { Pool } from "pg";

import { ApprovalReconciler } from "../src/approval-reconciler.js";
import { IngestStore } from "../src/ingest-store.js";
import {
  SidecarRegistry,
  type ApprovalReconcileSignal,
  type SidecarLink,
  MAX_ACTIVE_PENDING_IDS,
} from "../src/sidecar-registry.js";
import { cleanupSessions, dbReachable, makeEvent } from "./helpers.js";

function makeLink(): SidecarLink {
  return { send: () => {}, open: true };
}

describe("A. SidecarRegistry: hello 宣言 → ApprovalReconcileSignal", () => {
  function setup(): {
    registry: SidecarRegistry;
    link: SidecarLink;
    signals: ApprovalReconcileSignal[];
  } {
    const registry = new SidecarRegistry({ graceMs: 10 });
    const link = makeLink();
    registry.add(link);
    const signals: ApprovalReconcileSignal[] = [];
    registry.onApprovalReconcile((s) => signals.push(s));
    return { registry, link, signals };
  }

  it("宣言つき hello で signal が発火する (sessionIds / activeRequestIds / runtimeEpoch)", () => {
    const { registry, link, signals } = setup();
    registry.handleHello(link, {
      type: "hello",
      control_token: "t",
      session_ids: ["s1", "s2"],
      runtime_epoch: "epoch-1",
      active_pending_request_ids: ["s1:apr-a", "s2:apr-b"],
    });
    expect(signals).toHaveLength(1);
    expect([...signals[0]!.sessionIds].sort()).toEqual(["s1", "s2"]);
    expect(signals[0]!.activeRequestIds.has("s1:apr-a")).toBe(true);
    expect(signals[0]!.activeRequestIds.has("s2:apr-b")).toBe(true);
    expect(signals[0]!.runtimeEpoch).toBe("epoch-1");
  });

  it("空配列は正当な「pending ゼロ」宣言として発火する (受入#7 の根拠)", () => {
    const { registry, link, signals } = setup();
    registry.handleHello(link, {
      type: "hello",
      control_token: "t",
      session_ids: ["s1"],
      active_pending_request_ids: [],
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]!.activeRequestIds.size).toBe(0);
  });

  it("field 欠落 (旧 sidecar / observe-only daemon) では発火しない (fail-safe)", () => {
    const { registry, link, signals } = setup();
    registry.handleHello(link, { type: "hello", control_token: "t", session_ids: ["s1"] });
    expect(signals).toHaveLength(0);
  });

  it("malformed 宣言 (非配列 / 非 string 要素 / 上限超過) は全スキップ (消さない方向)", () => {
    const { registry, link, signals } = setup();
    registry.handleHello(link, {
      type: "hello",
      control_token: "t",
      session_ids: ["s1"],
      active_pending_request_ids: "not-an-array",
    });
    registry.handleHello(link, {
      type: "hello",
      control_token: "t",
      session_ids: ["s1"],
      active_pending_request_ids: [42],
    });
    registry.handleHello(link, {
      type: "hello",
      control_token: "t",
      session_ids: ["s1"],
      active_pending_request_ids: Array.from(
        { length: MAX_ACTIVE_PENDING_IDS + 1 },
        (_, i) => `r${i}`,
      ),
    });
    expect(signals).toHaveLength(0);
  });

  it("後勝ちで他接続へ移った session は signal の対象にしない (multiplex 安全)", () => {
    const registry = new SidecarRegistry({ graceMs: 10 });
    const link1 = makeLink();
    const link2 = makeLink();
    registry.add(link1);
    registry.add(link2);
    const signals: ApprovalReconcileSignal[] = [];
    registry.onApprovalReconcile((s) => signals.push(s));
    // link1 が s1 を観測学習 → link2 が後勝ち claim (所有移転)。
    registry.observeSession(link1, "s1");
    registry.observeSession(link2, "s1");
    // link1 の宣言つき hello (session_ids 無し = membership 不変)。s1 の所有は link2 のため対象外。
    registry.handleHello(link1, {
      type: "hello",
      control_token: "t",
      active_pending_request_ids: [],
    });
    expect(signals).toHaveLength(0);
  });
});

describe("B. ApprovalReconciler 単体 (fake store)", () => {
  interface Row {
    session_id: string;
    provider: string;
    state: string | undefined;
    request_ids: string[];
  }

  function makeReconciler(rows: Row[] | (() => Promise<Row[]>)) {
    const ingested: Record<string, unknown>[] = [];
    const reconciler = new ApprovalReconciler({
      store: {
        pendingApprovalsForSessions: typeof rows === "function" ? rows : async () => rows,
      },
      ingestEvent: async (event) => {
        ingested.push(event);
        return true;
      },
      now: () => "2026-08-06T00:00:00.000Z",
    });
    return { reconciler, ingested };
  }

  it("stale pending → 合成 cancel (relay_lost / not_sent / 実 provider / state 保持 / NO-RAW)", async () => {
    const { reconciler, ingested } = makeReconciler([
      {
        session_id: "s1",
        provider: "codex",
        state: "waiting.approval",
        request_ids: ["s1:apr-stale"],
      },
    ]);
    await reconciler.reconcile({ sessionIds: ["s1"], activeRequestIds: new Set() });

    expect(ingested).toHaveLength(1);
    const ev = ingested[0]!;
    expect(ev.provider).toBe("codex"); // 実 session の provider を偽装しない。
    expect(ev.source).toBe("external"); // backend 起点の合成を closed enum で正直に表す。
    expect(ev.session_id).toBe("s1");
    expect(ev.event_type).toBe("tool.permission.resolved");
    expect(ev.state).toBe("waiting.approval"); // 現 state 保持 (合成で遷移させない)。
    expect(ev.payload).toEqual({
      kind: "tool.permission.resolved",
      request_id: "s1:apr-stale",
      decision: "cancel",
      resolution_origin: "relay_lost",
      delivery_status: "not_sent",
    });
    // 合成イベントは T1 schema を満たす (通常 ingest 経路の parseEvent を通る形)。
    expect(() => parseEvent(ev)).not.toThrow();
  });

  it("宣言に在る pending は維持する (受入#6 側・合成しない)", async () => {
    const { reconciler, ingested } = makeReconciler([
      {
        session_id: "s1",
        provider: "claude_code",
        state: "waiting.approval",
        request_ids: ["a", "b"],
      },
    ]);
    await reconciler.reconcile({ sessionIds: ["s1"], activeRequestIds: new Set(["a", "b"]) });
    expect(ingested).toHaveLength(0);
  });

  it("fold 完了前の連続 hello でも同一 request_id を二重合成しない (in-flight dedup)", async () => {
    const rows: Row[] = [
      { session_id: "s1", provider: "claude_code", state: undefined, request_ids: ["dup-1"] },
    ];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const ingested: Record<string, unknown>[] = [];
    const reconciler = new ApprovalReconciler({
      store: { pendingApprovalsForSessions: async () => rows },
      ingestEvent: async (event) => {
        ingested.push(event);
        await gate; // fold 未完了を模す (1 回目が保留中に 2 回目の hello)。
        return true;
      },
    });
    const first = reconciler.reconcile({ sessionIds: ["s1"], activeRequestIds: new Set() });
    // 1 回目が in-flight のうちに 2 回目 (DB はまだ pending を返す)。
    await new Promise((r) => setTimeout(r, 10));
    const second = reconciler.reconcile({ sessionIds: ["s1"], activeRequestIds: new Set() });
    await new Promise((r) => setTimeout(r, 10));
    release!();
    await Promise.all([first, second]);
    expect(ingested).toHaveLength(1); // dedup: 合成は 1 回のみ。
    expect(reconciler.inFlightCount).toBe(0); // 解放済み。
  });

  it("store 読取り失敗は何も消さない (fail-safe)", async () => {
    const { reconciler, ingested } = makeReconciler(async () => {
      throw new Error("db down");
    });
    await expect(
      reconciler.reconcile({ sessionIds: ["s1"], activeRequestIds: new Set() }),
    ).resolves.toBeUndefined();
    expect(ingested).toHaveLength(0);
  });
});

const DATABASE_URL = process.env.DATABASE_URL;
const reachable = DATABASE_URL ? await dbReachable(DATABASE_URL) : false;

describe.skipIf(!reachable)("INV-APPROVAL-RECONCILE 受入#6/#7 (real Postgres)", () => {
  let pool: Pool;
  let store: IngestStore;
  let reconciler: ApprovalReconciler;
  const sessions: string[] = [];

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 5 });
    store = new IngestStore({ pool });
    // 本番配線 (ingestion-server.ts) と同一の経路: ingress redaction 床 → parseEvent → store.ingest。
    reconciler = new ApprovalReconciler({
      store,
      ingestEvent: async (event) => {
        const ev = parseEvent(redactEventWithAuthoritativeCounts(event));
        await store.ingest(ev);
        return true;
      },
    });
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

  async function ingestRequested(sid: string, requestId: string): Promise<void> {
    await store.ingest(
      makeEvent({
        session_id: sid,
        state: "waiting.approval",
        event_type: "tool.permission.requested",
        payload: {
          kind: "tool.permission.requested",
          request_id: requestId,
          tool_name: "Bash",
          command: "rm -rf /tmp/x",
          risk_level: "high",
        },
      }),
    );
  }

  it("受入#7: sidecar 再起動 (宣言に無い pending) → 合成 cancel が fold され pending が消える", async () => {
    const sid = newSession("sess_reconcile7");
    const requestId = `${sid}:apr-stale`;
    await ingestRequested(sid, requestId);

    const before = await store.pendingApprovalsForSessions([sid]);
    expect(before).toHaveLength(1);
    expect(before[0]!.request_ids).toEqual([requestId]);

    // sidecar が新プロセスで再接続 = pending ゼロ宣言。
    await reconciler.reconcile({ sessionIds: [sid], activeRequestIds: new Set() });

    // 合成 cancel が fold され DB pending から消える (= カード非表示 = 非操作可)。
    const after = await store.pendingApprovalsForSessions([sid]);
    expect(after).toHaveLength(0);

    // 監査トレイル: 合成 resolved が実際に永続され、正直なメタデータを持つ。
    const { rows } = await pool.query(
      `SELECT payload FROM events WHERE session_id = $1 AND event_type = 'tool.permission.resolved'`,
      [sid],
    );
    expect(rows).toHaveLength(1);
    const payload = rows[0].payload as Record<string, unknown>;
    expect(payload.request_id).toBe(requestId);
    expect(payload.decision).toBe("cancel");
    expect(payload.resolution_origin).toBe("relay_lost");
    expect(payload.delivery_status).toBe("not_sent");

    // 冪等: 再度の hello (同宣言) では合成しない (pending 消滅済み)。
    await reconciler.reconcile({ sessionIds: [sid], activeRequestIds: new Set() });
    const again = await pool.query(
      `SELECT count(*)::int AS n FROM events WHERE session_id = $1 AND event_type = 'tool.permission.resolved'`,
      [sid],
    );
    expect(again.rows[0].n).toBe(1);
  });

  it("受入#6: backend 再起動跨ぎ (宣言に在る pending) → 維持され、同一 request_id で一度だけ解決", async () => {
    const sid = newSession("sess_reconcile6");
    const requestId = `${sid}:apr-live`;
    await ingestRequested(sid, requestId);

    // 同一 sidecar プロセスの再接続 hello = pending が生きている宣言 → 合成しない。
    await reconciler.reconcile({ sessionIds: [sid], activeRequestIds: new Set([requestId]) });
    const kept = await store.pendingApprovalsForSessions([sid]);
    expect(kept).toHaveLength(1); // pending は維持 (actionable のまま)。

    // 再確立した relay で operator が解決 → 実 resolved が一度だけ届き pending が消える。
    await store.ingest(
      makeEvent({
        session_id: sid,
        state: "running.tool_preparing",
        event_type: "tool.permission.resolved",
        payload: {
          kind: "tool.permission.resolved",
          request_id: requestId,
          decision: "allow",
          resolution_origin: "operator",
          delivery_status: "sent",
        },
      }),
    );
    const after = await store.pendingApprovalsForSessions([sid]);
    expect(after).toHaveLength(0);

    // resolved は合成なしの 1 回のみ (operator 由来)。
    const { rows } = await pool.query(
      `SELECT payload FROM events WHERE session_id = $1 AND event_type = 'tool.permission.resolved'`,
      [sid],
    );
    expect(rows).toHaveLength(1);
    expect((rows[0].payload as Record<string, unknown>).resolution_origin).toBe("operator");
  });
});
