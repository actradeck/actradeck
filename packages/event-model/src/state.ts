/**
 * 正規化状態モデル (plan.md §4) + 許可遷移表 (T1 正典).
 *
 * 「running」一括りにしない。ユーザーが知りたいのは「モデル待ちなのか / コマンド
 * 実行中なのか / 承認待ちなのか」であり、状態は running.* / waiting.* へ分解する。
 *
 * ここで定義する `STATE_TRANSITIONS` は T1 契約であり、Phase 3 の backend reducer は
 * この表を唯一の遷移真実として参照する (reducer 側に独自の遷移ロジックを置かない)。
 */
import { z } from "zod";

/**
 * plan.md §4 の状態 enum (順序・綴りを厳密に一致させる)。
 * 値そのものが DB `events.state` / `session_state.state` (TEXT 列) に格納される。
 */
export const State = z.enum([
  "created",
  "starting",
  "running.model_wait",
  "running.model_streaming",
  "running.planning",
  "running.tool_preparing",
  "running.command_executing",
  "running.file_editing",
  "running.mcp_tool_calling",
  "running.web_searching",
  "running.testing",
  "waiting.approval",
  "waiting.user_input",
  "waiting.auth",
  "compacting",
  "completed",
  "failed",
  "interrupted",
  // ADR 0014 (provider lifecycle fidelity): provider が会話/スレッドを **一時 unload** した
  //   (Codex `thread/closed` = ~30 分無活動後の休止・delete ではない) 状態。この観測 run にとって
  //   terminal だが `completed`/`failed` と異なり **再開可能** (recoverability="resumable")。
  //   再開は新しい session_id (run lineage・Phase 3) で扱い、この run は不変のまま残す
  //   (terminal を再オープンしない設計)。plan.md §4 には無い ADR 0014 の additive 終端。
  "suspended",
  "stalled",
  "disconnected",
  "idle",
]);
export type State = z.infer<typeof State>;

/** 全状態のリスト (列挙・テスト用)。 */
export const ALL_STATES = State.options;

/**
 * 終端状態。ここに入ったら原則として遷移しない (リプレイ/新ターンは新セッション/
 * 再 starting で扱う)。reducer はこれらを「セッション確定」として projection する。
 *
 * ADR 0014: `suspended` (provider unload・再開可) も terminal 群に含める。terminal 不変性は
 *   維持し、「再開できるか」は状態値ではなく直交軸 `continuation` (下記 TERMINAL_CONTINUATION)
 *   で宣言する。terminal を再オープンしない (resume は新 session_id・Phase 3 lineage)。
 */
export const TERMINAL_STATES: readonly State[] = [
  "completed",
  "failed",
  "interrupted",
  "suspended",
] as const;

/**
 * **失敗を表す** terminal 状態の正典集合（TERMINAL_STATES の部分集合）。
 *
 * 「失敗/異常終了」を意味する terminal はこれだけ: `failed`（確定失敗）と `interrupted`（中断）。
 * `completed`（正常終了）と `suspended`（provider unload・再開可・ADR 0014）は **失敗ではない**。
 *
 * ⚠️ **減算派生しないこと（ADR 0014 SEC-1/TDA-1 回帰防止）**: 以前 webui 通知面は
 * `TERMINAL_STATES.filter(s => s !== "completed")` で失敗集合を導出していたため、TERMINAL_STATES に
 * 非失敗の新 terminal（`suspended`）を足した瞬間、再開可能な休止が「異常終了」通知へ誤って巻き込まれた。
 * 失敗判定は「terminal から何かを引く」のではなく、この **明示 allowlist** を唯一の出所とする。
 * 新しい terminal を足すときは、失敗であるものだけをここへ明示追加する（既定は非失敗＝安全側）。
 */
export const FAILURE_TERMINAL_STATES: readonly State[] = ["failed", "interrupted"] as const;

/** running.* サブ状態 (相互に自由遷移可能なアクティブ作業群)。 */
export const RUNNING_STATES: readonly State[] = [
  "running.model_wait",
  "running.model_streaming",
  "running.planning",
  "running.tool_preparing",
  "running.command_executing",
  "running.file_editing",
  "running.mcp_tool_calling",
  "running.web_searching",
  "running.testing",
] as const;

/** waiting.* サブ状態 (人間 / 外部の介入待ち)。 */
export const WAITING_STATES: readonly State[] = [
  "waiting.approval",
  "waiting.user_input",
  "waiting.auth",
] as const;

