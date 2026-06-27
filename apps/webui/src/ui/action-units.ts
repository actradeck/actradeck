/**
 * タイムラインの「アクション単位」畳み込み (純関数・設計裁定 019eb981).
 *
 * ユーザー核心不満:「何に対して・何を行って・結果どうなったのかが画面から読めない」。
 * raw イベント 1:1 行は述語のみ・対象切詰め・結果欠落で、1 つの出来事の理解に複数行の
 * 脳内結合を要する。本モジュールは ReplayEventDTO[] を **アクション単位** (対象 / 行為 /
 * 結果 / 承認チェーン) へ畳む。
 *
 * ── REAL DATA ONLY / 因果の捏造禁止 (最重要 KPI) ──────────────────────────────
 * 相関は **request_id の実観測一致のみ**。request_id には **2 つの非交差キー空間** が同居する
 * (T1 契約: packages/event-model/src/payload.ts の INV-REQUEST-ID-NAMESPACE 参照):
 *  - 承認キー (`<session_id>:apr-…` 等、sidecar 採番): tool.permission.requested / resolved が持つ。
 *  - `tu:<tool_use_id>` (sidecar 55a5abf 以降): command.started / command.completed / tool.failed が
 *    持ち、exit_code / command も同時に載るようになった (それ以前の旧イベントはどちらも持たない)。
 * **畳み込みゲートは event_type で判定する (request_id の有無で判定しない)**: 承認チェーン
 * (requested→resolved) のみを承認 request_id 一致で畳み、command 相関 (command.started ↔
 * command.completed / tool.failed) は **別 Map・別 event_type 集合** で `tu:<tool_use_id>`
 * 一致により独立に畳む。両グルーピングは event_type 集合が交差しないため、承認キーと command
 * キーが byte 同一でも namespace を跨いで突合しない (構造的禁止)。`tu:` prefix の文字列判定は
 * ゲートに使わない (event_type のみで判定・INV-REQUEST-ID-NAMESPACE)。
 * wall-display.matchCompletions は Pass2 で FIFO 隣接 fallback も使うが、本モジュールは
 * **request_id 実観測一致 ONLY** とし FIFO fallback は使わない (より保守的・捏造ゼロ)。
 *
 * 承認キーは実観測上 session_id 埋込み形式だが、畳み込みは **session_id 一致も併せて要求**
 * することで cross-session 混入を二重に防ぐ (INV-ACTION-UNIT-CORRELATION)。
 *
 * SEC (security.md): 入力 ReplayEventDTO は backend が redaction 済みで載せた allow-list
 * フィールドのみ。本モジュールは生 payload を一切参照しない (DTO の値を写すだけ)。
 */
import type { ActionKind } from "@actradeck/event-model";

import type { ReplayEventDTO, ReplayEventKind } from "../realtime/contract";

/**
 * アクション単位の行為種別 (観測された作業の種類)。
 *
 * **単一出所 (single source of truth)**: 値の集合は `@actradeck/event-model` の `ActionKind`
 * 正典 (packages/event-model/src/action-kind.ts) を再エクスポートする。projection が DTO へ載せる
 * `current_action_kind` と UI の畳み込みが同一語彙を共有し、ドリフトを構造的に防ぐ (ADR 019eeac6・
 * TDA ドリフト防止)。値を増減する場合は event-model 側の `ACTION_KINDS` を更新する (lock-step)。
 */
export type { ActionKind };

/**
 * command 相関ユニットの結果 (command 相関ユニットのみ定義・それ以外は undefined)。
 *  - running   : command.started のみ観測 (completed/failed 未到達)。
 *  - succeeded : command.completed を観測 (exit_code は実 CC が載せないため別軸・note 019ebc3a)。
 *  - failed    : tool.failed を観測。
 */
export type CommandOutcome = "running" | "succeeded" | "failed";

/** 承認チェーンの解決状態 (1 行に畳んだときのトーン判定に使う)。 */
export type ApprovalChainStatus =
  | "pending" // requested のみ観測・resolved 未到達 = 未解決 (警告トーン)
  | "resolved" // requested→resolved 両方観測 = 解決済み ("承認待ち" と読ませない)
  | "orphan_resolved"; // resolved のみ観測 (requested 欠落) = 履歴断片

