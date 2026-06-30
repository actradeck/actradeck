"use client";

/**
 * session 詳細ビュー (4 ペインの core スライス版).
 *
 * このスライスは「観測導線」最優先なので最小 4 ペイン:
 *  1. ステータスバー: liveness badge / 現在アクション / 介入要否。
 *  2. liveness evidence: process/event/stdout/file/model-stream の **heartbeat 別表示** (分解)。
 *     単一シグナルで停止断定しない (INV-STALLED の表示版)。
 *  3. 待ち状態強調: 承認待ち/入力待ち/認証待ち。
 *  4. メタ: repo/branch/cwd/最終イベント。
 * 実行タイムライン / 差分の本格ペインは後続スライス。
 *
 * 秘匿情報は描かない: detail は backend が redaction 済 DTO のみを流す契約 (security.md)。
 * Adaptive Clarity: Carbon Button/Tag/InlineNotification/Table を kit（token 駆動）へ置換。
 */
import { ActionTimeline } from "./ActionTimeline";
import { formatCurrentAction } from "./action-units-display";
import { interruptEnabledForState, type AckState, type ApprovalDecision } from "./approval-display";
import { ApprovalCard } from "./ApprovalCard";
import {
  currentActionSnapshot,
  deriveSessionFacts,
  isNonManagedCapture,
  normalizeCaptureMode,
  type SessionRiskFacts,
} from "./current-action-display";
import { Button, Icon, InlineAlert, Table, TBody, Tag, Td, Th, THead, Tr, type Tone } from "./kit";
import { useLocale } from "./LocaleProvider";
import { PersistedApprovalsPanel } from "./PersistedApprovalsPanel";
import { PolicySettingsPanel } from "./PolicySettingsPanel";
import {
  effectiveLivenessState,
  heartbeatRows,
  livenessBadge,
  waitingKind,
} from "./liveness-display";
import {
  isKnownKind,
  redactionEntries,
  redactionEntriesTotal,
  redactionKindLabelKey,
} from "./redaction-display";

import type { DiffBody, OutputBody } from "../replay/parse-body";
import type { ReplayEventDTO, SessionDetail as SessionDetailDTO } from "../realtime/contract";

/**
 * 段階2 (ADR 019ea4ba D2): diff 本文 / stdout 本文の on-demand pull コントローラ
 * (use-session-body の戻りの subset)。SessionDetail は本文を直接 fetch せず、この
 * コントローラ経由で「明示操作 → pull → redaction 済み本文を表示」する (push しない)。
 */
export interface SessionBodyController {
  readonly diff: DiffBody | undefined;
  readonly diffLoading: boolean;
  readonly diffError: string | undefined;
  readonly loadDiff: () => void;
  readonly output: OutputBody | undefined;
  readonly outputLoading: boolean;
  readonly outputError: string | undefined;
  readonly loadOutput: (eventId: string) => void;
}

function ageLabel(ageMs: number | null): string {
  if (ageMs === null) return "—";
  const s = Math.round(ageMs / 1000);
  return s < 60 ? `${s}s` : `${Math.round(s / 60)}m`;
}

export interface SessionDetailProps {
  readonly detail: SessionDetailDTO | null;
  readonly loading: boolean;
  /** 承認判断の送信 (D3: 楽観更新しない。送信→ack 表示は lastAck 経由)。未指定なら承認操作不可。 */
  readonly onApprove?: (requestId: string, decision: ApprovalDecision, persist?: boolean) => void;
  /** request_id をキーにした approve ack 状態 (カードの ack 表示突合)。 */
  readonly lastAck?: ReadonlyMap<string, AckState>;
  /**
   * interrupt (SIGINT 協調停止) 要求の送信。未指定なら中断操作不可。
   * D5: 実行中ツールの巻き戻しではなく managed claude への SIGINT。terminal では非表示。
   */
  readonly onInterrupt?: () => void;
  /**
   * 親 (CockpitBoard) が握る 1 秒粒度の現在時刻。承認の残り時間目安をライブ更新するために
   * props で受ける (SessionDetail 内で別 interval を持たず、tick を一元化する)。
   */
  readonly nowMs?: number;
  /**
   * タイムライン/現在作業/右 risk ペインの素材 (既存 `GET /realtime/sessions/:id/events` の
   * ReplayEventDTO・昇順)。ADR 019ea4ba 段階1: 新 endpoint/DTO を増やさず既存 pull を再利用する。
   * 未指定 (既存呼び出し) のときは 4 ペイン拡張部を出さず、従来の status/liveness/承認のみ描く
   * (既存 session-detail.test の文字列契約を無改変で保つため)。
   */
  readonly events?: readonly ReplayEventDTO[];
  /**
   * 段階2 (ADR 019ea4ba D2): diff/stdout 本文の on-demand pull コントローラ。未指定なら
   * 本文ボタン・本文表示を出さない (段階1 互換: 本文経路を作らない)。指定時のみ明示操作で pull する。
   */
  readonly body?: SessionBodyController;
}

