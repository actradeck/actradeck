"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ActionTimeline } from "./ActionTimeline";
import { formatCurrentAction } from "./action-units-display";
import { Button, IconButton, InlineAlert, RangeSlider, Select, Tag } from "./kit";
import { useLocale } from "./LocaleProvider";
import { shortSessionId, shortenCwd } from "./wall-display";
import { createReplayRequestGate, mergeReplayEvents } from "../replay/replay-load";
import { parseReplayEventsPage } from "../replay/parse-replay";
import {
  buildProjectionTimeline,
  clampReplayIndex,
  replayTimelineWindow,
  stepReplayIndex,
} from "../replay/replay-state";

import type { ReplayEventDTO } from "../realtime/contract";

const PAGE_LIMIT = 200;
export const MAX_LOADED_REPLAY_EVENTS = 5_000;
const SPEEDS = [0.5, 1, 2, 4, 8] as const;

type ReplaySpeed = (typeof SPEEDS)[number];

function relTime(first: string | undefined, current: string | undefined): string {
  if (!first || !current) return "00:00";
  const delta = Math.max(0, Date.parse(current) - Date.parse(first));
  const sec = Math.floor(delta / 1000);
  const m = Math.floor(sec / 60)
    .toString()
    .padStart(2, "0");
  const s = (sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

/**
 * 「いま何を再生しているか」を示す session 識別情報 (repo@branch / provider / cwd)。
 * 出所は CockpitBoard の SessionDetail (= SessionListItem 由来・すべて backend allow-list 済で
 * 一覧/Wall/詳細でも表示している非機微フィールド。新 redaction 面なし)。detail が未取得の間は
 * provider/cwd を replay events[0] から fallback 導出する。memory wall-show-working-directory:
 * 「どこで動いているか (cwd + repo@branch)」を必ず併記する。
 */
export interface SessionReplayIdentity {
  readonly repo?: string;
  readonly branch?: string;
  readonly provider?: string;
  readonly cwd?: string;
}

export interface SessionReplayPanelProps {
  readonly sessionId: string;
  readonly identity?: SessionReplayIdentity;
  readonly events: readonly ReplayEventDTO[];
  readonly index: number;
  readonly playing: boolean;
  readonly speed: ReplaySpeed;
  readonly hasMore: boolean;
  readonly loading: boolean;
  readonly error?: string;
  readonly onSeek?: (index: number) => void;
  readonly onStep?: (delta: -1 | 1) => void;
  readonly onPlayPause?: () => void;
  readonly onSpeed?: (speed: ReplaySpeed) => void;
  readonly onLoadMore?: () => void;
}

export function SessionReplayPanel({
  sessionId,
  identity,
  events,
  index,
  playing,
  speed,
  hasMore,
  loading,
  error,
  onSeek,
  onStep,
  onPlayPause,
  onSpeed,
  onLoadMore,
}: SessionReplayPanelProps) {
  const { t, locale } = useLocale();
  const currentIndex = clampReplayIndex(index, events.length);
  const current = currentIndex >= 0 ? events[currentIndex] : undefined;
  // 「いま何を再生しているか」の識別情報。detail 未取得時は provider/cwd を events[0] から補完。
  const repo = identity?.repo;
  const branch = identity?.branch;
  const provider = identity?.provider ?? events[0]?.provider;
  const cwd = identity?.cwd ?? events[0]?.cwd;
  const shortCwd = shortenCwd(cwd);
  const timeline = useMemo(() => buildProjectionTimeline(sessionId, events), [sessionId, events]);
  const projection =
    currentIndex >= 0 ? (timeline.projections[currentIndex] ?? timeline.initial) : timeline.initial;
  const visibleTimeline = useMemo(
    () => replayTimelineWindow(events, currentIndex),
    [events, currentIndex],
  );

  if (events.length === 0 && loading) {
    return (
      <section className="ad-empty" data-testid="replay-loading">
        {t("replay.loading")}
      </section>
    );
  }

  return (
    <section className="ad-replay" data-testid="session-replay">
      <header className="ad-replay__header" data-testid="replay-header">
        <div className="ad-replay__heading">
          <div className="ad-replay__title">
            <strong>{t("replay.title")}</strong>
            <Tag tone="info" size="md" data-testid="replay-position">
              {events.length === 0 ? 0 : currentIndex + 1}/{events.length}
            </Tag>
            <Tag tone="neutral" size="md" data-testid="replay-clock">
              {relTime(events[0]?.timestamp, current?.timestamp)}
            </Tag>
          </div>
          {/* 「いま何を再生しているか」を明示 (ユーザー指摘: replay 画面で対象 session が分かりにくい)。
              repo@branch / provider / cwd(~短縮・full は title) / session 短縮 id を併記する。
              memory wall-show-working-directory に整合 (cwd + repo@branch を必ず出す)。 */}
          <div
            className="ad-replay__identity"
            data-testid="replay-identity"
            aria-label={t("replay.identity.aria")}
          >
            <span className="ad-replay__replaying">{t("replay.replaying")}</span>
            {repo ? (
              <span className="ad-replay__repo" data-testid="replay-identity-repo">
                {repo}
                {branch ? <span className="ad-replay__branch">@{branch}</span> : null}
              </span>
            ) : null}
            {provider ? (
              <Tag tone="muted" size="sm" data-testid="replay-identity-provider">
                {provider}
              </Tag>
            ) : null}
            {shortCwd ? (
              <span className="ad-replay__cwd" title={cwd} data-testid="replay-identity-cwd">
                {shortCwd}
              </span>
            ) : null}
            <span className="ad-replay__sid" data-testid="replay-identity-session">
              <span className="ad-replay__sid-label">{t("replay.identity.session")}</span>
              <code className="ad-replay__sid-value">{shortSessionId(sessionId)}</code>
            </span>
          </div>
        </div>
        {hasMore ? (
          <Button
            size="sm"
            kind="secondary"
            iconStart="renew"
            data-testid="replay-load-more"
            disabled={loading}
            onClick={() => onLoadMore?.()}
          >
            {t("replay.loadMore")}
          </Button>
        ) : null}
      </header>

      {error ? (
        <InlineAlert
          kind="error"
          title={t("replay.error.title")}
          subtitle={error}
          data-testid="replay-error"
        />
      ) : null}
      {timeline.invalid_event_count > 0 ? (
        <InlineAlert
          kind="warning"
          title={t("replay.invalid.title")}
          subtitle={t("replay.invalid.subtitle", { count: timeline.invalid_event_count })}
          data-testid="replay-invalid-count"
        />
      ) : null}

      <div className="ad-replay__controls" data-testid="replay-controls">
        <IconButton
          icon="skip-back"
          label={t("replay.stepBack")}
          data-testid="replay-step-back"
          onClick={() => onStep?.(-1)}
        />
        <Button
          kind="primary"
          size="sm"
          iconStart={playing ? "pause" : "play"}
          data-testid="replay-play"
          onClick={() => onPlayPause?.()}
        >
          {playing ? t("replay.pause") : t("replay.play")}
        </Button>
        <IconButton
          icon="skip-forward"
          label={t("replay.stepNext")}
          data-testid="replay-step-next"
          onClick={() => onStep?.(1)}
        />
        <Select
          id="replay-speed"
          label={t("replay.speed")}
          data-testid="replay-speed"
          value={speed}
          onChange={(e) => onSpeed?.(Number(e.currentTarget.value) as ReplaySpeed)}
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}x
            </option>
          ))}
        </Select>
      </div>

      <div className="ad-replay__scrubber">
        <RangeSlider
          data-testid="replay-scrubber"
          aria-label={t("replay.position.aria")}
          aria-valuetext={
            events.length > 0
              ? t("replay.position.valuetext", { current: currentIndex + 1, total: events.length })
              : t("replay.position.noEvents")
          }
          min={events.length > 0 ? 0 : -1}
          max={events.length > 0 ? events.length - 1 : -1}
          value={currentIndex}
          disabled={events.length === 0}
          onChange={(e) => onSeek?.(Number(e.currentTarget.value))}
        />
      </div>

      <div className="ad-replay-state" data-testid="replay-state">
        <div>
          <span className="ad-kv-label">state</span>
          <strong>{projection.state ?? "—"}</strong>
        </div>
        <div>
          <span className="ad-kv-label">current</span>
          {/* 表示時ローカライズ (P2・ADR 019eeac6): replay reducer の SessionProjection が持つ
              current_action_kind + current_action_subject から viewer locale で述語を組む。
              kind 欠落 (legacy) は current_action (日本語焼き込み summary) に fallback。 */}
          <strong>
            {formatCurrentAction(
              {
                kind: projection.current_action_kind,
                subject: projection.current_action_subject,
                fallback: projection.current_action,
              },
              locale,
            ) ?? "—"}
          </strong>
        </div>
        <div>
          <span className="ad-kv-label">pending</span>
          <strong>{projection.pending_approvals.length}</strong>
        </div>
      </div>

      {/* アクション単位ビュー (設計裁定 019eb981): 対象/行為/結果の行文法 + 行クリックで
          詳細モーダル。スクラブ (seek) はスクラバーが担い、行クリックは詳細表示に充てる。
          raw イベントはトグルで保持。可視ウィンドウ内のイベントのみ畳む (大規模 replay の負荷抑制)。 */}
      <ActionTimeline
        sessionId={sessionId}
        events={visibleTimeline.items.map((it) => it.event)}
        ariaLabel={t("replay.aria")}
        emptyLabel={t("replay.empty")}
        className="ad-replay-actions"
      />
      {events.length > visibleTimeline.items.length ? (
        <Tag tone="muted" size="sm" data-testid="replay-window">
          {visibleTimeline.start + 1}-{visibleTimeline.end}/{events.length}
        </Tag>
      ) : null}
    </section>
  );
}

