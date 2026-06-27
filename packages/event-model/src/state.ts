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
 */
export const TERMINAL_STATES: readonly State[] = ["completed", "failed", "interrupted"] as const;

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
 * - 終端状態 (completed/failed/interrupted) からの遷移は無い (空集合)。
 *   ※ INV-EVENT-TRANSITION の「completed→running 拒否」はこの空集合で担保。
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
  completed: [],
  failed: [],
  interrupted: [],

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
