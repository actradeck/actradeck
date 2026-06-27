/**
 * 承認カードの **表示用** 派生 (純関数・状態と表示の分離).
 *
 * ADR 019e9999 段階②。D3「楽観更新しない」を表示側でも徹底する: ボタン押下→approve frame
 * 送信→backend ack(ok/error) を表示するだけで、pending の消滅は backend の delta.detail
 * (resolved 由来) が確定させる。relay 失敗 (ok:false / error) を「許可済み」と誤表示しない。
 *
 * SEC: ここは PendingApproval (backend が redaction 済みで載せた DTO) の値をそのまま見せ方に
 * 落とすだけ。生 tool_input を独自取得しない・新規の秘匿情報を描かない (security.md)。
 */
import { t, type Locale, type MessageKey } from "./i18n/messages";
import { isKnownKind, redactionKindLabelKey } from "./redaction-display";

import type { ClientFrame, PendingApproval, ServerFrame } from "../realtime/contract";

/**
 * UI が送る承認判断 (ADR 019e9999 段階③: 4 値へ拡張)。
 * T1 正典は `@actradeck/event-model` の `ApprovalDecision`
 * (`["allow","allow_for_session","deny","cancel"]`)。UI はこれに **一方向追従** する
 * (逆ドリフト禁止)。
 * - allow              … この 1 回のみ許可。
 * - allow_for_session  … 以降このセッションで **同一署名 (tool+risk+command/path) のみ** 自動許可。
 *                        sidecar が署名一致のみ honor する (過剰 allow しない)。
 * - deny               … この 1 回を拒否。
 * - cancel             … 取消 (sidecar は安全側で deny として honor する)。
 */
export type ApprovalDecision = "allow" | "allow_for_session" | "deny" | "cancel";

/** approve frame の ack を request_id 単位で保持するクライアント状態 1 件分。 */
export interface AckState {
  /** ユーザが送った判断 (送信した方向の表示に使う)。 */
  readonly decision: ApprovalDecision;
  /** ack 受信前は undefined (= 送信中)。受信後は backend の ok。 */
  readonly ok: boolean | undefined;
  /** backend が返した relay 失敗理由 (あれば)。 */
  readonly error: string | undefined;
}

/**
 * 1 枚のカードに表示する ack フェーズ。`pending` は送信前 (未操作)。
 * 段階③ (4 値): 「許可系」「拒否系」を decision の種類で分けて表示する
 * (allow→allowed / allow_for_session→allowed_for_session / deny→denied / cancel→cancelled)。
 */
export type AckPhase =
  | "pending"
  | "sending"
  | "allowed"
  | "allowed_for_session"
  | "denied"
  | "cancelled"
  | "failed";

/**
 * request_id をキーに ack state を引き、当該カードの表示フェーズへ落とす純関数。
 * - 未送信: "pending"
 * - 送信済み・ack 未受信: "sending"
 * - ack ok=false or error: "failed" (D3: relay 失敗を成功と誤表示しない)
 * - ack ok=true: decision に応じ "allowed"/"allowed_for_session"/"denied"/"cancelled"
 */
export function ackPhase(ack: AckState | undefined): AckPhase {
  if (!ack) return "pending";
  if (ack.ok === undefined) return "sending";
  if (ack.ok === false || ack.error !== undefined) return "failed";
  switch (ack.decision) {
    case "allow":
      return "allowed";
    case "allow_for_session":
      return "allowed_for_session";
    case "deny":
      return "denied";
    case "cancel":
      return "cancelled";
  }
}

/** フェーズの人間可読ラベル (観測状態の表示)。既定 locale は ja。 */
export function ackPhaseLabel(phase: AckPhase, locale: Locale = "ja"): string {
  switch (phase) {
    case "pending":
      return t(locale, "approval.phase.pending");
    case "sending":
      return t(locale, "approval.phase.sending");
    case "allowed":
      return t(locale, "approval.phase.allowed");
    case "allowed_for_session":
      return t(locale, "approval.phase.allowedForSession");
    case "denied":
      return t(locale, "approval.phase.denied");
    case "cancelled":
      return t(locale, "approval.phase.cancelled");
    case "failed":
      return t(locale, "approval.phase.failed");
  }
}

