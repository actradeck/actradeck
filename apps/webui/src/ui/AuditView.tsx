"use client";

/**
 * 監査ビュー (強み(a) audit view/export)。
 *
 * 期間を指定して全セッションのガバナンス証跡 (redaction 種類別件数 / 承認 decision 別件数 /
 * 高リスク件数 / メタ) を集約表示し、JSON/CSV で export する。供給は same-origin
 * `/realtime/audit/...` の pull のみ (**token は載せない** — BFF が server-side で付与)。
 * 表示・export は backend allow-list 集計値のみで原文秘匿を含まない (INV-AUDIT-EXPORT-NO-RAW)。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AuditDetailModal } from "./AuditDetailModal";
import {
  aggregateSessions,
  buildAuditUrl,
  decidedTotal,
  distinctProjects,
  filterSessions,
  formatKindCounts,
  formatStamp,
  parseAuditReport,
  projectLabel,
  shortenPath,
  type AuditRangeReport,
} from "./audit-view";
import { Button, InlineAlert, Select, Tag } from "./kit";
import { useLocale } from "./LocaleProvider";

/** 日付テキスト入力の値 (YYYY-MM-DD) を ISO8601 の日境界へ。空/不正は undefined (= 無制限)。 */
function dayStartIso(date: string): string | undefined {
  if (!date) return undefined;
  const t = Date.parse(`${date}T00:00:00.000Z`);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}
