"use client";

/**
 * Work-items パネル (ADR 0015 §D8・差別化ゲート 019ec619 の UI 面).
 *
 * 「エージェントが *完了した* と自己申告したが、それは *検証されたか* / その検証は *今のコード* に対して
 * まだ有効か」を per work item で示す。表示は **観測されたイベント**のみ由来 (架空の確信を作らない)。
 *
 * - client-side fold: 既取得のイベントフィード上で `foldWorkItems` (= projection `reduceWorkItems` 共有)。
 * - 4 badge: `deriveWorkItemBadge` 単一正準 (work-items-fold.badgeDisplay 経由・locale 写像)。
 * - evidence 注記: method / fidelity (§D7)・check 分類 (§D6)・run_dirty / stale 理由。
 * - evidence-ref: claim / check / diff の timeline event へジャンプ (onJumpToEvent)。
 *
 * 表示専用: mutation / approve / policy / live gate に一切触れない。NO-RAW: work_item_id は hash 表示、
 * subject は projection が redacted+bounded 済の値を写すのみ (生 task id / 生パス / secret を DOM へ出さない)。
 */
import { deriveWorkItemBadge } from "@actradeck/projection";
import { useMemo } from "react";

import { Button, Tag } from "./kit";
import { useLocale } from "./LocaleProvider";
import {
  badgeDisplay,
  checkKindLabelKey,
  checkMatchLabelKey,
  evidenceRefs,
  fidelityLabelKey,
  foldWorkItems,
  methodLabelKey,
  shortWorkItemId,
  statusLabelKey,
} from "./work-items-fold";

import type { WorkItem } from "@actradeck/projection";
import type { ReplayEventDTO } from "../realtime/contract";

export interface WorkItemsPanelProps {
  readonly sessionId: string;
  /** 昇順 (REPLAY_ORDER) の ReplayEventDTO 配列 (Session Detail が既取得のフィード)。 */
  readonly events: readonly ReplayEventDTO[];
  /**
   * evidence-ref クリックで対応する timeline event へジャンプする (§D8)。未指定なら参照は表示のみ
   * (非活性)。SessionDetail が ActionTimeline の focusEventId へ橋渡しする。
   */
  readonly onJumpToEvent?: (eventId: string) => void;
}

function WorkItemRow({
  item,
  onJumpToEvent,
}: {
  readonly item: WorkItem;
  readonly onJumpToEvent?: (eventId: string) => void;
}) {
  const { t } = useLocale();
  const bd = badgeDisplay(item);
  const methodKey = methodLabelKey(item.claim_method);
  const fidelityKey = fidelityLabelKey(item.claim_fidelity);
  const checkKindKey = checkKindLabelKey(item.check_kind);
  const checkMatchKey = checkMatchLabelKey(item.check_match);
  const refs = evidenceRefs(item);

  return (
    <li
      className="ad-workitem"
      data-testid={`work-item-${item.work_item_id}`}
      data-scheme={item.id_scheme}
      data-status={item.status}
      data-verification={item.verification_state}
    >
      <div className="ad-workitem__head">
        {bd ? (
          <Tag
            tone={bd.tone}
            size="sm"
            data-testid="work-item-badge"
            data-badge={bd.badge}
            title={t(bd.titleKey)}
          >
            {t(bd.labelKey)}
          </Tag>
        ) : (
          <Tag tone="muted" size="sm" data-testid="work-item-status" data-status={item.status}>
            {t(statusLabelKey(item.status))}
          </Tag>
        )}
        {/* subject は projection が redacted+bounded 済の値 (NO-RAW: 生 task subject を直取得しない)。 */}
        <span className="ad-workitem__subject" data-testid="work-item-subject">
          {item.subject ?? t("workitem.noSubject")}
        </span>
        {/* work_item_id は既に scheme:sha256[:16] の hash (生 provider task id / 生パス非含)。 */}
        <code className="ad-workitem__id" data-testid="work-item-id">
          {shortWorkItemId(item.work_item_id)}
        </code>
      </div>

      {/* 観測証拠の注記 (method/fidelity/check 分類/run_dirty/stale 理由)。 */}
      <div className="ad-workitem__evidence" data-testid="work-item-evidence">
        {methodKey ? (
          <Tag
            tone="muted"
            size="sm"
            data-testid="work-item-method"
            data-method={item.claim_method}
          >
            {t("workitem.evidence.methodLabel", { value: t(methodKey) })}
          </Tag>
        ) : null}
        {fidelityKey ? (
          <Tag
            tone="muted"
            size="sm"
            data-testid="work-item-fidelity"
            data-fidelity={item.claim_fidelity}
          >
            {t("workitem.evidence.fidelityLabel", { value: t(fidelityKey) })}
          </Tag>
        ) : null}
        {checkKindKey ? (
          <Tag
            tone="info"
            size="sm"
            data-testid="work-item-check"
            data-check-kind={item.check_kind}
          >
            {checkMatchKey
              ? t("workitem.check.label", { kind: t(checkKindKey), match: t(checkMatchKey) })
              : t("workitem.check.labelKindOnly", { kind: t(checkKindKey) })}
          </Tag>
        ) : null}
        {item.check_exit_code !== undefined ? (
          <Tag
            tone={item.check_exit_code === 0 ? "success" : "danger"}
            size="sm"
            data-testid="work-item-exit"
          >
            {t("workitem.check.exit", { code: item.check_exit_code })}
          </Tag>
        ) : null}
        {item.run_dirty ? (
          <Tag
            tone="warn"
            size="sm"
            data-testid="work-item-run-dirty"
            title={t("workitem.runDirty.title")}
          >
            {t("workitem.runDirty")}
          </Tag>
        ) : null}
        {item.verification_state === "stale" ? (
          <span className="ad-workitem__stale" data-testid="work-item-stale-reason">
            {t("workitem.stale.reason")}
          </span>
        ) : null}
      </div>

      {/* evidence-ref: claim / check / diff の timeline event へジャンプ (evidence _は_ イベントログ)。 */}
      {refs.length > 0 ? (
        <div className="ad-workitem__refs" data-testid="work-item-refs">
          <span className="ad-workitem__refs-label">{t("workitem.ref.label")}</span>
          {refs.map((ref) => (
            <Button
              key={ref.role}
              size="sm"
              kind="ghost"
              data-testid={`work-item-ref-${ref.role}`}
              data-event-id={ref.eventId}
              disabled={onJumpToEvent === undefined}
              title={t("workitem.ref.jump")}
              onClick={() => onJumpToEvent?.(ref.eventId)}
            >
              {t(ref.labelKey)}
            </Button>
          ))}
        </div>
      ) : null}
    </li>
  );
}

