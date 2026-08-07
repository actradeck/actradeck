/**
 * Approval Reconciler — 再起動跨ぎの stale pending approval を非 actionable 化する
 * (ADR 0014 Phase 4・decision 019fd705 D6)。
 *
 * 背景: backend の pending_approvals は session_state (DB) に永続されるが、sidecar 側の pending は
 * in-memory (ApprovalBridge の Map) で daemon 再起動により消える。従来は sidecar 再起動後の再接続
 * hello で presence が復帰すると **もう解決しようのない** stale pending カードが actionable に再表示
 * され、approve は foreign request_id として sidecar 側で no-op になるのに UI へ ack ok が返っていた。
 *
 * 本 reconciler は hello の `active_pending_request_ids` 宣言 (SidecarRegistry の
 * ApprovalReconcileSignal) を根拠に:
 *  - 宣言に **無い** DB pending → `tool.permission.resolved { decision: "cancel",
 *    resolution_origin: "relay_lost", delivery_status: "not_sent" }` を **合成 ingest** し、
 *    projection fold が該当カードを除去する (受入#7)。decision=cancel は「operator の決定を
 *    偽装しない」正直な写像 (誰も決定していない・agent へ何も届いていない)。
 *  - 宣言に **在る** DB pending → 何もしない (sidecar 側で生きており、再確立した relay で
 *    一度だけ解決できる = 受入#6)。
 *
 * 安全性:
 *  - 合成イベントは通常の ingest 経路 (ingress redaction 床 → parseEvent → store.ingest) を通す
 *    (専用の裏口を作らない)。payload は closed enum + request_id のみ (NO-RAW)。
 *  - **watermark (QA-1/TDA-5 R2)**: 宣言は hello 構築時点のスナップショットで、hello 受信直後に
 *    生成された pending は「宣言に載る機会が無かった」だけで stale ではない。requested_at が
 *    `signal.receivedAt - RECONCILE_WATERMARK_MS` より新しい pending は合成対象から外す
 *    (真に stale なら次の hello — reannounce は session 観測ごとに発火 — で watermark を跨ぎ回収
 *    される)。requested_at が読めない pending も消さない (fail-safe)。
 *  - **並行ガード (SEC-3 R2)**: reconcile は hello ごとに fire-and-forget で起動されるため、
 *    暴走 reannounce ループが無制限の DB クエリへ増幅しないよう同時実行を
 *    MAX_CONCURRENT_RECONCILES で頭打ちする (超過 signal は捨てる = 次 hello で自然リトライ)。
 *  - **producer 検証 (SEC-4 R2)**: 合成イベントは ingest 前に EventPayload (strict union) で
 *    検証する (sidecar producer の assertPayloadConsistency と対称)。ingress の parseEvent は
 *    payload を looseObject で素通しするため、backend 合成 producer 側でこの検証を持たないと
 *    「closed enum ゆえ拒否」の NO-RAW 根拠が実経路のどこにも存在しなくなる。
 *  - 冪等: 合成が fold されると DB pending から当該 request_id が消えるため、後続 hello では
 *    そもそも stale として列挙されない。fold 完了前の連続 hello は in-flight dedup (request_id
 *    単位) で二重合成を防ぐ。
 *  - 宣言の検証 (型 / 上限 / 所有 session 限定 / session 数上限) は
 *    SidecarRegistry.maybeEmitApprovalReconcile が担う (malformed は本 reconciler に届かない)。
 *
 * 既知エッジ (正直開示・decision 019fd705): sidecar のローカル store に未送信の実 resolved が
 * queue されたまま再接続した場合、合成 cancel と実 resolved が同一 request_id に対して両方
 * 監査トレイルへ残りうる (projection は 2 発目を no-op 除去するため表示は安全・情報は失われない)。
 * さらに実 resolved が永続前に失われた場合は合成行が唯一の記録になりうる (SEC-5・ADR 0014
 * Landed 節に開示・合成行は「backend reconciliation の観測」であり「元要求が未解決だった」ことの
 * 断定ではない、と読み手契約を固定する)。
 */
import { EventPayload, newEventId, SYNTHETIC_RETIRE_ORIGIN } from "@actradeck/event-model";

import type { ApprovalReconcileSignal } from "./sidecar-registry.js";

/**
 * watermark の余裕幅 (ms)。宣言スナップショット (sidecar 構築) と hello 受信 (backend) の間の
 * 転送・スケジューリング遅延を吸収する。sidecar/backend は同一マシン (loopback・security.md の
 * 信頼境界) ゆえ時計は共有 — 数秒あれば十分で、真の stale (死んだ daemon の残骸・分単位) とは
 * 桁が違う。
 */
export const RECONCILE_WATERMARK_MS = 2000;

/** 同時に走れる reconcile の上限 (SEC-3 R2: hello 増幅による pg Pool 飢餓の防止)。 */
export const MAX_CONCURRENT_RECONCILES = 4;

/** reconcile が依存する最小 store 面 (IngestStore.pendingApprovalsForSessions の構造的部分型)。 */
export interface ReconcileStoreView {
  pendingApprovalsForSessions(sessionIds: readonly string[]): Promise<
    {
      session_id: string;
      provider: string;
      state: string | undefined;
      requests: { request_id: string; requested_at: string }[];
    }[]
  >;
}

