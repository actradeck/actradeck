"use client";

/**
 * アクション単位の詳細モーダル (設計裁定 019eb981).
 *
 * 行クリックで開き、当該 ActionUnit の詳細を表示する:
 *  - 対象全文 (コピー可能な <code> ブロック)、絶対+相対時刻、行為、承認チェーン
 *    (risk_level/auto_allowed/decision)、exit_code/elapsed_ms、構成 raw イベント一覧。
 *  - コマンド unit のとき「出力を見る」= 既存 GET /commands/:eventId/output。
 *  - 「現在の差分を見る」= 既存 GET /diff (per-event ではなくセッション現在作業ツリー差分・UI 文言で明示)。
 *  - fetch はモーダル表示中のみ・閉じたら state 破棄 (useSessionBody.clear / メモリ衛生)。
 *
 * SEC (INV-ACTION-MODAL-ALLOWLIST): 参照するのは **ActionUnit / ReplayEventDTO allow-list
 * フィールドのみ** + redaction 済み本文 pull (parse-body 経由)。生 payload を参照する経路は作らない。
 */
import { useEffect, useId, useRef, useState } from "react";

import {
  actionVerb,
  decisionLabel,
  formatClock,
  formatCurrentAction,
  formatElapsed,
  riskTone,
} from "./action-units-display";
import { useLocale } from "./LocaleProvider";
import { useSessionBody } from "./use-session-body";
import { Button, Modal, Tag } from "./kit";

import type { ActionUnit } from "./action-units";

export interface ActionDetailModalProps {
  readonly sessionId: string;
  /** 表示対象。null のときモーダルは閉じている。 */
  readonly unit: ActionUnit | null;
  readonly onClose: () => void;
}

