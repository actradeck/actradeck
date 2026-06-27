/**
 * 現在作業ビュー (中央ペイン) と git/risk ペイン (右ペイン) の **表示用** 派生 (純関数).
 *
 * ADR 019ea4ba 段階1 (MVP・既存イベントのみ・新 backend データ経路ゼロ):
 *  - 中央ペインの切替軸は **新 state/event_type を作らず** T1 `State` 機械をそのまま使う
 *    (packages/event-model/src/state.ts)。`State→ビュー種別` を純関数 `currentActionView` に切り出し、
 *    SessionDetail は描画のみ (liveness-display.ts / approval-display.ts と同じ「状態と表示の分離」)。
 *  - 右ペインの risk フラグ/サマリは **タイムラインが既に pull した ReplayEventDTO 配列**から導出する
 *    (`deriveSessionFacts`)。新 endpoint も新 DTO フィールドも増やさない。
 *
 * SEC (security.md): ここは backend が redaction 済みで載せた DTO の値だけを見せ方へ落とす。
 * 生 payload / tool_input を独自取得しない・新たな本文チャネルを作らない (段階1 は行サマリのみ)。
 * stdout 本文 tail / git 全体 diff 本文 / secret_detected 明示化は段階2 (本ファイル対象外)。
 */
import { formatCurrentAction } from "./action-units-display";
import { t, type Locale } from "./i18n/messages";

import type { ReplayEventDTO, SessionDetail } from "../realtime/contract";

/**
 * 中央「現在作業」ビューの種別。T1 `State` を写像した表示軸であり、新しい状態機械ではない。
 * - model_stream … model 待ち/streaming/planning: agent message / reasoning summary tail + plan。
 * - command      … command/tool 実行: command + cwd + elapsed + kill (= 既存 interrupt)。
 * - file_edit    … file 編集: 対象 path (+ 既存 file.change.proposed.diff があれば diff) + 承認。
 * - mcp          … MCP ツール呼び出し: server / tool。
 * - web          … web 検索: query。
 * - waiting      … 承認/入力/認証待ち: 既存承認カード / waiting バナー。
 * - idle         … created/starting/compacting/idle/terminal/stalled/unknown 等: 既定の控えめ表示。
 */
export type CurrentActionView =
  | "model_stream"
  | "command"
  | "file_edit"
  | "mcp"
  | "web"
  | "waiting"
  | "idle";

/**
 * `State`(文字列) → 中央ペインのビュー種別へ写像する純関数 (INV-DETAIL-CURRENT-ACTION-MAP)。
 *
 * detail.state は `string | undefined` (wire 由来で未知値もありうる) のため、ここでは T1 の
 * 列挙名に対して明示マッチし、**未知 state は安全に `idle` へ fallback** する (UI を壊さない)。
 * waiting.* は承認/入力/認証の区別を上位 (liveness-display.waitingKind) が担うので一括 `waiting`。
 */
export function currentActionView(state: string | undefined): CurrentActionView {
  switch (state) {
    case "running.model_wait":
    case "running.model_streaming":
    case "running.planning":
      return "model_stream";
    case "running.tool_preparing":
    case "running.command_executing":
    case "running.testing":
      return "command";
    case "running.file_editing":
      return "file_edit";
    case "running.mcp_tool_calling":
      return "mcp";
    case "running.web_searching":
      return "web";
    case "waiting.approval":
    case "waiting.user_input":
    case "waiting.auth":
      return "waiting";
    default:
      // created / starting / compacting / idle / stalled / completed / failed / interrupted /
      // disconnected / 未知値 → 控えめな既定ビュー (現在「アクティブ作業」を断定しない)。
      return "idle";
  }
}

/** 中央ペインの見出しラベル (観測状態の表示)。既定 locale は ja。 */
export function currentActionViewLabel(view: CurrentActionView, locale: Locale = "ja"): string {
  switch (view) {
    case "model_stream":
      return t(locale, "action.view.modelStream");
    case "command":
      return t(locale, "action.view.command");
    case "file_edit":
      return t(locale, "action.view.fileEdit");
    case "mcp":
      return t(locale, "action.view.mcp");
    case "web":
      return t(locale, "action.view.web");
    case "waiting":
      return t(locale, "action.view.waiting");
    case "idle":
      return t(locale, "action.view.idle");
  }
}

