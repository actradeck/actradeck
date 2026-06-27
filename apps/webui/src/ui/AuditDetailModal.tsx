"use client";

/**
 * 監査セッション詳細モーダル。
 *
 * 監査ビューの行クリックで開き、当該セッションの監査詳細を per-session endpoint
 * (`GET /realtime/audit/sessions/:id` = detail=true・承認エントリ列付き) から pull して表示する:
 *  - メタ (どのプロジェクト=repo/cwd・いつ=開始/終了/最終イベント・provider/source・取得方式・権限モード・状態)
 *  - ガバナンス証跡の集計 (secret 種別件数 / 承認 decision 別 / 高リスク)
 *  - 承認イベントのタイムライン (timestamp / tool / risk / decision / 自動許可)
 *
 * 供給は same-origin pull のみ (**token は載せない** — BFF が server-side で付与)。表示は backend
 * allow-list DTO の集計値・enum・メタのみで原文秘匿を含まない (INV-AUDIT-EXPORT-NO-RAW)。
 * 既存 .ad-modal__* スタイルを再利用 (ActionDetailModal と同規約)。閉じたら pull 済み state を破棄。
 */
import { useEffect, useId, useRef, useState } from "react";

import { decisionLabel, formatClock, riskTone } from "./action-units-display";
import {
  buildRedactionOccurrencesUrl,
  buildSessionAuditUrl,
  decidedTotal,
  entryPrimaryText,
  formatStamp,
  occurrencePrimaryText,
  parseAuditSession,
  parseRedactionOccurrences,
  projectLabel,
  shortenPath,
  sortedKindCounts,
  type AuditSessionSummary,
  type RedactionOccurrences,
} from "./audit-view";
import { Button, Modal, Tag } from "./kit";
import { useLocale } from "./LocaleProvider";

export interface AuditDetailModalProps {
  /** 表示対象 session_id。null のときモーダルは閉じている。 */
  readonly sessionId: string | null;
  readonly onClose: () => void;
  /**
   * 「このセッションを再生」導線 (任意)。指定時はヘッダーに Replay ボタンを出し、押下で
   * 当該 session_id を渡してモーダルを閉じる。調査(監査)→ 再構成(Replay) を直結する
   * (ユーザー指摘: Replay が構造的に遠い)。配線側 (CockpitBoard) が board+replay へ deep-link する。
   */
  readonly onReplay?: (sessionId: string) => void;
  /**
   * ガバナンス証跡の occurrence から該当イベントを Replay で開く導線 (任意)。
   * 供給時のみ各 occurrence に「Replay で確認」を出す。実際のビュー遷移は呼び出し側が担う
   * (本モーダルは sessionId + eventId を渡すだけ・decision 019f03cc で deep-link 統合は後続)。
   */
  readonly onJumpToReplay?: (sessionId: string, eventId: string) => void;
}

