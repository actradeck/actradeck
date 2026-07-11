"use client";

/**
 * Audit coverage パネル (ADR 019f4cdb 後続 UI スライス・frontend.md「観測された作業状態のみ表示」).
 *
 * 「欠落を検知できない audit は弱い」— external adapter は at-most-once / silent-drop ゆえ、
 * per-provider の **最終受信からの経過 (= 監査できていない時間)** を compact に可視化し gap を正直に出す。
 * 表示は実観測 (endpoint 応答・event-model 正準 parse 済) のみ。架空状態を作らない。
 *
 * NO-RAW: provider は slug 検証済み・時刻は generated_at 基準の相対経過 (生 ISO を素出ししない)。
 * gap severity は色 **と語** の二重符号 (a11y)。null gap (非稼働/無受信) は警告しない (誤警報しない)。
 *
 * seq-drop chip (ADR 019f4cdb Phase2): client 申告 seq に穴があるとき ("≥N dropped?" と **hedged**) 表示する。
 * gap severity とは独立の信号で、**「下限」ゆえ真の欠落はこれ以上ありうる** (末尾/先頭 drop は検知不能)。
 * `seq_missing_lower_bound === null` (seq-bearing 無し) / `0` (穴なし) は表示しない (誤警報しない)。
 *
 * seq-suppressed 診断 (SEC-6): `seq_suppressed_session_count > 0` のとき控えめ (muted) に "N seq-suppressed"
 * を併記する。密性違反 (非密カウンタ or 過半を失う実大量 drop) で欠落信号を抑制した session 数で、
 * severity には連動しない純診断 (欠落 chip が 0/非表示でも出うる)。0 は非表示。
 */
import type { AuditCoverageReport } from "@actradeck/event-model";

import { useLocale } from "./LocaleProvider";
import {
  type GapSeverity,
  compactDuration,
  formatSeqDrop,
  gapSeverity,
  relativeReceivedAge,
} from "./audit-coverage-display";
import type { MessageKey } from "./i18n/messages";

/** warn/critical のみ語ラベルを出す (ok/idle は非警告 = ラベルなし)。 */
const STATUS_KEY: Partial<Record<GapSeverity, MessageKey>> = {
  warn: "audit.coverage.status.warn",
  critical: "audit.coverage.status.critical",
};

export interface AuditCoveragePanelProps {
  /** 検証済みレポート (未取得 or provider ゼロなら描画しない)。 */
  readonly report: AuditCoverageReport | null;
  /** 最終成功 fetch からの経過 ms (use-audit-coverage 由来・成功前は null)。 */
  readonly staleForMs?: number | null;
  /** 表示中の値が古い (最終成功から STALE 閾値超) = coverage API に到達できていない。 */
  readonly isStale?: boolean;
  /** 一度も coverage を取得できていない (連続失敗) = API 到達不能。 */
  readonly unreachable?: boolean;
}

/**
 * per-provider 行を compact に描画する。
 *
 * staleness の可視化 (誤安心の是正):
 *  - `report === null && unreachable` → 従来は無描画だったが、**「到達不能」警告行を描画**する
 *    (fetch 失敗は架空状態でなく観測事実。空 = 正常、と誤読させない)。
 *  - `report !== null && isStale` → 先頭に **stale バナー** (最終成功からの経過を明示) を出し
 *    section に `data-stale` を付け rows を CSS で減光する。行の severity 計算は変更しない
 *    (バナーが優先信号)。
 *  - fresh (isStale=false・unreachable=false) 時は表示完全不変 (既存挙動を回帰で守る)。
 *
 * それ以外で report が null / providers 空なら **何も描画しない** (架空の枠を出さない)。
 * 各行: provider slug / 稼働数 / 最終受信の相対経過 / gap 警告バッジ (warn=amber・critical=red・語ラベル併記)。
 */
export function AuditCoveragePanel({
  report,
  staleForMs = null,
  isStale = false,
  unreachable = false,
}: AuditCoveragePanelProps) {
  const { t } = useLocale();
  if (report === null || report.providers.length === 0) {
    // 未取得だが連続失敗で到達不能: 観測事実 (fetch 失敗) として警告行だけ描画する。
    if (report === null && unreachable) {
      return (
        <section
          className="ad-coverage ad-coverage--unreachable"
          data-testid="coverage-unreachable"
          aria-label="audit coverage"
        >
          <h3 className="ad-coverage__title">{t("audit.coverage.title")}</h3>
          <p className="ad-coverage__unreachable" role="status">
            {t("audit.coverage.unreachable")}
          </p>
        </section>
      );
    }
    return null;
  }
  const staleAge = staleForMs !== null ? compactDuration(staleForMs) : null;
  return (
    <section
      className="ad-coverage"
      data-testid="audit-coverage"
      aria-label="audit coverage"
      data-stale={isStale ? "true" : undefined}
    >
      {isStale ? (
        <p className="ad-coverage__stale-banner" data-testid="coverage-stale-banner" role="status">
          {t("audit.coverage.staleBanner", { age: staleAge ?? t("common.dash") })}
        </p>
      ) : null}
      <h3 className="ad-coverage__title">{t("audit.coverage.title")}</h3>
      <ul className="ad-coverage__rows">
        {report.providers.map((p) => {
          const severity = gapSeverity(p.gap_candidate_ms);
          const age = relativeReceivedAge(p.last_received_at, report.generated_at);
          const statusKey = STATUS_KEY[severity];
          const ageText =
            p.last_received_at === null
              ? t("audit.coverage.noEvents")
              : age !== null
                ? t("audit.coverage.age", { age })
                : t("common.dash");
          // seq-drop chip: null/0 は null (非表示)。cap 超は `≥N+ dropped?` (SEC-1・桁溢れ防止)。
          const seqDrop = formatSeqDrop(p.seq_missing_lower_bound);
          return (
            <li
              key={p.provider}
              className="ad-coverage__row"
              data-testid={`coverage-row-${p.provider}`}
              data-severity={severity}
            >
              <span className="ad-coverage__provider">{p.provider}</span>
              <span className="ad-coverage__sessions">
                {t("audit.coverage.sessions", { count: p.active_session_count })}
              </span>
              <span className="ad-coverage__age" data-testid={`coverage-age-${p.provider}`}>
                {ageText}
              </span>
              {statusKey !== undefined ? (
                <span
                  className="ad-coverage__status"
                  data-testid={`coverage-status-${p.provider}`}
                  role="status"
                >
                  {t(statusKey)}
                </span>
              ) : null}
              {seqDrop !== null ? (
                <span
                  className="ad-coverage__seqdrop"
                  data-testid={`coverage-seqdrop-${p.provider}`}
                  role="status"
                >
                  {t(seqDrop.capped ? "audit.coverage.seqDropCapped" : "audit.coverage.seqDrop", {
                    count: seqDrop.count,
                  })}
                </span>
              ) : null}
              {p.seq_suppressed_session_count > 0 ? (
                <span
                  className="ad-coverage__seqsuppressed"
                  data-testid={`coverage-seqsuppressed-${p.provider}`}
                  title={t("audit.coverage.seqSuppressed.title")}
                >
                  {t("audit.coverage.seqSuppressed", { count: p.seq_suppressed_session_count })}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