/** アクション単位が表す承認チェーン (request_id 相関で畳んだ結果)。 */
export interface ApprovalChain {
  readonly requestId: string;
  readonly status: ApprovalChainStatus;
  /** resolved.decision (allow/deny/...): resolved 観測時のみ。 */
  readonly decision: string | undefined;
  /** requested.risk_level。 */
  readonly riskLevel: string | undefined;
  /** requested.auto_allowed (自動許可だったか)。 */
  readonly autoAllowed: boolean | undefined;
}

/**
 * 1 アクション単位。タイムライン 1 行 + 詳細モーダルの両方を駆動する。
 * すべて ReplayEventDTO allow-list フィールド由来 (生 payload 不参照)。
 */
export interface ActionUnit {
  /** 安定キー。承認は request_id、それ以外は構成イベントの先頭 event_id。 */
  readonly id: string;
  readonly sessionId: string;
  readonly kind: ActionKind;
  /** 対象 = command 全文 / path / tool_name のいずれか (切詰めずに保持)。 */
  readonly target: string | undefined;
  /** 対象の種類 (行レンダラがアイコン/折返しを選ぶ手がかり)。 */
  readonly targetKind: "command" | "path" | "tool" | undefined;
  /** command 実行時の作業ディレクトリ。 */
  readonly cwd: string | undefined;
  /** 承認チェーン (kind==="approval" のとき)。 */
  readonly approval: ApprovalChain | undefined;
  /**
   * command 相関ユニットの結果 (command.started↔completed/tool.failed を `tu:` で畳んだとき)。
   * 承認・単独ユニットでは undefined。outcome はイベント由来のみ (started のみ=running・
   * completed 観測=succeeded・tool.failed 観測=failed)。
   */
  readonly commandOutcome: CommandOutcome | undefined;
  /** 結果: exit code (command 完了行があれば)。 */
  readonly exitCode: number | undefined;
  /** 結果: 経過 ms。 */
  readonly elapsedMs: number | undefined;
  /** 行サマリ (既存 display_text を踏襲・diff.updated 等の従来 summary 行に使う)。 */
  readonly summary: string;
  /** 代表イベント種別 (raw event_type)。 */
  readonly eventType: string;
  /** 時刻範囲 (start = 最初の構成イベント, end = 最後)。ISO 文字列。 */
  readonly startTime: string;
  readonly endTime: string;
  /** stdout pull の anchor (command.started の event_id があれば)。 */
  readonly commandEventId: string | undefined;
  /** 構成イベント (モーダルの「構成 raw イベント一覧」用・昇順)。 */
  readonly events: readonly ReplayEventDTO[];
}

const KIND_OF_REPLAY: Record<ReplayEventKind, ActionKind> = {
  session: "session",
  turn: "turn",
  approval: "approval",
  command: "command",
  file: "file",
  tool: "tool",
  mcp: "mcp",
  web: "web",
  message: "message",
  liveness: "liveness",
  error: "tool",
  other: "other",
};

/** 対象テキストと種類を ReplayEventDTO から選ぶ (command > path > tool_name の優先)。 */
function pickTarget(e: ReplayEventDTO): {
  target: string | undefined;
  targetKind: ActionUnit["targetKind"];
} {
  if (e.command) return { target: e.command, targetKind: "command" };
  if (e.path) return { target: e.path, targetKind: "path" };
  if (e.tool_name) return { target: e.tool_name, targetKind: "tool" };
  return { target: undefined, targetKind: undefined };
}

const PERMISSION_REQUESTED = "tool.permission.requested";
const PERMISSION_RESOLVED = "tool.permission.resolved";

const COMMAND_STARTED = "command.started";
const COMMAND_COMPLETED = "command.completed";
const TOOL_FAILED = "tool.failed";

/** command 相関ユニットを構成しうる event_type 集合 (承認集合と交差しない)。 */
const COMMAND_CORRELATED_TYPES = new Set<string>([COMMAND_STARTED, COMMAND_COMPLETED, TOOL_FAILED]);

/**
 * 承認チェーンの構成イベント群から ApprovalChain + 代表フィールドを組む。
 * requested を対象/risk の出所、resolved を decision の出所とする (実 payload に整合)。
 */
