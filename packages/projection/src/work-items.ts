/**
 * Work-items 純 fold (ADR 0015 evidence-based completion・§D4).
 *
 * session_state reducer (index.ts) とは **独立した直交 fold** (§D1: work item は state 機械を動かさない)。
 * backend の増分投影 (`work_items` テーブル・A2 で配線) と webui の client-side fold が同一関数を共有し、
 * 保存済み (redacted・append-only) イベント列から決定的に再構築できる (INV-WORKITEMS-FOLD-PARITY)。
 *
 * ⚠️ **参照契約 (TDA-6)**: fold は item を **値変化時に必ず新しいオブジェクト参照で返す** (不変 item は
 *    同一参照を保つ)。backend 増分 upsert はこの「参照が変わった = 値が変わった」を diff 条件に使うため、
 *    既存 item を **in-place mutate してはならない** (mutate すると変化が参照 diff から漏れ under-upsert する)。
 *
 * ## 対象イベント (それ以外は zero-cost skip)
 * - `work.item.updated`   : declared-id (task scheme) の per-item 観測。
 * - `turn.plan.updated`   : plan snapshot (plan scheme・absent → removed 調停・§D3)。
 * - `command.started`     : check_kind 有 → in-flight check を開き run_dirty 判定の起点にする (§D5)。
 * - `command.completed`   : check_kind + 既知 exit → session-global 束縛で検証遷移 (§D5/§D6)。
 * - `diff.updated`        : tree fingerprint 変化 → passed を stale 化 + in-flight check を dirty 化。
 * - terminal (session.ended / terminal state 保持イベント) : freeze (end-of-run 真実を保存・§D4)。
 *
 * ## claim / verification 規則 (§D5)
 * - **CompletionClaim** = item が初めて `completed` へ遷移した観測。level-based ゆえ at-least-once /
 *   CC dual-source (PostToolUse + TaskCompleted hook) でも **1 claim** に畳む (冪等)。`claimed_at` は
 *   初観測、`claim_method/fidelity` は観測した最高 fidelity へ昇格。
 * - **reopen** (completed → 非 completed) で claim & 検証を撤回 (`unverified` へ戻す・行は現在値)。
 * - **永続 verified boolean を作らない**: `passed` は `verified_tree_fp` 相対、fingerprint 変化で `stale`。
 */
import {
  CheckKind,
  CheckMatch,
  ObservationFidelity,
  ObservationMethod,
  coerceWorkItemStatus,
  deriveWorkItemId,
  isTerminalStateValue,
  toEpochMs,
  treeFingerprint,
  type NormalizedEvent,
  type ObservationFidelity as ObservationFidelityT,
  type VerificationState,
  type WorkItemIdScheme,
  type WorkItemStatus,
} from "@actradeck/event-model";

import { boundTurnSummary } from "./index.js";

/** 1 セッションあたりの work item 上限 (DoS 境界・MAX_PENDING_APPROVALS 前例)。超過は drop + count。 */
export const MAX_WORK_ITEMS = 200;

/**
 * fold が反応する event_type の**正準集合** (§D4・TDA-A2-7 単一出所)。
 *
 * `applyWorkItemsEvent` の switch が反応する 5 種 + 明示 terminal event_type `session.ended` (freeze)。
 * backend の増分投影 gate (`isWorkItemFoldEvent`) と rebuild SELECT の WHERE はこの配列を **import して
 * 共有**する (手書き複製しない = 反応 case 追加時の gate 更新漏れによる silent under-count を構造的に防ぐ)。
 * terminal *state 値* (isTerminalStateValue) による freeze は event_type 非依存ゆえ本集合と直交し、backend
 * 側で `|| isTerminalStateValue(ev.state)` と OR 合成する。
 *
 * ⚠️ 本集合と switch の乖離 (反応 case を足して本配列を忘れる) は INV-WORKITEM-REACTIVE-SET-COMPLETE
 *    (packages/projection/src/inv-work-items-reactive-set.test.ts) が全 EventType 走査で回帰固定する。
 */
export const WORK_ITEM_REACTIVE_EVENT_TYPES: readonly string[] = [
  "work.item.updated",
  "turn.plan.updated",
  "command.started",
  "command.completed",
  "diff.updated",
  "session.ended",
];

/**
 * work_items テーブル 1 行に対応する投影値 (§D4)。`description` は投影しない (leak/bloat trim・
 * redacted event が保持し UI detail が timeline から読む)。
 */
