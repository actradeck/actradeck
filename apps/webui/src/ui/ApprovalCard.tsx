"use client";

/**
 * 承認カード 1 枚 (単一出所・ADR 019ead14 D2)。
 *
 * SessionDetail の承認バナーと Approval Inbox の双方がこの **1 コンポーネント**を共有し、
 * 承認 UI のドリフトを防ぐ (D2: 二重描画の単一出所化)。表示は approval-display の純関数と
 * backend が redaction 済みで載せた値のみ (生 tool_input は参照しない / security.md)。
 *
 * pending の各要素を request_id で独立に描き、ack を request_id 突合で表示する。
 * D3: 楽観更新しない — 押下→送信中→ack(ok/error) を表示するだけ。確定済み/送信中は再送を抑止。
 */
import { useState } from "react";

import {
  ackPhase,
  ackPhaseLabel,
  ackResolvedOrSending,
  allowRequiresAck,
  approvalPrimaryText,
  approvalSecretKindViews,
  approvalTimeRemainingMs,
  approvalTriggerReasonKey,
  riskTone,
  type AckState,
  type ApprovalDecision,
} from "./approval-display";
import { useLocale } from "./LocaleProvider";
import { Button, Tag, type Tone } from "./kit";

import type { Locale } from "./i18n/messages";
import { t } from "./i18n/messages";
import type { PendingApproval } from "../realtime/contract";

/** タイムアウト目安が「まもなく」強調に切り替わる閾値 (ms)。推定値ベース (誤認防止)。 */
const APPROVAL_SOON_THRESHOLD_MS = 5_000;

/** 承認の推定タイムアウト目安 (秒) 表示。UI は実 timeout を知らないため安全側の推定値。 */
function approvalTimeoutHint(requestedAtIso: string, nowMs: number, locale: Locale) {
  const remainingMs = approvalTimeRemainingMs(requestedAtIso, nowMs);
  const seconds = Math.ceil(remainingMs / 1000);
  if (remainingMs <= 0) {
    return { tone: "expired" as const, label: t(locale, "approval.timeout.expired") };
  }
  if (remainingMs < APPROVAL_SOON_THRESHOLD_MS) {
    return { tone: "soon" as const, label: t(locale, "approval.timeout.soon", { seconds }) };
  }
  return { tone: "ok" as const, label: t(locale, "approval.timeout.ok", { seconds }) };
}

/** risk tone (approval-display) を kit Tag tone へ。 */
function riskKitTone(tone: ReturnType<typeof riskTone>): Tone {
  if (tone === "high") return "danger";
  if (tone === "warn") return "warn";
  if (tone === "ok") return "success";
  return "muted";
}

/** ack phase を kit Tag tone へ。 */
function ackKitTone(phase: ReturnType<typeof ackPhase>): Tone {
  if (phase === "allowed" || phase === "allowed_for_session") return "success";
  if (phase === "denied" || phase === "cancelled" || phase === "failed") return "danger";
  if (phase === "sending") return "info";
  return "muted";
}

