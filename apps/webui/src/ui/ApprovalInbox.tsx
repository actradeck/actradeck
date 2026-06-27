"use client";

/**
 * Approval Inbox (ADR 019ead14 段階1)。
 *
 * 全ライブセッションの承認待ち (connected かつ pending 非空) を 1 画面に集約する横断ビュー
 * (plan.md §18-2)。承認カードは SessionDetail と **同一の {@link ApprovalCard}** + 既存 approve relay
 * + 共有 lastAck を通す (D2: 単一出所)。各行は対象 session へ deep-link できる。
 *
 * SEC: 表示は backend が redaction 済みで載せた値のみ (approvalPrimaryText 経由)。生 payload は無い。
 * bypassPermissions セッションは pending を生成しないため自動的に Inbox 対象外 (decision 019eace6)。
 */
import { ApprovalCard } from "./ApprovalCard";
import { Button, Icon, InlineAlert, Tag } from "./kit";
import { useLocale } from "./LocaleProvider";
import { useApprovalInbox } from "./use-approval-inbox";

import type { AckState, ApprovalDecision } from "./approval-display";

export interface ApprovalInboxProps {
  /** Inbox が表示中か (false の間は fetch せず保持を破棄する)。 */
  readonly active: boolean;
  /** 親が握る 1 秒粒度の現在時刻 (承認の残り時間目安をライブ更新する)。 */
  readonly nowMs: number;
  /** 変化で再 fetch するキー (例: needs_attention 件数)。live nudge は既存 delta.list が担う。 */
  readonly refreshKey?: number;
  /** 承認判断の送信 (既存 relay)。session_id を明示で渡す (relay 境界=canRelay は session_id で不変)。 */
  readonly onApprove: (
    sessionId: string,
    requestId: string,
    decision: ApprovalDecision,
    reason?: string,
    persist?: boolean,
  ) => void;
  /** approve ack を request_id 突合で保持 (送信中/許可送信済/relay 失敗 表示)。Detail と共有。 */
  readonly lastAck: ReadonlyMap<string, AckState>;
  /** 行から対象 session の詳細へ deep-link する。 */
  readonly onOpenSession?: (sessionId: string) => void;
  /** 行から対象 session の Replay へ直行する (board+replay deep-link・親が握る)。 */
  readonly onOpenReplay?: (sessionId: string) => void;
}

export function ApprovalInbox({
  active,
  nowMs,
  refreshKey,
  onApprove,
  lastAck,
  onOpenSession,
  onOpenReplay,
}: ApprovalInboxProps) {
  const { t } = useLocale();
  const { approvals, loading, error, refresh } = useApprovalInbox({
    enabled: active,
    ...(refreshKey !== undefined ? { refreshKey } : {}),
  });
  const total = approvals.reduce((n, s) => n + s.pending_approvals.length, 0);

  return (
    <section data-testid="approval-inbox" aria-label="approval inbox" className="ad-inbox">
      <div className="ad-panel__header">
        <div>
          <h2 className="ad-panel__title">{t("inbox.title")}</h2>
          <span className="ad-session-meta">
            {t("inbox.summary", { total, sessions: approvals.length })}
          </span>
        </div>
        <Button
          kind="ghost"
          size="sm"
          iconStart="renew"
          data-testid="inbox-refresh"
          onClick={refresh}
          title={t("inbox.refresh.title")}
        >
          {t("common.refresh")}
        </Button>
      </div>

      {error ? (
        <InlineAlert
          data-testid="inbox-error"
          role="status"
          kind="error"
          title={t("inbox.error.title")}
          subtitle={error}
        />
      ) : null}

      {total === 0 ? (
        <p data-testid="inbox-empty" className="ad-inbox__empty">
          {loading ? t("common.loading") : t("inbox.empty")}
        </p>
      ) : (
        <div className="ad-inbox__groups">
          {approvals.map((group) => (
            <section
              key={group.session_id}
              data-testid={`inbox-group-${group.session_id}`}
              className="ad-inbox__group"
              aria-label={`approvals for ${group.session_id}`}
            >
              <header className="ad-inbox__group-header">
                <Icon name="warning" className="ad-approval-banner__icon" />
                <Tag tone="neutral" size="sm" data-testid="inbox-session-provider">
                  {group.provider || t("inbox.session")}
                </Tag>
                <code className="ad-inbox__group-id" data-testid="inbox-session-id">
                  {group.session_id.slice(0, 12)}
                </code>
                {group.cwd ? <span className="ad-session-meta">{group.cwd}</span> : null}
                {onOpenSession ? (
                  <Button
                    kind="ghost"
                    size="sm"
                    iconStart="dashboard"
                    data-testid={`inbox-open-${group.session_id}`}
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
                    data-testid={`inbox-replay-${group.session_id}`}
                    onClick={() => onOpenReplay(group.session_id)}
                    title={t("inbox.replay.title")}
                  >
                    {t("common.replay")}
                  </Button>
                ) : null}
              </header>
              <ul className="ad-approval-list" data-testid={`inbox-list-${group.session_id}`}>
                {group.pending_approvals.map((a) => (
                  <ApprovalCard
                    key={a.request_id}
                    approval={a}
                    ack={lastAck.get(a.request_id)}
                    onApprove={(requestId, decision, persist) =>
                      onApprove(group.session_id, requestId, decision, undefined, persist)
                    }
                    nowMs={nowMs}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