export interface WorkItem {
  readonly session_id: string;
  readonly work_item_id: string;
  readonly id_scheme: WorkItemIdScheme;
  readonly subject: string | undefined;
  readonly status: WorkItemStatus;
  readonly ordinal: number | undefined;
  readonly created_at: string | undefined;
  readonly created_event_id: string | undefined;
  readonly claimed_at: string | undefined;
  readonly claim_event_id: string | undefined;
  readonly claim_method: string | undefined;
  readonly claim_fidelity: string | undefined;
  readonly verification_state: VerificationState;
  readonly verified_at: string | undefined;
  readonly verification_event_id: string | undefined;
  readonly check_kind: string | undefined;
  readonly check_match: string | undefined;
  readonly check_exit_code: number | undefined;
  readonly verified_tree_fp: string | undefined;
  readonly run_dirty: boolean;
  readonly stale_at: string | undefined;
  readonly stale_event_id: string | undefined;
  readonly updated_at: string;
}

/** in-flight check (command.started〜completed 間)。fingerprint 変化を挟んだら `dirtied`。 */
interface PendingCheck {
  readonly request_id: string;
  readonly dirtied: boolean;
}

/**
 * work-items fold の状態。`items` が主出力 (テーブル行相当)。`tree_fp` / `pending_checks` は
 * 検証遷移を導出する **transient な fold 状態** (A2 は resume 戦略として events からの再 fold か
 * これらの永続かを選ぶ — 本 slice は純 fold のみ)。
 */
export interface WorkItemsProjection {
  readonly session_id: string;
  readonly items: readonly WorkItem[];
  /** MAX_WORK_ITEMS 超過で drop した新規 item 数 (observable・honest)。 */
  readonly dropped_count: number;
  /** terminal 到達で凍結 (以後の mutation を無視し end-of-run 真実を保存)。 */
  readonly frozen: boolean;
  readonly tree_fp: string | undefined;
  readonly pending_checks: readonly PendingCheck[];
}

export function initialWorkItemsProjection(sessionId: string): WorkItemsProjection {
  return {
    session_id: sessionId,
    items: [],
    dropped_count: 0,
    frozen: false,
    tree_fp: undefined,
    pending_checks: [],
  };
}

/** UI バッジ (§D8・4 状態)。non-completed / waived は undefined (バッジ非表示)。 */
export type WorkItemBadge =
  | "self_claimed"
  | "verified"
  | "verification_failed"
  | "changed_after_verification";

/**
 * item → バッジの**単一正準導出** (§D8)。webui はこれを import し locale 文字列へ写す (日本語を焼き込まない)。
 * completed のみバッジ対象。verification_state で 4 状態へ分岐する。
 */
export function deriveWorkItemBadge(item: WorkItem): WorkItemBadge | undefined {
  if (item.status !== "completed") return undefined;
  switch (item.verification_state) {
    case "unverified":
      return "self_claimed";
    case "passed":
      return "verified";
    case "failed":
      return "verification_failed";
    case "stale":
      return "changed_after_verification";
    default:
      return undefined; // waived (P1 予約) 等
  }
}

// --- 内部ヘルパ (closed-enum gate・NO-RAW) -------------------------------

function payloadValue(payload: unknown, key: string): unknown {
  if (typeof payload !== "object" || payload === null) return undefined;
  return (payload as Record<string, unknown>)[key];
}

function payloadString(payload: unknown, key: string): string | undefined {
  const v = payloadValue(payload, key);
  return typeof v === "string" ? v : undefined;
}

// WorkItemStatus の closed-enum gate は event-model の正準 `coerceWorkItemStatus` を使う
// (TDA-B2-1: sidecar 3 normalizer と手書きコピーを共有・単一出所。未知/非文字列は "unknown")。

function gateCheckKind(v: unknown): string | undefined {
  const r = CheckKind.safeParse(v);
  return r.success ? r.data : undefined;
}

function gateCheckMatch(v: unknown): string | undefined {
  const r = CheckMatch.safeParse(v);
  return r.success ? r.data : undefined;
}

/** ObservationStamp の method/fidelity を closed-enum で gate (unknown/enum 外は undefined = 証拠なし)。 */
function gateObservation(v: unknown): { method: string | undefined; fidelity: string | undefined } {
  if (typeof v !== "object" || v === null) return { method: undefined, fidelity: undefined };
  const o = v as Record<string, unknown>;
  const m = ObservationMethod.safeParse(o.method);
  const f = ObservationFidelity.safeParse(o.fidelity);
  return {
    method: m.success ? m.data : undefined,
    fidelity: f.success ? f.data : undefined,
  };
}