export function ApprovalCard({
  approval,
  ack,
  onApprove,
  nowMs,
}: {
  readonly approval: PendingApproval;
  readonly ack: AckState | undefined;
  readonly onApprove?: (requestId: string, decision: ApprovalDecision, persist?: boolean) => void;
  readonly nowMs: number;
}) {
  const { locale, t: tl } = useLocale();
  const phase = ackPhase(ack);
  const disabled = !onApprove || ackResolvedOrSending(phase);
  const tone = riskTone(approval.risk_level);
  // 自動ガード理由 (ADR 019ecc70 D3): なぜ pause したか + どの種類の秘匿を検出したか。
  // 純関数で写像し Detail / Inbox で同一表示。no-raw-display 防御は純関数側が担保
  // (既知 enum 以外の trigger / kind は raw を出さず汎用ラベルへ畳む)。
  const reasonKey = approvalTriggerReasonKey(approval.trigger);
  const secretKindViews = approvalSecretKindViews(approval.secret_kinds, locale);
  // 段階2 (INV-INBOX-HIGHRISK-DENY-DEFAULT): 高リスクは allow 系を明示確認でゲートし、
  // 確認なしの誤 allow を UI 構造で抑止する (deny/cancel は常に直接操作可能=安全側既定)。
  const highRiskGate = allowRequiresAck(approval.risk_level);
  const [highRiskAcked, setHighRiskAcked] = useState(false);
  // allow / allow_for_session は確定/送信中に加え、高リスク未確認時も無効。
  const allowDisabled = disabled || (highRiskGate && !highRiskAcked);
  // 確認チェックは未確定 (操作可能) の高リスクカードでのみ出す。
  const showHighRiskAck = highRiskGate && !disabled;
  // 推定タイムアウト目安。UI は実 timeout を知らないため安全側の推定 (誤認防止)。
  // 確定済み (ok ack) のカードでは締め切り表示は意味を持たないので出さない。
  const timeoutHint = ackResolvedOrSending(phase)
    ? null
    : approvalTimeoutHint(approval.requested_at, nowMs, locale);

  return (
    <li
      data-testid={`approval-card-${approval.request_id}`}
      data-request-id={approval.request_id}
      data-ack-phase={phase}
      data-highrisk={highRiskGate ? "true" : undefined}
      className={highRiskGate ? "ad-approval-card ad-approval-card--highrisk" : "ad-approval-card"}
    >
      <div className="ad-approval-card__header">
        <Tag tone="neutral" size="sm" data-testid="approval-tool">
          {approval.tool_name ?? tl("approval.tool.unknown")}
        </Tag>
        <Tag tone={riskKitTone(tone)} size="sm" data-testid="approval-risk" data-tone={tone}>
          {tl("approval.risk", { risk: approval.risk_level ?? tl("approval.risk.unknown") })}
        </Tag>
        <Tag tone={ackKitTone(phase)} size="sm" data-testid="approval-ack" data-phase={phase}>
          {ackPhaseLabel(phase, locale)}
        </Tag>
      </div>
      <code data-testid="approval-primary">{approvalPrimaryText(approval)}</code>
      {/* 自動ガード理由 (ADR 019ecc70 D3)。なぜ止めたか (trigger) + 検出した秘匿の種類 (secret_kinds)。
          SEC (no-raw-display・PR#29 同方針): 既知 enum 以外の trigger / kind は raw 文字列を text にも
          data 属性にも出さず、汎用ラベル + 固定 sentinel "unknown" へ畳む。原文は一切描かない。 */}
      {reasonKey || secretKindViews.length > 0 ? (
        <div className="ad-approval-card__guard" data-testid="approval-guard-reason">
          {reasonKey ? (
            <Tag
              tone="warn"
              size="sm"
              iconStart="warning-alt"
              data-testid="approval-trigger"
              // 既知 trigger のみ data 属性へ (未知は reasonKey=null ゆえここに来ない=raw を出さない)。
              data-trigger={approval.trigger}
            >
              {tl(reasonKey)}
            </Tag>
          ) : null}
          {secretKindViews.length > 0 ? (
            <ul
              className="ad-approval-card__secret-kinds"
              data-testid="approval-secret-kinds"
              aria-label={tl("approval.reason.secretKinds.aria")}
            >
              {secretKindViews.map((v) => (
                <li key={v.attr}>
                  <Tag
                    tone="warn"
                    size="sm"
                    data-testid="approval-secret-kind"
                    // 既知 → 公開 enum / 未知 → 固定 sentinel "unknown" (raw kind を属性に出さない)。
                    data-secret-kind={v.attr}
                    data-secret-kind-known={v.known}
                  >
                    {tl("approval.reason.secretKind", { label: v.label })}
                  </Tag>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {timeoutHint ? (
        <Tag
          tone={timeoutHint.tone === "soon" || timeoutHint.tone === "expired" ? "danger" : "info"}
          size="sm"
          data-testid="approval-timeout"
          data-tone={timeoutHint.tone}
        >
          {timeoutHint.label}
        </Tag>
      ) : null}
      {showHighRiskAck ? (
        <label className="ad-approval-card__highrisk-ack" data-testid="approval-highrisk-ack">
          <input
            type="checkbox"
            checked={highRiskAcked}
            data-testid="approval-highrisk-ack-input"
            onChange={(e) => setHighRiskAcked(e.target.checked)}
          />
          {tl("approval.highRiskAck")}
        </label>
      ) : null}
      <div className="ad-approval-card__actions">
        <Button
          size="sm"
          kind="primary"
          iconStart="check"
          data-testid="approval-allow"
          title={tl("approval.allow.title")}
          disabled={allowDisabled}
          onClick={() => onApprove?.(approval.request_id, "allow")}
        >
          {tl("approval.allow")}
        </Button>
        <Button
          size="sm"
          kind="secondary"
          iconStart="check"
          data-testid="approval-allow-for-session"
          title={tl("approval.allowForSession.title")}
          disabled={allowDisabled}
          onClick={() => onApprove?.(approval.request_id, "allow_for_session")}
        >
          {tl("approval.allowForSession")}
        </Button>
        {/* ADR 019ee0c0: 永続化対象 (medium-bash + repo 解決可 + feature-ON) のときのみ提示。
            allow_for_session + persist=true を送り、再起動跨ぎで同一署名を自動許可する。
            正直なラベル: 「再起動後も許可」(Hermes #41769 の UI/実体 不一致を回避)。 */}
        {approval.persistable === true ? (
          <Button
            size="sm"
            kind="secondary"
            iconStart="renew"
            data-testid="approval-allow-persist"
            title={tl("approval.allowPersist.title")}
            disabled={allowDisabled}
            onClick={() => onApprove?.(approval.request_id, "allow_for_session", true)}
          >
            {tl("approval.allowPersist")}
          </Button>
        ) : null}
        <Button
          size="sm"
          kind="danger"
          iconStart="warning-alt"
          data-testid="approval-deny"
          title={tl("approval.deny.title")}
          disabled={disabled}
          onClick={() => onApprove?.(approval.request_id, "deny")}
        >
          {tl("approval.deny")}
        </Button>
        <Button
          size="sm"
          kind="ghost"
          iconStart="close"
          data-testid="approval-cancel"
          title={tl("approval.cancel.title")}
          disabled={disabled}
          onClick={() => onApprove?.(approval.request_id, "cancel")}
        >
          {tl("approval.cancel")}
        </Button>
      </div>
      {phase === "failed" && ack?.error ? (
        <span data-testid="approval-ack-error">{ack.error}</span>
      ) : null}
    </li>
  );
}
