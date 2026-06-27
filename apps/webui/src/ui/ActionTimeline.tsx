"use client";

/**
 * アクション単位タイムライン (共有コンポーネント・設計裁定 019eb981).
 *
 * SessionDetail のタイムラインと SessionReplay のイベントリストで **行コンポーネントを共通化** する。
 * 行文法は `[時刻] [対象] [行為] [結果]`:
 *  - 対象は切詰めで隠さない (折返し)。
 *  - 解決済み承認は「承認 → 許可」等の過去形でトーンを落とす (未解決のみ警告)。
 *  - exit 0 は静か、非 0 は danger。
 * 行クリック (と Enter/Space) で当該 ActionUnit の詳細モーダルを開く。
 * raw イベント表示は既定オフのトグルで残す (デバッグ用・既定はアクション単位)。
 *
 * SEC: 表示する値は ActionUnit (= ReplayEventDTO allow-list 由来) のみ。生 payload 不参照。
 */
import { useId, useMemo, useState } from "react";

import { ActionDetailModal } from "./ActionDetailModal";
import {
  actionResult,
  actionVerb,
  autoAllowedLabel,
  commandOutcomeBadge,
  formatClock,
  formatCurrentAction,
  formatElapsed,
  isUnresolvedAttention,
  riskTone,
} from "./action-units-display";
import { foldActionUnits } from "./action-units";
import { useLocale } from "./LocaleProvider";
import { Tag } from "./kit";

import type { ActionUnit } from "./action-units";
import type { ReplayEventDTO } from "../realtime/contract";

/** 1 アクション行 (button 化・キーボード到達・行クリックで詳細)。 */
function ActionRow({ unit, onOpen }: { readonly unit: ActionUnit; readonly onOpen: () => void }) {
  const { t, locale } = useLocale();
  const verb = actionVerb(unit, locale);
  const result = actionResult(unit, locale);
  const outcome = commandOutcomeBadge(unit, locale);
  const elapsed = formatElapsed(unit.elapsedMs);
  const autoAllowed = autoAllowedLabel(unit, locale);
  const attention = isUnresolvedAttention(unit);
  const targetText = unit.target ?? t("action.target.none");

  return (
    <li
      className="ad-action-row"
      data-testid={`action-row-${unit.id}`}
      data-kind={unit.kind}
      data-attention={attention}
    >
      <button
        type="button"
        className="ad-action-row__btn"
        onClick={onOpen}
        aria-label={t("action.row.aria", { verb: verb.label, target: targetText })}
        title={t("action.row.openDetails")}
      >
        <time className="ad-action-row__time" dateTime={unit.startTime}>
          {formatClock(unit.startTime)}
        </time>
        {/* 対象: 切詰めず折返し (command 全文 / path / tool_name)。 */}
        <span
          className="ad-action-row__target"
          data-target-kind={unit.targetKind ?? "none"}
          data-empty={unit.target === undefined}
        >
          {targetText}
        </span>
        {/* 行為 (述語)。承認は解決状態でトーンが変わる。 */}
        <Tag tone={verb.tone} size="sm" className="ad-action-row__verb">
          {verb.label}
        </Tag>
        {/* 結果 + 補足チップ。 */}
        <span className="ad-action-row__result">
          {unit.approval?.riskLevel ? (
            <Tag tone={riskTone(unit.approval.riskLevel)} size="sm">
              risk:{unit.approval.riskLevel}
            </Tag>
          ) : null}
          {autoAllowed ? (
            <Tag tone="muted" size="sm">
              {autoAllowed}
            </Tag>
          ) : null}
          {/* command 相関ユニットの成功/失敗/実行中 (commandOutcome 由来)。 */}
          {outcome ? (
            <Tag tone={outcome.tone} size="sm" data-testid={`action-outcome-${unit.id}`}>
              {outcome.label}
            </Tag>
          ) : null}
          {/* exit_code は存在時のみ補助表示 (実 CC は載せない・捏造なし)。 */}
          {result ? (
            <Tag tone={result.tone} size="sm" data-testid={`action-result-${unit.id}`}>
              {result.label}
            </Tag>
          ) : null}
          {elapsed ? <span className="ad-action-row__elapsed">{elapsed}</span> : null}
        </span>
      </button>
    </li>
  );
}