/** fidelity の順位 (§D5 claim 昇格用)。undefined/未知は最下位。 */
const FIDELITY_RANK: Readonly<Record<ObservationFidelityT, number>> = {
  authoritative: 4,
  observed: 3,
  parsed: 2,
  inferred: 1,
  unknown: 0,
};

function fidelityRank(f: string | undefined): number {
  return f !== undefined && f in FIDELITY_RANK ? FIDELITY_RANK[f as ObservationFidelityT] : -1;
}

function findItem(items: readonly WorkItem[], id: string): WorkItem | undefined {
  return items.find((it) => it.work_item_id === id);
}

function replaceItem(items: readonly WorkItem[], next: WorkItem): readonly WorkItem[] {
  return items.map((it) => (it.work_item_id === next.work_item_id ? next : it));
}

/** claim / 検証フィールドを全て初期化した「非 claim」状態 (新規 non-completed / reopen / removal で共有)。 */
const CLEARED_CLAIM = {
  claimed_at: undefined,
  claim_event_id: undefined,
  claim_method: undefined,
  claim_fidelity: undefined,
  verification_state: "unverified" as VerificationState,
  verified_at: undefined,
  verification_event_id: undefined,
  check_kind: undefined,
  check_match: undefined,
  check_exit_code: undefined,
  verified_tree_fp: undefined,
  run_dirty: false,
  stale_at: undefined,
  stale_event_id: undefined,
} as const;

interface Upsert {
  readonly id: string;
  readonly id_scheme: WorkItemIdScheme;
  readonly status: WorkItemStatus;
  readonly subject: string | undefined;
  readonly ordinal: number | undefined;
  readonly method: string | undefined;
  readonly fidelity: string | undefined;
}

/**
 * item の upsert + claim/reopen 遷移 (§D5)。work.item.updated と plan item が共有する単一実装。
 * 新規 completed は claim を張り、既存の completed↔非 completed 遷移で claim を張る/撤回する。
 */
function upsertItem(
  prev: WorkItemsProjection,
  u: Upsert,
  ev: NormalizedEvent,
): WorkItemsProjection {
  const now = ev.timestamp;
  const existing = findItem(prev.items, u.id);

  if (existing === undefined) {
    // 新規 item — MAX 上限 (超過は drop + count・既存 item の更新は上限に数えない)。
    if (prev.items.length >= MAX_WORK_ITEMS) {
      return { ...prev, dropped_count: prev.dropped_count + 1 };
    }
    const claimed = u.status === "completed";
    const item: WorkItem = {
      session_id: ev.session_id,
      work_item_id: u.id,
      id_scheme: u.id_scheme,
      subject: u.subject,
      status: u.status,
      ordinal: u.ordinal,
      created_at: now,
      created_event_id: ev.event_id,
      ...CLEARED_CLAIM,
      claimed_at: claimed ? now : undefined,
      claim_event_id: claimed ? ev.event_id : undefined,
      claim_method: claimed ? u.method : undefined,
      claim_fidelity: claimed ? u.fidelity : undefined,
      updated_at: now,
    };
    return { ...prev, items: [...prev.items, item] };
  }

  let next: WorkItem = { ...existing, status: u.status, updated_at: now };
  // subject / ordinal は新しい観測が値を持つときだけ更新 (欠落で既存を消さない)。
  if (u.subject !== undefined) next = { ...next, subject: u.subject };
  if (u.ordinal !== undefined) next = { ...next, ordinal: u.ordinal };

  const wasCompleted = existing.status === "completed";
  const nowCompleted = u.status === "completed";

  if (nowCompleted && !wasCompleted) {
    // 新 claim (初 completed または撤回後の再 claim)。claimed_at は初観測 (撤回で消えていれば now)。
    next = {
      ...next,
      claimed_at: existing.claimed_at ?? now,
      claim_event_id: ev.event_id,
      claim_method: u.method,
      claim_fidelity: u.fidelity,
      verification_state: "unverified",
    };
  } else if (nowCompleted && wasCompleted) {
    // 冪等な再観測: claimed_at 維持・fidelity は最高観測へ昇格 (CC dual-source・§D5)。
    if (fidelityRank(u.fidelity) > fidelityRank(existing.claim_fidelity)) {
      next = { ...next, claim_method: u.method, claim_fidelity: u.fidelity };
    }
  } else if (!nowCompleted && wasCompleted) {
    // reopen: claim & 検証を撤回し unverified へ (events は履歴を保持・行は現在値)。
    next = { ...next, ...CLEARED_CLAIM };
  }

  return { ...prev, items: replaceItem(prev.items, next) };
}

