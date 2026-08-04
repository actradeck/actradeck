"use client";

/**
 * ライブ session 一覧 (plan.md §3A / frontend.md 最重要 KPI).
 * **1 行で「動いているか / 何をしているか / 介入要否」が分かる**こと。
 * 停止は断定せず liveness badge は suspected を明示。承認/入力/認証待ちは強調する。
 *
 * Adaptive Clarity: Carbon Table/Tag を kit（ネイティブ table + token 駆動 Tag/StatusBadge）へ置換。
 */
import { Button, StatusBadge, Table, TBody, Tag, Td, Th, THead, Tr } from "./kit";
import { CaptureModeBadge } from "./CaptureModeBadge";
import { useLocale } from "./LocaleProvider";
import {
  effectiveLivenessState,
  livenessBadge,
  needsOperator,
  waitingKind,
} from "./liveness-display";
import { formatCurrentAction } from "./action-units-display";
import { MANAGED_CODEX_CMD } from "./managed-codex";
import { shortSessionId } from "./wall-display";
import { ManagedCodexSpawnPanel } from "./ManagedCodexSpawnPanel";
import type { SafetyDemoPhase } from "./use-safety-demo";

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
        <div className="ad-session-meta">{shortSessionId(item.session_id)}</div>
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
        {/* capture provenance (ADR 019f41ec-c549): 非 managed のみバッジ。managed/欠落=無し=既定。
            detail pill と同一意味論 (observe-only とは呼ばない)・単一出所 CaptureModeBadge。 */}
        <CaptureModeBadge
          captureMode={item.capture_mode}
          source={item.source}
          testId="session-capture-mode"
        />
      </Td>
    </Tr>
  );
}

/**
 * readiness データ (観測 daemon 数 + per-agent 配線 boolean・NO-RAW)。真の空状態パネルと post-demo
 * 段階案内 (task 019f41ec) が共有する。
 */
export interface ReadinessData {
  readonly daemonCount: number;
  readonly claude?: AgentVisibilityWire["claude"];
  readonly codex?: AgentVisibilityWire["codex"];
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
  readonly readiness?: ReadinessData;
  /**
   * task 019f41ec / decision 019fcdaf: デモ完走後の「実エージェント接続」段階案内。board の表示 session が
   * すべて使い捨てデモ (`demo-safety-*`) かつ 1 件以上 terminal のときのみ親が渡す (実データ駆動・
   * `isPostDemoBoardState`)。一覧テーブルの上に描画し、実 session が観測されると自然に消える。
   */
  readonly postDemo?: { readonly readiness: ReadinessData };
  /**
   * ADR 019f22a7 P1: 空状態の「この端末で守られている」セクション + 30秒セーフティデモ CTA。
   * 指定時のみ readiness パネル下に描画する (readiness が出る真の空状態でのみ有効)。CTA 押下は親が握る
   * BFF 経由の起動 (`onLaunch`)・phase で二度押し抑止 / 進行 / 失敗を表示する。
   */
  readonly safety?: {
    readonly phase: SafetyDemoPhase;
    readonly onLaunch: () => void;
  };
  /**
   * ADR 019f4206 A段: Codex Managed spawn 導線。spawn 可能 (spawn_capable) な attach デーモンの id 群。
   * 1 つ以上あるときだけ readiness パネルに spawn フォームを描画する (ゼロなら env opt-in 促し hint)。
   */
  readonly codexSpawn?: {
    readonly spawnDaemonIds: readonly string[];
  };
}

/**
 * ADR 019f22a7 P1: 空状態の安全性訴求 + セーフティデモ CTA。
 * 「止める・残さない・証明できる」を **静的な✓で断定せず**、使い捨て 30 秒デモで **実証する** capability として
 * 提示する (claim-matches-default-mode: 偽りの常時✓を作らない)。デモが本物の証跡ゆえ「見せる」でなく「証明する」。
 */
