"use client";

/**
 * Live Wall のレーン並び順をユーザーが DnD / キーボードで決め、localStorage に永続化するフック。
 *
 * Wall は pull で定期再取得され lane 集合が変動するため、保存順を毎回 reconcileLaneOrder で
 * 現存セッションへ突き合わせる (既知は順序保持・新規は末尾・消滅は除去)。並べ替えは純関数
 * moveInOrder / moveByOffset に委譲し、本フックは状態保持と永続化のみ担う。
 * localStorage 不可 (プライベートモード等) でも throw せず、その場合は揮発順序で機能は維持する。
 */
import { useEffect, useState } from "react";

import { applyLaneOrder, moveByOffset, moveRelative, reconcileLaneOrder } from "./wall-display";

import type { DropPlace } from "./wall-display";
import type { WallLane } from "../realtime/contract";

const ORDER_KEY = "actradeck.wall.lane-order.v1";
const SEP = "";

function loadOrder(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(ORDER_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveOrder(order: readonly string[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ORDER_KEY, JSON.stringify(order));
  } catch {
    /* localStorage 不可は無視 (並びは揮発するが機能は保つ)。 */
  }
}

export interface WallOrderApi {
  /** 永続順 + reconcile を適用した表示順の lanes。 */
  readonly orderedLanes: WallLane[];
  /** DnD: drag 中の fromId を toId の前/後 (ドロップ位置) へ移動して永続化する。 */
  readonly reorder: (fromId: string, toId: string, place: DropPlace) => void;
  /** ライブ追従 DnD: 確定したプレビュー順 (現存 id の置換) をそのまま永続化する。 */
  readonly applyOrder: (next: readonly string[]) => void;
  /** キーボード代替: id を delta(±1) 移動して永続化する。 */
  readonly nudge: (id: string, delta: number) => void;
}

export function useWallLaneOrder(lanes: readonly WallLane[]): WallOrderApi {
  const [order, setOrder] = useState<string[]>(loadOrder);
  const presentIds = lanes.map((l) => l.session.session_id);
  const effective = reconcileLaneOrder(order, presentIds);
  const effectiveKey = effective.join(SEP);

  // 取得変化 (新規参入 / 消滅 / 並べ替え後) で正規化順を state と localStorage に反映する。
  // effective/lanes は毎レンダー派生のため、安定キー effectiveKey のみを依存にして churn を防ぐ
  // (effective はその key と 1:1 に決まるので stale 参照にならない)。
  useEffect(() => {
    setOrder((prev) => (prev.join(SEP) === effectiveKey ? prev : effective));
    saveOrder(effective);
  }, [effectiveKey]);

  const commit = (next: string[]): void => {
    setOrder(next);
    saveOrder(next);
  };

  return {
    orderedLanes: applyLaneOrder(lanes, effective),
    reorder: (fromId, toId, place) => commit(moveRelative(effective, fromId, toId, place)),
    // プレビュー順は現存 id の置換だが、競合取得との安全のため reconcile を通して確定する。
    applyOrder: (next) => commit(reconcileLaneOrder(next, presentIds)),
    nudge: (id, delta) => commit(moveByOffset(effective, id, delta)),
  };
}
