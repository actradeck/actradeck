"use client";

/**
 * ADR 019f1582: 接続中 daemon の id 一覧 pull フック (承認ポリシー設定の relay-target 供給用)。
 *
 * same-origin `/realtime/daemons` を fetch する。**token は載せない** — BFF (custom server) が server-side で
 * Bearer を付与して backend へ中継する (ADR 019e92b7・use-wall-feed と同方針)。backend は relay 可能
 * (open + controlToken 受領済み) な daemon の id のみ返す (id は randomUUID で credential でない・NO-RAW)。
 *
 * 用途: エージェントセッション未接続でも、常時接続の attach daemon 経由で per-repo policy を設定する導線。
 * CockpitBoard が session 優先・daemon フォールバックで relay-target を選ぶ。daemonId は per-connection 採番
 * ゆえ daemon 再接続で変わる。`enabled` の間は控えめな間隔で再 pull して churn を吸収する (reconnect storm を
 * 避ける緩やかな間隔・frontend.md)。policy は machine-global ゆえどの daemon に届いても fan-out で収束する。
 */
import { useCallback, useEffect, useState } from "react";

const DAEMONS_PATH = "/realtime/daemons";
/** churn 吸収用の控えめな再取得間隔 (daemon は長命ゆえ頻繁である必要はない)。 */
const POLL_MS = 20_000;

/** 応答 `{ daemons: [{id}] }` を寛容に検証し id 文字列のみ抽出する (use-wall-feed と同方針)。 */
export function parseDaemons(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null) return [];
  const list = (raw as { daemons?: unknown }).daemons;
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const d of list) {
    if (typeof d === "object" && d !== null) {
      const id = (d as { id?: unknown }).id;
      if (typeof id === "string" && id.length > 0) out.push(id);
    }
  }
  return out;
}

export interface UseDaemonsResult {
  /** 接続中 daemon の id 群 (決定的順序にソート済・「先頭」を安定選択するため)。 */
  readonly daemonIds: readonly string[];
  /** 手動再取得 (mutation が daemon not registered で失敗したとき等に呼ぶ)。 */
  readonly refresh: () => void;
}

export function useDaemons(opts: {
  readonly enabled: boolean;
  readonly refreshKey?: number;
}): UseDaemonsResult {
  const { enabled, refreshKey = 0 } = opts;
  const [daemonIds, setDaemonIds] = useState<readonly string[]>([]);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) {
      setDaemonIds([]); // 非表示時は破棄 (メモリ衛生・use-wall-feed 同方針)。
      return;
    }
    let cancelled = false;
    const pull = (): void => {
      void fetch(DAEMONS_PATH, { headers: { accept: "application/json" } })
        .then(async (res) => {
          if (!res.ok) throw new Error(`daemons ${res.status}`);
          return (await res.json()) as unknown;
        })
        .then((data) => {
          // 決定的順序へソート (複数 daemon 時に「先頭」を安定選択し read 一貫性を緩和)。
          if (!cancelled) setDaemonIds([...parseDaemons(data)].sort());
        })
        .catch(() => {
          // 取得失敗 (一時的) は last-known を保持して flicker を避ける。daemon が本当に消えたら次回 pull で
          // 空/新リストへ収束する。stale id を引いて mutation が 404 (daemon not registered) でも安全側
          // (relay されず・error 表示)・refresh() で即再取得できる。
        });
    };
    pull();
    const timer = setInterval(pull, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, refreshKey, nonce]);

  return { daemonIds, refresh };
}
