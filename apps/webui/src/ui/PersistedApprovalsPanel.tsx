"use client";

/**
 * PersistedApprovalsPanel — 永続承認 allowlist の in-UI 一覧 + 失効 (PAL-v2 / ADR 019ee147)。
 *
 * - allowlist は **machine-global** (この端末の全 daemon が ~/.actradeck/approvals/allowlist.json を共有)。
 *   session 詳細内に置くが、対象は端末全体である旨を文言で明示する。
 * - データは useAllowlist が同一 origin の BFF proxy 経由で pull する。entries は NO-RAW
 *   (sha256 署名 / repo scope / basename / risk / 時刻) で、生コマンドは描画しない (security.md)。
 * - 失効は除去のみ (新規 grant を作らない)。enabled=false (永続化 OFF) でも dormant エントリを掃除できる。
 * - lazy: 既定では一覧を出さず、明示操作 (load) で取得する (diff pull と同じ保守的 pull-on-demand)。
 */
import { Button, InlineAlert, Tag } from "./kit";
import { useLocale } from "./LocaleProvider";
import { useAllowlist } from "./use-allowlist";

export interface PersistedApprovalsPanelProps {
  readonly sessionId: string;
  /** 残り期限算出の基準時刻 (テスト決定論化用・既定 Date.now)。 */
  readonly nowMs?: number;
}

/** 残り期限を人間可読に (分→時→日)。期限切れは null (呼び元が i18n の「期限切れ」を出す)。 */
function formatRemaining(expiresAtMs: number, nowMs: number): string | null {
  const ms = expiresAtMs - nowMs;
  if (ms <= 0) return null;
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function PersistedApprovalsPanel({ sessionId, nowMs }: PersistedApprovalsPanelProps) {
  const { t } = useLocale();
  const now = nowMs ?? Date.now();
  const { view, loading, error, load, revoke, revoking } = useAllowlist(sessionId);

  return (
    <section
      className="ad-allowlist"
      data-testid="allowlist-panel"
      aria-label={t("allowlist.aria")}
    >
      <h3 className="ad-pane-title">{t("allowlist.title")}</h3>
      <p className="ad-allowlist__desc">{t("allowlist.desc")}</p>

      {view === undefined ? (
        <Button
          kind="ghost"
          size="sm"
          data-testid="allowlist-load"
          onClick={() => load()}
          disabled={loading}
        >
          {loading ? t("allowlist.loading") : t("allowlist.load")}
        </Button>
      ) : (
        <>
          <div className="ad-allowlist__head">
            <Button
              kind="ghost"
              size="sm"
              data-testid="allowlist-reload"
              onClick={() => load()}
              disabled={loading}
            >
              {loading ? t("allowlist.loading") : t("allowlist.reload")}
            </Button>
            <span className="ad-allowlist__count" data-testid="allowlist-count">
              {t("allowlist.count", { count: view.entries.length })}
            </span>
          </div>

          {!view.enabled ? (
            <InlineAlert
              kind="warning"
              data-testid="allowlist-disabled"
              title={t("allowlist.disabled")}
            />
          ) : null}

          {view.entries.length === 0 ? (
            <p className="ad-allowlist__empty" data-testid="allowlist-empty">
              {t("allowlist.empty")}
            </p>
          ) : (
            <ul className="ad-allowlist__list" data-testid="allowlist-list">
              {view.entries.map((e) => {
                const remaining = formatRemaining(e.expires_at_ms, now);
                return (
                  <li
                    key={`${e.signature}:${e.repo_scope}`}
                    className="ad-allowlist__item"
                    data-testid="allowlist-item"
                  >
                    {/* signature は sha256 (NO-RAW)。先頭 12 桁のみ表示 (失効指定はフル署名で行う)。 */}
                    <code className="ad-allowlist__sig" data-testid="allowlist-sig">
                      {e.signature.slice(0, 12)}…
                    </code>
                    <span className="ad-allowlist__repo" data-testid="allowlist-repo">
                      {t("allowlist.repo", { repo: e.repo_label ?? "?" })}
                    </span>
                    <Tag tone="info" size="sm" data-testid="allowlist-risk">
                      {t("allowlist.risk", { risk: e.risk.length > 0 ? e.risk : "?" })}
                    </Tag>
                    <span className="ad-allowlist__expires" data-testid="allowlist-expires">
                      {remaining === null
                        ? t("allowlist.expired")
                        : t("allowlist.expires", { remaining })}
                    </span>
                    <Button
                      kind="danger"
                      size="sm"
                      data-testid="allowlist-revoke"
                      title={t("allowlist.revoke.title")}
                      disabled={revoking}
                      onClick={() => revoke(e.signature, e.repo_scope)}
                    >
                      {revoking ? t("allowlist.revoking") : t("allowlist.revoke")}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      {error !== undefined ? (
        <p className="ad-body-error" data-testid="allowlist-error">
          {t("allowlist.error", { error })}
        </p>
      ) : null}
    </section>
  );
}