export function ActionDetailModal({ sessionId, unit, onClose }: ActionDetailModalProps) {
  const { t, locale } = useLocale();
  const titleId = useId();
  const body = useSessionBody(sessionId);
  const [copied, setCopied] = useState(false);

  // body.clear を安定参照で呼ぶための ref (useSessionBody の戻りは毎 render 新規)。
  const clearRef = useRef(body.clear);
  clearRef.current = body.clear;

  // 対象 unit が変わる/閉じるたびに pull 済み本文を破棄する (秘匿本文をメモリに残さない)。
  // 依存は unit のみ (本文破棄の駆動軸)。clearRef でクロージャの陳腐化を避ける。
  useEffect(() => {
    clearRef.current();
    setCopied(false);
  }, [unit]);

  if (!unit) {
    return <Modal open={false} onClose={onClose} titleId={titleId} />;
  }

  const verb = actionVerb(unit, locale);
  const isCommand = unit.commandEventId !== undefined;
  const targetText = unit.target;

  const copyTarget = () => {
    if (!targetText) return;
    void navigator.clipboard?.writeText(targetText).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  return (
    <Modal open onClose={onClose} titleId={titleId} data-testid="action-detail-modal">
      <header className="ad-modal__header">
        <h2 id={titleId} className="ad-modal__title">
          {t("modal.detail.title")}
        </h2>
        <Button
          kind="ghost"
          size="sm"
          iconStart="close"
          data-testid="action-detail-close"
          onClick={onClose}
        >
          {t("modal.close")}
        </Button>
      </header>

      <div className="ad-modal__body">
        {/* 行為 */}
        <section className="ad-modal__section">
          <h3 className="ad-modal__label">{t("modal.detail.action")}</h3>
          <Tag tone={verb.tone} size="md">
            {verb.label}
          </Tag>
        </section>

        {/* 対象全文 (コピー可能な code ブロック) */}
        <section className="ad-modal__section">
          <h3 className="ad-modal__label">{t("modal.detail.target")}</h3>
          {targetText ? (
            <div className="ad-modal__target">
              <code className="ad-modal__code" data-testid="action-detail-target">
                {targetText}
              </code>
              <Button
                kind="secondary"
                size="sm"
                data-testid="action-detail-copy"
                onClick={copyTarget}
              >
                {copied ? t("modal.detail.copied") : t("modal.detail.copy")}
              </Button>
            </div>
          ) : (
            <p className="ad-modal__muted">{t("modal.detail.targetNone")}</p>
          )}
          {unit.cwd ? (
            <p className="ad-modal__kv" data-testid="action-detail-cwd">
              <span className="ad-modal__kv-label">{t("modal.detail.cwd")}</span>
              <code className="ad-modal__code-inline">{unit.cwd}</code>
            </p>
          ) : null}
        </section>

        {/* 時刻 (絶対 + 範囲) */}
        <section className="ad-modal__section">
          <h3 className="ad-modal__label">{t("modal.detail.time")}</h3>
          <p className="ad-modal__kv" data-testid="action-detail-time">
            <time dateTime={unit.startTime}>{unit.startTime}</time>
            {unit.endTime !== unit.startTime ? (
              <span className="ad-modal__muted">
                {" "}
                {t("modal.detail.timeRange", {
                  start: formatClock(unit.startTime),
                  end: formatClock(unit.endTime),
                })}
              </span>
            ) : null}
          </p>
        </section>

        {/* 承認チェーン */}
        {unit.approval ? (
          <section className="ad-modal__section" data-testid="action-detail-approval">
            <h3 className="ad-modal__label">{t("modal.detail.approval")}</h3>
            <ul className="ad-modal__chips">
              {unit.approval.riskLevel ? (
                <li>
                  <Tag tone={riskTone(unit.approval.riskLevel)} size="sm">
                    {t("modal.detail.risk", { risk: unit.approval.riskLevel })}
                  </Tag>
                </li>
              ) : null}
              {unit.approval.decision ? (
                <li>
                  <Tag tone={unit.approval.decision === "deny" ? "danger" : "success"} size="sm">
                    {t("modal.detail.decision", {
                      decision: decisionLabel(unit.approval.decision, locale),
                    })}
                  </Tag>
                </li>
              ) : null}
              {unit.approval.autoAllowed !== undefined ? (
                <li>
                  <Tag tone="muted" size="sm">
                    {t("modal.detail.autoAllowed", {
                      value: unit.approval.autoAllowed
                        ? t("modal.bool.true")
                        : t("modal.bool.false"),
                    })}
                  </Tag>
                </li>
              ) : null}
            </ul>
          </section>
        ) : null}

        {/* 結果 (exit / elapsed) */}
        {unit.exitCode !== undefined || unit.elapsedMs !== undefined ? (
          <section className="ad-modal__section" data-testid="action-detail-result">
            <ul className="ad-modal__chips">
              {unit.exitCode !== undefined ? (
                <li>
                  <Tag tone={unit.exitCode === 0 ? "neutral" : "danger"} size="sm">
                    {t("modal.detail.exit", { code: unit.exitCode })}
                  </Tag>
                </li>
              ) : null}
              {unit.elapsedMs !== undefined ? (
                <li>
                  <Tag tone="muted" size="sm">
                    {t("modal.detail.elapsed", {
                      elapsed: formatElapsed(unit.elapsedMs) ?? String(unit.elapsedMs),
                    })}
                  </Tag>
                </li>
              ) : null}
            </ul>
          </section>
        ) : null}

        {/* 構成 raw イベント一覧 */}
        <section className="ad-modal__section">
          <h3 className="ad-modal__label">{t("modal.detail.events")}</h3>
          <ul className="ad-modal__events" data-testid="action-detail-events">
            {unit.events.map((e) => (
              <li key={e.event_id} className="ad-modal__event" data-kind={e.kind}>
                <time className="ad-modal__event-time" dateTime={e.timestamp}>
                  {formatClock(e.timestamp)}
                </time>
                <span className="ad-modal__event-type">{e.event_type}</span>
                {/* 表示時ローカライズ (P2): display_text 直表示でなく kind+subject から locale で組む。 */}
                <span className="ad-modal__event-text">
                  {formatCurrentAction(
                    { kind: e.kind, subject: e.subject, fallback: e.display_text },
                    locale,
                  ) ?? e.display_text}
                </span>
              </li>
            ))}
          </ul>
        </section>

        {/* コマンド出力 pull (command unit のみ) */}
        {isCommand ? (
          <section className="ad-modal__section" data-testid="action-detail-output">
            <Button
              kind="secondary"
              size="sm"
              data-testid="action-output-load"
              disabled={body.outputLoading}
              onClick={() => body.loadOutput(unit.commandEventId!)}
            >
              {body.outputLoading ? t("modal.output.loading") : t("modal.output.load")}
            </Button>
            {body.outputError ? (
              <p className="ad-modal__error">
                {t("modal.output.error", { error: body.outputError })}
              </p>
            ) : null}
            {body.output ? (
              body.output.not_found ? (
                <p className="ad-modal__muted">{t("modal.output.notFound")}</p>
              ) : (
                <pre className="ad-modal__pre" aria-label={t("modal.output.aria")}>
                  {body.output.output_excerpt || t("modal.output.empty")}
                  {body.output.truncated ? t("modal.output.truncated") : ""}
                </pre>
              )
            ) : null}
          </section>
        ) : null}

        {/* セッション現在差分 pull (per-event ではない旨を明示) */}
        <section className="ad-modal__section" data-testid="action-detail-diff">
          <Button
            kind="secondary"
            size="sm"
            data-testid="action-diff-load"
            disabled={body.diffLoading}
            onClick={() => body.loadDiff()}
          >
            {body.diffLoading ? t("modal.diff.loading") : t("modal.diff.load")}
          </Button>
          <p className="ad-modal__note">{t("modal.diff.note")}</p>
          {body.diffError ? (
            <p className="ad-modal__error">{t("modal.diff.error", { error: body.diffError })}</p>
          ) : null}
          {body.diff ? (
            <>
              {body.diff.secret_detected ? (
                <Tag tone="warn" size="sm" data-testid="action-diff-secret">
                  {t("modal.diff.secret", { count: body.diff.redaction_count })}
                </Tag>
              ) : null}
              <pre className="ad-modal__pre" aria-label={t("modal.diff.aria")}>
                {body.diff.body || t("modal.diff.empty")}
                {body.diff.truncated ? t("modal.diff.truncated") : ""}
              </pre>
            </>
          ) : null}
        </section>
      </div>
    </Modal>
  );
}
