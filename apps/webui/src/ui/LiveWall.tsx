"use client";

/**
 * Live Wall (ADR 019ead7a 段階1)。
 *
 * 全 live session のアクションを **共通時間軸**のウォーターフォールで横断可視化する新トップビュー
 * (design 019ead09)。各レーン = 1 connected session、行 bar = 1 アクションの所要時間 (decision D2 の
 * 決定論純関数 windowEvents/computeLaneBars/barGeometry)。カードクリックで既存 detail へ deep-link。
 *
 * 供給は pull (use-wall-feed) のみ。単一選択購読 (use-realtime) を触らない (INV-WALL-SINGLE-SELECT-INTACT)。
 * SEC: 表示は backend allow-list 投影 ReplayEventDTO の値のみ (display_text 等・redaction 済 at-rest)。
 * 観測イベントのみ描画し、duration を捏造しない (INV-WALL-OBSERVED-ONLY)。
 */
import { useRef, useState } from "react";

import { formatCurrentAction } from "./action-units-display";
import { ApprovalCard } from "./ApprovalCard";
import { Button, Icon, InlineAlert, StatusBadge, Tag } from "./kit";
import { useLocale } from "./LocaleProvider";
import { livenessBadge } from "./liveness-display";
import { useApprovalInbox } from "./use-approval-inbox";
import {
  applyLaneOrder,
  attentionLaneIds,
  barGeometry,
  barMotion,
  computeLaneBars,
  DEFAULT_WALL_WINDOW_MS,
  formatElapsed,
  laneCollapsedDefault,
  laneLiveElapsedMs,
  reorderByPointerY,
  rulerDivisionsFor,
  rulerTicks,
  shortenCwd,
  WALL_WINDOW_PRESETS,
  windowEvents,
} from "./wall-display";
import { useWallFeed } from "./use-wall-feed";
import { useWallLaneOrder } from "./use-wall-order";

import type { AckState, ApprovalDecision } from "./approval-display";
import type { MessageKey } from "./i18n/messages";
import type { RulerTick } from "./wall-display";
import type { PendingApproval, WallLane } from "../realtime/contract";

/**
 * ネイティブ DnD の既定スナップショット (半透明の要素複製) を消すための 1x1 透明画像。
 * 代わりに自前の追従ゴースト overlay を指の真下に描く (リッチな掴み感)。
 * SSR (renderToStaticMarkup) では Image が無いので呼び出しは onDragStart (ブラウザのみ) に限定し、
 * 生成は遅延・キャッシュする。失敗 (古い環境) は握り潰し既定ゴーストにフォールバックする。
 */
let cachedEmptyDragImage: HTMLImageElement | null = null;
function setEmptyDragImage(dt: DataTransfer): void {
  try {
    if (!cachedEmptyDragImage) {
      const img = new Image();
      img.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
      cachedEmptyDragImage = img;
    }
    dt.setDragImage(cachedEmptyDragImage, 0, 0);
  } catch {
    /* setDragImage 非対応はフォールバック (既定スナップショット)。 */
  }
}

/** ドラッグ追従の進行状態 (overlay ゴーストの位置 + ライブプレビュー順)。 */
interface WallDragState {
  readonly id: string;
  /** 追従ゴーストの固定 left / 幅 (掴んだ瞬間の矩形)。 */
  readonly left: number;
  readonly width: number;
  /** ポインタ Y と掴んだ点のレーン内オフセット (ghost top = pointerY - grabDY)。 */
  readonly pointerY: number;
  readonly grabDY: number;
  /** ライブで再計算される表示順 (現存 id の置換)。 */
  readonly preview: string[];
}

