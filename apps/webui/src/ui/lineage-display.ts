/**
 * run lineage の**表示用**派生 (純関数・ADR 0014 Phase 3c・decision 019fd250)。
 *
 * 消費者要件 (ADR 0014 Phase 3 / carryover TDA-1・TDA-3):
 *  - continued-from は **session_id で解決**する。resumed_from_session_id は宣言値でありうる
 *    (Codex rollout の forked_from_id): 参照先は未観測・安定会話 id でありうる。
 *  - 参照先が未観測 = **linked-unknown** 表示 (orphan/エラー化しない・宣言エッジを観測済みと
 *    偽らない)。
 *  - resumed_from == 自 session_id (rollout で stable id 欠落時 forked_from_id == file id で
 *    成立しうる) は **self-loop 禁止**でエッジ非表示。
 *  - lineage フィールド欠落 (attach 大半・裁定 019f81d5: reap 跨ぎ best-effort) は
 *    **何も主張しない** (undefined → セクション非表示。「連結不明」を常設ラベルにしない)。
 *
 * continuation は event-model の正準 `resolveContinuation` (stored-first・矛盾値禁止則) を
 * ここで唯一の消費点として通す。lifecycle 表示は従来どおり state が権威で、end_kind から
 * 合成しない (本モジュールは run 境界メタの表示派生のみを担う)。
 */
import { resolveContinuation } from "@actradeck/event-model";

import type { Continuation } from "@actradeck/event-model";
import type { SessionDetail } from "../realtime/contract";

/** continued-from エッジの表示形。resolved = 観測済み run へ解決 / linked-unknown = 宣言のみ。 */
export interface ContinuedFromDisplay {
  readonly kind: "resolved" | "linked-unknown";
  readonly sessionId: string;
}

/**
 * continued-from エッジの表示派生。エッジ無し / self-loop は undefined (非表示)。
 * resolved 判定は backend の resumed_from_observed (sessions EXISTS) が根拠。
 */
export function deriveContinuedFrom(
  detail: Pick<SessionDetail, "session_id" | "resumed_from_session_id" | "resumed_from_observed">,
): ContinuedFromDisplay | undefined {
  const from = detail.resumed_from_session_id;
  if (from === undefined || from.length === 0) return undefined;
  if (from === detail.session_id) return undefined; // self-loop 禁止 (TDA-1)
  return {
    kind: detail.resumed_from_observed === true ? "resolved" : "linked-unknown",
    sessionId: from,
  };
}

/**
 * continuation の resolved 値 (stored-first・decision 019fd250)。表示はこの 1 値のみで、
 * stored と derived を並記しない。terminal 前 (state 非 terminal) は undefined = 非表示。
 */
export function resolvedContinuationOf(
  detail: Pick<SessionDetail, "state" | "recoverability">,
): Continuation | undefined {
  return resolveContinuation(detail.recoverability, detail.state);
}

/**
 * run 系譜チェーンの表示有無: 2 run 以上あるときのみ (backend が単独 run をキー落とし済みだが、
 * 表示層でも同じ床を張る)。自 run の位置は session_id 一致で呼び出し側がマークする。
 */
export function hasLineageChain(detail: Pick<SessionDetail, "lineage_runs">): boolean {
  return (detail.lineage_runs?.length ?? 0) >= 2;
}
