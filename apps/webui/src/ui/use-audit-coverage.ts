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
 * **staleness 可視化 (誤安心の是正)**: 取得失敗/奇形を単に握り潰すと「古い正常値」を無期限に
 * 老化させず表示し続け、恒久障害の監査盤で**誤った安心**を作る。そこで last-known を保持しつつ
 * (flicker 回避は正しい)、**最終成功からの経過**を簿記し可視化する。経過は同一 client 時計の
 * 差分 (`Date.now() - lastSuccess`) ゆえ clock skew に依存しない。ポーリング interval は API 停止中も
 * 回り続けるので、各失敗 pull が state を更新 → 再レンダーが保証される。
 *
 * **fail-visible (SEC-1)**: settle しない pull (backend hang / half-open TCP) では成功/失敗の
 * いずれも発火せず staleness が凍結しうる。これを防ぐため per-pull の AbortController timeout
 * (`COVERAGE_FETCH_TIMEOUT_MS`) を張り、abort→fetch reject→onStale へ確実に落とす (自己完結)。
 *
 * accepted staleness: coverage は pull 時点のスナップショット。POLL_MS は use-readiness / use-daemons
 * と揃えた控えめな間隔 (gap 検知は分オーダーの閾値ゆえ秒精度の追従は不要)。
 */
import { useEffect, useRef, useState } from "react";

import { type AuditCoverageReport, parseAuditCoverageReportWire } from "@actradeck/event-model";

const COVERAGE_PATH = "/realtime/audit/coverage";
/** 控えめな再取得間隔 (use-readiness / use-daemons と同値・gap 閾値は分オーダー)。test も参照する。 */
export const COVERAGE_POLL_MS = 20_000;
/**
 * per-pull の fetch timeout (SEC-1・fail-visible 自己完結化)。settle しない pull (backend hang /
 * half-open TCP) では onFresh/onStale とも呼ばれず staleness が凍結する (undici headersTimeout ~5min
 * 既定への暗黙依存・browser→proxy 脚は unbounded)。POLL と同値 = 次 pull 発火前に必ず settle させ、
 * abort→fetch reject→既存 .catch→onStale 経路へ乗せる (新規分岐を増やさない)。test も参照する。
 */
export const COVERAGE_FETCH_TIMEOUT_MS = COVERAGE_POLL_MS;
/**
 * 最終成功からこの時間を超えて新鮮データを得られなければ「stale」とみなす閾値 (strict `>`)。
 * POLL の 3 倍。strict `>` ゆえ、ちょうど 3×POLL (= 3 回目の失敗 pull) では**まだ stale でなく**、
 * **4 回目の連続失敗 pull (~80s) で発火**する (一過性の 1〜3 回失敗では警告しない)。test も参照する。
 */
export const COVERAGE_STALE_MS = 3 * COVERAGE_POLL_MS;
/** 一度も成功せずこの回数連続で失敗したら「到達不能」とみなす閾値 (初回起動時の一時失敗を除外)。 */
const UNREACHABLE_FAILURE_THRESHOLD = 3;

export interface UseAuditCoverageResult {
  /** 直近の検証済みレポート (未取得は null・取得後は last-known を保持)。 */
  readonly coverage: AuditCoverageReport | null;
  /** 最終成功 fetch からの経過 ms (成功前は null・成功で 0 にリセット・失敗 pull ごとに増加)。 */
  readonly staleForMs: number | null;
  /** 一度でも成功済み ∧ 経過が STALE 閾値超 = 表示中の値が古い (バナーで警告する)。 */
  readonly isStale: boolean;
  /** 一度も成功なし ∧ 連続失敗が閾値以上 = coverage API へ到達できていない。 */
  readonly unreachable: boolean;
}