/**
 * 中央ペインへ表示する「現在作業」スナップショット。すべて **既存 DTO / 既存イベント由来**。
 * 本文 (stdout tail / diff 全体) は載せない (段階2)。`diff` は既存 file.change.proposed.diff が
 * timeline 行に載っていれば拾うが、段階1 の ReplayEventDTO は diff 本文を allow-list しないため
 * 実際には常に undefined (段階2 で read DTO 拡張時に有効化)。
 */
export interface CurrentActionSnapshot {
  readonly view: CurrentActionView;
  readonly label: string;
  /** 表示用の主テキスト (command / path / summary / current_action のいずれか・redaction 済み)。 */
  readonly primaryText: string | undefined;
  /** command 実行ビューの作業ディレクトリ (既存 DTO の cwd)。 */
  readonly cwd: string | undefined;
  /** command/tool の経過時間 (ms)。最新の該当イベント由来。 */
  readonly elapsedMs: number | undefined;
  /** 直近の exit code (command 完了行があれば)。 */
  readonly exitCode: number | undefined;
}

/** state に対し中央ペインの「主テキスト」を選ぶ素材となる最新イベントの kind 群。 */
const VIEW_EVENT_KINDS: Record<CurrentActionView, readonly string[]> = {
  model_stream: ["message", "turn"],
  command: ["command", "tool"],
  file_edit: ["file"],
  mcp: ["mcp"],
  web: ["web"],
  waiting: ["approval"],
  idle: [],
};

/** 配列末尾から条件一致の最初の要素を返す (最新 = タイムライン昇順の末尾)。 */
function findLast<T>(arr: readonly T[], pred: (v: T) => boolean): T | undefined {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i]!)) return arr[i];
  }
  return undefined;
}

/**
 * detail.state + (既に pull 済みの) timeline events から中央ペインの現在作業を組む純関数。
 * events は昇順 (REPLAY_ORDER) 前提。新しい情報経路を作らず、行サマリ相当のみ抽出する。
 */
export function currentActionSnapshot(
  detail: Pick<
    SessionDetail,
    "state" | "current_action" | "current_action_kind" | "current_action_subject" | "cwd"
  >,
  events: readonly ReplayEventDTO[] = [],
  locale: Locale = "ja",
): CurrentActionSnapshot {
  const view = currentActionView(detail.state);
  const kinds = VIEW_EVENT_KINDS[view];
  const latest = kinds.length > 0 ? findLast(events, (e) => kinds.includes(e.kind)) : undefined;

  // 主テキスト: 最新イベントの構造値 (command/path) を最優先 (本ペインは「今この瞬間」を示す)。
  // 無ければ表示時ローカライズした current_action (kind+subject 優先・欠落で legacy summary) →
  // latest.summary → detail.state の順で fallback (ADR 019eeac6・後方互換)。
  const localizedCurrentAction = formatCurrentAction(
    {
      kind: detail.current_action_kind,
      subject: detail.current_action_subject,
      fallback: detail.current_action,
    },
    locale,
  );
  const primaryText =
    latest?.command ??
    latest?.path ??
    localizedCurrentAction ??
    latest?.summary ??
    detail.state ??
    undefined;

  return {
    view,
    label: currentActionViewLabel(view, locale),
    primaryText,
    cwd: latest?.cwd ?? detail.cwd,
    elapsedMs: latest?.elapsed_ms,
    exitCode: latest?.exit_code,
  };
}

/**
 * 右ペイン (git/risk) の集約フラグ。**既存 timeline events からのみ導出** (段階1)。
 * diff 行数メトリクス (changed_files/added/removed) は ReplayEventDTO の allow-list に
 * 載らないため段階1 は **変更ファイルイベントの有無/件数** で代替する (本文・行数は段階2)。
 * secret_detected の明示化も段階2 (過少表示で安全側)。
 */
