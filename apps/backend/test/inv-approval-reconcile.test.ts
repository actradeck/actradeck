/**
 * INV-APPROVAL-RECONCILE (ADR 0014 Phase 4・decision 019fd705 D6):
 * sidecar 再接続 hello の `active_pending_request_ids` 宣言に基づく stale pending の非 actionable 化。
 *
 * 3 層で固定する:
 *  A. SidecarRegistry: hello 宣言の検証と ApprovalReconcileSignal 発火 (欠落/malformed は fail-safe
 *     スキップ・所有 session 限定・session 数上限 SEC-3・epoch uuid gate SEC-6)。
 *  B. ApprovalReconciler 単体: stale → 合成 cancel (decision=cancel / resolution_origin=relay_lost /
 *     delivery_status=not_sent・provider は実 session の値・NO-RAW)、active → 維持、二重合成防止、
 *     watermark (QA-1/TDA-5 R2)、並行ガード (SEC-3 R2)、producer 検証 (SEC-4 R2)。
 *  C. REAL PostgreSQL 受入:
 *     - 受入#7: sidecar 再起動 (宣言に無い pending) → 合成 cancel が fold され pending_approvals から
 *       消える (= UI カード非表示 = 非操作可)。
 *     - 受入#6: backend 再起動跨ぎ (宣言に在る pending) → pending は維持され、同一 request_id の実
 *       resolved で一度だけ解決される (合成は発生しない)。
 *  (registry→reconciler→ingestOne の**配線**は inv-approval-reconcile-wiring.test.ts が
 *   buildIngestionServer + 実 WS で固定する・TDA-3 R2)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { EventPayload, mintApprovalRequestId, parseEvent } from "@actradeck/event-model";
import { redactEventWithAuthoritativeCounts } from "@actradeck/redaction";
import { Pool } from "pg";

import {
  ApprovalReconciler,
  buildSyntheticApprovalCancel,
  MAX_CONCURRENT_RECONCILES,
  RECONCILE_WATERMARK_MS,
} from "../src/approval-reconciler.js";
import { IngestStore } from "../src/ingest-store.js";
import { MAX_ACTIVE_PENDING_IDS } from "@actradeck/event-model";
import {
  SidecarRegistry,
  type ApprovalReconcileSignal,
  type SidecarLink,
  MAX_RECONCILE_SESSIONS,
} from "../src/sidecar-registry.js";
import { cleanupSessions, dbReachable, makeEvent } from "./helpers.js";

function makeLink(): SidecarLink {
  return { send: () => {}, open: true };
}

const EPOCH_UUID = "0199f0a1-2b3c-7d4e-8f01-23456789abcd";

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

  it("宣言つき hello で signal が発火する (sessionIds / activeRequestIds / runtimeEpoch / receivedAt)", () => {
    const { registry, link, signals } = setup();
    const before = Date.now();
    registry.handleHello(link, {
      type: "hello",
      control_token: "t",
      session_ids: ["s1", "s2"],
      runtime_epoch: EPOCH_UUID,
      // SEC-R4-8: 宣言 id は正準 APPROVAL_REQUEST_ID_RE 準拠が必須 (非適合は宣言ごと破棄)。
      active_pending_request_ids: [
        "s0123456789ab:apr-00000000000000000000000000000001",
        "s0123456789ab:apr-00000000000000000000000000000002",
      ],
    });
    expect(signals).toHaveLength(1);
    expect([...signals[0]!.sessionIds].sort()).toEqual(["s1", "s2"]);
    expect(
      signals[0]!.activeRequestIds.has("s0123456789ab:apr-00000000000000000000000000000001"),
    ).toBe(true);
    expect(
      signals[0]!.activeRequestIds.has("s0123456789ab:apr-00000000000000000000000000000002"),
    ).toBe(true);
    expect(signals[0]!.runtimeEpoch).toBe(EPOCH_UUID);
    // QA-1/TDA-5 (R2): watermark の基準時刻 = hello 受信時刻。
    expect(signals[0]!.receivedAt).toBeGreaterThanOrEqual(before);
    expect(signals[0]!.receivedAt).toBeLessThanOrEqual(Date.now());
  });

  it("非 uuid の runtime_epoch は破棄される (SEC-6 R2: 任意文字列を conn メタに持ち込まない)", () => {
    const { registry, link, signals } = setup();
    registry.handleHello(link, {
      type: "hello",
      control_token: "t",
      session_ids: ["s1"],
      runtime_epoch: "x".repeat(64), // 長さは通るが uuid shape でない
      active_pending_request_ids: [],
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]!.runtimeEpoch).toBeUndefined();
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

  it("所有 session 数が MAX_RECONCILE_SESSIONS 超なら発火しない (SEC-3 R2: DB fan-in 上限)", () => {
    const { registry, link, signals } = setup();
    const over = Array.from({ length: MAX_RECONCILE_SESSIONS + 1 }, (_, i) => `sx${i}`);
    registry.handleHello(link, {
      type: "hello",
      control_token: "t",
      session_ids: over,
      active_pending_request_ids: [],
    });
    expect(signals).toHaveLength(0);
    // 上限ちょうどは発火する (境界)。
    const exact = Array.from({ length: MAX_RECONCILE_SESSIONS }, (_, i) => `sy${i}`);
    registry.handleHello(link, {
      type: "hello",
      control_token: "t",
      session_ids: exact,
      active_pending_request_ids: [],
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]!.sessionIds).toHaveLength(MAX_RECONCILE_SESSIONS);
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
    requests: { request_id: string; requested_at: string }[];
  }

  /** 固定基準時刻。stale pending は watermark (receivedAt - RECONCILE_WATERMARK_MS) より十分古い。 */
  const RECEIVED_AT = Date.parse("2026-08-06T00:10:00.000Z");
  const STALE_AT = "2026-08-06T00:00:00.000Z"; // watermark より 10 分古い

  function staleReq(requestId: string): { request_id: string; requested_at: string } {
    return { request_id: requestId, requested_at: STALE_AT };
  }

  /**
   * SEC-R5-2 (task 019fd80f): DB 側 request_id ゲート導入後、合成対象になれるのは正準 OR
   * known-legacy 形のみ。stale fixture は正準形 (`s<12hex>:apr-<32hex>`) で書く。
   */
  const canon = (hexSuffix: string) => `s0123456789ab:apr-${hexSuffix.padStart(32, "0")}`;
  const STALE_ID = canon("57a1e");
  const FRESH_ID = canon("f8e5");
  const OLD_ID = canon("01d");
  const NOAT_ID = canon("0a7");
  const DUP_ID = canon("d0b");

  function signal(
    sessionIds: string[],
    active: string[],
    receivedAt: number = RECEIVED_AT,
  ): ApprovalReconcileSignal {
    return { sessionIds, activeRequestIds: new Set(active), receivedAt };
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
      now: () => "2026-08-06T00:10:00.000Z",
    });
    return { reconciler, ingested };
  }

  it("stale pending → 合成 cancel (relay_lost / not_sent / 実 provider / state 保持 / NO-RAW)", async () => {
    const { reconciler, ingested } = makeReconciler([
      {
        session_id: "s1",
        provider: "codex",
        state: "waiting.approval",
        requests: [staleReq(STALE_ID)],
      },
    ]);
    await reconciler.reconcile(signal(["s1"], []));

    expect(ingested).toHaveLength(1);
    const ev = ingested[0]!;
    expect(ev.provider).toBe("codex"); // 実 session の provider を偽装しない。
    expect(ev.source).toBe("external"); // backend 起点の合成を closed enum で正直に表す。
    expect(ev.session_id).toBe("s1");
    expect(ev.event_type).toBe("tool.permission.resolved");
    expect(ev.state).toBe("waiting.approval"); // 現 state 保持 (合成で遷移させない)。
    expect(ev.payload).toEqual({
      kind: "tool.permission.resolved",
      request_id: STALE_ID,
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
        requests: [staleReq("a"), staleReq("b")],
      },
    ]);
    await reconciler.reconcile(signal(["s1"], ["a", "b"]));
    expect(ingested).toHaveLength(0);
  });

  it("watermark: hello 受信直後に生まれた pending は宣言に無くても消さない (QA-1/TDA-5 R2)", async () => {
    const freshAt = new Date(RECEIVED_AT - RECONCILE_WATERMARK_MS + 500).toISOString(); // 余裕幅内
    const { reconciler, ingested } = makeReconciler([
      {
        session_id: "s1",
        provider: "claude_code",
        state: "waiting.approval",
        requests: [{ request_id: FRESH_ID, requested_at: freshAt }, staleReq(OLD_ID)],
      },
    ]);
    await reconciler.reconcile(signal(["s1"], []));
    // fresh は生存 (宣言スナップショットに載る機会が無かっただけ)、old のみ合成。
    expect(ingested).toHaveLength(1);
    expect((ingested[0]!.payload as Record<string, unknown>).request_id).toBe(OLD_ID);
  });

  it("watermark: requested_at が読めない pending は消さない (fail-safe)", async () => {
    const { reconciler, ingested } = makeReconciler([
      {
        session_id: "s1",
        provider: "claude_code",
        state: undefined,
        requests: [{ request_id: NOAT_ID, requested_at: "not-a-timestamp" }],
      },
    ]);
    await reconciler.reconcile(signal(["s1"], []));
    expect(ingested).toHaveLength(0);
  });

  /**
   * INV-APPROVAL-RECONCILE-ID-GATE (SEC-R5-2 landing・task 019fd80f):
   * 宣言側 (parseActivePendingRequestIds) は正準 RE を強制する。DB 側に同じゲートが無いと、
   * 適合宣言に載り得ない id (mangled / 別 namespace) が「宣言に無い」だけで retire される
   * (fail-unsafe 非対称)。ゲートは正準 OR known-legacy (CHANGELOG 0.7.0 の designed recovery)。
   */
  it("SEC-R5-2: 正準にも known-legacy にも一致しない DB pending は宣言に無くても合成しない (fail-safe)", async () => {
    const nonRetirable = [
      // redaction で prefix / token が marker 化された mangled id (宣言 raw ≠ at-rest の恒久割れ)。
      "[REDACTED:high-entropy]:apr-F9aSKs-LnHcbygXAZ16NLQ",
      "s0123456789ab:apr-[REDACTED:hex-token]",
      // 旧テスト fixture 形 (どの出荷形でもない未知形)。
      "s1:apr-stale",
    ];
    const { reconciler, ingested } = makeReconciler([
      {
        session_id: "s1",
        provider: "claude_code",
        state: "waiting.approval",
        // 非対象 3 件 + 正準 stale 1 件を同居させ、ゲートが「当該 id だけ」を skip することを pin。
        requests: [...nonRetirable.map(staleReq), staleReq(STALE_ID)],
      },
    ]);
    await reconciler.reconcile(signal(["s1"], []));
    expect(ingested).toHaveLength(1);
    expect((ingested[0]!.payload as Record<string, unknown>).request_id).toBe(STALE_ID);
    // 観測: skip 延べ数 (NO-RAW・件数のみ)。
    expect(reconciler.nonRetirableSkipCount).toBe(nonRetirable.length);
    expect(reconciler.inFlightCount).toBe(0);
  });

  it("SEC-R5-2: known-legacy 形 (v0.4.0〜v0.6.0 base64url / それ以前の Date-seq) は引き続き retire される (designed recovery)", async () => {
    const legacyB64 = "sess_0199f0a1-2b3c-7d4e-8f01-23456789abcd:apr-F9aSKs-LnHcbygXAZ16NLQ";
    const legacySeq = "0199f0a1-2b3c-7d4e-8f01-23456789abcd:apr-1754450000000-3";
    const { reconciler, ingested } = makeReconciler([
      {
        session_id: "s1",
        provider: "claude_code",
        state: "waiting.approval",
        requests: [staleReq(legacyB64), staleReq(legacySeq)],
      },
    ]);
    await reconciler.reconcile(signal(["s1"], []));
    expect(ingested.map((e) => (e.payload as Record<string, unknown>).request_id)).toEqual([
      legacyB64,
      legacySeq,
    ]);
    expect(reconciler.nonRetirableSkipCount).toBe(0);
  });

  it("QA-4: `tu:` namespace (command 相関・INV-REQUEST-ID-NAMESPACE) の id は承認として retire しない", async () => {
    const { reconciler, ingested } = makeReconciler([
      {
        session_id: "s1",
        provider: "claude_code",
        state: "waiting.approval",
        requests: [
          staleReq("tu:toolu_01ABCDEFGHIJKLMNOPQRSTUV"),
          staleReq("tu:s1:apr-F9aSKs-LnHcbygXAZ16NLQ"),
        ],
      },
    ]);
    await reconciler.reconcile(signal(["s1"], []));
    expect(ingested).toHaveLength(0);
    expect(reconciler.nonRetirableSkipCount).toBe(2);
  });

  it("SEC-R5-2: ゲートは宣言 Set 突合の後段 (宣言に在る非正準 id は skip 計上せず維持)", async () => {
    // 宣言に在る id は形に関わらず「生存」— ゲート以前に continue するので計上もしない。
    const { reconciler, ingested } = makeReconciler([
      {
        session_id: "s1",
        provider: "claude_code",
        state: "waiting.approval",
        requests: [staleReq("s1:apr-stale")],
      },
    ]);
    await reconciler.reconcile(signal(["s1"], ["s1:apr-stale"]));
    expect(ingested).toHaveLength(0);
    expect(reconciler.nonRetirableSkipCount).toBe(0);
  });

  it("fold 完了前の連続 hello でも同一 request_id を二重合成しない (in-flight dedup)", async () => {
    const rows: Row[] = [
      {
        session_id: "s1",
        provider: "claude_code",
        state: undefined,
        requests: [staleReq(DUP_ID)],
      },
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
    const first = reconciler.reconcile(signal(["s1"], []));
    // 1 回目が in-flight のうちに 2 回目 (DB はまだ pending を返す)。
    await new Promise((r) => setTimeout(r, 10));
    const second = reconciler.reconcile(signal(["s1"], []));
    await new Promise((r) => setTimeout(r, 10));
    release!();
    await Promise.all([first, second]);
    expect(ingested).toHaveLength(1); // dedup: 合成は 1 回のみ。
    expect(reconciler.inFlightCount).toBe(0); // 解放済み。
  });

  it("並行 reconcile は MAX_CONCURRENT_RECONCILES で頭打ち (SEC-3 R2: 超過 signal は捨てる)", async () => {
    let storeCalls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const reconciler = new ApprovalReconciler({
      store: {
        pendingApprovalsForSessions: async () => {
          storeCalls += 1;
          await gate; // 全部を in-flight のまま滞留させる。
          return [];
        },
      },
      ingestEvent: async () => true,
    });
    const inFlight = Array.from({ length: MAX_CONCURRENT_RECONCILES + 3 }, () =>
      reconciler.reconcile(signal(["s1"], [])),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(storeCalls).toBe(MAX_CONCURRENT_RECONCILES); // 超過分は DB へ到達しない。
    expect(reconciler.runningCount).toBe(MAX_CONCURRENT_RECONCILES);
    release!();
    await Promise.all(inFlight);
    expect(reconciler.runningCount).toBe(0);
  });

  it("store 読取り失敗は何も消さない (fail-safe)", async () => {
    const { reconciler, ingested } = makeReconciler(async () => {
      throw new Error("db down");
    });
    await expect(reconciler.reconcile(signal(["s1"], []))).resolves.toBeUndefined();
    expect(ingested).toHaveLength(0);
  });

  it("SEC-4 R2: 合成 producer は strict (EventPayload 合格)・ingress parseEvent は loose (両実態の pin)", () => {
    const synthetic = buildSyntheticApprovalCancel(
      { session_id: "s1", provider: "claude_code", state: "waiting.approval" },
      "s1:apr-x",
      "2026-08-06T00:00:00.000Z",
    );
    // producer 側 strict: 合成 payload は closed union に合格する (reconciler はこれで ingest 前検証)。
    expect(EventPayload.safeParse(synthetic.payload).success).toBe(true);
    // 未知 enum 値は EventPayload では落ちる (producer 検証の意味)…
    const bogus = {
      ...(synthetic.payload as Record<string, unknown>),
      resolution_origin: "bogus-origin",
    };
    expect(EventPayload.safeParse(bogus).success).toBe(false);
    // …が、ingress の parseEvent は payload を looseObject で素通しする (SEC-4 の正直な開示:
    // 「closed enum ゆえ ingress で拒否」は成立しない。strict 検証は producer/consumer 境界のみ)。
    expect(() => parseEvent({ ...synthetic, payload: bogus })).not.toThrow();
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
    // 本番と同一の ingress 床 (redaction → parseEvent → store.ingest) を通す。ただし本番配線点
    // (ingestion-server の ingestOne + onApprovalReconcile) 自体はここでは経由しない — その配線は
    // inv-approval-reconcile-wiring.test.ts が buildIngestionServer + 実 WS で固定する (TDA-3 R2)。
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

  /** watermark を跨いだ「過去の」requested を ingest する (真に stale な pending を模す)。 */
  async function ingestRequested(sid: string, requestId: string): Promise<void> {
    await store.ingest(
      makeEvent({
        session_id: sid,
        state: "waiting.approval",
        event_type: "tool.permission.requested",
        timestamp: new Date(Date.now() - 60_000).toISOString(),
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

  function liveSignal(sid: string, active: string[]): ApprovalReconcileSignal {
    return { sessionIds: [sid], activeRequestIds: new Set(active), receivedAt: Date.now() };
  }

  it("受入#7: sidecar 再起動 (宣言に無い pending) → 合成 cancel が fold され pending が消える", async () => {
    const sid = newSession("sess_reconcile7");
    // SEC-R5-2: 合成対象は正準形のみ (fixture も正準で書く)。
    const requestId = "s0123456789ab:apr-00000000000000000000000000057a1e";
    await ingestRequested(sid, requestId);

    const before = await store.pendingApprovalsForSessions([sid]);
    expect(before).toHaveLength(1);
    expect(before[0]!.requests.map((r) => r.request_id)).toEqual([requestId]);

    // sidecar が新プロセスで再接続 = pending ゼロ宣言。
    await reconciler.reconcile(liveSignal(sid, []));

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
    await reconciler.reconcile(liveSignal(sid, []));
    const again = await pool.query(
      `SELECT count(*)::int AS n FROM events WHERE session_id = $1 AND event_type = 'tool.permission.resolved'`,
      [sid],
    );
    expect(again.rows[0].n).toBe(1);
  });

  it("受入#6: backend 再起動跨ぎ (宣言に在る pending) → 維持され、同一 request_id で一度だけ解決", async () => {
    const sid = newSession("sess_reconcile6");
    const requestId = "s0123456789ab:apr-0000000000000000000000000000011fe";
    await ingestRequested(sid, requestId);

    // 同一 sidecar プロセスの再接続 hello = pending が生きている宣言 → 合成しない。
    await reconciler.reconcile(liveSignal(sid, [requestId]));
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

  it("TDA-R4-6: 合成 cancel は sessions.source を書換えず liveness を live にしない (ADR 前提の T1 pin)", async () => {
    // ADR R4 節の「verified harmless」は次の 2 事実に依存する — どちらも CI 未強制だった:
    //  (a) 合成 producer は source:"external" を名乗るが、ingest upsert は sessions.source を
    //      更新しない (更新すると外部 session 扱い = Wall recency-proxy 候補化の経路が開く)。
    //  (b) 合成 ingest 直後に liveness が relay_lost 除外つきで再計算される (除外を怠ると
    //      timestamp=now の合成イベントが stale session を live に見せる)。
    const sid = newSession("sess_reconcile_src");
    const requestId = "s0123456789ab:apr-000000000000000000000000000000a6";
    await ingestRequested(sid, requestId); // timestamp = now-60s (live 窓の外)。
    const src0 = await pool.query(`SELECT source FROM sessions WHERE session_id = $1`, [sid]);
    expect(src0.rows[0].source).toBe("hooks");

    await reconciler.reconcile(liveSignal(sid, []));
    // (a) source は不変 (upsert の DO UPDATE SET に source が入ると RED)。
    const src1 = await pool.query(`SELECT source FROM sessions WHERE session_id = $1`, [sid]);
    expect(src1.rows[0].source).toBe("hooks");
    // (b) 合成 cancel (timestamp=now) の後も live ではない (活動除外が製造 activity を遮断)。
    const lv = await pool.query(
      `SELECT liveness->>'state' AS s FROM session_state WHERE session_id = $1`,
      [sid],
    );
    expect(lv.rows[0].s).not.toBe("live");
  });

  it("QA-R2-1 (R3): hello 受信直後に生まれた pending は実 DB 経路でも消えない (watermark 実データ pin)", async () => {
    // R2 の watermark は fake store でのみ検証されていた。実 ingest (redaction 床 → parseEvent →
    // store.ingest → projection fold) が requested_at を正しく運ぶことを実 PG で pin する。
    // requested_at を偽装 (epoch 0 等) すると全 pending が太古扱いになり watermark が無効化される
    // — その falsification はこのテストが RED にする。
    const sid = newSession("sess_reconcile_wm");
    const requestId = "s0123456789ab:apr-0123456789abcdef0123456789abcdef";
    // timestamp = 今 (watermark 余裕幅の内側) の requested を実 ingest。
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
    // pending ゼロ宣言でも fresh pending は生存する (宣言スナップショットに載る機会が無かっただけ)。
    await reconciler.reconcile(liveSignal(sid, []));
    const kept = await store.pendingApprovalsForSessions([sid]);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.requests.map((r) => r.request_id)).toEqual([requestId]);
    // 合成 resolved は書かれていない。
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM events WHERE session_id = $1 AND event_type = 'tool.permission.resolved'`,
      [sid],
    );
    expect(rows[0].n).toBe(0);
  });

  it("受入#6 (SEC-1 R2 ベクタ): sess_<uuidv7> 形 session の pending も宣言との突合で維持される", async () => {
    // SEC-1 の再現形: session_id が redaction high-entropy 形 (41 文字単一 run) でも、
    // 正準採番 (event-model mintApprovalRequestId・raw session_id 非含) は ingress 床で不変 →
    // 宣言 (raw) と DB (at-rest) が同一空間で突合できる。QA-R2-5 (R3): 採番は手書き固定値でなく
    // **実際に正準 minter を呼ぶ** (backend からも import 可能になったため) — minter が
    // redaction 不安定な形へ drift すればここが RED になる (結合が本物になった)。
    // mintSyntheticSessionId の実在形そのまま (sess_ + uuid = 41 文字の単一 run)。newSession の
    // suffix を付けると相関 field 救済 shape を外れ top-level session_id ごと redaction されるため
    // 使わない (このベクタの狙いは「session_id は救済され request_id 内 prefix だけ壊れる」非対称)。
    const sid = `sess_${crypto.randomUUID()}`;
    sessions.push(sid);
    const requestId = mintApprovalRequestId(sid);
    await store.ingest(
      parseEvent(
        redactEventWithAuthoritativeCounts(
          makeEvent({
            session_id: sid,
            state: "waiting.approval",
            event_type: "tool.permission.requested",
            timestamp: new Date(Date.now() - 60_000).toISOString(),
            payload: {
              kind: "tool.permission.requested",
              request_id: requestId,
              tool_name: "Bash",
              command: "rm -rf /tmp/x",
              risk_level: "high",
            },
          }) as unknown as Record<string, unknown>,
        ),
      ),
    );
    // at-rest の request_id が採番値のまま (redaction-stable) であること。
    const stored = await store.pendingApprovalsForSessions([sid]);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.requests.map((r) => r.request_id)).toEqual([requestId]);
    // 生存宣言 (bridge の raw キー = 同一値) → 維持される (受入#6)。
    await reconciler.reconcile(liveSignal(sid, [requestId]));
    expect(await store.pendingApprovalsForSessions([sid])).toHaveLength(1);
  });
});