/** ボタンを無効化すべきか (送信中 or 確定済みの ok ack は二重送信を防ぐ)。 */
export function ackResolvedOrSending(phase: AckPhase): boolean {
  return (
    phase === "sending" ||
    phase === "allowed" ||
    phase === "allowed_for_session" ||
    phase === "denied" ||
    phase === "cancelled"
  );
}

/** risk_level バッジのトーン (未知/未指定は muted)。表示専用で意味づけは backend が正典。 */
export function riskTone(risk: string | undefined): "high" | "warn" | "ok" | "muted" {
  switch (risk) {
    case "high":
      return "high";
    case "medium":
      return "warn";
    case "low":
      return "ok";
    default:
      return "muted";
  }
}

/**
 * 高リスク承認の allow 系を **明示確認でゲートすべきか** (ADR 019ead14 段階2 /
 * INV-INBOX-HIGHRISK-DENY-DEFAULT)。
 *
 * risk_level=high の pending は「確認なしの誤 allow」を UI 構造で抑止する: allow /
 * allow_for_session は明示的な確認操作なしには押せない一方、deny / cancel は常に直接操作可能
 * (= 安全側既定の操作導線)。medium / low / unknown はゲートしない (過剰フリクション回避)。
 * risk の意味づけは backend が正典 (UI は一方向追従)。
 */
export function allowRequiresAck(risk: string | undefined): boolean {
  return risk === "high";
}

/**
 * カードの主表示テキスト (command(redacted) 優先・無ければ path・どちらも無ければ tool_name)。
 * 生の tool_input は参照しない (backend redaction 済み値のみ)。
 */
export function approvalPrimaryText(a: PendingApproval): string {
  return a.command ?? a.path ?? a.tool_name ?? a.request_id;
}

// ─── 自動ガード理由表示 (ADR 019ecc70 D3 / 下流 019ecc97 申し送り) ──────────────
//
// 承認 pause の **理由** を「観測された作業状態」として表示する純関数群 (単一出所)。
// SessionDetail の承認バナーと Approval Inbox は同一 ApprovalCard を共有するため、
// これらの純関数を ApprovalCard が呼ぶことで Detail / Inbox の表示が必ず一致する。
//
// SEC (INV-REDACTION / INV-AUTOGUARD-NO-RAW の表示版・PR#29 と同方針):
//  - 扱うのは trigger (閉じた enum) と secret_kinds (公開 enum 語彙名) のみ。原文・raw 値は
//    一切扱わない・描かない。
//  - backend/projection が closed-enum 防御済 (未知 trigger / 未知 kind を drop) だが、UI は
//    **最終 sink** として多層防御する: 既知 enum 以外の trigger / kind は raw 文字列を text にも
//    data 属性にも出さず、汎用 (generic) ラベル + 固定 sentinel へ畳む。

/** 承認 pause 理由 (trigger) の語彙。T1 = event-model `ApprovalTrigger` に一方向追従 (逆ドリフト禁止)。 */
const APPROVAL_TRIGGERS: ReadonlySet<string> = new Set(["destructive", "secret", "both"]);

/**
 * trigger 文字列 → 人間可読の理由ラベルキー (純関数・単一出所)。
 *  - "secret"      … 秘匿情報を検出
 *  - "destructive" … 破壊的操作
 *  - "both"        … 両方
 *  - 未設定 / 既知 enum 以外 … null (理由バッジを出さない。raw 文字列は決して表示しない)。
 *
 * 既知 enum 以外を null へ畳むのが no-raw-display 防御の核 (敵対 trigger / deploy skew で
 * 任意文字列が来ても UI に raw を出さない)。
 */
export function approvalTriggerReasonKey(trigger: string | undefined): MessageKey | null {
  switch (trigger) {
    case "secret":
      return "approval.reason.secret";
    case "destructive":
      return "approval.reason.destructive";
    case "both":
      return "approval.reason.both";
    default:
      return null;
  }
}

/** trigger が既知の自動ガード enum か (data 属性へ raw を出さないための判定)。 */
export function isKnownApprovalTrigger(trigger: string | undefined): boolean {
  return trigger !== undefined && APPROVAL_TRIGGERS.has(trigger);
}