function SafetyDemoPanel({ phase, onLaunch }: { phase: SafetyDemoPhase; onLaunch: () => void }) {
  const { t } = useLocale();
  const busy = phase === "launching" || phase === "running";
  return (
    <section className="ad-safety" data-testid="safety-demo" data-phase={phase}>
      <h3 className="ad-safety__title">{t("safetyDemo.title")}</h3>
      <p className="ad-safety__lead">{t("safetyDemo.lead")}</p>
      <ul className="ad-safety__caps">
        <li>
          <span className="ad-safety__verb">{t("safetyDemo.cap.blockVerb")}</span>
          <span>{t("safetyDemo.cap.block")}</span>
        </li>
        <li>
          <span className="ad-safety__verb">{t("safetyDemo.cap.redactVerb")}</span>
          <span>{t("safetyDemo.cap.redact")}</span>
        </li>
        <li>
          <span className="ad-safety__verb">{t("safetyDemo.cap.auditVerb")}</span>
          <span>{t("safetyDemo.cap.audit")}</span>
        </li>
      </ul>
      <Button
        kind="primary"
        size="md"
        iconStart="play"
        data-testid="safety-demo-cta"
        disabled={busy}
        onClick={onLaunch}
      >
        {t("safetyDemo.cta")}
      </Button>
      {phase === "launching" || phase === "running" ? (
        <span className="ad-safety__progress" data-testid="safety-demo-progress" role="status">
          {phase === "launching" ? t("safetyDemo.launching") : t("safetyDemo.running")}
        </span>
      ) : null}
      {phase === "error" ? (
        <span className="ad-safety__error" data-testid="safety-demo-error" role="alert">
          {t("safetyDemo.error")}
        </span>
      ) : null}
    </section>
  );
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

/**
 * per-agent ✓/✗/— 行 (ADR 019f1972 §2b)。真の空状態パネルと post-demo 段階案内 (task 019f41ec) で共有する
 * 単一出所 (両所で JSX を二重保守しない)。Managed 導線 hint (ADR 019f3960 C) も同梱: codex が
 * observable/detected のときのみ表示 (missing は非表示)。すべて静的リテラル + boolean 由来 (NO-RAW)。
 */
function ReadinessAgentList({
  claude,
  codex,
}: {
  claude: AgentVisibilityWire["claude"];
  codex: AgentVisibilityWire["codex"];
}) {
  const { t } = useLocale();
  const cl = claudeState(claude);
  const cd = codexState(codex);
  return (
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
      {/* ADR 019f3960 C: codex が observable/detected の時のみ Managed 導線 hint を出す
          (missing は非表示)。承認 relay + 予防は Managed 起動でのみ有効・rollout は検知のみ。
          command は静的リテラル (MANAGED_CODEX_CMD)・ユーザーデータ非注入 (NO-RAW 自明)。 */}
      {cd === "observable" || cd === "detected" ? (
        <li
          className="ad-readiness__managed-hint"
          data-testid="readiness-codex-managed-hint"
          data-state={cd}
        >
          <span>{t("readiness.agent.codex.managedHint")}</span> <code>{MANAGED_CODEX_CMD}</code>
        </li>
      ) : null}
    </ul>
  );
}

/**
 * task 019f41ec / decision 019fcdaf: デモ完走後の段階案内 (一覧テーブル上部)。デモは使い捨ての教材
 * セッション — 「次は自分の実エージェントを接続する」への橋渡しを、実測 readiness (観測 daemon 数 +
 * per-agent 配線) で段階表示する。NO-RAW: 静的リテラル + boolean/非負整数のみ。外部リンクは張らず
 * docs パスをテキストで示す (webui に外部リンク面を新設しない)。
 */
function PostDemoNextSteps({ readiness }: { readiness: ReadinessData }) {
  const { t } = useLocale();
  const connected = readiness.daemonCount > 0;
  return (
    <section className="ad-postdemo" data-testid="post-demo-next" data-connected={connected}>
      <h3 className="ad-postdemo__title">{t("postDemo.title")}</h3>
      <p className="ad-postdemo__lead">{t("postDemo.lead")}</p>
      {connected ? (
        <>
          <p className="ad-postdemo__step" data-testid="post-demo-connected">
            {t("readiness.connected", { count: readiness.daemonCount })}
          </p>
          {readiness.claude !== undefined && readiness.codex !== undefined ? (
            <ReadinessAgentList claude={readiness.claude} codex={readiness.codex} />
          ) : null}
        </>
      ) : (
        <>
          <p className="ad-postdemo__step" data-testid="post-demo-disconnected">
            {t("readiness.disconnected")}
          </p>
          <p className="ad-postdemo__step" data-testid="post-demo-docker-hint">
            {t("readiness.disconnectedDockerHint")}
          </p>
        </>
      )}
    </section>
  );
}

// Managed Codex 起動コマンド (ADR 019f3960 C)。docs/README の呼び出し規約 (`./scripts/actradeck up`)
// command は locale 非依存の静的リテラル (i18n 文言は散文のみ・NO-RAW)。TDA-3 sweep 019f397c:
// rename-sensitive な prefix は managed-codex.ts へ単一出所化し、SessionDetail の codexHint と共有する
// (webui の 2 表示面はこれで drift しない・docs 側は同モジュールの grep 註記で追う)。

export function SessionList({
  sessions,
  selectedId,
  nowMs,
  onSelect,
  emptyLabel,
  emptyAction,
  readiness,
  postDemo,
  safety,
  codexSpawn,
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
      // cd は codexSpawn の env opt-in hint 判定にのみ使用 (agent 行の描画は ReadinessAgentList が内部計算)。
      const cd = codex ? codexState(codex) : null;
      return (
        <div className="ad-empty" data-testid="readiness" data-connected={connected}>
          {connected ? (
            <>
              <span data-testid="readiness-connected">
                {t("readiness.connected", { count: readiness.daemonCount })}
              </span>
              {claude !== undefined && codex !== undefined ? (
                <ReadinessAgentList claude={claude} codex={codex} />
              ) : (
                <span className="ad-readiness__hint">{t("readiness.connected.hint")}</span>
              )}
              {/* ADR 019f4206 A段: spawn 可能 daemon が 1 つ以上あるときだけ Managed Codex 起動フォームを出す。
                  ゼロでも codex が観測可能/検出済なら env opt-in が必要な旨を hint 表示 (正直な開示)。 */}
              {codexSpawn ? (
                codexSpawn.spawnDaemonIds.length > 0 ? (
                  <ManagedCodexSpawnPanel spawnDaemonIds={codexSpawn.spawnDaemonIds} />
                ) : cd === "observable" || cd === "detected" ? (
                  <p className="ad-spawn__disabled" data-testid="codex-spawn-disabled">
                    {t("codexSpawn.disabledHint")}
                  </p>
                ) : null
              ) : null}
            </>
          ) : (
            <>
              <span data-testid="readiness-disconnected">{t("readiness.disconnected")}</span>
              {/* task 019f41ec: Docker (cockpit-only) 経路の橋渡し。native コマンドが無い環境でも
                  次の一手 (host 側 sidecar 接続) へ辿り着けるよう docs パスをテキストで示す。 */}
              <span className="ad-readiness__hint" data-testid="readiness-docker-hint">
                {t("readiness.disconnectedDockerHint")}
              </span>
            </>
          )}
          {safety ? <SafetyDemoPanel phase={safety.phase} onLaunch={safety.onLaunch} /> : null}
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
    <>
      {/* task 019f41ec: デモ完走後の段階案内。表示 session が全部使い捨てデモのときだけ親が渡す。 */}
      {postDemo ? <PostDemoNextSteps readiness={postDemo.readiness} /> : null}
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
    </>
  );
}
