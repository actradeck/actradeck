"use client";

/**
 * 承認グループ 1 セッション分のチロム (単一出所)。
 *
 * Approval Inbox (横断ビュー) と Action Rail (board 最上段の要対応レーン) の双方がこの
 * **1 コンポーネント** を共有し、承認グループ見出し + カード列のドリフトを防ぐ。承認カード自体は
 * さらに {@link ApprovalCard} が単一出所 (ADR 019ead14 D2)。表示は backend が redaction 済みで
 * 載せた値のみ (approvalPrimaryText 経由・生 payload は無い / security.md)。
 *
 * `idPrefix` で testid/aria を呼び出し側ごとに分ける ("inbox" | "rail")。`secondaryLabel` は
 * 見出しの副ラベル: Inbox は cwd、Action Rail は repo@branch を渡す (どちらも redacted DTO 由来)。
 */
import { ApprovalCard } from "./ApprovalCard";
import { Button, Icon, Tag } from "./kit";
import { useLocale } from "./LocaleProvider";
import { shortSessionId } from "./wall-display";

import type { AckState, ApprovalDecision } from "./approval-display";
import type { SessionApprovals } from "../realtime/contract";

export interface ApprovalSessionGroupProps {
  readonly group: SessionApprovals;
  /** 親が握る 1 秒粒度の現在時刻 (承認の残り時間目安をライブ更新)。 */
  readonly nowMs: number;
  /** approve ack を request_id 突合で保持 (送信中/許可送信済/relay 失敗)。Detail/Inbox と共有。 */
  readonly lastAck: ReadonlyMap<string, AckState>;
  /** 承認判断の送信 (既存 relay)。session_id を明示で渡す (relay 境界=canRelay は session_id で不変)。 */
  readonly onApprove: (
    sessionId: string,
    requestId: string,
    decision: ApprovalDecision,
    persist?: boolean,
  ) => void;
  /** 見出しから対象 session の詳細へ deep-link する。 */
  readonly onOpenSession?: (sessionId: string) => void;
  /** 見出しから対象 session の Replay へ直行する。 */
  readonly onOpenReplay?: (sessionId: string) => void;
  /** 見出し副ラベル: Inbox=cwd / Action Rail=repo@branch (redacted DTO 由来)。 */
  readonly secondaryLabel?: string;
  /** testid/aria の接頭辞。呼び出し側 typo で testid 契約を静かに壊さないよう closed union に狭める。 */
  readonly idPrefix: "inbox" | "rail";
}

export function ApprovalSessionGroup({
  group,
  nowMs,
  lastAck,
  onApprove,
  onOpenSession,
  onOpenReplay,
  secondaryLabel,
  idPrefix,
}: ApprovalSessionGroupProps) {
  const { t } = useLocale();
  return (
    <section
      data-testid={`${idPrefix}-group-${group.session_id}`}
      className="ad-inbox__group"
      aria-label={t("inbox.groupAria", { sessionId: group.session_id })}
    >
      <header className="ad-inbox__group-header">
        <Icon name="warning" className="ad-approval-banner__icon" />
        <Tag tone="neutral" size="sm" data-testid={`${idPrefix}-session-provider`}>
          {group.provider || t("inbox.session")}
        </Tag>
        <code className="ad-inbox__group-id" data-testid={`${idPrefix}-session-id`}>
          {shortSessionId(group.session_id)}
        </code>
        {secondaryLabel ? <span className="ad-session-meta">{secondaryLabel}</span> : null}
        {onOpenSession ? (
          <Button
            kind="ghost"
            size="sm"
            iconStart="dashboard"
            data-testid={`${idPrefix}-open-${group.session_id}`}
            onClick={() => onOpenSession(group.session_id)}
            title={t("inbox.open.title")}
          >
            {t("common.details")}
          </Button>
        ) : null}
        {onOpenReplay ? (
          <Button
            kind="ghost"
            size="sm"
            iconStart="renew"
            data-testid={`${idPrefix}-replay-${group.session_id}`}
            onClick={() => onOpenReplay(group.session_id)}
            title={t("inbox.replay.title")}
          >
            {t("common.replay")}
          </Button>
        ) : null}
      </header>
      <ul className="ad-approval-list" data-testid={`${idPrefix}-list-${group.session_id}`}>
        {group.pending_approvals.map((a) => (
          <ApprovalCard
            key={a.request_id}
            approval={a}
            ack={lastAck.get(a.request_id)}
            onApprove={(requestId, decision, persist) =>
              onApprove(group.session_id, requestId, decision, persist)
            }
            nowMs={nowMs}
          />
        ))}
      </ul>
    </section>
  );
}