/** secret_kinds の 1 要素を表示へ落とした結果 (raw kind 文字列は保持しても **描画時に使わない**)。 */
export interface ApprovalSecretKindView {
  /** 公開 enum (既知) か。false の枝では raw kind を text/属性に一切出さない。 */
  readonly known: boolean;
  /**
   * 表示ラベル。既知 → i18n kind ラベル (例「GitHub トークン」)。
   * 未知 → 汎用ラベル (risk.redaction.unknownKind「その他の秘匿」)。raw kind 文字列は使わない。
   */
  readonly label: string;
  /**
   * data 属性へ出す安全な kind 識別子。既知 → 公開 enum 文字列。未知 → 固定 sentinel "unknown"
   * (PR#29 と同型。raw kind を属性にも入れない)。
   */
  readonly attr: string;
}

/**
 * secret_kinds (公開 enum 語彙名の配列) を表示用ビューへ写像する純関数 (no-raw-display 防御つき)。
 *
 * - 各要素は `isKnownKind` で公開 enum か判定し、既知 → `redactionKindLabelKey` の i18n ラベル、
 *   未知 → 汎用ラベル + sentinel "unknown" へ畳む (raw kind 文字列は text にも属性にも出さない)。
 * - 重複 / 非文字列の防御: 文字列のみ採り、(known,label) で重複排除して安定描画する。
 * - undefined / 空配列 → 空配列 (理由は trigger 側で出る・kind 行は出さない)。
 *
 * redaction-display.ts (PR#29 資産) のラベル/判定を再利用し、RiskPane の内訳表示と単一出所にする。
 */
export function approvalSecretKindViews(
  kinds: readonly string[] | undefined,
  locale: Locale = "ja",
): readonly ApprovalSecretKindView[] {
  if (kinds === undefined) return [];
  const out: ApprovalSecretKindView[] = [];
  const seen = new Set<string>();
  for (const k of kinds) {
    if (typeof k !== "string") continue;
    const known = isKnownKind(k);
    // 既知は公開 enum 名で dedup、未知はすべて同一 sentinel として 1 つに畳む。
    const dedupKey = known ? `k:${k}` : "unknown";
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    out.push({
      known,
      label: known ? t(locale, redactionKindLabelKey(k)) : t(locale, "risk.redaction.unknownKind"),
      attr: known ? k : "unknown",
    });
  }
  return out;
}

/**
 * approve ack を request_id をキーにした AckState Map へ畳み込む純関数 (単一出所)。
 * D3: 送信時 ("送信中"=ok undefined) に立てた decision を保持しつつ ok/error を上書きする。
 * 送信前に届いた ack (理論上稀) は decision 不明 → "deny" 既定で扱い、誤って許可済みにしない。
 * use-realtime の ack 反映と reduce テストがこの 1 経路を共有する。
 */
export function reduceApproveAck(
  prev: ReadonlyMap<string, AckState>,
  ack: { readonly request_id: string; readonly ok: boolean; readonly error: string | undefined },
): ReadonlyMap<string, AckState> {
  const prior = prev.get(ack.request_id);
  const next: AckState = {
    decision: prior?.decision ?? "deny",
    ok: ack.ok,
    error: ack.error,
  };
  const m = new Map(prev);
  m.set(ack.request_id, next);
  return m;
}

/**
 * approve ack を表す ServerFrame(ack) から **承認カードへ反映すべき tuple** を抽出する純関数.
 *
 * QA-1 (action フィルタ glue): lastAck は **approve ack だけ** で動かす。subscribe / unsubscribe /
 * interrupt の ack や、request_id を持たない ack は承認カードに触れてはならない (取り違え防止)。
 * その判定をフック(use-realtime) の中に埋めると node 環境では赤テスト化できないため、ここに抽出し
 * `reduceApproveAck` の唯一の前段フィルタとして単体テストで固定する。
 *
 * 非 null を返す条件 (両方必須):
 *  - `frame.action === "approve"`            … subscribe/unsubscribe/interrupt ack を除外
 *  - `typeof frame.request_id === "string"`  … request_id 欠落 ack を除外 (どのカードか不明)
 * それ以外は `null` (= lastAck を変えない)。
 */