/**
 * 許可遷移表 (T1). key = from, value = 到達可能な to の集合。
 *
 * 設計方針:
 * - created → starting → (running.* | waiting.* | idle) のライフサイクル。
 * - running.* 同士は自由に遷移できる (モデル待ち → コマンド実行 → ファイル編集 …)。
 * - running.* / waiting.* / compacting からはいつでも終端 (completed/failed/interrupted) へ。
 * - waiting.* は承認/入力/認証が解決すれば running.* へ戻れる。
 * - stalled / disconnected は「アクティブだった状態」からの診断的遷移であり、
 *   復帰 (running.* へ) または終端へ抜けられる (停止を断定しない: plan.md §5)。
 * - compacting は running.* / waiting.* から入り、元の作業 (running.*) へ戻る。
 * - idle は starting / running.* から入り、新たな作業で running.* へ戻れる。
 * - 終端状態 (completed/failed/interrupted/suspended) からの遷移は無い (空集合)。
 *   ※ INV-EVENT-TRANSITION の「completed→running 拒否」はこの空集合で担保。
 *   ※ suspended も terminal ゆえ再オープン不可。再開は新 session_id で扱う (ADR 0014)。
 */
const RUNNING = RUNNING_STATES;
const WAITING = WAITING_STATES;
const TERMINAL = TERMINAL_STATES;
/** running.* / waiting.* / compacting から共通で抜けられる「離脱先」。 */
const EXITS: readonly State[] = [...TERMINAL, "stalled", "disconnected", "idle"] as const;

export const STATE_TRANSITIONS: Readonly<Record<State, readonly State[]>> = {
  created: ["starting", "disconnected", "failed"],
  starting: [...RUNNING, ...WAITING, "idle", "disconnected", "failed"],

  // running.* 群: 互いに自由 + waiting.* + compacting + 離脱先。
  "running.model_wait": [...RUNNING, ...WAITING, "compacting", ...EXITS],
  "running.model_streaming": [...RUNNING, ...WAITING, "compacting", ...EXITS],
  "running.planning": [...RUNNING, ...WAITING, "compacting", ...EXITS],
  "running.tool_preparing": [...RUNNING, ...WAITING, "compacting", ...EXITS],
  "running.command_executing": [...RUNNING, ...WAITING, "compacting", ...EXITS],
  "running.file_editing": [...RUNNING, ...WAITING, "compacting", ...EXITS],
  "running.mcp_tool_calling": [...RUNNING, ...WAITING, "compacting", ...EXITS],
  "running.web_searching": [...RUNNING, ...WAITING, "compacting", ...EXITS],
  "running.testing": [...RUNNING, ...WAITING, "compacting", ...EXITS],

  // waiting.* 群: 解決すれば running.* へ復帰、別の待ちへ移行、または離脱。
  "waiting.approval": [...RUNNING, ...WAITING, ...EXITS],
  "waiting.user_input": [...RUNNING, ...WAITING, ...EXITS],
  "waiting.auth": [...RUNNING, ...WAITING, ...EXITS],

  // compacting: 圧縮後は作業 (running.*) へ戻る or 待ち or 離脱。
  compacting: [...RUNNING, ...WAITING, ...EXITS],

  // 終端: 遷移なし (空集合) → completed→running 等を構造的に拒否。
  //   suspended (provider unload・再開可) も terminal 不変。running.*/waiting.*/idle 等
  //   アクティブ状態からは EXITS (= ...TERMINAL) 経由で到達できるが、そこから先は無い。
  completed: [],
  failed: [],
  interrupted: [],
  suspended: [],

  // 診断状態: 停止を断定しない。復帰 (running.*) / 別の待ち / 終端へ抜けられる。
  stalled: [...RUNNING, ...WAITING, "disconnected", ...TERMINAL],
  disconnected: [...RUNNING, ...WAITING, "stalled", ...TERMINAL],

  // idle: 次の作業で running.* へ、または starting に戻る / 離脱。
  idle: [...RUNNING, "starting", ...TERMINAL, "disconnected"],
};

/** ある状態が終端 (これ以上遷移しない) か。 */
export function isTerminalState(state: State): boolean {
  return TERMINAL_STATES.includes(state);
}

/**
 * `isTerminalState` の **string 緩包含版** (State 型 narrow 不要・T1 正典 TERMINAL_STATES 帰着)。
 *
 * DTO / DB 由来の state は `string | undefined` (SessionListItem.state / detail.state 等) で届き、
 * `State` へ narrow せずに terminal 判定したい消費面 (presence recency proxy / webui interrupt 可否)
 * がここを共有する。手書きの `new Set(["completed","failed","interrupted"])` 列挙コピーを各層に
 * 置かないための単一出所 (consolidation-invariant-sweep-all-copies / wall-ended-badge TDA-1)。
 * 未知値 / 未提供 (undefined) は非 terminal = false。
 */
export function isTerminalStateValue(state: string | undefined): boolean {
  return typeof state === "string" && (TERMINAL_STATES as readonly string[]).includes(state);
}

