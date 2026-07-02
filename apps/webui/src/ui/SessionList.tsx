"use client";

/**
 * ライブ session 一覧 (plan.md §3A / frontend.md 最重要 KPI).
 * **1 行で「動いているか / 何をしているか / 介入要否」が分かる**こと。
 * 停止は断定せず liveness badge は suspected を明示。承認/入力/認証待ちは強調する。
 *
 * Adaptive Clarity: Carbon Table/Tag を kit（ネイティブ table + token 駆動 Tag/StatusBadge）へ置換。
 */
import { Button, StatusBadge, Table, TBody, Tag, Td, Th, THead, Tr } from "./kit";
import { useLocale } from "./LocaleProvider";
import {
  effectiveLivenessState,
  livenessBadge,
  needsOperator,
  waitingKind,
} from "./liveness-display";
import { formatCurrentAction } from "./action-units-display";

import type { SessionListItem } from "../realtime/contract";
// 2b-TDA-2 (sweep 019f1991): per-agent の wire shape は正準型を参照する (inline 再宣言しない)。
import type { AgentVisibilityWire } from "@actradeck/event-model";

function relativeAge(iso: string | undefined, nowMs: number): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

export interface SessionRowProps {
  readonly item: SessionListItem;
  readonly selected: boolean;
  readonly nowMs: number;
  readonly onSelect: (sessionId: string) => void;
}

export function SessionRow({ item, selected, nowMs, onSelect }: SessionRowProps) {
  const { locale, t } = useLocale();
  // 表示時の鮮度補正: 凍結された "live"(履歴/無活動)を now 基準で idle/unknown へ降格する。
  const badge = livenessBadge(effectiveLivenessState(item, nowMs), item.stalled_suspected);
  const waiting = waitingKind(item.state);
  const attention = needsOperator(item);
  const waitingLabel = waiting ? t(`waiting.${waiting}` as const) : t("list.attention");
  const dash = t("common.dash");
  // 現在アクション要約は表示時ローカライズ (kind+subject 優先・欠落で legacy summary→state→dash)。
  const currentAction =
    formatCurrentAction(
      {
        kind: item.current_action_kind,
        subject: item.current_action_subject,
        fallback: item.current_action,
      },
      locale,
    ) ??
    item.state ??
    dash;
  return (
    <Tr
      tabIndex={0}
      data-testid="session-row"
      data-selected={selected}
      data-attention={attention}
      aria-selected={selected}
      className="ad-session-row"
      onClick={() => onSelect(item.session_id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(item.session_id);
        }
      }}
    >
      <Td data-testid="liveness">
        <StatusBadge badge={badge} />
      </Td>
      <Td data-testid="action" className="ad-session-action">
        {currentAction}
        <div className="ad-session-meta">{item.session_id.slice(0, 12)}</div>
      </Td>
      <Td data-testid="attention">
        {attention ? (
          <Tag tone="danger" size="sm" iconStart="warning">
            {waitingLabel}
          </Tag>
        ) : (
          <Tag tone="muted" size="sm">
            {t("list.clear")}
          </Tag>
        )}
      </Td>
      <Td data-testid="repo">
        <span className="ad-kv-value">
          {item.repo ?? dash}
          {item.branch ? `@${item.branch}` : ""}
        </span>
      </Td>
      <Td data-testid="last-event">{relativeAge(item.last_event_at, nowMs)}</Td>
      <Td data-testid="provider">
        <Tag tone="neutral" size="sm">
          {item.provider}
        </Tag>
      </Td>
    </Tr>
  );
}

export interface SessionListProps {
  readonly sessions: readonly SessionListItem[];
  readonly selectedId: string | null;
  readonly nowMs: number;
  readonly onSelect: (sessionId: string) => void;
  /** 空一覧時の文言(文脈別: 起動中なし/検索一致なし等)。未指定は既定文言。 */
  readonly emptyLabel?: string;
  /**
   * 空一覧時に出す任意のアクション(例: 検索一致0かつ履歴OFFのとき「履歴も含めて検索」)。
   * 履歴ゲート(既定 起動中のみ)で過去 session が隠れる罠を、その場の1クリックで緩和する。
   */
  readonly emptyAction?: { readonly label: string; readonly onClick: () => void };
  /**
   * **真の初回/空状態**(検索一致0 でも 履歴OFF でもなく観測 session が 0)のとき出す readiness パネル。
   * 既出データ(接続中 observer daemon 数)だけで「接続できているか・次に何をするか」を示す。
   * 指定時は emptyLabel/emptyAction より優先して描画する(架空状態は出さない・実観測のみ)。
   *
   * ADR 019f1972 §2b: claude/codex があれば per-agent ✓/✗/— 行を描画する (Claude/Codex が個別に配線
   * されているか)。**2a 後方互換**: 省略 (daemonCount のみ) なら従来の doctor ヒント文言へフォールバックする。
   * すべて NO-RAW (boolean のみ・観測された配線状態であり「リアルタイム」ではない=hello 時点値)。
   */
  readonly readiness?: {
    readonly daemonCount: number;
    readonly claude?: AgentVisibilityWire["claude"];
    readonly codex?: AgentVisibilityWire["codex"];
  };
}