function buildApprovalUnit(requestId: string, group: readonly ReplayEventDTO[]): ActionUnit {
  const requested = group.find((e) => e.event_type === PERMISSION_REQUESTED);
  const resolved = group.find((e) => e.event_type === PERMISSION_RESOLVED);

  const status: ApprovalChainStatus = requested
    ? resolved
      ? "resolved"
      : "pending"
    : "orphan_resolved";

  // 対象は requested から (command/tool_name)。orphan resolved は対象不明 (捏造しない)。
  const targetSource = requested ?? group[0]!;
  const { target, targetKind } = pickTarget(targetSource);

  const approval: ApprovalChain = {
    requestId,
    status,
    decision: resolved?.decision,
    riskLevel: requested?.risk_level,
    autoAllowed: requested?.auto_allowed,
  };

  const first = group[0]!;
  const last = group[group.length - 1]!;
  return {
    id: `apr:${requestId}`,
    sessionId: first.session_id,
    kind: "approval",
    target,
    targetKind,
    cwd: requested?.cwd,
    approval,
    commandOutcome: undefined,
    exitCode: undefined,
    elapsedMs: undefined,
    summary: (resolved ?? requested ?? first).display_text,
    eventType: (requested ?? resolved ?? first).event_type,
    startTime: first.timestamp,
    endTime: last.timestamp,
    commandEventId: undefined,
    events: group,
  };
}

/** 単独イベント (相関キー無し) を 1 アクション単位へ写す。 */
function buildStandaloneUnit(e: ReplayEventDTO): ActionUnit {
  const { target, targetKind } = pickTarget(e);
  return {
    id: `ev:${e.event_id}`,
    sessionId: e.session_id,
    kind: KIND_OF_REPLAY[e.kind] ?? "other",
    target,
    targetKind,
    cwd: e.cwd,
    approval: undefined,
    commandOutcome: undefined,
    exitCode: e.exit_code,
    elapsedMs: e.elapsed_ms,
    summary: e.display_text,
    eventType: e.event_type,
    startTime: e.timestamp,
    endTime: e.timestamp,
    commandEventId: e.event_type === COMMAND_STARTED ? e.event_id : undefined,
    events: [e],
  };
}

/** ISO timestamp の差 (ms)。両方が有効な ISO のときのみ数値、それ以外は undefined。 */
function diffMs(startIso: string, endIso: string): number | undefined {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (Number.isNaN(start) || Number.isNaN(end)) return undefined;
  return end - start;
}

/**
 * command 相関グループ (command.started ↔ command.completed / tool.failed・`tu:` 一致) を
 * 1 アクション単位へ畳む。outcome / elapsedMs / exitCode は **実観測由来のみ** (捏造しない):
 *  - commandOutcome: tool.failed 観測 → failed / command.completed 観測 → succeeded /
 *    started のみ → running。
 *  - elapsedMs: DTO elapsed_ms (実観測) を優先。無ければ started と (completed|failed) の
 *    **両方を観測した場合のみ** timestamp 差で算出 (片方欠落で捏造しない)。
 *  - exitCode: completed/failed の exit_code が存在する場合のみ (実 CC は載せない・0 を捏造しない)。
 * orphan (completed/failed のみ・started 欠落) もユニット化するが outcome はイベント由来のみ。
 */
function buildCommandUnit(requestId: string, group: readonly ReplayEventDTO[]): ActionUnit {
  const started = group.find((e) => e.event_type === COMMAND_STARTED);
  const completed = group.find((e) => e.event_type === COMMAND_COMPLETED);
  const failed = group.find((e) => e.event_type === TOOL_FAILED);

  const commandOutcome: CommandOutcome = failed ? "failed" : completed ? "succeeded" : "running";

  const endEvent = failed ?? completed;

  // exit_code は completed/failed に実在する場合のみ (0 を捏造しない)。
  const exitCode = endEvent?.exit_code;

  // elapsed: DTO の実観測値を優先。無ければ started と終端の両方があるときだけ timestamp 差。
  const dtoElapsed = started?.elapsed_ms ?? endEvent?.elapsed_ms;
  const elapsedMs =
    dtoElapsed !== undefined
      ? dtoElapsed
      : started && endEvent
        ? diffMs(started.timestamp, endEvent.timestamp)
        : undefined;

  const { target, targetKind } = pickTarget(started ?? endEvent ?? group[0]!);
  // target は command を最優先 (started?.command ?? completed?.command)。切詰めない。
  const command = started?.command ?? completed?.command ?? failed?.command;

  const first = group[0]!;
  const last = group[group.length - 1]!;
  return {
    id: `cmd:${requestId}`,
    sessionId: first.session_id,
    kind: "command",
    target: command ?? target,
    targetKind: command ? "command" : targetKind,
    cwd: started?.cwd ?? first.cwd,
    approval: undefined,
    commandOutcome,
    exitCode,
    elapsedMs,
    summary: (started ?? endEvent ?? first).display_text,
    eventType: (started ?? endEvent ?? first).event_type,
    startTime: first.timestamp,
    endTime: last.timestamp,
    // stdout pull anchor は started の event_id (実在時のみ)。
    commandEventId: started?.event_id,
    events: group,
  };
}

