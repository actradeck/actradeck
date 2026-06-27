/**
 * アクション単位の **表示用** 派生 (純関数・設計裁定 019eb981).
 *
 * 行文法 `[時刻] [対象] [行為] [結果]` の各パートと「トーン」をここで決める。
 * foldActionUnits (データ畳み込み) と分離し、状態と表示を分ける (current-action-display と同方針)。
 *
 * トーン規律 (ユーザー要望):
 *  - 解決済み承認は「承認待ち」と読めない表現にしトーンを落とす (例: 「承認 → 許可 (13s)」)。
 *  - 未解決承認のみ警告トーン。
 *  - exit 0 は静かに (neutral)、非 0 は danger。
 *
 * SEC: ActionUnit の allow-list フィールドのみ参照 (生 payload 経路を作らない)。
 */
import { t, type Locale, type MessageKey } from "./i18n/messages";

import type { ActionUnit, ActionKind } from "./action-units";

/** 行・タグのトーン (kit Tag の Tone サブセット + 行ハイライト用)。 */
export type ActionTone = "neutral" | "info" | "success" | "warn" | "danger" | "muted";

/** 行為ラベル (述語) の表示。承認は解決状態でトーンと文言を変える。 */
export interface ActionVerb {
  readonly label: string;
  readonly tone: ActionTone;
}

/** 結果チップの表示 (exit code / decision / elapsed)。無い場合は undefined。 */
export interface ActionResult {
  readonly label: string;
  readonly tone: ActionTone;
}

/** 経過 ms を人間可読へ (s / ms)。 */
export function formatElapsed(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}

/** ISO timestamp の時刻部 (HH:MM:SS)。 */
export function formatClock(iso: string): string {
  // ISO 形式前提 (`2026-06-12T01:46:36.500Z`)。non-ISO は素通し (壊さない)。
  return iso.length >= 19 && iso[10] === "T" ? iso.slice(11, 19) : iso;
}

/**
 * 行為 (述語) を決める。承認チェーンは解決状態でトーンを変える:
 *  - resolved → 「承認 → {decision}」neutral/success (= 過去形・"承認待ち" と読ませない)。
 *  - pending  → 「承認待ち」warn (= 未解決のみ警告)。
 *  - orphan_resolved → 「承認 (履歴)」muted。
 */
/**
 * ActionKind → 述語の i18n キーの **単一写像** (DRY・ドリフト防止・ADR 019eeac6 / TDA 指摘)。
 *
 * `actionVerb()`(timeline) と `formatCurrentAction()`(current-action) の両方がこの写像を共有し、
 * kind→述語のドリフトを構造的に防ぐ。**approval は単一トーンの述語キー** (`action.verb.approvalPending`)
 * を返す: timeline の pending/resolved/orphan トーン分岐 (`actionVerb` 内) は timeline 専用で、
 * current_action へは持ち込まない (current_action は「今この瞬間の承認待ち」を 1 トーンで示す)。
 * `other` だけは固定文言を持たない (timeline は raw event_type を出す) ため undefined を返し、
 * 呼び元が fallback (eventType / current_action / state) を選ぶ。
 */
export function actionVerbKey(kind: ActionKind): MessageKey | undefined {
  switch (kind) {
    case "approval":
      return "action.verb.approvalPending";
    case "command":
      return "action.verb.command";
    case "file":
      return "action.verb.file";
    case "tool":
      return "action.verb.tool";
    case "mcp":
      return "action.verb.mcp";
    case "web":
      return "action.verb.web";
    case "turn":
      return "action.verb.turn";
    case "session":
      return "action.verb.session";
    case "message":
      return "action.verb.message";
    case "liveness":
      return "action.verb.liveness";
    case "other":
      return undefined;
  }
}

/** kind → timeline 行のトーン (非承認分岐のみ・承認は actionVerb 内で解決状態別に決める)。 */
const VERB_TONE: Record<Exclude<ActionKind, "approval">, ActionTone> = {
  command: "neutral",
  file: "info",
  tool: "neutral",
  mcp: "info",
  web: "warn",
  turn: "muted",
  session: "muted",
  message: "muted",
  liveness: "muted",
  other: "muted",
};

export function actionVerb(unit: ActionUnit, locale: Locale = "ja"): ActionVerb {
  if (unit.kind === "approval" && unit.approval) {
    const a = unit.approval;
    if (a.status === "pending") {
      return { label: t(locale, "action.verb.approvalPending"), tone: "warn" };
    }
    if (a.status === "orphan_resolved") {
      return { label: t(locale, "action.verb.approvalHistory"), tone: "muted" };
    }
    // resolved: decision を後置 (許可/拒否)。auto_allowed は別チップで補足。
    const decision = a.decision
      ? decisionLabel(a.decision, locale)
      : t(locale, "action.decision.unknown");
    return {
      label: t(locale, "action.verb.approvalResolved", { decision }),
      tone: a.decision === "deny" ? "danger" : "success",
    };
  }

  // 非承認 (approval 以外) は kind→key の単一写像 + VERB_TONE を共有する。
  // approval の解決状態分岐は上で処理済みなのでここで approval は除外される。
  const kind = unit.kind;
  if (kind === "approval") {
    // approval なのに unit.approval が欠落 (実観測では発生しないが型安全のため)。
    return { label: t(locale, "action.verb.approvalPending"), tone: "muted" };
  }
  const key = actionVerbKey(kind);
  if (key === undefined) {
    // other (固定文言なし) は raw event_type を出す (従来挙動を保持)。
    return { label: unit.eventType, tone: "muted" };
  }
  return { label: t(locale, key), tone: VERB_TONE[kind] };
}