/** Claude の観測配線状態 3 値 (anyHook=配線済み / binary のみ=未配線 / 未検出)。 */
type ClaudeState = "wired" | "detected" | "missing";
function claudeState(c: AgentVisibilityWire["claude"]): ClaudeState {
  if (c.anyHook) return "wired"; // hook 注入済み=セッションが cockpit に出る。
  if (c.binaryOnPath) return "detected"; // binary はあるが未配線 (doctor で hook 注入)。
  return "missing"; // 未検出。
}

/** Codex の観測配線状態 3 値 (rollout 解決=観測可能 / binary のみ=未解決 / 未検出)。 */
type CodexState = "observable" | "detected" | "missing";
function codexState(c: AgentVisibilityWire["codex"]): CodexState {
  if (c.rolloutDirResolved) return "observable"; // rollout dir 解決=観測可能。
  if (c.binaryOnPath) return "detected"; // binary はあるが rollout 未解決。
  return "missing"; // 未検出。
}

/** ✓ (配線/観測可能) / ✗ (検出のみ) / — (未検出) のマーカー (NO-RAW: ユーザーデータでない記号)。 */
function readinessMark(state: ClaudeState | CodexState): string {
  if (state === "wired" || state === "observable") return "✓";
  if (state === "detected") return "✗";
  return "—";
}

export function SessionList({
  sessions,
  selectedId,
  nowMs,
  onSelect,
  emptyLabel,
  emptyAction,
  readiness,
}: SessionListProps) {
  const { t } = useLocale();
  if (sessions.length === 0) {
    // 真の初回/空状態: 観測 daemon 数で「接続できているか・次に何をするか」を示す(実観測のみ)。
    if (readiness) {
      const connected = readiness.daemonCount > 0;
      // ADR 019f1972 §2b: per-agent 情報が両方そろっていれば ✓/✗/— 行を出す。片方でも欠ければ 2a 文言へ
      // フォールバック (後方互換・架空状態を出さない)。
      const claude = readiness.claude;
      const codex = readiness.codex;
      const hasPerAgent = claude !== undefined && codex !== undefined;
      const cl = claude ? claudeState(claude) : null;
      const cd = codex ? codexState(codex) : null;
      return (
        <div className="ad-empty" data-testid="readiness" data-connected={connected}>
          {connected ? (
            <>
              <span data-testid="readiness-connected">
                {t("readiness.connected", { count: readiness.daemonCount })}
              </span>
              {hasPerAgent && cl !== null && cd !== null ? (
                <ul className="ad-readiness__agents" data-testid="readiness-agents">
                  <li data-testid="readiness-agent-claude" data-state={cl}>
                    <span className="ad-readiness__mark" aria-hidden="true">
                      {readinessMark(cl)}
                    </span>
                    <span>{t(`readiness.agent.claude.${cl}` as const)}</span>
                  </li>
                  <li data-testid="readiness-agent-codex" data-state={cd}>
                    <span className="ad-readiness__mark" aria-hidden="true">
                      {readinessMark(cd)}
                    </span>
                    <span>{t(`readiness.agent.codex.${cd}` as const)}</span>
                  </li>
                </ul>
              ) : (
                <span className="ad-readiness__hint">{t("readiness.connected.hint")}</span>
              )}
            </>
          ) : (
            <span data-testid="readiness-disconnected">{t("readiness.disconnected")}</span>
          )}
        </div>
      );
    }
    return (
      <div className="ad-empty" data-testid="empty-list">
        <span>{emptyLabel ?? t("list.empty")}</span>
        {emptyAction ? (
          <Button
            kind="secondary"
            size="sm"
            iconStart="time"
            data-testid="empty-action"
            onClick={emptyAction.onClick}
          >
            {emptyAction.label}
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <Table data-testid="session-list" className="ad-session-table" caption={t("list.caption")}>
      <THead>
        <Tr>
          <Th>{t("list.col.liveness")}</Th>
          <Th>{t("list.col.action")}</Th>
          <Th>{t("list.col.attention")}</Th>
          <Th>{t("list.col.repo")}</Th>
          <Th>{t("list.col.age")}</Th>
          <Th>{t("list.col.provider")}</Th>
        </Tr>
      </THead>
      <TBody>
        {sessions.map((s) => (
          <SessionRow
            key={s.session_id}
            item={s}
            selected={s.session_id === selectedId}
            nowMs={nowMs}
            onSelect={onSelect}
          />
        ))}
      </TBody>
    </Table>
  );
}