/**
 * `state` が **失敗を表す** terminal（`FAILURE_TERMINAL_STATES`）か。`isTerminalStateValue` の
 * 失敗限定版（string 緩包含・DTO 由来 `string | undefined` を narrow せず判定）。webui 通知の
 * 失敗分類の単一出所（減算派生 FAILED_STATES を置換・ADR 0014 SEC-1/TDA-1）。completed / suspended /
 * 未知値 / undefined は false（＝失敗でない・安全側）。
 */
export function isFailureTerminalStateValue(state: string | undefined): boolean {
  return (
    typeof state === "string" && (FAILURE_TERMINAL_STATES as readonly string[]).includes(state)
  );
}

/**
 * ADR 0014 直交軸 (1/3) — **turn の結果** (セッションの結果ではない)。
 * 正規化 phase (`State`) と独立: 1 つの turn が中断/失敗しても run 自体は継続しうる。
 */
export type LastTurnOutcome = "completed" | "failed" | "interrupted";

/**
 * ADR 0014 直交軸 (2/3) — **再開可能性** (recoverability)。
 * terminal 状態に到達したとき、その run/会話を再開できるかの evidence。
 * `resumable` = provider が再開手段を持つ (Codex unload 等)。`not_resumable` = 正常終了。
 * `unknown` = 判定不能 (失敗/中断で証跡が無い)。
 */
export type Continuation = "resumable" | "not_resumable" | "unknown";

/**
 * ADR 0014 直交軸 (3/3) — **終端の根拠**。どうやって terminal と判定したか。
 * `provider` = provider の明示イベント (thread/closed・session end・interrupt)。
 * `process_exit` = 子プロセスの OS 終了 (managed liveness 層)。`timeout` = 無応答上限。
 * `inferred` = 上記の明示証跡なしに縮退推定 (over-claim しない安全側の既定)。
 */
export type TerminalEvidence = "provider" | "process_exit" | "timeout" | "inferred";

/**
 * terminal 状態 → 既定 `continuation` の正準写像 (T1 単一出所・ADR 0014)。
 * projection reducer / UI はこれを唯一の真実として参照し、手書きの分岐コピーを置かない。
 * non-terminal 状態はキーを持たない (= 直交軸は terminal でのみ意味を持つ)。
 */
export const TERMINAL_CONTINUATION: Readonly<Partial<Record<State, Continuation>>> = {
  completed: "not_resumable",
  failed: "unknown",
  interrupted: "unknown",
  suspended: "resumable",
};

/**
 * terminal 状態 → 既定 `terminal_evidence` の正準写像 (T1 単一出所・ADR 0014)。
 * 明示 provider イベント由来 (completed/interrupted/suspended) は "provider"、`failed` は
 * 既定 "inferred" (normalizer 経路の failed は明示証跡が無いため over-claim しない)。より強い
 * 証跡 (process_exit / timeout) を持つ層は Phase 4 でイベントに明示付与して override する。
 */
export const TERMINAL_EVIDENCE_DEFAULT: Readonly<Partial<Record<State, TerminalEvidence>>> = {
  completed: "provider",
  interrupted: "provider",
  suspended: "provider",
  failed: "inferred",
};

/** terminal 状態の既定 continuation を引く (non-terminal / undefined は undefined)。 */
export function terminalContinuation(state: State | undefined): Continuation | undefined {
  return state !== undefined ? TERMINAL_CONTINUATION[state] : undefined;
}

/** terminal 状態の既定 terminal_evidence を引く (non-terminal / undefined は undefined)。 */
export function terminalEvidenceFor(state: State | undefined): TerminalEvidence | undefined {
  return state !== undefined ? TERMINAL_EVIDENCE_DEFAULT[state] : undefined;
}

/**
 * from → to が許可遷移か判定する (T1 遷移表に基づく)。
 *
 * - 同一状態への遷移 (from === to) は冪等な再観測 (例: 連続する model_streaming) として
 *   常に許可する。これがないと delta イベント連打で reducer が誤検知する。
 * - 未知の状態 (enum 外) は false。
 */
export function isValidTransition(from: State, to: State): boolean {
  if (from === to) return true;
  const allowed = STATE_TRANSITIONS[from];
  return allowed !== undefined && allowed.includes(to);
}

/**
 * 遷移を表明し、不正なら例外を投げる (reducer / ingestion が fail-fast に使う)。
 */
export function assertValidTransition(from: State, to: State): void {
  if (!isValidTransition(from, to)) {
    throw new InvalidStateTransitionError(from, to);
  }
}

/** 不正 state 遷移エラー (INV-EVENT-TRANSITION 違反)。 */
export class InvalidStateTransitionError extends Error {
  override readonly name = "InvalidStateTransitionError";
  constructor(
    readonly from: State,
    readonly to: State,
  ) {
    super(`Invalid state transition: ${from} -> ${to}`);
  }
}
