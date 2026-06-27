/**
 * list フレーム → ListState 反映 + onListDelta 副作用の **純経路** (QA-1 unblock).
 *
 * 背景: 純関数 (computeNotifications/engine) は緑でも、use-realtime.handleFrame の
 * 「snapshot.list は onListDelta を呼ばない / delta.list は **反映前 prev** を渡し
 * ちょうど 1 回呼ぶ」という**配線**が無監視だった (= 偽ゲート)。レンダラ無しの node で
 * この配線を赤テスト化するため、handleFrame の list ブランチを本純関数へ抽出し、
 * use-realtime.ts はこの 1 経路へ委譲する (単一出所)。
 *
 * 契約 (INV-NOTIFY-SNAPSHOT-NOT-FIRED が pin する):
 *  - snapshot.list: state を置換するのみ。**onListDelta は呼ばない** (既存 true の一斉発火回避)。
 *  - delta.list: prev = **反映前** state の同 session_id エントリ (undefined 可) を取り、state を
 *    更新したうえで onListDelta(prev, curr) を **ちょうど 1 回** 呼ぶ。
 */
import { applyListDelta, applySnapshotList, type ListState } from "../realtime/list-reducer";

import type { SessionListItem } from "../realtime/contract";

/** list フレームの最小形 (backend 正典 ServerFrame の list ブランチ subset)。 */
export type ListFrame =
  | { readonly type: "snapshot.list"; readonly sessions: readonly SessionListItem[] }
  | { readonly type: "delta.list"; readonly session: SessionListItem };

export type OnListDelta = (prev: SessionListItem | undefined, curr: SessionListItem) => void;

/**
 * list フレームを現在 state へ反映し、delta のときだけ onListDelta を呼ぶ。次 state を返す。
 * **副作用 (onListDelta) は state 計算の後に 1 回だけ**呼ぶ (setState reducer 内では呼ばない設計)。
 */
export function applyListFrame(
  state: ListState,
  frame: ListFrame,
  onListDelta: OnListDelta | undefined,
): ListState {
  if (frame.type === "snapshot.list") {
    // snapshot は通知の起点にしない (onListDelta を呼ばない)。state のみ置換。
    return applySnapshotList(frame.sessions);
  }
  // delta.list: prev は **反映前** state から取得 → state 更新 → onListDelta(prev, curr) 1 回。
  const prev = state.items.get(frame.session.session_id);
  const next = applyListDelta(state, frame.session);
  onListDelta?.(prev, frame.session);
  return next;
}