function dayEndIso(date: string): string | undefined {
  if (!date) return undefined;
  const t = Date.parse(`${date}T23:59:59.999Z`);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

export function AuditView({
  active,
  onReplay,
}: {
  readonly active: boolean;
  /** 監査行 → 詳細モーダル → 「このセッションを再生」で Replay へ deep-link する導線 (任意)。 */
  readonly onReplay?: (sessionId: string) => void;
}): React.JSX.Element {
  const { t } = useLocale();
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [report, setReport] = useState<AuditRangeReport | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // 行クリックで開く詳細モーダルの対象 session_id (null = 閉)。
  const [selected, setSelected] = useState<string | null>(null);
  // クライアント側フィルタ (読み込み済みセッションを絞る・backend 非依存)。
  const [projectFilter, setProjectFilter] = useState("");
  const [textFilter, setTextFilter] = useState("");

  const range = useCallback(
    () => ({
      ...(dayStartIso(fromDate) !== undefined ? { from: dayStartIso(fromDate) } : {}),
      ...(dayEndIso(toDate) !== undefined ? { to: dayEndIso(toDate) } : {}),
    }),
    [fromDate, toDate],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const res = await fetch(buildAuditUrl(range()), { headers: { accept: "application/json" } });
      if (!res.ok) {
        setError(t("audit.error"));
        setReport(undefined);
        return;
      }
      setReport(parseAuditReport((await res.json()) as unknown));
    } catch {
      setError(t("audit.error"));
      setReport(undefined);
    } finally {
      setLoading(false);
    }
  }, [range, t]);

  const download = useCallback(
    async (format: "json" | "csv") => {
      setError(undefined);
      try {
        const url = buildAuditUrl({ ...range(), format });
        const res = await fetch(url, {
          headers: { accept: format === "csv" ? "text/csv" : "application/json" },
        });
        if (!res.ok) {
          setError(t("audit.error"));
          return;
        }
        const text = await res.text();
        const blob = new Blob([text], {
          type: format === "csv" ? "text/csv;charset=utf-8" : "application/json",
        });
        const href = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = href;
        a.download = `actradeck-audit.${format}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(href);
      } catch {
        setError(t("audit.error"));
      }
    },
    [range, t],
  );

  // 監査タブを開いたら一度だけ自動集計する (空のツールバーだけが浮く初期表示を避ける)。
  const didAutoLoad = useRef(false);
  useEffect(() => {
    if (active && !didAutoLoad.current) {
      didAutoLoad.current = true;
      void load();
    }
  }, [active, load]);

  const sessions = report?.sessions ?? [];
  const projects = useMemo(() => distinctProjects(sessions), [sessions]);
  const visibleSessions = useMemo(
    () => filterSessions(sessions, projectFilter, textFilter),
    [sessions, projectFilter, textFilter],
  );
  // KPI はフィルタ適用後の表示中セッションから集計する (絞り込みと数値を一致させる)。
  const totals = useMemo(() => aggregateSessions(visibleSessions), [visibleSessions]);

  if (!active) return <></>;

  return (
    <section className="ad-audit" aria-label={t("audit.title")} data-testid="audit-view">
      <div className="ad-audit__controls">
        <label className="ad-audit__field">
          <span>{t("audit.from")}</span>
          <input
            type="text"
            inputMode="numeric"
            placeholder="YYYY-MM-DD"
            pattern="\d{4}-\d{2}-\d{2}"
            maxLength={10}
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            data-testid="audit-from"
          />
        </label>
        <label className="ad-audit__field">
          <span>{t("audit.to")}</span>
          <input
            type="text"
            inputMode="numeric"
            placeholder="YYYY-MM-DD"
            pattern="\d{4}-\d{2}-\d{2}"
            maxLength={10}
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            data-testid="audit-to"
          />
        </label>
        <Button
          kind="primary"
          iconStart="activity"
          className="ad-audit__load"
          onClick={() => void load()}
          data-testid="audit-load"
          title={t("audit.load.title")}
        >
          {loading ? t("audit.loading") : t("audit.load")}
        </Button>
        <div className="ad-audit__controls-spacer" aria-hidden="true" />
        <Button
          kind="ghost"
          size="sm"
          disabled={report === undefined}
          onClick={() => void download("json")}
          data-testid="audit-export-json"
          title={t("audit.exportJson.title")}
        >
          {t("audit.exportJson")}
        </Button>
        <Button
          kind="ghost"
          size="sm"
          disabled={report === undefined}
          onClick={() => void download("csv")}
          data-testid="audit-export-csv"
          title={t("audit.exportCsv.title")}
        >
          {t("audit.exportCsv")}
        </Button>
      </div>

      {error !== undefined ? <InlineAlert kind="error" title={error} /> : null}

      {report === undefined ? (
        loading ? (
          <p className="ad-audit__empty">{t("audit.loading")}</p>
        ) : error === undefined ? (
          <p className="ad-audit__empty">{t("audit.initialHint")}</p>
        ) : null
      ) : (
        <>
          <div className="ad-audit__summary" data-testid="audit-totals">
            <div className="ad-audit__kpi">
              <span className="ad-audit__kpi-label">{t("audit.sessions")}</span>
              <span className="ad-audit__kpi-value">{totals.sessions}</span>
            </div>
            <div className="ad-audit__kpi" data-tone={totals.redactions > 0 ? "warn" : "neutral"}>
              <span className="ad-audit__kpi-label">{t("audit.redactions")}</span>
              <span className="ad-audit__kpi-value">{totals.redactions}</span>
            </div>
            <div className="ad-audit__kpi" data-tone={totals.deny > 0 ? "danger" : "neutral"}>
              <span className="ad-audit__kpi-label">{t("audit.deny")}</span>
              <span className="ad-audit__kpi-value">{totals.deny}</span>
            </div>
            <div className="ad-audit__kpi">
              <span className="ad-audit__kpi-label">{t("audit.approvals")}</span>
              <span className="ad-audit__kpi-value">{totals.approvals}</span>
            </div>
            <div className="ad-audit__kpi" data-tone={totals.highRisk > 0 ? "warn" : "neutral"}>
              <span className="ad-audit__kpi-label">{t("audit.highRisk")}</span>
              <span className="ad-audit__kpi-value">{totals.highRisk}</span>
            </div>
          </div>

          {report.sessions.length === 0 ? (
            <p className="ad-audit__empty">{t("audit.empty")}</p>
          ) : (
            <>
              <div className="ad-audit__filters">
                <Select
                  id="audit-filter-project"
                  label={t("audit.filter.project")}
                  value={projectFilter}
                  onChange={(e) => setProjectFilter(e.target.value)}
                  data-testid="audit-filter-project"
                >
                  <option value="">{t("audit.filter.allProjects")}</option>
                  {projects.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </Select>
                <label className="ad-audit__field">
                  <span>{t("audit.filter.search")}</span>
                  <input
                    type="search"
                    className="ad-audit__search-input"
                    value={textFilter}
                    placeholder={t("audit.filter.searchPlaceholder")}
                    onChange={(e) => setTextFilter(e.target.value)}
                    data-testid="audit-filter-search"
                  />
                </label>
                <span className="ad-audit__count" data-testid="audit-count">
                  {t("audit.filter.showing", {
                    shown: visibleSessions.length,
                    total: report.sessions.length,
                  })}
                </span>
              </div>

              {visibleSessions.length === 0 ? (
                <p className="ad-audit__empty">{t("audit.filteredEmpty")}</p>
              ) : (
                <ul className="ad-audit__list">
                  {visibleSessions.map((s) => (
                    <li key={s.session_id}>
                      <button
                        type="button"
                        className="ad-audit__row"
                        data-testid="audit-row"
                        aria-haspopup="dialog"
                        aria-label={`${projectLabel(s)} — ${t("audit.detail.openRow")}`}
                        onClick={() => setSelected(s.session_id)}
                      >
                        <span className="ad-audit__row-head">
                          <span className="ad-audit__row-title">
                            <span className="ad-audit__project">{projectLabel(s)}</span>
                            <Tag tone="info" size="sm">
                              {s.provider}
                              {s.source.length > 0 ? ` · ${s.source}` : ""}
                            </Tag>
                            {s.branch !== undefined ? (
                              <span className="ad-audit__branch">@{s.branch}</span>
                            ) : null}
                            {s.state !== undefined ? (
                              <span className="ad-audit__state">{s.state}</span>
                            ) : null}
                          </span>
                          <span className="ad-audit__meta">
                            {s.cwd !== undefined ? (
                              <span className="ad-audit__path">{shortenPath(s.cwd)}</span>
                            ) : null}
                            {s.last_event_at !== undefined ? (
                              <span className="ad-audit__when">
                                {t("audit.lastEvent")}: {formatStamp(s.last_event_at)}
                              </span>
                            ) : null}
                          </span>
                        </span>
                        <span className="ad-audit__row-tags">
                          {s.secret_detected ? (
                            <Tag tone="warn" size="sm">
                              🔒 {s.secret_redaction_count}
                            </Tag>
                          ) : null}
                          {formatKindCounts(s.secret_redaction_count_by_kind).map((label) => (
                            <Tag key={label} tone="neutral" size="sm">
                              {label}
                            </Tag>
                          ))}
                          {s.approvals.by_decision.deny > 0 ? (
                            <Tag tone="danger" size="sm">
                              {t("audit.deny")} ×{s.approvals.by_decision.deny}
                            </Tag>
                          ) : null}
                          {decidedTotal(s.approvals) - s.approvals.by_decision.deny > 0 ? (
                            <Tag tone="success" size="sm">
                              {t("audit.allow")} ×
                              {decidedTotal(s.approvals) - s.approvals.by_decision.deny}
                            </Tag>
                          ) : null}
                          {s.approvals.pending > 0 ? (
                            <Tag tone="neutral" size="sm">
                              {t("audit.pending")} ×{s.approvals.pending}
                            </Tag>
                          ) : null}
                          {s.high_risk_op_count > 0 ? (
                            <Tag tone="warn" size="sm">
                              {t("audit.highRisk")} ×{s.high_risk_op_count}
                            </Tag>
                          ) : null}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          {report.has_more ? <p className="ad-audit__more">{t("audit.hasMore")}</p> : null}
        </>
      )}

      <AuditDetailModal
        sessionId={selected}
        onClose={() => setSelected(null)}
        {...(onReplay ? { onReplay } : {})}
      />
    </section>
  );
}
