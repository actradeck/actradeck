"use client";

/**
 * Live Wall の横断フィード pull フック (ADR 019ead7a D1)。
 *
 * same-origin `/realtime/wall` を fetch する。**token は載せない** — BFF (custom server) が
 * server-side で Bearer を付与して backend `/realtime/wall` へ中継する (ADR 019e92b7)。
 * backend は connected な live session の直近 N events だけを ReplayEventDTO allow-list 投影で返す。
 *
 * - `enabled=false` (Wall 非表示) のときは fetch せず保持中のフィードも破棄する (メモリ衛生)。
 * - `refreshKey` の変化 (delta.list の last_event_at 進行 nudge) で再 fetch する。
 * - `refresh()` は手動再取得。
 * 単一選択購読 (use-realtime) は触らない: Wall は pull のみで供給する (INV-WALL-SINGLE-SELECT-INTACT)。
 */
import { useCallback, useEffect, useState } from "react";

import type { ReplayEventDTO, WallLane } from "../realtime/contract";

const WALL_PATH = "/realtime/wall";

function isString(v: unknown): v is string {
  return typeof v === "string";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * `/realtime/wall` 応答を **寛容に** 検証する (LIVE-FOUND-3 教訓 019e98fc: 必須キーを増やしすぎて
 * 全黙殺しない)。session_id 無しレーン・event_id/timestamp 無し event のみ落とす。events は backend が
 * allow-list 投影済 (raw payload は存在しない) ため、最小キー検証後はそのまま通す。
 */
export function parseWallResponse(raw: unknown): WallLane[] {
  if (!isRecord(raw)) return [];
  const lanes = (raw as { lanes?: unknown }).lanes;
  if (!Array.isArray(lanes)) return [];
  const out: WallLane[] = [];
  for (const lane of lanes) {
    if (!isRecord(lane)) continue;
    const session = lane.session;
    if (!isRecord(session) || !isString(session.session_id)) continue;
    const rawEvents = lane.events;
    if (!Array.isArray(rawEvents)) continue;
    const events: ReplayEventDTO[] = [];
    for (const ev of rawEvents) {
      if (!isRecord(ev) || !isString(ev.event_id) || !isString(ev.timestamp)) continue;
      events.push(ev as unknown as ReplayEventDTO);
    }
    out.push({ session: session as unknown as WallLane["session"], events });
  }
  return out;
}

export interface UseWallFeedResult {
  readonly lanes: readonly WallLane[];
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly refresh: () => void;
}

export function useWallFeed(opts: {
  readonly enabled: boolean;
  readonly refreshKey?: number;
}): UseWallFeedResult {
  const { enabled, refreshKey = 0 } = opts;
  const [lanes, setLanes] = useState<readonly WallLane[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) {
      // 非表示時は保持中のフィードを破棄 (メモリ衛生・Approval Inbox 同方針)。
      setLanes([]);
      setError(undefined);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    void fetch(WALL_PATH, { headers: { accept: "application/json" } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`wall ${res.status}`);
        return (await res.json()) as unknown;
      })
      .then((data) => {
        if (!cancelled) setLanes(parseWallResponse(data));
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "wall fetch failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, refreshKey, nonce]);

  return { lanes, loading, error, refresh };
}