/** elapsed ms を短いラベルへ (ms<1000 は ms、それ以上は秒)。 */
function elapsedLabel(ms: number | undefined): string {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** risk 文字列 → kit Tag tone。 */
function riskFactTone(risk: SessionRiskFacts["highestRisk"]): Tone {
  if (risk === "high") return "danger";
  if (risk === "medium") return "warn";
  if (risk === "low") return "success";
  return "muted";
}

/**
 * 中央「現在作業」ペイン。detail.state を純関数で写像し、state に応じた最小ビューを描く。
 * 本文 (stdout tail / diff 全体) は載せない (段階1)。kill は親の interrupt を再利用する。
 */
/** events 末尾から最新の command.started の event_id を探す (stdout pull の anchor)。 */
function latestCommandStartedId(events: readonly ReplayEventDTO[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.event_type === "command.started") return events[i]!.event_id;
  }
  return undefined;
}

function CurrentActionPane({
  detail,
  events,
  canInterrupt,
  onInterrupt,
  body,
}: {
  readonly detail: SessionDetailDTO;
  readonly events: readonly ReplayEventDTO[];
  readonly canInterrupt: boolean;
  readonly onInterrupt?: () => void;
  readonly body?: SessionBodyController;
}) {
  const { locale, t } = useLocale();
  const snap = currentActionSnapshot(detail, events, locale);
  const anchorId = latestCommandStartedId(events);
  return (
    <section
      className="ad-current-action"
      data-testid="current-action"
      data-view={snap.view}
      aria-label={t("action.currentAria")}
    >
      <header className="ad-current-action__head">
        <Tag tone="info" size="md" data-testid="current-action-label">
          {snap.label}
        </Tag>
        {snap.view === "command" && canInterrupt ? (
          <Button
            kind="danger"
            size="sm"
            iconStart="stop"
            data-testid="current-action-kill"
            title={t("action.kill.title")}
            onClick={() => onInterrupt?.()}
          >
            {t("action.kill")}
          </Button>
        ) : null}
      </header>
      {snap.primaryText ? (
        <code className="ad-current-action__primary" data-testid="current-action-primary">
          {snap.primaryText}
        </code>
      ) : (
        <p className="ad-current-action__empty" data-testid="current-action-empty">
          {t("action.empty")}
        </p>
      )}
      <dl className="ad-current-action__meta">
        {snap.view === "command" || snap.view === "file_edit" ? (
          <div>
            <dt className="ad-kv-label">{t("action.meta.cwd")}</dt>
            <dd className="ad-kv-value" data-testid="current-action-cwd">
              {snap.cwd ?? t("common.dash")}
            </dd>
          </div>
        ) : null}
        {snap.elapsedMs !== undefined ? (
          <div>
            <dt className="ad-kv-label">{t("action.meta.elapsed")}</dt>
            <dd className="ad-kv-value" data-testid="current-action-elapsed">
              {elapsedLabel(snap.elapsedMs)}
            </dd>
          </div>
        ) : null}
        {snap.exitCode !== undefined ? (
          <div>
            <dt className="ad-kv-label">{t("action.meta.exitCode")}</dt>
            <dd className="ad-kv-value" data-testid="current-action-exit">
              <Tag tone={snap.exitCode === 0 ? "success" : "danger"} size="sm">
                {snap.exitCode}
              </Tag>
            </dd>
          </div>
        ) : null}
      </dl>
      {/* 段階2 (D2-A): command/tool 実行ビューの stdout tail を on-demand 表示。
          出所 command.output.delta.delta は redacted-at-rest。明示操作でのみ pull する
          (常時 push しない)。a11y: role="log" / aria-live=polite で末尾追記を読み上げ。 */}
      {body && (snap.view === "command" || snap.view === "file_edit") && anchorId ? (
        <div className="ad-current-action__output" data-testid="current-action-output-block">
          <Button
            size="sm"
            kind="ghost"
            iconStart="activity"
            data-testid="output-load"
            disabled={body.outputLoading}
            title={t("action.output.load.title")}
            onClick={() => body.loadOutput(anchorId)}
          >
            {body.outputLoading ? t("action.output.loading") : t("action.output.load")}
          </Button>
          {body.outputError ? (
            <span data-testid="output-error" className="ad-body-error">
              {t("action.output.error", { error: body.outputError })}
            </span>
          ) : null}
          {body.output ? (
            <pre
              className="ad-output-pre"
              data-testid="output-pre"
              data-truncated={body.output.truncated}
              role="log"
              aria-live="polite"
              aria-label={t("action.output.aria")}
            >
              {body.output.output_excerpt.length > 0
                ? body.output.output_excerpt
                : t("action.output.empty")}
              {body.output.truncated ? t("action.output.truncated") : ""}
            </pre>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * 左「実行タイムライン」ペイン。アクション単位ビュー (対象/行為/結果) で描く (設計裁定 019eb981)。
 * 行クリックで詳細モーダル・raw イベントはトグルで保持。a11y は ActionTimeline (role=log) が担う。
 */
function TimelinePane({
  sessionId,
  events,
}: {
  readonly sessionId: string;
  readonly events: readonly ReplayEventDTO[];
}) {
  const { t } = useLocale();
  return (
    <section className="ad-timeline" aria-label={t("timeline.title")}>
      <h3 className="ad-pane-title">{t("timeline.title")}</h3>
      <ActionTimeline
        sessionId={sessionId}
        events={events}
        ariaLabel={t("timeline.aria")}
        emptyLabel={t("timeline.empty")}
      />
    </section>
  );
}

/**
 * 右「git / risk」ペイン。既存 timeline events から導出した facts のみ (段階1)。
 * diff 行数メトリクス本文・secret_detected 明示化は段階2。
 */
function RiskPane({
  detail,
  events,
  body,
}: {
  readonly detail: SessionDetailDTO;
  readonly events: readonly ReplayEventDTO[];
  readonly body?: SessionBodyController;
}) {
  const { t } = useLocale();
  const facts = deriveSessionFacts(detail, events);
  // 強み(a)③ redaction 可視化: kind 別内訳 (公開 enum + 件数のみ・原文なし)。
  // 欠落/空/不正値は redactionEntries が graceful に空配列へ畳むため、内訳は出ない (既存合計表示は維持)。
  const redactionByKind = redactionEntries(detail.secret_redaction_count_by_kind);
  return (
    <section className="ad-risk" data-testid="risk-pane" aria-label={t("risk.title")}>
      <h3 className="ad-pane-title">{t("risk.title")}</h3>
      <ul className="ad-risk__flags">
        <li>
          <Tag
            tone={riskFactTone(facts.highestRisk)}
            size="sm"
            data-testid="risk-highest"
            data-risk={facts.highestRisk}
          >
            {t("risk.highest", { risk: facts.highestRisk })}
          </Tag>
        </li>
        <li>
          <Tag
            tone={facts.fileChanges ? "info" : "muted"}
            size="sm"
            data-testid="risk-files"
            data-changed-paths={facts.changedPathCount}
          >
            {t("risk.files", { count: facts.changedPathCount })}
          </Tag>
        </li>
        {facts.mcp ? (
          <li>
            <Tag tone="info" size="sm" data-testid="risk-mcp">
              {t("risk.mcp")}
            </Tag>
          </li>
        ) : null}
        {facts.web ? (
          <li>
            <Tag tone="warn" size="sm" data-testid="risk-web">
              {t("risk.web")}
            </Tag>
          </li>
        ) : null}
        {facts.hadCommandFailure ? (
          <li>
            <Tag tone="danger" size="sm" data-testid="risk-failure">
              {t("risk.failure")}
            </Tag>
          </li>
        ) : null}
        <li>
          <Tag
            tone={facts.captureMode === "attach" ? "warn" : "muted"}
            size="sm"
            data-testid="risk-capture-mode"
            data-capture-mode={facts.captureMode}
          >
            {t("risk.captureMode", { mode: facts.captureMode })}
          </Tag>
        </li>
        {/* 段階2 (D3): permission_mode (sandbox) を明示。どこまで自動許可されているか = 介入要否の手がかり。
            bypassPermissions / acceptEdits は注意色で強調する (誤って広く許可されていないか)。 */}
        {detail.permission_mode ? (
          <li>
            <Tag
              tone={permissionModeTone(detail.permission_mode)}
              size="sm"
              data-testid="risk-permission-mode"
              data-permission-mode={detail.permission_mode}
              title={t("risk.permission.title")}
            >
              {t("risk.permission", { mode: detail.permission_mode })}
            </Tag>
          </li>
        ) : null}
        {/* 段階2 (D5 / Plan Step5): secret_detected — redaction が秘匿を検出した事実 (件数/bool のみ・値は出さない)。
            出所は 2 系統あり data-secret-source で区別する (監査・テスト容易化):
              - "session": detail.secret_detected (session 単位・常時・diff pull 不要)。**主表示**。
                欠落 (undefined) は未観測=非表示 (旧セッション後方互換・「無し」と誤表示しない)。
              - "diff": diff 本文 pull の結果 (その diff 限定・pull 前は非表示)。**補助表示**。
                session 単位が既に主表示として出ている場合は重複を避けて出さない。
            いずれも件数/bool のみ。秘匿値そのものは絶対に描画しない (INV-REDACTION 隣接)。 */}
        {detail.secret_detected === true ? (
          <li>
            <Tag
              tone="warn"
              size="sm"
              data-testid="risk-secret-detected"
              data-secret-source="session"
              data-redaction-count={detail.secret_redaction_count}
              title={t("risk.secretDetected.session.title")}
            >
              {/* TDA-4: detected=true かつ count=undefined のフォールバック (件数不明でも検出は表示)。
                  到達条件: secret_detected 列のみ true で secret_redaction_count 列が NULL の行
                  (理論上は両列が常に同時に書かれるため稀だが、片側 NULL の旧/部分行に安全側で対応)。 */}
              {detail.secret_redaction_count === undefined
                ? t("risk.secretDetected.session.unknown")
                : t("risk.secretDetected.session", {
                    count: detail.secret_redaction_count,
                  })}
            </Tag>
          </li>
        ) : detail.secret_detected === undefined && body?.diff?.secret_detected ? (
          <li>
            <Tag
              tone="warn"
              size="sm"
              data-testid="risk-secret-detected"
              data-secret-source="diff"
              data-redaction-count={body.diff.redaction_count}
              title={t("risk.secretDetected.title")}
            >
              {t("risk.secretDetected", { count: body.diff.redaction_count })}
            </Tag>
          </li>
        ) : null}
      </ul>
      {/* 強み(a)③: redaction の kind 別内訳。secret_redaction_count_by_kind (公開 enum + 件数) を
          安定順 (件数 desc → kind 名 asc) のタグで列挙する。表示変換 (kind→ラベル) は UI 層のみ・
          データ層は raw 保持 (ユーザー確定方針)。
          SEC (SEC-1/QA-1 統合・defense-in-depth): 未知 kind は **raw 文字列を画面にも属性にも出さない**。
          redaction 表示は信頼の核ゆえ、層をまたぐ leak (phantom/XSS 形 kind 名) を最終 sink(UI) で止める。
          未知 kind は汎用ラベル化 + data-redaction-kind は固定 sentinel "unknown" にする (raw kind を入れない)。
          「未知である事実」は data-redaction-kind-known=false で保持する。
          空/undefined (旧 session) は内訳ブロックごと非表示 (既存合計表示は別途維持)。
          a11y: 既存 RiskPane の ul[role 既定]/Tag の慣行に合わせ、見出しを aria-label に置く。
          件数 (int) + kind ラベルのみ。秘匿値・raw payload は一切 component に渡さない。 */}
      {redactionByKind.length > 0 ? (
        <div
          className="ad-risk__redaction"
          data-testid="redaction-breakdown"
          data-kind-count={redactionByKind.length}
        >
          <h4 className="ad-risk__redaction-title" title={t("risk.redaction.breakdown.title")}>
            {t("risk.redaction.breakdown")}
          </h4>
          <ul className="ad-risk__redaction-kinds" aria-label={t("risk.redaction.breakdown")}>
            {redactionByKind.map((e) => {
              const known = isKnownKind(e.kind);
              return (
                <li key={e.kind}>
                  <Tag
                    tone="warn"
                    size="sm"
                    iconStart="warning-alt"
                    data-testid="redaction-kind-tag"
                    // 既知 → 語彙 kind (安全)。未知 → 固定 sentinel (raw kind を属性にも出さない)。
                    data-redaction-kind={known ? e.kind : "unknown"}
                    data-redaction-kind-count={e.count}
                    data-redaction-kind-known={known}
                  >
                    {t("risk.redaction.kindCount", {
                      // 既知 → i18n ラベル / 未知 → 汎用ラベル (raw kind 文字列は画面に出さない)。
                      label: known
                        ? t(redactionKindLabelKey(e.kind))
                        : t("risk.redaction.unknownKind"),
                      count: e.count,
                    })}
                  </Tag>
                </li>
              );
            })}
          </ul>
          <Tag tone="muted" size="sm" data-testid="redaction-breakdown-total">
            {t("risk.redaction.total", { count: redactionEntriesTotal(redactionByKind) })}
          </Tag>
        </div>
      ) : null}
      {/* 段階2 (D2-B): git 全体 diff 本文を on-demand pull で表示。常時 push しない・SQLite に
          貯めない。本文は sidecar の redaction choke を透過済み (raw diff は決して届かない)。 */}
      {body ? (
        <div className="ad-risk__diff" data-testid="diff-block">
          <Button
            size="sm"
            kind="ghost"
            iconStart="dashboard"
            data-testid="diff-load"
            disabled={body.diffLoading}
            title={t("risk.diff.load.title")}
            onClick={() => body.loadDiff()}
          >
            {body.diffLoading ? t("risk.diff.loading") : t("risk.diff.load")}
          </Button>
          {body.diffError ? (
            <span data-testid="diff-error" className="ad-body-error">
              {t("risk.diff.error", { error: body.diffError })}
            </span>
          ) : null}
          {body.diff ? (
            <pre
              className="ad-diff-pre"
              data-testid="diff-pre"
              data-truncated={body.diff.truncated}
              aria-label={t("risk.diff.aria")}
            >
              {body.diff.body.length > 0 ? body.diff.body : t("risk.diff.empty")}
              {body.diff.truncated ? t("risk.diff.truncated") : ""}
            </pre>
          ) : null}
        </div>
      ) : (
        <p className="ad-risk__note" data-testid="risk-note">
          {t("risk.note")}
        </p>
      )}
    </section>
  );
}

/** permission_mode 文字列 → kit Tag tone (自動許可が広いモードを注意色に)。 */
function permissionModeTone(mode: string): Tone {
  const m = mode.toLowerCase();
  if (m.includes("bypass")) return "danger";
  if (m.includes("accept")) return "warn";
  return "muted";
}

export function SessionDetailView({
  detail,
  loading,
  onApprove,
  lastAck,
  onInterrupt,
  nowMs,
  events,
  body,
}: SessionDetailProps) {
  const { locale, t } = useLocale();
  if (!detail) {
    return (
      <section className="ad-empty" data-testid="detail-empty">
        {loading ? t("detail.empty.loading") : t("detail.empty.select")}
      </section>
    );
  }
  // SSR (テスト) では nowMs を渡されないことがある。その場合は描画時刻を使う。
  const now = nowMs ?? Date.now();
  // 表示時の鮮度補正: 凍結された "live"(履歴/無活動)を now 基準で idle/unknown へ降格する。
  const badge = livenessBadge(effectiveLivenessState(detail, now), detail.stalled_suspected);
  const waiting = waitingKind(detail.state);
  const rows = heartbeatRows(detail);
  const pending = detail.pending_approvals;
  // interrupt は非 terminal の managed/非 managed どちらにも安全に出せる (sidecar が no-op 担保)。
  const canInterrupt = onInterrupt !== undefined && interruptEnabledForState(detail.state);

  return (
    <section className="ad-detail" data-testid="detail">
      {/* ステータスバー */}
      <header className="ad-detail-summary" data-testid="status-bar" data-tone={badge.tone}>
        <div>
          <div className="ad-detail-summary__title">
            <Tag
              tone={detail.needs_attention ? "danger" : "success"}
              size="md"
              iconStart={detail.needs_attention ? "warning" : "check"}
              data-testid="detail-liveness"
              title={badge.title}
            >
              {badge.label}
            </Tag>
            {detail.needs_attention ? (
              <Tag tone="danger" size="md" data-testid="detail-attention">
                {t("detail.attention")}
              </Tag>
            ) : null}
            {/* capture_mode バッジ (ADR 019ea4ba D4 / TDA-1)。
                non-managed capture は ActraDeck が起動を所有しないことだけを示す。
                approval relay 可否とは直交するため "observe-only" とは呼ばない。 */}
            {isNonManagedCapture(detail.capture_mode) ? (
              <Tag
                tone="warn"
                size="md"
                iconStart="warning-alt"
                data-testid="detail-capture-mode"
                data-capture-mode={normalizeCaptureMode(detail.capture_mode)}
                title={t("detail.captureMode.nonManaged.title")}
              >
                {t("detail.captureMode.nonManaged", {
                  mode: normalizeCaptureMode(detail.capture_mode),
                })}
              </Tag>
            ) : null}
          </div>
          <p className="ad-detail-action" data-testid="detail-action">
            {formatCurrentAction(
              {
                kind: detail.current_action_kind,
                subject: detail.current_action_subject,
                fallback: detail.current_action,
              },
              locale,
            ) ??
              detail.state ??
              t("common.dash")}
          </p>
        </div>
        {canInterrupt ? (
          <Button
            kind="danger"
            size="sm"
            iconStart="stop"
            data-testid="interrupt-button"
            title={t("detail.interrupt.title")}
            onClick={() => onInterrupt?.()}
          >
            {t("detail.interrupt")}
          </Button>
        ) : null}
      </header>

      {/* 承認待ち: pending_approvals を列挙する承認カード群へ拡張 (ADR 019e9999 段階②)。
          各カードは request_id で独立に approve/deny 送信し ack を突合表示する (D2: 独立 Inbox
          でなく detail 内 / D3: 楽観更新しない)。pending が空なら従来の簡易バナーへフォールバック。
          バナー外枠 section[role=alert] を単一 live region とし、見出しは Icon+text で二重 alert を避ける。 */}
      {pending.length > 0 ? (
        <section data-testid="approval-banner" role="alert" className="ad-approval-banner">
          <p className="ad-approval-banner__head">
            <Icon name="warning" className="ad-approval-banner__icon" />
            <strong>{t("detail.approval.head")}</strong>
            <span>{t("detail.approval.pendingCount", { count: pending.length })}</span>
          </p>
          <ul className="ad-approval-list" data-testid="approval-list">
            {pending.map((a) => (
              <ApprovalCard
                key={a.request_id}
                approval={a}
                ack={lastAck?.get(a.request_id)}
                onApprove={onApprove}
                nowMs={now}
              />
            ))}
          </ul>
        </section>
      ) : waiting ? (
        <InlineAlert
          data-testid="waiting-banner"
          role="alert"
          kind="info"
          title={
            waiting === "approval"
              ? t("detail.waiting.approval")
              : waiting === "auth"
                ? t("detail.waiting.auth")
                : t("detail.waiting.input")
          }
          subtitle={
            waiting === "approval"
              ? t("detail.waiting.approval.body")
              : waiting === "auth"
                ? t("detail.waiting.auth.body")
                : t("detail.waiting.input.body")
          }
        />
      ) : null}

      {/* liveness evidence (heartbeat 別表示) */}
      <Table
        data-testid="liveness-evidence"
        className="ad-liveness-evidence"
        caption={t("detail.liveness.caption")}
      >
        <THead>
          <Tr>
            <Th>{t("detail.liveness.col.signal")}</Th>
            <Th>{t("detail.liveness.col.seen")}</Th>
            <Th>{t("detail.liveness.col.age")}</Th>
            <Th>{t("detail.liveness.col.fresh")}</Th>
            <Th>{t("detail.liveness.col.note")}</Th>
          </Tr>
        </THead>
        <TBody>
          {rows.map((r) => (
            <Tr
              key={r.kind}
              data-testid={`hb-${r.kind}`}
              data-observed={r.observed}
              data-fresh={r.fresh ?? ""}
            >
              <Td>{r.kind}</Td>
              <Td>{r.observed ? t("detail.liveness.seen.yes") : t("common.dash")}</Td>
              <Td>{ageLabel(r.ageMs)}</Td>
              <Td>
                <Tag tone={r.fresh === null ? "muted" : r.fresh ? "success" : "danger"} size="sm">
                  {r.fresh === null
                    ? t("common.dash")
                    : r.fresh
                      ? t("detail.liveness.fresh")
                      : t("detail.liveness.stale")}
                </Tag>
              </Td>
              <Td>{r.extra ?? ""}</Td>
            </Tr>
          ))}
        </TBody>
      </Table>
      <p className="ad-liveness-reason" data-testid="liveness-reason">
        {detail.liveness_reason}
      </p>

      {/* メタ */}
      <dl className="ad-detail-grid" data-testid="detail-meta">
        <div>
          <dt className="ad-kv-label">repo</dt>
          <dd className="ad-kv-value">
            {detail.repo ?? "—"}
            {detail.branch ? `@${detail.branch}` : ""}
          </dd>
        </div>
        <div>
          <dt className="ad-kv-label">cwd</dt>
          <dd className="ad-kv-value">{detail.cwd ?? "—"}</dd>
        </div>
        <div>
          <dt className="ad-kv-label">provider</dt>
          <dd className="ad-kv-value">{detail.provider}</dd>
        </div>
        <div>
          <dt className="ad-kv-label">invalid transitions</dt>
          <dd className="ad-kv-value">{detail.invalid_transition_count}</dd>
        </div>
      </dl>

      {/* 4 ペイン拡張 (ADR 019ea4ba 段階1)。events 未指定 (既存呼び出し) では描かない。
          status-bar / 承認 / liveness を 1 ペイン目 (上) として、ここに 残り 3 ペインを足す:
          中央=現在作業 / 左=タイムライン / 右=git・risk。レイアウトは CSS グリッドが担う。 */}
      {events !== undefined ? (
        <div className="ad-detail-panes" data-testid="detail-panes">
          <CurrentActionPane
            detail={detail}
            events={events}
            canInterrupt={canInterrupt}
            onInterrupt={onInterrupt}
            {...(body !== undefined ? { body } : {})}
          />
          <TimelinePane sessionId={detail.session_id} events={events} />
          <RiskPane detail={detail} events={events} {...(body !== undefined ? { body } : {})} />
        </div>
      ) : null}

      {/* PAL-v2 (ADR 019ee147): 永続承認 allowlist の in-UI 一覧 + 失効 (machine-global・lazy pull)。 */}
      <PersistedApprovalsPanel sessionId={detail.session_id} />

      {/* ADR 019f0c3e Phase 2: bypass/YOLO 承認ポリシー設定 (machine-global・lazy pull・allowlist と対称)。 */}
      <PolicySettingsPanel sessionId={detail.session_id} />
    </section>
  );
}
