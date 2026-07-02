"use client";

/**
 * ADR 019f1972 §2b (decision 019f1a29): first-run readiness pull フック。
 *
 * same-origin `/realtime/readiness` を fetch し、cockpit の真の空状態パネルが per-agent ✓/✗ を出すための
 * 観測サマリ (観測 daemon 数 + Claude/Codex の配線状態) を供給する。**token は載せない** — BFF (custom server)
 * が server-side で Bearer を付与して backend へ中継する (use-daemons / use-wall-feed と同方針)。
 *
 * NO-RAW: 応答は boolean + 非負整数のみ。agent 観測可能性は event-model の正準 `parseAgentVisibilityWire` で
 * 再検証射影し (boolean のみ抽出・余剰 field を構造的に落とす)、daemonCount は非負 number へ安全抽出する。
 * 不正/欠落は null or 0 へ縮退 (fail-safe・false positive を作らない)。
 *
 * accepted staleness: visibility は daemon の hello 時点値ゆえ「リアルタイム」ではない (hook を後から入れても
 * 次 reannounce / 再接続まで stale)。真の証明はセッション出現で panel が消えること。よって POLL_MS は控えめ。
 */
import { useCallback, useEffect, useState } from "react";

import { type AgentVisibilityWire, parseAgentVisibilityWire } from "@actradeck/event-model";

const READINESS_PATH = "/realtime/readiness";
/** churn 吸収用の控えめな再取得間隔 (visibility は hello 時点値で頻繁更新しない・use-daemons と同値)。 */
const POLL_MS = 20_000;

/** readiness パネルが描画に使う観測サマリ (NO-RAW: boolean + 非負整数のみ)。 */
export interface AgentReadiness extends AgentVisibilityWire {
  /** 観測している (open な) daemon の総数。 */
  readonly daemonCount: number;
}

/**
 * 応答 `{ daemonCount, claude:{...}, codex:{...} }` を寛容に検証する (use-daemons の parseDaemons と同方針)。
 * agent 観測可能性は正準パーサで射影 (malformed は全 false へ縮退)・daemonCount は非負 number へ安全抽出。
 * 形が壊れている (非 object) ときのみ null (= 未取得扱い)。
 */
export function parseReadiness(raw: unknown): AgentReadiness | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  // 正準パーサで boolean のみ抽出。sub-object 欠落でも全 false の安全形を返す (未配線=安全側)。
  const vis = parseAgentVisibilityWire(obj) ?? {
    claude: { binaryOnPath: false, anyHook: false },
    codex: { binaryOnPath: false, rolloutDirResolved: false },
  };
  const rawCount = obj.daemonCount;
  const daemonCount =
    typeof rawCount === "number" && Number.isFinite(rawCount) && rawCount >= 0
      ? Math.floor(rawCount)
      : 0;
  return { daemonCount, claude: vis.claude, codex: vis.codex };
}

export interface UseReadinessResult {
  /** 観測サマリ (未取得は null)。 */
  readonly readiness: AgentReadiness | null;
  /** 手動再取得。 */
  readonly refresh: () => void;
}

export function useReadiness(opts: {
  readonly enabled: boolean;
  readonly refreshKey?: number;
}): UseReadinessResult {
  const { enabled, refreshKey = 0 } = opts;
  const [readiness, setReadiness] = useState<AgentReadiness | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) {
      setReadiness(null); // 非表示時は破棄 (メモリ衛生・use-daemons 同方針)。
      return;
    }
    let cancelled = false;
    const pull = (): void => {
      void fetch(READINESS_PATH, { headers: { accept: "application/json" } })
        .then(async (res) => {
          if (!res.ok) throw new Error(`readiness ${res.status}`);
          return (await res.json()) as unknown;
        })
        .then((data) => {
          const parsed = parseReadiness(data);
          // null (奇形応答) は last-known を保持 (flicker 回避)。有効パースのみ反映。
          if (!cancelled && parsed !== null) setReadiness(parsed);
        })
        .catch(() => {
          // 取得失敗 (一時的) は last-known を保持。daemon が本当に消えたら次回 pull で 0 へ収束する。
        });
    };
    pull();
    const timer = setInterval(pull, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, refreshKey, nonce]);

  return { readiness, refresh };
}