/**
 * Session Detail の additive work-items パネル。events を client-side fold し、work item ごとに
 * 状態 / バッジ / 証拠 / 参照を描く。events 空 / work item 無しなら空状態を出す (架空の状態を出さない)。
 */
export function WorkItemsPanel({ sessionId, events, onJumpToEvent }: WorkItemsPanelProps) {
  const { t } = useLocale();
  const projection = useMemo(() => foldWorkItems(sessionId, events), [sessionId, events]);
  const items = projection.items;
  // パネル内 claimed-unverified 件数 (TDA-B3-1: 述語を手書きせず canonical badge `deriveWorkItemBadge`
  //   由来に統一する — self_claimed = completed かつ unverified。バッジ 4 状態の単一正準と drift しない)。
  //   Wall の claimed_unverified_count (realtime-store.ts SQL) と同一意味論・別集計 (needs_attention と分離)。
  const claimedUnverified = items.filter((it) => deriveWorkItemBadge(it) === "self_claimed").length;

  return (
    <section
      className="ad-workitems"
      data-testid="work-items-panel"
      aria-label={t("workitem.panel.aria")}
    >
      <header className="ad-workitems__head">
        <h3 className="ad-pane-title">{t("workitem.panel.title")}</h3>
        {claimedUnverified > 0 ? (
          <Tag
            tone="warn"
            size="sm"
            data-testid="work-items-claimed-unverified-count"
            data-count={claimedUnverified}
            title={t("workitem.count.claimedUnverified.title")}
          >
            {t("workitem.count.claimedUnverified", { count: claimedUnverified })}
          </Tag>
        ) : null}
        {projection.dropped_count > 0 ? (
          <Tag
            tone="muted"
            size="sm"
            data-testid="work-items-dropped"
            data-count={projection.dropped_count}
          >
            {t("workitem.dropped", { count: projection.dropped_count })}
          </Tag>
        ) : null}
      </header>

      {items.length === 0 ? (
        <p className="ad-workitems__empty" data-testid="work-items-empty">
          {t("workitem.panel.empty")}
        </p>
      ) : (
        <ul className="ad-workitems__list" data-testid="work-items-list" data-count={items.length}>
          {items.map((item) => (
            <WorkItemRow
              key={item.work_item_id}
              item={item}
              {...(onJumpToEvent ? { onJumpToEvent } : {})}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