function applyWorkItemUpdated(prev: WorkItemsProjection, ev: NormalizedEvent): WorkItemsProjection {
  const providerTaskId = payloadString(ev.payload, "provider_task_id");
  if (providerTaskId === undefined) return prev; // 同定不能 → skip。
  const obs = gateObservation(payloadValue(ev.payload, "observation"));
  return upsertItem(
    prev,
    {
      id: deriveWorkItemId("task", providerTaskId),
      id_scheme: "task",
      status: coerceWorkItemStatus(payloadValue(ev.payload, "status")),
      subject: boundTurnSummary(payloadString(ev.payload, "subject")),
      ordinal: undefined,
      method: obs.method,
      fidelity: obs.fidelity,
    },
    ev,
  );
}

function applyPlanSnapshot(prev: WorkItemsProjection, ev: NormalizedEvent): WorkItemsProjection {
  const items = payloadValue(ev.payload, "items");
  if (!Array.isArray(items)) return prev; // typed items 無し (legacy steps のみ) → skip。

  let proj = prev;
  const seen = new Set<string>();
  for (let i = 0; i < items.length; i++) {
    const raw = items[i];
    if (typeof raw !== "object" || raw === null) continue;
    const step = payloadString(raw, "step");
    if (step === undefined) continue;
    const id = deriveWorkItemId("plan", step);
    seen.add(id); // 重複 step は同一 id へ collapse (last occurrence の status/ordinal 勝ち・§D3)。
    proj = upsertItem(
      proj,
      {
        id,
        id_scheme: "plan",
        status: coerceWorkItemStatus(payloadValue(raw, "status")),
        subject: boundTurnSummary(step),
        ordinal: i,
        method: undefined,
        fidelity: undefined,
      },
      ev,
    );
  }

  // snapshot 調停: plan-scheme で以前見たが今回 snapshot に無い item → `removed` (inferred・§D3)。
  // TDA-3 (removed 意味論・裁定): removal は **claim/verification フィールドを保持**する
  //   (歴史的アーカイブ・撤回しない)。status だけを removed へ落とし、claimed_at / verification_state 等は
  //   温存する。撤回するのは **reopen** (completed → 能動再作業) のみ (upsertItem の該当分岐)。
  //   badge は status gate ゆえ非表示になるが、履歴 (「消える前は passed だった」) は失わない。
  //   removed→再出現時は upsertItem が既存行を更新し claimed_at を継承する (新規作成しない)。
  let changed = false;
  const reconciled = proj.items.map((it) => {
    if (it.id_scheme === "plan" && it.status !== "removed" && !seen.has(it.work_item_id)) {
      changed = true;
      return { ...it, status: "removed" as WorkItemStatus, updated_at: ev.timestamp };
    }
    return it;
  });
  return changed ? { ...proj, items: reconciled } : proj;
}

function applyCommandStarted(prev: WorkItemsProjection, ev: NormalizedEvent): WorkItemsProjection {
  if (gateCheckKind(payloadValue(ev.payload, "check_kind")) === undefined) return prev;
  const reqId = payloadString(ev.payload, "request_id");
  if (reqId === undefined) return prev; // 相関キー無し → run_dirty 追跡不能 (completion 側で束縛は可)。
  const pending = [
    ...prev.pending_checks.filter((p) => p.request_id !== reqId),
    { request_id: reqId, dirtied: false },
  ];
  return { ...prev, pending_checks: pending };
}

function applyDiffUpdated(prev: WorkItemsProjection, ev: NormalizedEvent): WorkItemsProjection {
  const fp = treeFingerprint(
    payloadString(ev.payload, "head_sha"),
    payloadString(ev.payload, "diff_hash"),
  );
  if (fp === undefined || fp === prev.tree_fp) return prev; // fingerprint 不変 → no-op。

  // in-flight check を dirty 化 (§D5 run_dirty: check の start〜completed 間に tree が動いた)。
  const pending = prev.pending_checks.map((p) => (p.dirtied ? p : { ...p, dirtied: true }));

  // passed を stale 化 (§D5 INV-VERIFICATION-STALE: 永久 verified を作らない)。
  const items = prev.items.map((it) => {
    if (
      it.status === "completed" &&
      it.verification_state === "passed" &&
      it.verified_tree_fp !== fp
    ) {
      return {
        ...it,
        verification_state: "stale" as VerificationState,
        stale_at: ev.timestamp,
        stale_event_id: ev.event_id,
        updated_at: ev.timestamp,
      };
    }
    return it;
  });

  return { ...prev, tree_fp: fp, pending_checks: pending, items };
}