/**
 * 合成 cancel イベントを構築する (純関数・export はテストが EventPayload 契約を直接検証するため)。
 * - provider = 当該 session の実 provider (偽装しない)。source = "external" (sidecar 収集でない
 *   backend 起点の合成であることを closed enum で正直に表す)。
 * - state = 現 state を保持 (状態遷移を合成で動かさない。state 欠落時は遷移的に無害な
 *   "running.model_wait" = 既存 resolved-deny の遷移先へ倒す)。
 * - payload は closed enum + request_id のみ (NO-RAW): decision=cancel / resolution_origin=
 *   relay_lost / delivery_status=not_sent。
 */
export function buildSyntheticApprovalCancel(
  row: { session_id: string; provider: string; state: string | undefined },
  requestId: string,
  timestamp: string,
): Record<string, unknown> {
  return {
    event_id: newEventId(),
    provider: row.provider,
    source: "external",
    session_id: row.session_id,
    event_type: "tool.permission.resolved",
    state: row.state ?? "running.model_wait",
    timestamp,
    summary: "承認 取消 (中継喪失)",
    payload: {
      kind: "tool.permission.resolved",
      request_id: requestId,
      decision: "cancel",
      resolution_origin: SYNTHETIC_RETIRE_ORIGIN,
      delivery_status: "not_sent",
    },
  };
}

export interface ApprovalReconcilerOptions {
  readonly store: ReconcileStoreView;
  /**
   * 合成イベントを通常 ingest 経路へ流すコールバック (ingestion-server が ingestOne +
   * pushAfterIngest を配線)。戻り値 = 取り込みに成功したか (失敗は次 hello で自然リトライ)。
   */
  readonly ingestEvent: (event: Record<string, unknown>) => Promise<boolean>;
  /** 現在時刻 (注入可・既定 Date.now ベースの ISO)。合成イベントの timestamp に使う。 */
  readonly now?: () => string;
}

export class ApprovalReconciler {
  private readonly store: ReconcileStoreView;
  private readonly ingestEvent: (event: Record<string, unknown>) => Promise<boolean>;
  private readonly now: () => string;
  /** fold 完了前の連続 hello による二重合成を防ぐ in-flight dedup (request_id 単位)。 */
  private readonly inFlight = new Set<string>();
  /** 同時実行中の reconcile 数 (SEC-3 R2 並行ガード)。 */
  private running = 0;

  constructor(opts: ApprovalReconcilerOptions) {
    this.store = opts.store;
    this.ingestEvent = opts.ingestEvent;
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  /** in-flight の合成件数 (テスト/監視: dedup と解放を pin する)。 */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /** 同時実行中の reconcile 数 (テスト/監視: 並行ガードを pin する)。 */
  get runningCount(): number {
    return this.running;
  }

  /**
   * ApprovalReconcileSignal を処理する。DB の pending のうち「宣言に無く」かつ「watermark より
   * 古い」request_id を合成 cancel で非 actionable 化する。失敗は握り潰す (best-effort・次 hello
   * で再試行される)。同時実行が上限に達していれば signal を捨てる (SEC-3 R2)。
   */
  async reconcile(signal: ApprovalReconcileSignal): Promise<void> {
    if (this.running >= MAX_CONCURRENT_RECONCILES) return;
    this.running += 1;
    try {
      await this.reconcileInner(signal);
    } finally {
      this.running -= 1;
    }
  }

  private async reconcileInner(signal: ApprovalReconcileSignal): Promise<void> {
    let rows: Awaited<ReturnType<ReconcileStoreView["pendingApprovalsForSessions"]>>;
    try {
      rows = await this.store.pendingApprovalsForSessions(signal.sessionIds);
    } catch {
      return; // DB 読取り失敗 → 何も消さない (fail-safe)。
    }
    const watermark = signal.receivedAt - RECONCILE_WATERMARK_MS;
    for (const row of rows) {
      for (const { request_id: requestId, requested_at: requestedAt } of row.requests) {
        if (signal.activeRequestIds.has(requestId)) continue; // sidecar 側で生存 → 維持 (受入#6)。
        // QA-1/TDA-5 (R2): 宣言スナップショット後に生まれた pending は stale ではない。
        // requested_at が読めない場合も消さない (NaN 比較は false → skip・fail-safe)。
        const requestedMs = Date.parse(requestedAt);
        if (!(requestedMs < watermark)) continue;
        if (this.inFlight.has(requestId)) continue; // 連続 hello の二重合成防止。
        this.inFlight.add(requestId);
        try {
          const synthetic = buildSyntheticApprovalCancel(row, requestId, this.now());
          // SEC-4 (R2): backend 合成 producer の strict 検証 (sidecar assertPayloadConsistency と
          // 対称)。ingress parseEvent は looseObject 素通しゆえ、ここで落とさないと closed enum
          // 契約が実経路のどこにも存在しない。不整合は ingest しない (fail-safe・構造的には
          // builder が固定 literal を書くため到達不能 — 将来の編集ミスを止める床)。
          if (!EventPayload.safeParse(synthetic.payload).success) continue;
          await this.ingestEvent(synthetic);
        } catch {
          // 取り込み失敗は無視 (DB pending は残る → 次 hello で再試行)。
        } finally {
          this.inFlight.delete(requestId);
        }
      }
    }
  }
}