export function ackFromServerFrame(frame: Extract<ServerFrame, { type: "ack" }>): {
  readonly request_id: string;
  readonly ok: boolean;
  readonly error: string | undefined;
} | null {
  if (frame.action !== "approve") return null;
  if (typeof frame.request_id !== "string") return null;
  return { request_id: frame.request_id, ok: frame.ok, error: frame.error };
}

/** 承認送信時に "送信中" (ok undefined) を立てる純関数 (D3: pending を消さない)。 */
export function markApproveSending(
  prev: ReadonlyMap<string, AckState>,
  requestId: string,
  decision: ApprovalDecision,
): ReadonlyMap<string, AckState> {
  const m = new Map(prev);
  m.set(requestId, { decision, ok: undefined, error: undefined });
  return m;
}

/**
 * approve ClientFrame の **単一出所ビルダー** (T1: ClientFrame に追従)。
 * use-realtime.approve と送信テストが同じ構築経路を共有し、frame 形のドリフトを防ぐ。
 * reason は undefined のときキーごと落とす (任意フィールド)。
 */
export function buildApproveFrame(
  sessionId: string,
  requestId: string,
  decision: ApprovalDecision,
  reason?: string,
  persist?: boolean,
): Extract<ClientFrame, { type: "approve" }> {
  return {
    type: "approve",
    session_id: sessionId,
    request_id: requestId,
    decision,
    ...(reason !== undefined ? { reason } : {}),
    // ADR 019ee0c0: persist=true (再起動後も許可) のときのみ載せる。sidecar が最終 eligibility 判定。
    ...(persist === true ? { persist: true } : {}),
  };
}

/**
 * 承認の **推定残り時間** (ms) を返す純関数 (ADR 019e9999 段階③ timeout UX)。
 *
 * ⚠️ 重要 (誤認防止): UI は sidecar の **実 timeout を知らない**。pending には要求時刻
 * (`requested_at`) しか載らないため、sidecar 既定 ~30s を **推定値** として引くだけである。
 * 実際の自動拒否は sidecar 側 (承認ブリッジ) が確定させ、その結果は delta.detail (pending 消滅)
 * として届く。本関数の戻り値は「安全側の目安」であって締め切りの保証ではない。
 *
 * - `requestedAtIso` が不正/空なら NaN を避け、推定不能として `timeoutMs` (満額) を返す
 *   (=「まだ猶予あり」と安全側に倒す。突然 0 表示でユーザを慌てさせない)。
 * - 残りは 0 未満にクランプ (経過後は 0)。
 */
export function approvalTimeRemainingMs(
  requestedAtIso: string,
  nowMs: number,
  timeoutMs = 30_000,
): number {
  const requestedMs = Date.parse(requestedAtIso);
  if (Number.isNaN(requestedMs)) return timeoutMs;
  const remaining = requestedMs + timeoutMs - nowMs;
  return remaining > 0 ? remaining : 0;
}

/**
 * interrupt ボタンを **出してよい state か** (ADR 019e9999 段階③ / 段階② QA-2 配線)。
 *
 * D5: interrupt は managed claude への SIGINT 協調停止であり「実行中ツールの巻き戻し」ではない。
 * terminal (completed/failed/interrupted) では無意味なので false。それ以外の非 terminal
 * (live / running.x / waiting.x / compacting / starting / stalled / idle 等) では sidecar が
 * 安全に処理 (managed でなければ no-op) するため true。state 不明 (undefined) は安全側で false。
 *
 * 注: `@actradeck/event-model` の `isTerminalState` は `State` 型を要求するが detail.state は
 * `string | undefined` のため、ここでは UI ローカルに terminal 集合を当てて判定する
 * (T1 の TERMINAL_STATES = completed/failed/interrupted に追従)。
 */
const TERMINAL_STATE_NAMES: ReadonlySet<string> = new Set(["completed", "failed", "interrupted"]);

export function interruptEnabledForState(state: string | undefined): boolean {
  if (state === undefined) return false;
  return !TERMINAL_STATE_NAMES.has(state);
}