function applyCommandCompleted(
  prev: WorkItemsProjection,
  ev: NormalizedEvent,
): WorkItemsProjection {
  const checkKind = gateCheckKind(payloadValue(ev.payload, "check_kind"));
  if (checkKind === undefined) return prev; // チェックでない command → skip。

  const reqId = payloadString(ev.payload, "request_id");
  const pc =
    reqId !== undefined ? prev.pending_checks.find((p) => p.request_id === reqId) : undefined;
  const runDirty = pc?.dirtied ?? false;
  const pending =
    reqId !== undefined
      ? prev.pending_checks.filter((p) => p.request_id !== reqId)
      : prev.pending_checks;

  const exit = payloadValue(ev.payload, "exit_code");
  if (typeof exit !== "number" || !Number.isInteger(exit)) {
    // exit 抽出不能 → チェックは観測したが結果不明 → verification_state を **動かさない** (§D6・受入12)。
    return { ...prev, pending_checks: pending };
  }

  const checkMatch = gateCheckMatch(payloadValue(ev.payload, "check_match"));
  const newState: VerificationState = exit === 0 ? "passed" : "failed";
  const completedAt = ev.timestamp;
  const completedMs = toEpochMs(completedAt);
  const fp = prev.tree_fp;

  // TDA-1 (fingerprint 基盤ガード・非対称): `passed` は tree fingerprint 相対の**正の主張**ゆえ
  //   基盤 (tree_fp) が無い状態では成立させない (exit 欠落と同じ「基盤なしに verification を動かさない」
  //   §D6 前例)。`failed` (exit≠0) は基盤が無くても**安全方向の警報**ゆえ許可する — この非対称は原理的
  //   (verified は指紋に紐づく主張・failed は指紋に依存しない事実)。fp 無し passed check は observed だが
  //   verification_state を一切動かさない (unverified 維持)。
  if (newState === "passed" && fp === undefined) {
    return { ...prev, pending_checks: pending };
  }

  // session-global 束縛 (§D5): completed かつ claimed_at ≤ check 完了時刻の全 item を束縛する。
  //   per-item selective binding は観測から不可知ゆえ捏造しない (最新 check が item ごとに勝つ)。
  const items = prev.items.map((it) => {
    if (it.status !== "completed" || it.claimed_at === undefined) return it;
    if (toEpochMs(it.claimed_at) > completedMs) return it; // check より後の claim は束縛しない。
    return {
      ...it,
      verification_state: newState,
      verified_at: completedAt,
      verification_event_id: ev.event_id,
      check_kind: checkKind,
      check_match: checkMatch,
      check_exit_code: exit,
      verified_tree_fp: fp,
      run_dirty: runDirty,
      // 再検証で stale をクリア (passed|failed|stale → passed|failed・§D5)。
      stale_at: undefined,
      stale_event_id: undefined,
      updated_at: completedAt,
    };
  });

  return { ...prev, pending_checks: pending, items };
}

/**
 * 1 イベントを work-items fold へ適用する純関数 (§D4)。terminal freeze を最優先で判定し、
 * frozen 後は一切 mutate しない (post-terminal イベントで end-of-run 真実を壊さない・受入15)。
 */
export function applyWorkItemsEvent(
  prev: WorkItemsProjection,
  ev: NormalizedEvent,
): WorkItemsProjection {
  if (prev.frozen) return prev;

  // terminal freeze (§D4): session.ended か terminal state を帯びるイベントで凍結。self-contained
  //   ルール (session reducer の遷移検証に依存しない)。凍結イベント自身の mutation は適用しない。
  if (ev.event_type === "session.ended" || isTerminalStateValue(ev.state)) {
    return { ...prev, frozen: true };
  }

  switch (ev.event_type) {
    case "work.item.updated":
      return applyWorkItemUpdated(prev, ev);
    case "turn.plan.updated":
      return applyPlanSnapshot(prev, ev);
    case "command.started":
      return applyCommandStarted(prev, ev);
    case "command.completed":
      return applyCommandCompleted(prev, ev);
    case "diff.updated":
      return applyDiffUpdated(prev, ev);
    default:
      return prev; // 非対象イベントは zero-cost skip。
  }
}

/** イベント列を work-items fold へ畳む (増分 apply と決定的に同値・INV-WORKITEMS-FOLD-PARITY)。 */
export function reduceWorkItems(
  sessionId: string,
  events: readonly NormalizedEvent[],
): WorkItemsProjection {
  let proj = initialWorkItemsProjection(sessionId);
  for (const ev of events) {
    proj = applyWorkItemsEvent(proj, ev);
  }
  return proj;
}