export interface LiveWallProps {
  /** Wall が表示中か (false の間は fetch せず保持を破棄する)。 */
  readonly active: boolean;
  /** 親が握る 1 秒粒度の現在時刻 (ライブ追従窓・伸びるバーを刻む)。 */
  readonly nowMs: number;
  /** 変化で再 fetch するキー (delta.list の last_event_at nudge)。 */
  readonly refreshKey?: number;
  /** カードから対象 session の詳細へ deep-link する (既存 select を呼ぶのは親)。 */
  readonly onOpenSession?: (sessionId: string) => void;
  /** カードから対象 session の Replay へ直行する (board+replay deep-link・親が握る)。 */
  readonly onOpenReplay?: (sessionId: string) => void;
  /**
   * Wall インライン承認: 承認判断の送信 (Inbox/Detail と同一の既存 WS relay 経路)。
   * **無指定なら承認 UI を一切出さず、承認 pull (use-approval-inbox) も張らない** (純表示に縮退)。
   * session_id は relay 境界 (canRelay) の不変キーなので明示で渡す (ApprovalInbox と同契約)。
   */
  readonly onApprove?: (
    sessionId: string,
    requestId: string,
    decision: ApprovalDecision,
    reason?: string,
    persist?: boolean,
  ) => void;
  /** approve ack (request_id キー)。ApprovalCard の送信中/確定/失敗表示用 (D3: 楽観更新しない)。 */
  readonly lastAck?: ReadonlyMap<string, AckState>;
}

function windowLabel(
  ms: number,
  t: (key: MessageKey, params?: Record<string, string | number>) => string,
): string {
  if (ms >= 60_000) return t("time.window.minutes", { minutes: Math.round(ms / 60_000) });
  return t("time.window.seconds", { seconds: Math.round(ms / 1000) });
}

/**
 * 共通時間軸ルーラー (純表示・decoration)。窓の等分目盛り「N分前 … now」を lanes の先頭に
 * sticky 表示し、各 track の縦グリッド線 (WallLaneRow 側) と同じ rulerTicks を値源にする
 * (INV-WALL-RULER-DETERMINISM)。読み上げには冗長なので aria-hidden。
 */
