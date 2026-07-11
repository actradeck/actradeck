"use client";

/**
 * ADR 019f4cdb 後続 UI スライス: per-provider 監査カバレッジの pull フック。
 *
 * same-origin `/realtime/audit/coverage` を fetch し、cockpit の「Audit coverage」パネルへ
 * per-provider の最終受信 + gap 候補を供給する。**token は載せない** — BFF (custom server) が
 * server-side で Bearer を付与し backend へ中継する (use-readiness / use-daemons と同方針)。
 *
 * NO-RAW: 応答は必ず event-model の正準 `parseAuditCoverageReportWire` で検証射影してから使う
 * (既知 field のみ抽出・非 slug provider row を drop・非 ISO 時刻を落とす・余剰 field を構造的に
 * 落とす)。奇形/取得失敗は last-known を保持し flicker を避ける (fail-safe)。
 *
 * accepted staleness: coverage は pull 時点のスナップショット。POLL_MS は use-readiness / use-daemons
 * と揃えた控えめな間隔 (gap 検知は分オーダーの閾値ゆえ秒精度の追従は不要)。
 */
import { useEffect, useState } from "react";

import { type AuditCoverageReport, parseAuditCoverageReportWire } from "@actradeck/event-model";

const COVERAGE_PATH = "/realtime/audit/coverage";
/** 控えめな再取得間隔 (use-readiness / use-daemons と同値・gap 閾値は分オーダー)。test も参照する。 */
export const COVERAGE_POLL_MS = 20_000;

export interface UseAuditCoverageResult {
  /** 直近の検証済みレポート (未取得は null)。 */
  readonly coverage: AuditCoverageReport | null;
}

export function useAuditCoverage(opts: {
  readonly enabled: boolean;
  readonly refreshKey?: number;
}): UseAuditCoverageResult {
  const { enabled, refreshKey = 0 } = opts;
  const [coverage, setCoverage] = useState<AuditCoverageReport | null>(null);

  useEffect(() => {
    if (!enabled) {
      setCoverage(null); // 非表示時は破棄 (メモリ衛生・use-readiness 同方針)。
      return;
    }
    let cancelled = false;
    const pull = (): void => {
      void fetch(COVERAGE_PATH, { headers: { accept: "application/json" } })
        .then(async (res) => {
          if (!res.ok) throw new Error(`audit coverage ${res.status}`);
          return (await res.json()) as unknown;
        })
        .then((data) => {
          const parsed = parseAuditCoverageReportWire(data);
          // undefined (奇形応答・generated_at 不正) は last-known を保持 (flicker 回避)。
          if (!cancelled && parsed !== undefined) setCoverage(parsed);
        })
        .catch(() => {
          // 取得失敗 (一時的) は last-known を保持。恒久障害なら次 pull まで stale だが誤警報は作らない。
        });
    };
    pull();
    const timer = setInterval(pull, COVERAGE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [enabled, refreshKey]);

  return { coverage };
}