/**
 * ReplayEventDTO[] (昇順 REPLAY_ORDER) を ActionUnit[] へ畳む純関数。
 *
 * アルゴリズム (決定的・順序安定):
 *  1. 承認イベント (permission.requested/resolved) を `${session_id} ${request_id}` で
 *     グルーピング (承認 Map)。request_id を持たない承認イベントは独立行へ落とす (捏造しない)。
 *  2. command 相関イベント (command.started/completed・tool.failed) を `${session_id}
 *     ${request_id}` で **別 Map** にグルーピング (command Map)。event_type 集合が承認と交差
 *     しないため、承認キーと command キーが byte 同一でも namespace を跨いで畳まれない。
 *  3. 各グループは「グループ内最初のイベントが現れた位置」に 1 ユニットとして配置する
 *     (出力順 = 入力の到達順を保つ)。
 *  4. いずれのグループにも属さないイベントは、その場で単独ユニットとして配置する。
 * cross-session 混入は session_id をキーに含めることで構造的に防止する。
 */
export function foldActionUnits(events: readonly ReplayEventDTO[]): ActionUnit[] {
  // session request_id -> 構成イベント (到達順)。承認と command は **別 Map** (namespace 分離)。
  const approvalGroups = new Map<string, ReplayEventDTO[]>();
  const approvalFirstIndex = new Map<string, number>();
  const commandGroups = new Map<string, ReplayEventDTO[]>();
  const commandFirstIndex = new Map<string, number>();

  const isApprovalType = (t: string): boolean =>
    t === PERMISSION_REQUESTED || t === PERMISSION_RESOLVED;
  const isCommandType = (t: string): boolean => COMMAND_CORRELATED_TYPES.has(t);

  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (!e.request_id) continue;
    const key = `${e.session_id} ${e.request_id}`;
    // ゲートは event_type で判定 (承認集合 / command 集合は交差しない)。
    if (isApprovalType(e.event_type)) {
      let group = approvalGroups.get(key);
      if (!group) {
        group = [];
        approvalGroups.set(key, group);
        approvalFirstIndex.set(key, i);
      }
      group.push(e);
    } else if (isCommandType(e.event_type)) {
      let group = commandGroups.get(key);
      if (!group) {
        group = [];
        commandGroups.set(key, group);
        commandFirstIndex.set(key, i);
      }
      group.push(e);
    }
  }

  const units: ActionUnit[] = [];
  // 各 index で発行すべきグループ種別とキーを記録 (グループ先頭位置でのみ発行・順序安定)。
  const emitApprovalAt = new Map<number, string>();
  for (const [key, idx] of approvalFirstIndex) emitApprovalAt.set(idx, key);
  const emitCommandAt = new Map<number, string>();
  for (const [key, idx] of commandFirstIndex) emitCommandAt.set(idx, key);

  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;

    if (e.request_id && isApprovalType(e.event_type)) {
      // グループの先頭位置でのみ承認ユニットを発行。後続メンバーはスキップ。
      if (emitApprovalAt.get(i) === `${e.session_id} ${e.request_id}`) {
        units.push(buildApprovalUnit(e.request_id, approvalGroups.get(emitApprovalAt.get(i)!)!));
      }
      continue;
    }

    if (e.request_id && isCommandType(e.event_type)) {
      if (emitCommandAt.get(i) === `${e.session_id} ${e.request_id}`) {
        units.push(buildCommandUnit(e.request_id, commandGroups.get(emitCommandAt.get(i)!)!));
      }
      continue;
    }

    // どのグループにも属さないイベント (request_id 無し / 非相関 event_type) = 単独行。
    units.push(buildStandaloneUnit(e));
  }

  return units;
}
