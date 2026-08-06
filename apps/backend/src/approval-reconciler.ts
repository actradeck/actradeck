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
 *  - 冪等: 合成が fold されると DB pending から当該 request_id が消えるため、後続 hello では
 *    そもそも stale として列挙されない。fold 完了前の連続 hello は in-flight dedup (request_id
 *    単位) で二重合成を防ぐ。
 *  - 宣言の検証 (型 / 上限 / 所有 session 限定) は SidecarRegistry.maybeEmitApprovalReconcile が
 *    担う (malformed は本 reconciler に届かない)。
 *
 * 既知エッジ (正直開示・decision 019fd705): sidecar のローカル store に未送信の実 resolved が
 * queue されたまま再接続した場合、合成 cancel と実 resolved が同一 request_id に対して両方
 * 監査トレイルへ残りうる (projection は 2 発目を no-op 除去するため表示は安全・情報は失われない)。
 */
import { newEventId } from "@actradeck/event-model";

import type { ApprovalReconcileSignal } from "./sidecar-registry.js";

/** reconcile が依存する最小 store 面 (IngestStore.pendingApprovalsForSessions の構造的部分型)。 */
export interface ReconcileStoreView {
  pendingApprovalsForSessions(sessionIds: readonly string[]): Promise<
    {
      session_id: string;
      provider: string;
      state: string | undefined;
      request_ids: string[];
    }[]
  >;
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

  constructor(opts: ApprovalReconcilerOptions) {
    this.store = opts.store;
    this.ingestEvent = opts.ingestEvent;
    this.now = opts.now ?? (() => new Date().toISOString());
  }

  /** in-flight の合成件数 (テスト/監視: dedup と解放を pin する)。 */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /**
   * ApprovalReconcileSignal を処理する。DB の pending のうち宣言に無い request_id を合成 cancel
   * で非 actionable 化する。失敗は握り潰す (best-effort・次 hello で再試行される)。
   */
  async reconcile(signal: ApprovalReconcileSignal): Promise<void> {
    let rows: Awaited<ReturnType<ReconcileStoreView["pendingApprovalsForSessions"]>>;
    try {
      rows = await this.store.pendingApprovalsForSessions(signal.sessionIds);
    } catch {
      return; // DB 読取り失敗 → 何も消さない (fail-safe)。
    }
    for (const row of rows) {
      for (const requestId of row.request_ids) {
        if (signal.activeRequestIds.has(requestId)) continue; // sidecar 側で生存 → 維持 (受入#6)。
        if (this.inFlight.has(requestId)) continue; // 連続 hello の二重合成防止。
        this.inFlight.add(requestId);
        try {
          await this.ingestEvent(this.buildSyntheticCancel(row, requestId));
        } catch {
          // 取り込み失敗は無視 (DB pending は残る → 次 hello で再試行)。
        } finally {
          this.inFlight.delete(requestId);
        }
      }
    }
  }

  /**
   * 合成 cancel イベントを構築する。
   * - provider = 当該 session の実 provider (偽装しない)。source = "external" (sidecar 収集でない
   *   backend 起点の合成であることを closed enum で正直に表す)。
   * - state = 現 state を保持 (状態遷移を合成で動かさない。state 欠落時は遷移的に無害な
   *   "running.model_wait" = 既存 resolved-deny の遷移先へ倒す)。
   * - payload は closed enum + request_id のみ (NO-RAW): decision=cancel / resolution_origin=
   *   relay_lost / delivery_status=not_sent。
   */
  private buildSyntheticCancel(
    row: { session_id: string; provider: string; state: string | undefined },
    requestId: string,
  ): Record<string, unknown> {
    return {
      event_id: newEventId(),
      provider: row.provider,
      source: "external",
      session_id: row.session_id,
      event_type: "tool.permission.resolved",
      state: row.state ?? "running.model_wait",
      timestamp: this.now(),
      summary: "承認 取消 (中継喪失)",
      payload: {
        kind: "tool.permission.resolved",
        request_id: requestId,
        decision: "cancel",
        resolution_origin: "relay_lost",
        delivery_status: "not_sent",
      },
    };
  }
}