/**
 * replay 行 / replay current_action で `formatCurrentAction` が受ける kind。
 *
 * replay の `ReplayEventKind` は `ActionKind ∪ {"error"}` (T1: replay-contract)。`error` は
 * `ActionKind` に無く `actionVerbKey` の switch は受けないため、replay 経路ではこの広い型で受け、
 * `error` を `action.verb.error` 述語へ写す (cockpit 経路の `actionVerbKey(ActionKind)` 契約は不変)。
 */
export type ReplayDisplayKind = ActionKind | "error";

/**
 * `formatCurrentAction` 用 kind→述語キー写像 (replay の `error` を吸収する薄い拡張)。
 *  - `error` → `action.verb.error` (replay 専用・semantically「エラー」/「Error」)。
 *  - それ以外 → `actionVerbKey(ActionKind)` を共有 (kind→述語のドリフトを構造的に防ぐ・DRY)。
 */
function displayVerbKey(kind: ReplayDisplayKind): MessageKey | undefined {
  return kind === "error" ? "action.verb.error" : actionVerbKey(kind);
}

/**
 * current_action (セッション一覧/詳細の「現在のアクション要約」) を **表示時ローカライズ** する純関数
 * (ADR 019eeac6・INV-CURRENT-ACTION-I18N / INV-CURRENT-ACTION-FALLBACK)。
 *
 * 根因: normalizer が `event.summary` に日本語固定文字列を焼き込み、それが current_action として
 * DTO→UI へ素通しされるため UI を英語にしても要約が日本語のまま残る。対策: 保存は言語非依存にし、
 * 表示する瞬間に viewer の locale で述語を組み立てる。
 *
 * 写像:
 *  1. `kind` があれば `actionVerbKey(kind)` で **述語** を引く (actionVerb と同一写像を共有・DRY)。
 *     `subject` があれば「述語: subject」を組む (`action.currentAction.withSubject` テンプレート)。
 *     subject 欠落 → 述語のみ。kind=other (述語なし) は kind を無視して fallback へ落とす。
 *  2. `kind` 欠落 (legacy 行・旧 DTO) → `fallback` (= current_action legacy summary 文字列)。
 *  3. すべて欠落 → undefined を返し、最終段 (state→dash) は呼び元の既存 UI チェーンに委ねる。
 *
 * subject は backend で redaction-clean な構造値 (command/path/server/tool/query/tool_name/reason
 * 由来・secret は redaction marker 化済) のため、ここでの追加 redaction は不要 (security.md)。
 */
export function formatCurrentAction(
  input: {
    readonly kind?: ReplayDisplayKind;
    readonly subject?: string;
    readonly fallback?: string;
  },
  locale: Locale = "ja",
): string | undefined {
  const key = input.kind !== undefined ? displayVerbKey(input.kind) : undefined;
  if (key !== undefined) {
    const verb = t(locale, key);
    const subject = input.subject?.trim();
    return subject ? t(locale, "action.currentAction.withSubject", { verb, subject }) : verb;
  }
  // kind 欠落 / kind=other (述語なし) → legacy summary 文字列へ fallback。
  // それも無ければ undefined (state→dash は呼び元の既存チェーンが担う)。
  return input.fallback;
}

/** decision コードを表示ラベルへ (allow/deny/...)。 */
export function decisionLabel(decision: string, locale: Locale = "ja"): string {
  switch (decision) {
    case "allow":
      return t(locale, "action.decision.allow");
    case "deny":
      return t(locale, "action.decision.deny");
    default:
      return decision;
  }
}

/**
 * 結果チップを決める。exit 0 は静か (neutral)、非 0 は danger。
 * 承認の decision は actionVerb 側で表現するためここでは扱わない。
 */
export function actionResult(unit: ActionUnit, locale: Locale = "ja"): ActionResult | undefined {
  if (unit.exitCode !== undefined) {
    return {
      label: t(locale, "action.result.exit", { code: unit.exitCode }),
      tone: unit.exitCode === 0 ? "neutral" : "danger",
    };
  }
  return undefined;
}

/**
 * command 相関ユニットの成功/失敗/実行中バッジ (トーン付き)。command 相関ユニット
 * (commandOutcome 定義済み) のときのみ返す。それ以外は undefined (バッジを出さない)。
 *  - succeeded → success トーン「成功」。
 *  - failed    → danger トーン「失敗」。
 *  - running   → info トーン「実行中」(停止を断定しない・観測された作業状態のみ)。
 */
export function commandOutcomeBadge(
  unit: ActionUnit,
  locale: Locale = "ja",
): ActionResult | undefined {
  switch (unit.commandOutcome) {
    case "succeeded":
      return { label: t(locale, "action.outcome.succeeded"), tone: "success" };
    case "failed":
      return { label: t(locale, "action.outcome.failed"), tone: "danger" };
    case "running":
      return { label: t(locale, "action.outcome.running"), tone: "info" };
    default:
      return undefined;
  }
}

/** 承認の auto_allowed を補足チップにするか (true のときのみ「自動許可」)。 */
export function autoAllowedLabel(unit: ActionUnit, locale: Locale = "ja"): string | undefined {
  if (unit.kind === "approval" && unit.approval?.autoAllowed === true) {
    return t(locale, "action.autoAllowed");
  }
  return undefined;
}

/** risk_level チップのトーン。 */
export function riskTone(risk: string | undefined): ActionTone {
  switch (risk) {
    case "high":
      return "danger";
    case "medium":
      return "warn";
    case "low":
      return "info";
    default:
      return "muted";
  }
}

/**
 * 行が「未解決の介入待ち」か (呼び元が行を強調表示するための 1 bool)。
 * 解決済み承認・通常行は false (= 警告トーンにしない)。
 */
export function isUnresolvedAttention(unit: ActionUnit): boolean {
  return unit.kind === "approval" && unit.approval?.status === "pending";
}