export function useAuditCoverage(opts: {
  readonly enabled: boolean;
  readonly refreshKey?: number;
}): UseAuditCoverageResult {
  const { enabled, refreshKey = 0 } = opts;
  const [coverage, setCoverage] = useState<AuditCoverageReport | null>(null);
  const [staleForMs, setStaleForMs] = useState<number | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  // 描画を跨いで保持する簿記 (render を誘発しない)。lastSuccess は「最終成功の client 時刻」、
  // failures は「未成功状態での連続失敗数」。refreshKey nudge では reset しない (last-known 維持)。
  const lastSuccessRef = useRef<number | null>(null);
  const failuresRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      // 非表示時は破棄 (メモリ衛生・use-readiness 同方針)。簿記も初期化する。
      setCoverage(null);
      setStaleForMs(null);
      setUnreachable(false);
      lastSuccessRef.current = null;
      failuresRef.current = 0;
      return;
    }
    let cancelled = false;
    /** 成功時: last-known を更新し staleness を 0 にリセット (回復)。 */
    const onFresh = (parsed: AuditCoverageReport): void => {
      if (cancelled) return;
      lastSuccessRef.current = Date.now();
      failuresRef.current = 0;
      setCoverage(parsed);
      setStaleForMs(0);
      setUnreachable(false);
    };
    /**
     * 「新鮮なデータを得られなかった」= 取得失敗 (reject / !ok) と奇形応答 (parse undefined) の**両方**。
     * last-known は保持 (flicker 回避) しつつ経過を計上し、恒久障害を可視化する (誤安心を作らない)。
     */
    const onStale = (): void => {
      if (cancelled) return;
      failuresRef.current += 1;
      if (lastSuccessRef.current !== null) {
        // 同一 client 時計の差分 = clock skew 非依存。interval が回る限り pull ごとに増加する。
        setStaleForMs(Date.now() - lastSuccessRef.current);
      } else {
        // 一度も成功していない: 連続失敗が閾値に達したら到達不能とみなす。
        setUnreachable(failuresRef.current >= UNREACHABLE_FAILURE_THRESHOLD);
      }
    };
    // 保留中の abort timer 群 (unmount / enabled=false / refreshKey 変更の cleanup で全 clear・timer リーク防止)。
    const pendingAbortTimers = new Set<ReturnType<typeof setTimeout>>();
    const pull = (): void => {
      // SEC-1: per-pull timeout。settle しない fetch を必ず abort→reject させ onStale 経路へ乗せる
      // (fail-visible 自己完結・undici 既定 timeout への暗黙依存を断つ)。
      const controller = new AbortController();
      const abortTimer = setTimeout(() => controller.abort(), COVERAGE_FETCH_TIMEOUT_MS);
      pendingAbortTimers.add(abortTimer);
      const settle = (): void => {
        clearTimeout(abortTimer);
        pendingAbortTimers.delete(abortTimer);
      };
      void fetch(COVERAGE_PATH, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      })
        .then(async (res) => {
          if (!res.ok) throw new Error(`audit coverage ${res.status}`);
          return (await res.json()) as unknown;
        })
        .then((data) => {
          const parsed = parseAuditCoverageReportWire(data);
          // undefined (奇形応答・generated_at 不正) は「新鮮データなし」として stale 計上する。
          if (parsed !== undefined) onFresh(parsed);
          else onStale();
        })
        .catch(() => {
          // 取得失敗 (reject / !res.ok / timeout abort) も stale 計上 (last-known は保持しつつ経過を可視化)。
          onStale();
        })
        .finally(() => {
          settle();
        });
    };
    pull();
    const timer = setInterval(pull, COVERAGE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
      for (const t of pendingAbortTimers) clearTimeout(t);
      pendingAbortTimers.clear();
    };
  }, [enabled, refreshKey]);

  // isStale は「成功済み (staleForMs 非 null) ∧ 経過が閾値超」で導出する (staleForMs が非 null ⇔ 成功済み)。
  const isStale = staleForMs !== null && staleForMs > COVERAGE_STALE_MS;
  return { coverage, staleForMs, isStale, unreachable };
}