export function WallRuler({ windowMs }: { readonly windowMs: number }) {
  const { locale } = useLocale();
  const ticks = rulerTicks(windowMs, rulerDivisionsFor(windowMs), locale);
  return (
    <div className="ad-wall__ruler" data-testid="wall-ruler" aria-hidden>
      <div className="ad-wall__ruler-track">
        {ticks.map((t) => (
          <span
            key={t.leftPct}
            className="ad-wall__ruler-tick"
            data-edge={t.leftPct === 0 ? "start" : t.leftPct === 100 ? "end" : undefined}
            style={{ left: `${t.leftPct}%` }}
          >
            {t.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * 1 レーン (1 connected session) の行 = アクション bar 列。段階2: 進行中バーは liveness に応じ
 * 脈動 (barMotion)、live-ongoing は静的経過カウンタを併記 (reduced-motion 代替・脈動が無効でも
 * 「実行中・経過」が伝わる)。stalled/suspected はバー静止 + StatusBadge "STALLED?" のまま
 * (INV-WALL-{MOTION-LIVENESS-MAP, STALLED-STATIC, REDUCED-MOTION-ALT})。
 */
export function WallLaneRow({
  lane,
  nowMs,
  windowMs,
  onOpenSession,
  onOpenReplay,
  reorderable = false,
  isFirst = false,
  isLast = false,
  dragging = false,
  dropPlace = null,
  ghost = false,
  collapsed = false,
  ticks,
  onToggleCollapse,
  approvals,
  onApproveDecision,
  lastAck,
  onDragStartLane,
  onDragEndLane,
  onMoveLane,
}: {
  readonly lane: WallLane;
  readonly nowMs: number;
  readonly windowMs: number;
  readonly onOpenSession?: (sessionId: string) => void;
  readonly onOpenReplay?: (sessionId: string) => void;
  /** 並べ替え UI を出すか (lane が 2 つ以上のときのみ)。 */
  readonly reorderable?: boolean;
  readonly isFirst?: boolean;
  readonly isLast?: boolean;
  /** この lane が今ドラッグ中か (フロー側プレースホルダの淡色化用)。 */
  readonly dragging?: boolean;
  /** この lane が現在のドロップ先のとき、挿入位置 (上半分=before / 下半分=after)。 */
  readonly dropPlace?: "before" | "after" | null;
  /** 追従ゴースト (overlay) として描く複製か。true ならドラッグ源イベントを張らない。 */
  readonly ghost?: boolean;
  /** 折りたたみ表示 (track を隠しヘッダのみ)。既定は親が laneCollapsedDefault で決める。 */
  readonly collapsed?: boolean;
  /** track の縦グリッド線の値源 (WallRuler と同じ rulerTicks)。無指定なら線を描かない。 */
  readonly ticks?: readonly RulerTick[];
  /** 折りたたみトグル (無指定ならトグル UI を出さない)。 */
  readonly onToggleCollapse?: () => void;
  /** この lane の承認待ち (backend allow-list 投影・sidecar redaction 済)。無指定ならカードを出さない。 */
  readonly approvals?: readonly PendingApproval[];
  /** 承認判断 (request_id, decision, persist?)。LiveWall が lane の session_id へ束縛済み。 */
  readonly onApproveDecision?: (
    requestId: string,
    decision: ApprovalDecision,
    persist?: boolean,
  ) => void;
  /** approve ack (request_id キー)。 */
  readonly lastAck?: ReadonlyMap<string, AckState>;
  /** ドラッグ開始: session_id・掴んだ瞬間の矩形・ポインタ Y を親へ渡す (追従ゴーストの起点)。 */
  readonly onDragStartLane?: (sessionId: string, rect: DOMRect, clientY: number) => void;
  readonly onDragEndLane?: () => void;
  /** キーボード代替: delta(±1) で上下移動。 */
  readonly onMoveLane?: (delta: number) => void;
}) {
  const { locale, t } = useLocale();
  const item = lane.session;
  const badge = livenessBadge(item.liveness_state, item.stalled_suspected);
  const windowStartMs = nowMs - windowMs;
  const windowed = windowEvents(lane.events, nowMs, windowMs);
  const bars = computeLaneBars(windowed, nowMs);
  const liveElapsedMs = laneLiveElapsedMs(bars, item.liveness_state, item.stalled_suspected);
  const shortId = item.session_id.slice(0, 12);
  return (
    <section
      data-testid={`wall-lane-${item.session_id}`}
      data-lane-id={item.session_id}
      className="ad-wall__lane"
      aria-label={t("wall.laneAria", { sessionId: item.session_id })}
      draggable={reorderable && !ghost ? true : undefined}
      aria-hidden={ghost || undefined}
      data-dragging={dragging || undefined}
      data-drop={dropPlace ?? undefined}
      data-attention={item.needs_attention || undefined}
      data-collapsed={collapsed || undefined}
      onDragStart={
        reorderable && !ghost
          ? (e) => {
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", item.session_id);
              // 既定の半透明スナップショットを隠し、自前の追従ゴースト (overlay) に委ねる。
              setEmptyDragImage(e.dataTransfer);
              onDragStartLane?.(
                item.session_id,
                e.currentTarget.getBoundingClientRect(),
                e.clientY,
              );
            }
          : undefined
      }
      onDragEnd={reorderable && !ghost ? () => onDragEndLane?.() : undefined}
    >
      <header className="ad-wall__lane-header">
        <div className="ad-wall__lane-header-main">
          {reorderable ? (
            <span
              className="ad-wall__drag-handle"
              data-testid={`wall-drag-${item.session_id}`}
              aria-hidden
              title={t("wall.lane.dragHandle.title")}
            >
              ⠿
            </span>
          ) : null}
          <Tag tone="neutral" size="sm" data-testid="wall-lane-provider">
            {item.provider || t("wall.lane.session")}
          </Tag>
          <code className="ad-wall__lane-id" data-testid="wall-lane-id">
            {item.session_id.slice(0, 12)}
          </code>
          <StatusBadge badge={badge} />
          {item.needs_attention ? (
            <Tag tone="danger" size="sm" data-testid="wall-lane-attention">
              {t("wall.lane.attention")}
            </Tag>
          ) : null}
          <span className="ad-wall__lane-actions">
            {onOpenSession ? (
              <Button
                kind="ghost"
                size="sm"
                iconStart="dashboard"
                data-testid={`wall-open-${item.session_id}`}
                onClick={() => onOpenSession(item.session_id)}
                title={t("wall.lane.open.title")}
              >
                {t("common.details")}
              </Button>
            ) : null}
            {onOpenReplay ? (
              <Button
                kind="ghost"
                size="sm"
                iconStart="renew"
                data-testid={`wall-replay-${item.session_id}`}
                onClick={() => onOpenReplay(item.session_id)}
                title={t("wall.lane.replay.title")}
              >
                {t("common.replay")}
              </Button>
            ) : null}
            {onToggleCollapse ? (
              <Button
                kind="ghost"
                size="sm"
                data-testid={`wall-collapse-${item.session_id}`}
                aria-expanded={!collapsed}
                aria-label={t("wall.lane.collapse.aria", {
                  sessionId: shortId,
                  verb: collapsed
                    ? t("wall.lane.collapse.expand")
                    : t("wall.lane.collapse.collapse"),
                })}
                title={
                  collapsed
                    ? t("wall.lane.collapse.titleExpand")
                    : t("wall.lane.collapse.titleCollapse")
                }
                onClick={onToggleCollapse}
              >
                {collapsed ? "▸" : "▾"}
              </Button>
            ) : null}
            {reorderable ? (
              <span
                className="ad-wall__lane-move"
                role="group"
                aria-label={t("wall.lane.move.aria")}
              >
                <Button
                  kind="ghost"
                  size="sm"
                  data-testid={`wall-move-up-${item.session_id}`}
                  aria-label={t("wall.lane.moveUp.aria", { sessionId: shortId })}
                  title={t("wall.lane.moveUp.title")}
                  disabled={isFirst}
                  onClick={() => onMoveLane?.(-1)}
                >
                  ↑
                </Button>
                <Button
                  kind="ghost"
                  size="sm"
                  data-testid={`wall-move-down-${item.session_id}`}
                  aria-label={t("wall.lane.moveDown.aria", { sessionId: shortId })}
                  title={t("wall.lane.moveDown.title")}
                  disabled={isLast}
                  onClick={() => onMoveLane?.(1)}
                >
                  ↓
                </Button>
              </span>
            ) : null}
          </span>
        </div>
        <div className="ad-wall__lane-header-meta">
          {item.cwd ? (
            <code className="ad-wall__lane-cwd" data-testid="wall-lane-cwd" title={item.cwd}>
              <Icon name="dashboard" aria-hidden /> {shortenCwd(item.cwd)}
            </code>
          ) : null}
          {item.repo ? (
            <span className="ad-session-meta" data-testid="wall-lane-repo">
              {item.repo}
              {item.branch ? `@${item.branch}` : ""}
            </span>
          ) : null}
          {liveElapsedMs !== null ? (
            <span className="ad-wall__lane-elapsed" data-testid="wall-lane-elapsed">
              <Icon name="time" aria-hidden />{" "}
              {t("wall.lane.elapsed", { elapsed: formatElapsed(liveElapsedMs, locale) })}
            </span>
          ) : null}
          {(() => {
            // 現在アクション要約は表示時ローカライズ (kind+subject 優先・欠落で legacy summary)。
            // SessionList/SessionDetail/current-action-display と同一 helper・同一 fallback 順を共有。
            const currentAction = formatCurrentAction(
              {
                kind: item.current_action_kind,
                subject: item.current_action_subject,
                fallback: item.current_action,
              },
              locale,
            );
            return currentAction ? <span className="ad-session-meta">{currentAction}</span> : null;
          })()}
        </div>
      </header>
      {collapsed ? null : (
        <div
          className="ad-wall__track"
          data-testid={`wall-track-${item.session_id}`}
          role="img"
          aria-label={t("wall.track.aria", {
            count: bars.length,
            window: windowLabel(windowMs, t),
          })}
        >
          {ticks
            ?.filter((t) => t.leftPct > 0 && t.leftPct < 100)
            .map((t) => (
              <span
                key={t.leftPct}
                className="ad-wall__gridline"
                style={{ left: `${t.leftPct}%` }}
                aria-hidden
                data-testid="wall-gridline"
              />
            ))}
          {ticks && ticks.length > 0 ? (
            <span className="ad-wall__nowline" aria-hidden data-testid="wall-nowline" />
          ) : null}
          {bars.length === 0 ? (
            <span className="ad-wall__lane-empty" data-testid="wall-lane-empty">
              <Icon name="time" aria-hidden /> {t("wall.track.empty")}
            </span>
          ) : (
            bars.map((bar) => {
              const geo = barGeometry(bar, windowStartMs, windowMs);
              const motion = barMotion(bar.mode, item.liveness_state, item.stalled_suspected);
              return (
                <span
                  key={bar.event_id}
                  className={`ad-wall__bar ad-wall__bar--${bar.kind}${
                    motion === "pulse" ? " ad-wall__bar--pulse" : ""
                  }`}
                  data-testid="wall-bar"
                  data-kind={bar.kind}
                  data-mode={bar.mode}
                  data-motion={motion}
                  style={{ left: `${geo.leftPct}%`, width: `${geo.widthPct}%` }}
                  title={bar.label}
                />
              );
            })
          )}
        </div>
      )}
      {approvals && approvals.length > 0 ? (
        // 承認カードは折りたたみ中でも描く (介入要素を絶対に隠さない・laneCollapsedDefault と同方針)。
        // ApprovalCard は Inbox/Detail と同一の単一出所コンポーネント (高リスク確認ゲート内蔵・
        // INV-INBOX-HIGHRISK-DENY-DEFAULT を構造ごと継承)。
        <ul
          className="ad-approval-list ad-wall__approvals"
          data-testid={`wall-approvals-${item.session_id}`}
          aria-label={t("wall.approvalsAria", { sessionId: item.session_id })}
        >
          {approvals.map((a) => (
            <ApprovalCard
              key={a.request_id}
              approval={a}
              ack={lastAck?.get(a.request_id)}
              nowMs={nowMs}
              {...(onApproveDecision ? { onApprove: onApproveDecision } : {})}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/**
 * bar 色 = アクション種別 (kindOf 写像) の凡例。swatch クラスは ad-wall__bar--<kind> の背景を再利用。
 * approval と error は同じ danger 色なので 1 項目に統合。default(primary) は tool/mcp/web/turn/session/other。
 */
const WALL_LEGEND: ReadonlyArray<{ swatch: string; labelKey: MessageKey }> = [
  { swatch: "ad-wall__bar--command", labelKey: "wall.legend.command" },
  { swatch: "ad-wall__bar--file", labelKey: "wall.legend.file" },
  { swatch: "ad-wall__bar--approval", labelKey: "wall.legend.approval" },
  { swatch: "ad-wall__bar--liveness", labelKey: "wall.legend.liveness" },
  { swatch: "ad-wall__legend-swatch--default", labelKey: "wall.legend.default" },
];

export function LiveWall({
  active,
  nowMs,
  refreshKey,
  onOpenSession,
  onOpenReplay,
  onApprove,
  lastAck,
}: LiveWallProps) {
  const { locale, t } = useLocale();
  const { lanes, loading, error, refresh } = useWallFeed({
    enabled: active,
    ...(refreshKey !== undefined ? { refreshKey } : {}),
  });
  // Wall インライン承認: onApprove が配線されたときのみ承認 pull を張る (純表示時はゼロコスト)。
  // 供給/衛生/再取得 nudge は Approval Inbox と同一 (use-approval-inbox: enabled=false で破棄、
  // needs_attention 件数の増減 = delta.list 由来の wall feed 更新で refetch)。
  const inlineApproval = onApprove !== undefined;
  const attentionCount = lanes.filter((l) => l.session.needs_attention).length;
  const inbox = useApprovalInbox({
    enabled: active && inlineApproval,
    refreshKey: attentionCount,
  });
  const pendingBySession = new Map<string, readonly PendingApproval[]>();
  if (inlineApproval) {
    for (const g of inbox.approvals) pendingBySession.set(g.session_id, g.pending_approvals);
  }
  const { orderedLanes, applyOrder, nudge } = useWallLaneOrder(lanes);
  const [windowMs, setWindowMs] = useState<number>(DEFAULT_WALL_WINDOW_MS);
  const [drag, setDrag] = useState<WallDragState | null>(null);
  const lanesRef = useRef<HTMLDivElement>(null);
  // drop でコミット済みかを dragend が二重適用しないためのフラグ。
  const committedRef = useRef(false);
  const totalEvents = lanes.reduce((n, l) => n + l.events.length, 0);
  const reorderable = orderedLanes.length > 1;

  // ドラッグ中は preview 順で描画 (フロー側のレーンが指を避けてライブに動く)。
  const displayLanes = drag ? applyLaneOrder(lanes, drag.preview) : orderedLanes;
  const draggedLane = drag ? lanes.find((l) => l.session.session_id === drag.id) : undefined;

  // 共通時間軸の目盛り (ルーラーと各 track のグリッド線が同一値源・決定論)。
  const ticks = rulerTicks(windowMs, rulerDivisionsFor(windowMs), locale);

  // 要対応レーンの可視化: 並び順は変えず (DnD のユーザー並びを尊重)、カウンタ + 巡回ジャンプで誘導する。
  const attentionIds = attentionLaneIds(displayLanes);
  const attentionCursor = useRef(0);
  const jumpToAttention = (): void => {
    if (attentionIds.length === 0) return;
    const idx = attentionCursor.current % attentionIds.length;
    attentionCursor.current = idx + 1;
    const id = attentionIds[idx]!;
    const el = lanesRef.current?.querySelector(`[data-lane-id="${CSS.escape(id)}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  // レーン折りたたみ: 既定は laneCollapsedDefault (idle/unknown かつ非要対応のみ畳む)、
  // ユーザートグルが常に優先 (セッションごとに保持・揮発)。
  const [collapseChoice, setCollapseChoice] = useState<ReadonlyMap<string, boolean>>(new Map());
  const collapsedOf = (lane: WallLane): boolean =>
    collapseChoice.get(lane.session.session_id) ?? laneCollapsedDefault(lane.session);
  const toggleCollapse = (lane: WallLane): void => {
    const id = lane.session.session_id;
    setCollapseChoice((prev) => {
      const next = new Map(prev);
      next.set(id, !(prev.get(id) ?? laneCollapsedDefault(lane.session)));
      return next;
    });
  };

  // 現在描画中の各レーン中心 Y を DOM から測る (preview 順と同並び)。
  const measureLanes = (): { ids: string[]; centers: number[] } => {
    const root = lanesRef.current;
    const rows = root ? Array.from(root.querySelectorAll<HTMLElement>("[data-lane-id]")) : [];
    const ids: string[] = [];
    const centers: number[] = [];
    for (const r of rows) {
      const id = r.dataset.laneId;
      if (id === undefined) continue;
      const b = r.getBoundingClientRect();
      ids.push(id);
      centers.push(b.top + b.height / 2);
    }
    return { ids, centers };
  };

  const startDrag = (id: string, rect: DOMRect, clientY: number): void => {
    committedRef.current = false;
    setDrag({
      id,
      left: rect.left,
      width: rect.width,
      pointerY: clientY,
      // 掴んだ点のレーン内オフセット → ghost top = pointerY - grabDY で指の真下に固定。
      grabDY: clientY - rect.top,
      preview: displayLanes.map((l) => l.session.session_id),
    });
  };

  // ネイティブ DnD の継続的 dragover を使い、ゴーストを指へ追従させつつ preview 順を再計算する。
  const dragOver = (e: { clientY: number; preventDefault: () => void }): void => {
    if (!drag) return;
    e.preventDefault();
    const { ids, centers } = measureLanes();
    const preview = reorderByPointerY(ids, drag.id, centers, e.clientY);
    setDrag((d) => (d ? { ...d, pointerY: e.clientY, preview } : d));
  };

  const finishDrag = (): void => {
    committedRef.current = true;
    if (drag) applyOrder(drag.preview);
    setDrag(null);
  };
  const cancelDrag = (): void => {
    if (!committedRef.current) setDrag(null);
    committedRef.current = false;
  };

  return (
    <section data-testid="live-wall" aria-label="live wall" className="ad-wall">
      <div className="ad-panel__header">
        <div>
          <h2 className="ad-panel__title">{t("wall.title")}</h2>
          <span className="ad-session-meta">
            {t("wall.summary", { count: lanes.length, window: windowLabel(windowMs, t) })}
          </span>
        </div>
        <div className="ad-wall__controls">
          {attentionIds.length > 0 ? (
            <Button
              kind="secondary"
              size="sm"
              iconStart="warning"
              className="ad-wall__attention-jump"
              data-testid="wall-attention-jump"
              title={t("wall.attentionJump.title")}
              onClick={jumpToAttention}
            >
              {t("wall.attentionJump", { count: attentionIds.length })}
            </Button>
          ) : null}
          <div className="ad-segment" data-testid="wall-window">
            {WALL_WINDOW_PRESETS.map((ms) => (
              <Button
                key={ms}
                kind="ghost"
                size="sm"
                aria-pressed={windowMs === ms}
                data-active={windowMs === ms}
                data-testid={`wall-window-${ms}`}
                onClick={() => setWindowMs(ms)}
              >
                {windowLabel(ms, t)}
              </Button>
            ))}
          </div>
          <Button
            kind="ghost"
            size="sm"
            iconStart="renew"
            data-testid="wall-refresh"
            onClick={refresh}
            title={t("wall.refresh.title")}
          >
            {t("common.refresh")}
          </Button>
        </div>
      </div>

      <div className="ad-wall__legend" data-testid="wall-legend" aria-label={t("wall.legend.aria")}>
        <span>{t("wall.legend.label")}</span>
        {WALL_LEGEND.map((it) => (
          <span key={it.labelKey} className="ad-wall__legend-item">
            <span className={`ad-wall__legend-swatch ${it.swatch}`} aria-hidden />
            {t(it.labelKey)}
          </span>
        ))}
      </div>

      {error ? (
        <InlineAlert
          data-testid="wall-error"
          role="status"
          kind="error"
          title={t("wall.error.title")}
          subtitle={error}
        />
      ) : null}

      {lanes.length === 0 ? (
        <p data-testid="wall-empty" className="ad-wall__empty">
          {loading ? t("common.loading") : t("wall.empty")}
        </p>
      ) : (
        <div
          ref={lanesRef}
          className="ad-wall__lanes"
          data-event-count={totalEvents}
          data-dragging={drag ? drag.id : undefined}
          // ネイティブ DnD: 子レーンからバブルした dragover を受け、preview 順を再計算 + ゴーストを追従。
          onDragOver={reorderable ? dragOver : undefined}
          onDrop={
            reorderable
              ? (e) => {
                  e.preventDefault();
                  finishDrag();
                }
              : undefined
          }
        >
          <WallRuler windowMs={windowMs} />
          {displayLanes.map((lane, i) => (
            <WallLaneRow
              key={lane.session.session_id}
              lane={lane}
              nowMs={nowMs}
              windowMs={windowMs}
              reorderable={reorderable}
              isFirst={i === 0}
              isLast={i === displayLanes.length - 1}
              dragging={drag?.id === lane.session.session_id}
              collapsed={collapsedOf(lane)}
              ticks={ticks}
              onToggleCollapse={() => toggleCollapse(lane)}
              onDragStartLane={startDrag}
              onDragEndLane={cancelDrag}
              onMoveLane={(delta) => nudge(lane.session.session_id, delta)}
              {...(onOpenSession ? { onOpenSession } : {})}
              {...(onOpenReplay ? { onOpenReplay } : {})}
              {...(() => {
                // インライン承認: lane の session_id へ束縛した決定コールバックと pending を渡す。
                const pending = pendingBySession.get(lane.session.session_id);
                if (!onApprove || !pending || pending.length === 0) return {};
                return {
                  approvals: pending,
                  onApproveDecision: (
                    requestId: string,
                    decision: ApprovalDecision,
                    persist?: boolean,
                  ) => onApprove(lane.session.session_id, requestId, decision, undefined, persist),
                  ...(lastAck ? { lastAck } : {}),
                };
              })()}
            />
          ))}
        </div>
      )}

      {drag && draggedLane ? (
        <div
          className="ad-wall__drag-ghost"
          data-testid="wall-drag-ghost"
          aria-hidden
          style={{
            position: "fixed",
            left: `${drag.left}px`,
            top: `${drag.pointerY - drag.grabDY}px`,
            width: `${drag.width}px`,
            pointerEvents: "none",
            zIndex: 60,
          }}
        >
          <WallLaneRow
            lane={draggedLane}
            nowMs={nowMs}
            windowMs={windowMs}
            ghost
            collapsed={collapsedOf(draggedLane)}
            ticks={ticks}
          />
        </div>
      ) : null}
    </section>
  );
}