export function SessionReplayView({
  sessionId,
  identity,
}: {
  readonly sessionId: string | null;
  readonly identity?: SessionReplayIdentity;
}) {
  const { t } = useLocale();
  const [events, setEvents] = useState<readonly ReplayEventDTO[]>([]);
  const [index, setIndex] = useState(-1);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<ReplaySpeed>(1);
  const gate = useRef<ReturnType<typeof createReplayRequestGate> | null>(null);
  const eventsRef = useRef<readonly ReplayEventDTO[]>([]);
  gate.current ??= createReplayRequestGate();
  // loadPage を安定 ([] deps) に保ちつつ最新 locale の翻訳を引くため ref で渡す。
  const tRef = useRef(t);
  tRef.current = t;

  const loadPage = useCallback(
    async (sid: string, generation: number, nextCursor?: string): Promise<void> => {
      const requestGate = gate.current!;
      if (!requestGate.tryStart(generation)) return;
      setLoading(true);
      setError(undefined);
      try {
        const qs = new URLSearchParams({ limit: String(PAGE_LIMIT) });
        if (nextCursor) qs.set("cursor", nextCursor);
        const res = await fetch(`/realtime/sessions/${encodeURIComponent(sid)}/events?${qs}`);
        if (!requestGate.isCurrent(generation)) return;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const parsed = parseReplayEventsPage(await res.json());
        if (!requestGate.isCurrent(generation)) return;
        if (!parsed) throw new Error("invalid replay response");
        const merged = mergeReplayEvents(
          eventsRef.current,
          parsed.events,
          MAX_LOADED_REPLAY_EVENTS,
        );
        const truncated =
          merged.truncated || (parsed.has_more && merged.events.length >= MAX_LOADED_REPLAY_EVENTS);
        eventsRef.current = merged.events;
        setEvents(merged.events);
        setCursor(truncated ? undefined : parsed.next_cursor);
        setHasMore(!truncated && parsed.has_more);
        if (truncated) {
          setError(tRef.current("replay.limitReached", { limit: MAX_LOADED_REPLAY_EVENTS }));
        }
        setIndex((prev) => (prev < 0 && parsed.events.length > 0 ? 0 : prev));
        if (merged.appendedCount === 0 && parsed.events.length > 0) setPlaying(false);
      } catch (err) {
        if (requestGate.isCurrent(generation)) setError((err as Error).message);
      } finally {
        if (requestGate.isCurrent(generation)) setLoading(false);
        requestGate.finish(generation);
      }
    },
    [],
  );

  useEffect(() => {
    const generation = gate.current!.nextGeneration();
    eventsRef.current = [];
    setEvents([]);
    setIndex(-1);
    setCursor(undefined);
    setHasMore(false);
    setPlaying(false);
    if (sessionId) void loadPage(sessionId, generation);
  }, [loadPage, sessionId]);

  useEffect(() => {
    if (!playing) return;
    const id = setInterval(
      () => {
        setIndex((prev) => {
          const next = stepReplayIndex(prev, events.length, 1);
          if (next === prev) setPlaying(false);
          return next;
        });
      },
      Math.max(125, 1000 / speed),
    );
    return () => clearInterval(id);
  }, [playing, speed, events.length]);

  if (!sessionId) {
    return (
      <section className="ad-empty" data-testid="replay-empty">
        {t("replay.empty")}
      </section>
    );
  }

  return (
    <SessionReplayPanel
      sessionId={sessionId}
      {...(identity ? { identity } : {})}
      events={events}
      index={index}
      playing={playing}
      speed={speed}
      hasMore={hasMore}
      loading={loading}
      error={error}
      onSeek={(i) => setIndex(clampReplayIndex(i, events.length))}
      onStep={(delta) => setIndex((prev) => stepReplayIndex(prev, events.length, delta))}
      onPlayPause={() => setPlaying((p) => !p)}
      onSpeed={setSpeed}
      onLoadMore={() =>
        sessionId && void loadPage(sessionId, gate.current!.currentGeneration(), cursor)
      }
    />
  );
}