export interface SessionRiskFacts {
  /** 観測された最高 risk_level (high > medium > low > none)。command/file/approval 行由来。 */
  readonly highestRisk: "high" | "medium" | "low" | "none";
  /** MCP ツール呼び出しが出現したか。 */
  readonly mcp: boolean;
  /** Web 検索が出現したか (network 露出シグナル)。 */
  readonly web: boolean;
  /** file 変更系イベント (file.* / diff.updated) が出現したか。 */
  readonly fileChanges: boolean;
  /** 変更に関与したユニークなパス数 (段階1 の「変更量」近似)。 */
  readonly changedPathCount: number;
  /** 非ゼロ exit code の command があったか (失敗シグナル)。 */
  readonly hadCommandFailure: boolean;
  /** capture_mode (欠落は managed 既定; capture provenance バッジ判定の出所)。 */
  readonly captureMode: "managed" | "attach" | "codex_rollout";
}

const RISK_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

/** capture_mode を欠落許容で正規化する (欠落/未知 = managed 既定; ADR 019ea4ba D4 寛容性)。 */
export function normalizeCaptureMode(
  v: string | undefined,
): "managed" | "attach" | "codex_rollout" {
  return v === "attach" || v === "codex_rollout" ? v : "managed";
}

/**
 * ActraDeck が起動を所有しない capture 経路か。
 *
 * これは **approval relay 可否ではない**。Claude Code Attach は capture としては non-managed だが
 * hook 応答により approval relay できる。Codex rollout は passive tail なので observe-only。
 * そのため UI バッジは「起動所有 / stop 制御」だけを示し、承認能力は pending/relay の実データで示す。
 */
export function isNonManagedCapture(captureMode: string | undefined): boolean {
  return normalizeCaptureMode(captureMode) !== "managed";
}

/**
 * 右ペインの facts を timeline events + detail.capture_mode から導出する純関数。
 * 既存データのみ・redaction 済み値のみ参照 (security.md)。
 */
export function deriveSessionFacts(
  detail: Pick<SessionDetail, "capture_mode">,
  events: readonly ReplayEventDTO[] = [],
): SessionRiskFacts {
  let riskRank = 0;
  let mcp = false;
  let web = false;
  let fileChanges = false;
  let hadCommandFailure = false;
  const changedPaths = new Set<string>();

  for (const e of events) {
    if (e.risk_level && RISK_RANK[e.risk_level] !== undefined) {
      riskRank = Math.max(riskRank, RISK_RANK[e.risk_level]!);
    }
    if (e.kind === "mcp") mcp = true;
    if (e.kind === "web") web = true;
    if (e.kind === "file") {
      fileChanges = true;
      if (e.path) changedPaths.add(e.path);
    }
    if (typeof e.exit_code === "number" && e.exit_code !== 0) hadCommandFailure = true;
  }

  const highestRisk =
    riskRank === 3 ? "high" : riskRank === 2 ? "medium" : riskRank === 1 ? "low" : "none";

  return {
    highestRisk,
    mcp,
    web,
    fileChanges,
    changedPathCount: changedPaths.size,
    hadCommandFailure,
    captureMode: normalizeCaptureMode(detail.capture_mode),
  };
}

/** タイムライン1行の表示用射影 (既存 ReplayEventDTO の行サマリのみ; 本文展開は段階2)。 */
export interface TimelineRow {
  readonly eventId: string;
  readonly timestamp: string;
  readonly kind: string;
  readonly displayText: string;
  readonly toolName: string | undefined;
  readonly command: string | undefined;
  readonly path: string | undefined;
  readonly riskLevel: string | undefined;
  readonly decision: string | undefined;
  readonly exitCode: number | undefined;
  readonly elapsedMs: number | undefined;
}

/**
 * ReplayEventDTO を timeline 行射影へ (純関数)。順序は呼び元が保持する (REPLAY_ORDER 昇順)。
 * INV-DETAIL-TIMELINE-ORDER は events 配列の順序を変えないこと自体で満たす (本射影は map のみ)。
 */
export function toTimelineRow(e: ReplayEventDTO): TimelineRow {
  return {
    eventId: e.event_id,
    timestamp: e.timestamp,
    kind: e.kind,
    displayText: e.display_text,
    toolName: e.tool_name,
    command: e.command,
    path: e.path,
    riskLevel: e.risk_level,
    decision: e.decision,
    exitCode: e.exit_code,
    elapsedMs: e.elapsed_ms,
  };
}
