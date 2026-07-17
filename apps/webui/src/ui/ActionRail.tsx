"use client";

/**
 * Action Rail — board 最上段の「いま人が対応すべき 1 操作」レーン (decision 019f69ef)。
 *
 * R3 反証「UI は機能的だが情報密度が高く、いま何をすべきかが埋もれる」への恒久対応。既定ビューの
 * 最上段に、対応が必要なものだけを優先度順で出す: pending 承認カード (inline allow/deny = 唯一の
 * "1 操作") → stalled? → waiting(auth/input) → generic needs_attention。要対応 0 件は穏やかな
 * "All clear" を出す (架空状態でなく実データの 0)。
 *
 * SEC: 表示は既存の NO-RAW 変換点のみ — 承認は ApprovalCard/approvalPrimaryText の単一出所、
 * session_id は shortSessionId、repo@branch は redacted DTO の allowlist フィールド。生 command /
 * cwd / state 名は載せない。attention 判定は deriveAttention (既存 needs_attention /
 * stalled_suspected / waitingKind の再利用) で、新規の危険判定を作らない。
 */
import { deriveAttention, type AttentionSignalKind } from "./action-rail";
import { ApprovalSessionGroup } from "./ApprovalSessionGroup";
import { Icon, Tag, type Tone } from "./kit";
import { useLocale } from "./LocaleProvider";
import { shortSessionId } from "./wall-display";

import type { AckState, ApprovalDecision } from "./approval-display";
import type { SessionApprovals, SessionListItem } from "../realtime/contract";

export interface ActionRailProps {
  /** 一覧 session (stalled?/waiting/attention の導出元・repo@branch の join 元)。 */
  readonly sessions: readonly SessionListItem[];
  /** `/realtime/approvals` の pending 承認 (board 表示中のみ pull・redacted DTO)。 */
  readonly approvals: readonly SessionApprovals[];
  /** 親が握る 1 秒粒度の現在時刻。 */
  readonly nowMs: number;
  /** approve ack (request_id 突合)。Detail/Inbox と共有。 */
  readonly lastAck: ReadonlyMap<string, AckState>;
  /** 承認判断の送信 (既存 relay)。 */
  readonly onApprove: (
    sessionId: string,
    requestId: string,
    decision: ApprovalDecision,
    reason?: string,
    persist?: boolean,
  ) => void;
  /** 対象 session の詳細へ deep-link (承認以外のシグナルの主動線)。 */
  readonly onOpenSession: (sessionId: string) => void;
  /** 対象 session の Replay へ直行。 */
  readonly onOpenReplay?: (sessionId: string) => void;
}

/** シグナル種別 → kit Tag tone。停止断定はしない (stalled? は warn 止まり)。 */
function signalTone(kind: AttentionSignalKind): Tone {
  switch (kind) {
    case "approval":
      return "warn";
    case "stalled":
      return "warn";
    case "auth":
      return "info";
    case "input":
      return "info";
    case "attention":
    default:
      return "warn";
  }
}

export function ActionRail({
  sessions,
  approvals,
  nowMs,
  lastAck,
  onApprove,
  onOpenSession,
  onOpenReplay,
}: ActionRailProps) {
  const { t } = useLocale();
  const { approvalGroups, signals, total } = deriveAttention(sessions, approvals);

  return (
    <section
      className="ad-action-rail"
      data-testid="action-rail"
      data-clear={total === 0}
      aria-label={t("actionRail.aria")}
    >
      <div className="ad-action-rail__header">
        <Icon name="warning" className="ad-approval-banner__icon" />
        <h2 className="ad-panel__title">{t("actionRail.title")}</h2>
        <Tag
          tone={total > 0 ? "danger" : "success"}
          size="sm"
          data-testid="action-rail-count"
          data-attention={total > 0}
        >
          {total}
        </Tag>
      </div>

      {total === 0 ? (
        <p className="ad-action-rail__clear" data-testid="action-rail-clear">
          <Icon name="check" className="ad-action-rail__clear-icon" />
          {t("actionRail.clear")}
        </p>
      ) : (
        <>
          {approvalGroups.map(({ group, repoLabel }) => (
            <ApprovalSessionGroup
              key={group.session_id}
              group={group}
              nowMs={nowMs}
              lastAck={lastAck}
              onApprove={(sessionId, requestId, decision, persist) =>
                onApprove(sessionId, requestId, decision, undefined, persist)
              }
              onOpenSession={onOpenSession}
              {...(onOpenReplay ? { onOpenReplay } : {})}
              {...(repoLabel ? { secondaryLabel: repoLabel } : {})}
              idPrefix="rail"
            />
          ))}

          {signals.length > 0 ? (
            <ul className="ad-action-rail__signals" data-testid="action-rail-signals">
              {signals.map((s) => (
                <li key={s.session_id} className="ad-action-rail__signal">
                  <button
                    type="button"
                    className="ad-action-rail__signal-btn"
                    data-testid={`action-rail-signal-${s.session_id}`}
                    data-kind={s.kind}
                    onClick={() => onOpenSession(s.session_id)}
                    title={t("actionRail.signal.open.title")}
                  >
                    <Tag tone={signalTone(s.kind)} size="sm">
                      {t(`actionRail.kind.${s.kind}`)}
                    </Tag>
                    <span className="ad-action-rail__signal-label">
                      {s.repoLabel ?? shortSessionId(s.session_id)}
                    </span>
                    <span className="ad-session-meta">{s.provider}</span>
                    <span className="ad-action-rail__signal-go">{t("common.details")}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </section>
  );
}
