"use client";

/**
 * Cockpit ボード: ライブ session 一覧 → 詳細の core 縦切り (Phase 4 スライス 1).
 * 状態は useRealtime が握り、ここは配置と「今 1 秒の now」更新だけを担う (表示層)。
 *
 * Adaptive Clarity: Carbon Header/Content/Search/Button/Tag を kit/AppHeader（token 駆動）へ置換。
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { formatCurrentAction } from "./action-units-display";
import { ApprovalInbox } from "./ApprovalInbox";
import { AuditView } from "./AuditView";
import { LiveWall } from "./LiveWall";
import { AppHeader, Button, Tag, type Tone } from "./kit";
import { LocaleToggle } from "./LocaleToggle";
import { useLocale } from "./LocaleProvider";
import { NotificationToggle } from "./NotificationToggle";
import { useNotifications } from "./use-notifications";
import { SessionDetailView } from "./SessionDetail";
import { SessionList } from "./SessionList";
import { SessionReplayView } from "./SessionReplay";
import { ThemeToggle } from "./ThemeToggle";
import { useRealtime } from "./use-realtime";
import { useSessionEvents } from "./use-session-events";
import { useSessionBody } from "./use-session-body";

export interface CockpitBoardProps {
  /**
   * same-origin BFF WS URL。未指定なら実行時に location から導出する (token は含めない —
   * BFF が server-side で Bearer を付与)。
   */
  readonly wsUrl?: string;
}