/** raw イベント行 (従来表示・トグル時)。 */
function RawRow({ event }: { readonly event: ReplayEventDTO }) {
  const { locale } = useLocale();
  // 表示時ローカライズ (P2・ADR 019eeac6): 日本語焼き込みの display_text を直表示せず、
  // kind (述語テンプレート) + subject (言語非依存な構造値) から viewer locale で組み立てる。
  // kind=other / subject 欠落 / 旧 DTO は formatCurrentAction の fallback (display_text) に落ちる。
  const text =
    formatCurrentAction(
      { kind: event.kind, subject: event.subject, fallback: event.display_text },
      locale,
    ) ?? event.display_text;
  return (
    <li
      className="ad-action-row ad-action-row--raw"
      data-testid={`raw-row-${event.event_id}`}
      data-kind={event.kind}
    >
      <div className="ad-action-row__btn ad-action-row__btn--static">
        <time className="ad-action-row__time" dateTime={event.timestamp}>
          {formatClock(event.timestamp)}
        </time>
        <span className="ad-action-row__rawtype">{event.event_type}</span>
        <span className="ad-action-row__target">{text}</span>
      </div>
    </li>
  );
}

export interface ActionTimelineProps {
  readonly sessionId: string;
  /** 昇順 (REPLAY_ORDER) の ReplayEventDTO 配列。 */
  readonly events: readonly ReplayEventDTO[];
  /** 一覧の aria-label。 */
  readonly ariaLabel: string;
  readonly className?: string;
  readonly emptyLabel: string;
}

/**
 * アクション単位ビュー本体。アクション単位 ⇄ raw イベントのトグルと詳細モーダルを束ねる。
 * 既定はアクション単位 (KPI: 対象/行為/結果を 1 行で読ませる)。
 */
export function ActionTimeline({
  sessionId,
  events,
  ariaLabel,
  className,
  emptyLabel,
}: ActionTimelineProps) {
  const { t } = useLocale();
  const [showRaw, setShowRaw] = useState(false);
  const [selected, setSelected] = useState<ActionUnit | null>(null);
  const toggleId = useId();

  const units = useMemo(() => foldActionUnits(events), [events]);

  return (
    <div className={["ad-action-timeline", className].filter(Boolean).join(" ")}>
      <div className="ad-action-timeline__toolbar">
        <span id={toggleId} className="ad-action-timeline__toolbar-label">
          {t("action.toggle.label")}
        </span>
        <div className="ad-action-timeline__toggle" role="group" aria-labelledby={toggleId}>
          <button
            type="button"
            className="ad-toggle-btn"
            data-testid="action-toggle-units"
            aria-pressed={!showRaw}
            onClick={() => setShowRaw(false)}
          >
            {t("action.toggle.units")}
          </button>
          <button
            type="button"
            className="ad-toggle-btn"
            data-testid="action-toggle-raw"
            aria-pressed={showRaw}
            onClick={() => setShowRaw(true)}
          >
            {t("action.toggle.raw")}
          </button>
        </div>
      </div>

      <ol
        className="ad-action-timeline__list"
        data-testid="action-timeline"
        data-view={showRaw ? "raw" : "units"}
        role="log"
        aria-live="polite"
        aria-label={ariaLabel}
      >
        {events.length === 0 ? (
          <li className="ad-action-timeline__empty" data-testid="action-timeline-empty">
            {emptyLabel}
          </li>
        ) : showRaw ? (
          events.map((e) => <RawRow key={e.event_id} event={e} />)
        ) : (
          units.map((u) => <ActionRow key={u.id} unit={u} onOpen={() => setSelected(u)} />)
        )}
      </ol>

      <ActionDetailModal sessionId={sessionId} unit={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
