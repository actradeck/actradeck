"use client";

/**
 * セッション詳細4ペイン (ADR 019ea4ba 段階1) の素材 events を取得するフック.
 *
 * 既存 `GET /realtime/sessions/:id/events` (ReplayEventDTO・昇順) を **そのまま再利用**する
 * (新 endpoint/DTO を作らない)。タイムライン/現在作業/右 risk ペインが同じ 1 配列を共有する。
 *
 * 設計:
 *  - 選択 session が変わるたびに先頭から取得し直す (世代ゲートで stale 応答を捨てる)。
 *  - 上限ページまで cursor を辿り「最新側」を含める (現在作業ビューは末尾=最新を見るため)。
 *  - 失敗は握り、空配列のまま (UI は「まだイベントがありません」を出す・架空状態を出さない)。
 *  - 本フックは表示素材の取得のみ。redaction は backend/sidecar 契約に委ねる (再取得・本文展開なし)。
 *
 * 注: live 更新の差分追記は段階2 (subscribe の delta.detail を timeline へ追記)。段階1 は
 * 選択時 + 明示再取得で十分 (MVP・KPI は「いま何をしているか」を state+最新行で満たす)。
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { parseReplayEventsPage } from "../replay/parse-replay";
import { createReplayRequestGate } from "../replay/replay-load";

import type { ReplayEventDTO } from "../realtime/contract";

const PAGE_LIMIT = 200;
/** 段階1 の取得上限ページ (200*10=2000 行)。長尺は段階2 の仮想スクロール/差分追記で扱う。 */
const MAX_PAGES = 10;

export interface UseSessionEventsResult {
  readonly events: readonly ReplayEventDTO[];
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly reload: () => void;
}

export function useSessionEvents(sessionId: string | null): UseSessionEventsResult {
  const [events, setEvents] = useState<readonly ReplayEventDTO[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const gate = useRef<ReturnType<typeof createReplayRequestGate> | null>(null);
  gate.current ??= createReplayRequestGate();

  const load = useCallback(async (sid: string, generation: number): Promise<void> => {
    const requestGate = gate.current!;
    if (!requestGate.tryStart(generation)) return;
    setLoading(true);
    setError(undefined);
    try {
      const acc: ReplayEventDTO[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const qs = new URLSearchParams({ limit: String(PAGE_LIMIT) });
        if (cursor) qs.set("cursor", cursor);
        const res = await fetch(`/realtime/sessions/${encodeURIComponent(sid)}/events?${qs}`);
        if (!requestGate.isCurrent(generation)) return;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const parsed = parseReplayEventsPage(await res.json());
        if (!requestGate.isCurrent(generation)) return;
        if (!parsed) throw new Error("invalid events response");
        acc.push(...parsed.events);
        if (!parsed.has_more || !parsed.next_cursor) break;
        cursor = parsed.next_cursor;
      }
      if (!requestGate.isCurrent(generation)) return;
      setEvents(acc);
    } catch (err) {
      if (requestGate.isCurrent(generation)) {
        setError((err as Error).message);
        setEvents([]);
      }
    } finally {
      if (requestGate.isCurrent(generation)) setLoading(false);
      requestGate.finish(generation);
    }
  }, []);

  useEffect(() => {
    const generation = gate.current!.nextGeneration();
    setEvents([]);
    setError(undefined);
    if (sessionId) void load(sessionId, generation);
  }, [load, sessionId]);

  const reload = useCallback(() => {
    if (sessionId) void load(sessionId, gate.current!.nextGeneration());
  }, [load, sessionId]);

  return { events, loading, error, reload };
}