export function AuditDetailModal({
  sessionId,
  onClose,
  onReplay,
  onJumpToReplay,
}: AuditDetailModalProps) {
  const { t, locale } = useLocale();
  const titleId = useId();
  const [summary, setSummary] = useState<AuditSessionSummary | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // 世代ガード: sessionId が変わるたび最新 fetch のみ反映 (古い応答の取りこぼし防止)。
  const genRef = useRef(0);

  // ガバナンス証跡 drill-down (decision 019f03cc): kind タグ click → 当該 kind の発生イベント一覧。
  const [openKind, setOpenKind] = useState<string | null>(null);
  const [occ, setOcc] = useState<RedactionOccurrences | undefined>(undefined);
  const [occLoading, setOccLoading] = useState(false);
  const [occError, setOccError] = useState<string | undefined>(undefined);
  // drill-down 専用の世代ガード (kind 切替で最新のみ反映)。
  const occGenRef = useRef(0);

  // session 切替/クローズで drill-down 表示も破棄する (別 session の occurrence を残さない)。
  const resetDrilldown = (): void => {
    occGenRef.current++;
    setOpenKind(null);
    setOcc(undefined);
    setOccError(undefined);
    setOccLoading(false);
  };

  useEffect(() => {
    if (sessionId === null) {
      // 閉じたら pull 済み詳細を破棄 (メモリ衛生)。
      genRef.current++;
      setSummary(undefined);
      setError(undefined);
      setLoading(false);
      resetDrilldown();
      return;
    }
    const gen = ++genRef.current;
    setLoading(true);
    setError(undefined);
    setSummary(undefined);
    resetDrilldown();
    void (async () => {
      try {
        const res = await fetch(buildSessionAuditUrl(sessionId), {
          headers: { accept: "application/json" },
        });
        if (genRef.current !== gen) return;
        if (!res.ok) {
          setError(t("audit.error"));
          return;
        }
        const parsed = parseAuditSession((await res.json()) as unknown);
        if (genRef.current !== gen) return;
        if (parsed === undefined) {
          setError(t("audit.error"));
          return;
        }
        setSummary(parsed);
      } catch {
        if (genRef.current === gen) setError(t("audit.error"));
      } finally {
        if (genRef.current === gen) setLoading(false);
      }
    })();
  }, [sessionId, t]);

  // kind タグ click: 同 kind 再 click で閉じ、別 kind なら当該 kind の発生イベントを pull。
  const toggleKind = (kind: string): void => {
    if (sessionId === null) return;
    if (openKind === kind) {
      resetDrilldown();
      return;
    }
    const gen = ++occGenRef.current;
    setOpenKind(kind);
    setOcc(undefined);
    setOccError(undefined);
    setOccLoading(true);
    void (async () => {
      try {
        const res = await fetch(buildRedactionOccurrencesUrl(sessionId, kind), {
          headers: { accept: "application/json" },
        });
        if (occGenRef.current !== gen) return;
        if (!res.ok) {
          setOccError(t("audit.occurrences.error"));
          return;
        }
        const parsed = parseRedactionOccurrences((await res.json()) as unknown);
        if (occGenRef.current !== gen) return;
        if (parsed === undefined) {
          setOccError(t("audit.occurrences.error"));
          return;
        }
        setOcc(parsed);
      } catch {
        if (occGenRef.current === gen) setOccError(t("audit.occurrences.error"));
      } finally {
        if (occGenRef.current === gen) setOccLoading(false);
      }
    })();
  };

  const meta: ReadonlyArray<readonly [string, string | undefined]> =
    summary === undefined
      ? []
      : [
          [t("audit.detail.session"), summary.session_id],
          [
            t("audit.detail.agent"),
            [summary.provider, summary.source].filter((x) => x.length > 0).join(" · ") || undefined,
          ],
          [t("audit.detail.repo"), summary.repo],
          [t("audit.detail.cwd"), summary.cwd !== undefined ? shortenPath(summary.cwd) : undefined],
          [t("audit.detail.captureMode"), summary.capture_mode],
          [t("audit.detail.permissionMode"), summary.permission_mode],
          [t("audit.detail.state"), summary.state],
          [t("audit.detail.started"), formatStamp(summary.started_at) || undefined],
          [t("audit.detail.ended"), formatStamp(summary.ended_at) || undefined],
          [t("audit.lastEvent"), formatStamp(summary.last_event_at) || undefined],
        ];

  const allowCount =
    summary === undefined
      ? 0
      : decidedTotal(summary.approvals) - summary.approvals.by_decision.deny;

  return (
    <Modal
      open={sessionId !== null}
      onClose={onClose}
      titleId={titleId}
      className="ad-audit-modal"
      data-testid="audit-detail"
    >
      <div className="ad-modal__header">
        <h2 id={titleId} className="ad-modal__title">
          {t("audit.detail.title")}
          {summary !== undefined ? (
            <span className="ad-modal__title-sub"> — {projectLabel(summary)}</span>
          ) : null}
        </h2>
        <div className="ad-modal__header-actions">
          {onReplay && sessionId !== null ? (
            <Button
              kind="primary"
              size="sm"
              iconStart="renew"
              data-testid="audit-detail-replay"
              onClick={() => {
                onReplay(sessionId);
                onClose();
              }}
            >
              {t("audit.detail.replay")}
            </Button>
          ) : null}
          <Button kind="ghost" size="sm" onClick={onClose} data-testid="audit-detail-close">
            {t("modal.close")}
          </Button>
        </div>
      </div>

      <div className="ad-modal__body">
        {loading ? <p className="ad-modal__muted">{t("audit.loading")}</p> : null}
        {error !== undefined ? <p className="ad-modal__error">{error}</p> : null}

        {summary !== undefined ? (
          <>
            <section className="ad-modal__section">
              {meta.map(([label, value]) =>
                value !== undefined ? (
                  <p key={label} className="ad-modal__kv">
                    <span className="ad-modal__kv-label">{label}</span>
                    <span>{value}</span>
                  </p>
                ) : null,
              )}
            </section>

            <section className="ad-modal__section">
              <h3 className="ad-modal__label">{t("audit.detail.governance")}</h3>
              <div className="ad-modal__chips">
                <Tag tone={summary.secret_detected ? "warn" : "neutral"} size="sm">
                  🔒 {t("audit.redactions")} ×{summary.secret_redaction_count}
                </Tag>
                {/* kind 別件数は click で当該 redaction の発生イベントへ drill-down (decision 019f03cc)。
                    閲覧用に button 化 (キーボード操作・aria-expanded)・件数/kind 名のみ (原文非載せ)。 */}
                {sortedKindCounts(summary.secret_redaction_count_by_kind).map(({ kind, count }) => (
                  <button
                    key={kind}
                    type="button"
                    className="ad-kind-chip"
                    data-testid={`audit-kind-${kind}`}
                    aria-expanded={openKind === kind}
                    data-active={openKind === kind}
                    onClick={() => toggleKind(kind)}
                  >
                    {kind} ×{count}
                  </button>
                ))}
                {summary.approvals.by_decision.deny > 0 ? (
                  <Tag tone="danger" size="sm">
                    {t("audit.deny")} ×{summary.approvals.by_decision.deny}
                  </Tag>
                ) : null}
                {allowCount > 0 ? (
                  <Tag tone="success" size="sm">
                    {t("audit.allow")} ×{allowCount}
                  </Tag>
                ) : null}
                {summary.approvals.pending > 0 ? (
                  <Tag tone="neutral" size="sm">
                    {t("audit.pending")} ×{summary.approvals.pending}
                  </Tag>
                ) : null}
                {summary.high_risk_op_count > 0 ? (
                  <Tag tone="warn" size="sm">
                    {t("audit.highRisk")} ×{summary.high_risk_op_count}
                  </Tag>
                ) : null}
              </div>

              {/* drill-down: 選択 kind の発生イベント一覧 (timestamp / event_type / redacted 文脈 / 件数)。
                  原文は出さない (redacted command/path のみ)。供給時のみ Replay 導線を出す。 */}
              {openKind !== null ? (
                <div className="ad-occ" data-testid="audit-occurrences">
                  <p className="ad-occ__head">
                    <span className="ad-occ__title">
                      {t("audit.occurrences.title")} — <code>{openKind}</code>
                    </span>
                    {occ !== undefined ? (
                      <span className="ad-occ__meta">
                        {t("audit.occurrences.showing", {
                          events: occ.occurrences.length,
                          markers: occ.total,
                        })}
                        {occ.has_more ? ` · ${t("audit.occurrences.more")}` : ""}
                      </span>
                    ) : null}
                  </p>
                  {occLoading ? (
                    <p className="ad-modal__muted">{t("audit.occurrences.loading")}</p>
                  ) : null}
                  {occError !== undefined ? <p className="ad-modal__error">{occError}</p> : null}
                  {occ !== undefined && !occLoading ? (
                    occ.occurrences.length > 0 ? (
                      <ul className="ad-modal__events" data-testid="audit-occurrence-list">
                        {occ.occurrences.map((o) => (
                          <li key={o.event_id} className="ad-audit-detail__event">
                            <span className="ad-audit-detail__event-meta">
                              <time className="ad-audit-detail__event-time">
                                {formatStamp(o.timestamp)}
                              </time>
                              <Tag tone="neutral" size="sm">
                                {o.event_type}
                              </Tag>
                              <Tag tone="warn" size="sm">
                                🔒 ×{o.count}
                              </Tag>
                              {onJumpToReplay !== undefined ? (
                                <Button
                                  kind="ghost"
                                  size="sm"
                                  iconStart="renew"
                                  data-testid={`audit-occurrence-jump-${o.event_id}`}
                                  onClick={() => onJumpToReplay(summary.session_id, o.event_id)}
                                >
                                  {t("audit.occurrences.jump")}
                                </Button>
                              ) : null}
                            </span>
                            <code className="ad-audit-detail__cmd">{occurrencePrimaryText(o)}</code>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="ad-modal__muted">{t("audit.occurrences.empty")}</p>
                    )
                  ) : null}
                </div>
              ) : null}
            </section>

            <section className="ad-modal__section">
              <h3 className="ad-modal__label">{t("audit.detail.timeline")}</h3>
              {summary.entries !== undefined && summary.entries.length > 0 ? (
                <ul className="ad-modal__events" data-testid="audit-detail-timeline">
                  {summary.entries.map((e) => (
                    <li key={e.event_id} className="ad-audit-detail__event">
                      <span className="ad-audit-detail__event-meta">
                        <time className="ad-audit-detail__event-time">
                          {formatClock(e.timestamp)}
                        </time>
                        {e.tool_name !== undefined ? (
                          <Tag tone="neutral" size="sm">
                            {e.tool_name}
                          </Tag>
                        ) : null}
                        {e.risk_level !== undefined ? (
                          <Tag tone={riskTone(e.risk_level)} size="sm">
                            {t("audit.detail.risk")}: {e.risk_level}
                          </Tag>
                        ) : null}
                        {e.decision !== undefined ? (
                          <Tag tone={e.decision === "deny" ? "danger" : "success"} size="sm">
                            {decisionLabel(e.decision, locale)}
                          </Tag>
                        ) : null}
                        {e.auto_allowed === true ? (
                          <Tag tone="muted" size="sm">
                            {t("audit.detail.autoAllowed")}
                          </Tag>
                        ) : null}
                      </span>
                      {(e.command ?? e.path) !== undefined ? (
                        <code className="ad-audit-detail__cmd">{entryPrimaryText(e)}</code>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="ad-modal__muted">{t("audit.detail.noEntries")}</p>
              )}
            </section>
          </>
        ) : null}
      </div>
    </Modal>
  );
}