/** ブラウザの location から same-origin の BFF WS URL を導出 (http→ws / https→wss)。 */
function deriveSameOriginWsUrl(): string {
  if (typeof window === "undefined") return "ws://localhost/realtime/ws";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/realtime/ws`;
}

/** WS 接続状態を kit Tag tone へ。 */
function statusKitTone(status: string): Tone {
  if (status === "open") return "success";
  if (status === "closed" || status === "error") return "danger";
  if (status === "connecting") return "info";
  return "muted";
}

export function CockpitBoard({ wsUrl }: CockpitBoardProps) {
  const { locale, t } = useLocale();
  const url = wsUrl ?? deriveSameOriginWsUrl();
  // 通知（強み(a)）: 設定 + 発火エンジン。delta.list の prev→curr を notify へ流す（snapshot は通さない）。
  const notifications = useNotifications();
  const {
    status,
    sessions,
    selectedId,
    detail,
    select,
    approve,
    interrupt,
    lastAck,
    showHistory,
    setShowHistory,
    connectedCount,
    totalCount,
  } = useRealtime({
    url,
    onListDelta: notifications.notify,
  });
  // 相対時刻表示を 1 秒粒度で更新 (受け入れ基準: heartbeat/最終イベントの新鮮さを刻む)。
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [view, setView] = useState<"detail" | "replay">("detail");
  // 監査 → Replay の deep-link 制御 (ユーザー指摘: 調査面から Replay へ直行できない)。
  //  - requestedViewRef: 選択時に view を既定 detail へ戻す effect を、deep-link のときだけ replay に上書きさせる。
  //  - pinnedSelectionRef: 自動選択 effect が「一覧に未出現の選択(履歴ロード前の過去 session)」を
  //    先頭へ上書きするのを防ぐ。deep-link で選んだ session を保持する。
  const requestedViewRef = useRef<"replay" | null>(null);
  const pinnedSelectionRef = useRef<string | null>(null);
  // トップレベルビュー: 通常ボード ↔ 横断 Approval Inbox (ADR 019ead14 D2) ↔ Live Wall (ADR 019ead7a D3)。
  const [topView, setTopView] = useState<"board" | "inbox" | "wall" | "audit">("board");
  const [query, setQuery] = useState("");
  // セッション詳細4ペイン (ADR 019ea4ba 段階1) の素材。詳細表示中のみ取得する
  // (replay 表示中は SessionReplayView が独自に取得するため二重取得を避ける)。
  const { events: detailEvents } = useSessionEvents(view === "detail" ? selectedId : null);
  // 段階2 (ADR 019ea4ba D2): diff/stdout 本文の on-demand pull。詳細表示中の選択 session のみ。
  // session 切替で保持本文を破棄する (秘匿本文をメモリに残さない)。
  const sessionBody = useSessionBody(view === "detail" ? selectedId : null);
  const { clear: clearBody } = sessionBody;
  useEffect(() => {
    clearBody();
  }, [selectedId, view, clearBody]);
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    // 選択切替で既定 detail へ。ただし deep-link (監査→Replay) が replay を要求していれば尊重。
    setView(requestedViewRef.current ?? "detail");
    requestedViewRef.current = null;
  }, [selectedId]);
  useEffect(() => {
    const firstSessionId = sessions[0]?.session_id;
    if (!firstSessionId) return;
    if (selectedId && sessions.some((s) => s.session_id === selectedId)) return;
    // deep-link で選んだ session は、履歴ロード前で一覧に未出現でも先頭へ上書きしない。
    if (selectedId && pinnedSelectionRef.current === selectedId) return;
    select(firstSessionId);
  }, [sessions, selectedId, select]);
  // 監査詳細 →「このセッションを再生」: board + Replay へ直行する。selectedId 変化で view が
  // detail に戻る effect と、自動選択 effect の上書きを ref で無効化したうえで replay を開く。
  const openSessionReplay = useCallback(
    (sessionId: string) => {
      pinnedSelectionRef.current = sessionId;
      setShowHistory(true); // 過去 session を一覧へ出して選択ハイライトを成立させる
      setTopView("board");
      if (sessionId === selectedId) {
        // 既に選択済み: selectedId は変わらず view リセット effect も走らないため直接 replay へ。
        setView("replay");
      } else {
        requestedViewRef.current = "replay";
        select(sessionId);
      }
    },
    [selectedId, select, setShowHistory],
  );

  const normalizedQuery = query.trim().toLowerCase();
  const filteredSessions =
    normalizedQuery.length === 0
      ? sessions
      : sessions.filter((s) =>
          [s.session_id, s.repo, s.branch, s.cwd, s.provider, s.state, s.current_action, s.agent_id]
            .filter((v): v is string => typeof v === "string" && v.length > 0)
            .some((v) => v.toLowerCase().includes(normalizedQuery)),
        );
  const attentionCount = sessions.filter((s) => s.needs_attention).length;
  const runningCount = sessions.filter((s) => s.state?.startsWith("running.")).length;
  // Live Wall の live nudge (ADR 019ead7a D1): connected な session の last_event_at が進むと
  // 値が変わる refreshKey。delta.list の更新で Wall を軽量再 fetch する (新 frame 型を作らない)。
  const wallRefreshKey = sessions.reduce((acc, s) => {
    if (!s.connected || typeof s.last_event_at !== "string") return acc;
    const t = Date.parse(s.last_event_at);
    return Number.isNaN(t) ? acc : acc + t;
  }, 0);
  // 空一覧の文脈別文言(架空状態を出さない・実データに忠実)。
  const emptyLabel =
    normalizedQuery.length > 0
      ? t("workspace.empty.noMatch")
      : !showHistory && totalCount > 0
        ? t("workspace.empty.noLive", { count: totalCount })
        : undefined;
  // 履歴ゲート緩和 (C): 検索一致0 かつ履歴OFF かつ過去 session が存在するとき、その場で
  // 「履歴も含めて検索」を出す。既定 起動中のみで過去 session が隠れる罠 (Replay 到達性) を解く。
  const canSearchHistory =
    normalizedQuery.length > 0 &&
    filteredSessions.length === 0 &&
    !showHistory &&
    totalCount > connectedCount;
  const selectedLabel =
    formatCurrentAction(
      {
        kind: detail?.current_action_kind,
        subject: detail?.current_action_subject,
        fallback: detail?.current_action,
      },
      locale,
    ) ??
    detail?.state ??
    (selectedId ? selectedId.slice(0, 12) : t("common.dash"));

  return (
    <div className="ad-shell">
      <AppHeader
        productName={t("common.product")}
        tagline={t("common.tagline")}
        skipLabel={t("common.skipToMain")}
        markSrc="/brand/icon.svg"
      >
        <NotificationToggle notifications={notifications} />
        <LocaleToggle />
        <ThemeToggle />
      </AppHeader>
      <div className="ad-content">
        <main id="main" data-testid="cockpit" className="ad-board">
          <section className="ad-overview" aria-label="session summary">
            <div className="ad-metric" data-testid="conn-status" data-status={status}>
              <span className="ad-metric__label">{t("overview.connection")}</span>
              <Tag tone={statusKitTone(status)} size="md" iconStart="activity">
                {status}
              </Tag>
            </div>
            <div className="ad-metric">
              <span className="ad-metric__label">{t("overview.connected")}</span>
              <span className="ad-metric__value" data-testid="connected-count">
                {connectedCount}
              </span>
            </div>
            <div className="ad-metric">
              <span className="ad-metric__label">{t("overview.running")}</span>
              <span className="ad-metric__value">{runningCount}</span>
            </div>
            <div className="ad-metric">
              <span className="ad-metric__label">{t("overview.needsAttention")}</span>
              <span className="ad-metric__value">{attentionCount}</span>
            </div>
            <div className="ad-segment" data-testid="top-tabs">
              <Button
                kind="ghost"
                size="sm"
                iconStart="dashboard"
                aria-pressed={topView === "board"}
                data-active={topView === "board"}
                onClick={() => setTopView("board")}
              >
                {t("tab.board")}
              </Button>
              <Button
                kind="ghost"
                size="sm"
                iconStart="warning"
                data-testid="open-inbox"
                aria-pressed={topView === "inbox"}
                data-active={topView === "inbox"}
                onClick={() => setTopView("inbox")}
              >
                {attentionCount > 0
                  ? t("tab.inboxCount", { count: attentionCount })
                  : t("tab.inbox")}
              </Button>
              <Button
                kind="ghost"
                size="sm"
                iconStart="activity"
                data-testid="open-wall"
                aria-pressed={topView === "wall"}
                data-active={topView === "wall"}
                onClick={() => setTopView("wall")}
              >
                {t("tab.wall")}
              </Button>
              <Button
                kind="ghost"
                size="sm"
                iconStart="dashboard"
                data-testid="open-audit"
                aria-pressed={topView === "audit"}
                data-active={topView === "audit"}
                onClick={() => setTopView("audit")}
              >
                {t("tab.audit")}
              </Button>
            </div>
          </section>

          {topView === "inbox" ? (
            <ApprovalInbox
              active={topView === "inbox"}
              nowMs={nowMs}
              refreshKey={attentionCount}
              onApprove={approve}
              lastAck={lastAck}
              onOpenSession={(sessionId) => {
                select(sessionId);
                setTopView("board");
              }}
              onOpenReplay={openSessionReplay}
            />
          ) : topView === "wall" ? (
            <LiveWall
              active={topView === "wall"}
              nowMs={nowMs}
              refreshKey={wallRefreshKey}
              onOpenSession={(sessionId) => {
                select(sessionId);
                setTopView("board");
              }}
              onOpenReplay={openSessionReplay}
              onApprove={approve}
              lastAck={lastAck}
            />
          ) : topView === "audit" ? (
            <AuditView active={topView === "audit"} onReplay={openSessionReplay} />
          ) : (
            <section className="ad-workspace">
              <aside className="ad-panel" aria-label="sessions">
                <div className="ad-panel__header">
                  <h2 className="ad-panel__title">{t("workspace.sessions")}</h2>
                  <div className="ad-panel__actions">
                    <Tag tone="neutral" size="sm">
                      {filteredSessions.length}/{sessions.length}
                    </Tag>
                    <Button
                      kind="ghost"
                      size="sm"
                      iconStart="time"
                      data-testid="toggle-history"
                      data-active={showHistory}
                      aria-pressed={showHistory}
                      onClick={() => setShowHistory(!showHistory)}
                      title={
                        showHistory
                          ? t("workspace.history.titleHide")
                          : t("workspace.history.titleShow")
                      }
                    >
                      {showHistory
                        ? t("workspace.history.showOnlyLive")
                        : t("workspace.history.withHistory", {
                            count: Math.max(0, totalCount - connectedCount),
                          })}
                    </Button>
                  </div>
                </div>
                <div className="ad-search">
                  <label htmlFor="session-search" className="ad-visually-hidden">
                    {t("workspace.search.label")}
                  </label>
                  <input
                    id="session-search"
                    type="search"
                    className="ad-search__input"
                    placeholder={t("workspace.search.placeholder")}
                    value={query}
                    onChange={(event) => setQuery(event.currentTarget.value)}
                  />
                </div>
                <div className="ad-sessions-scroll">
                  <SessionList
                    sessions={filteredSessions}
                    selectedId={selectedId}
                    nowMs={nowMs}
                    onSelect={select}
                    {...(emptyLabel !== undefined ? { emptyLabel } : {})}
                    {...(canSearchHistory
                      ? {
                          emptyAction: {
                            label: t("workspace.empty.searchHistory"),
                            onClick: () => setShowHistory(true),
                          },
                        }
                      : {})}
                  />
                </div>
              </aside>

              <section className="ad-panel" aria-label="session workspace">
                <div className="ad-panel__header">
                  <div>
                    <h2 className="ad-panel__title">{t("workspace.title")}</h2>
                    <span className="ad-session-meta">{selectedLabel}</span>
                  </div>
                  <div className="ad-segment" data-testid="detail-tabs">
                    <Button
                      kind="ghost"
                      size="sm"
                      iconStart="dashboard"
                      aria-pressed={view === "detail"}
                      data-active={view === "detail"}
                      onClick={() => setView("detail")}
                    >
                      {t("workspace.tab.detail")}
                    </Button>
                    <Button
                      kind="ghost"
                      size="sm"
                      iconStart="renew"
                      data-testid="open-replay"
                      aria-pressed={view === "replay"}
                      data-active={view === "replay"}
                      disabled={!selectedId}
                      onClick={() => setView("replay")}
                    >
                      {t("workspace.tab.replay")}
                    </Button>
                  </div>
                </div>
                <div className="ad-panel__body">
                  {view === "detail" ? (
                    <SessionDetailView
                      detail={detail}
                      loading={selectedId !== null && detail === null}
                      nowMs={nowMs}
                      onApprove={(requestId, decision, persist) => {
                        if (selectedId)
                          approve(selectedId, requestId, decision, undefined, persist);
                      }}
                      onInterrupt={selectedId ? () => interrupt(selectedId) : undefined}
                      lastAck={lastAck}
                      events={detailEvents}
                      body={sessionBody}
                    />
                  ) : (
                    <SessionReplayView
                      sessionId={selectedId}
                      {...(detail
                        ? {
                            identity: {
                              ...(detail.repo !== undefined ? { repo: detail.repo } : {}),
                              ...(detail.branch !== undefined ? { branch: detail.branch } : {}),
                              provider: detail.provider,
                              ...(detail.cwd !== undefined ? { cwd: detail.cwd } : {}),
                            },
                          }
                        : {})}
                    />
                  )}
                </div>
              </section>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
