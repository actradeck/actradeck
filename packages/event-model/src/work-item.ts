/**
 * Work item / completion claim / verification 契約 (ADR 0015・T1 正典).
 *
 * plan.md KPI「その完了は今のコードで検証されているか?」を型で答えるための closed 語彙群と、
 * consumer 全員が保存済み (redacted) イベントから再導出できる正準関数を集約する。
 *
 * ## 設計不変条件 (ADR 0015)
 * - **id は post-redaction テキストからのみ導出** (§D3): `deriveWorkItemId` は sidecar が採番せず
 *   projection の fold でのみ使う。raw (pre-redaction) テキストを渡してはならない (ハッシュ oracle 化を防ぐ)。
 * - **enum は全て closed**: 未知値は parse 境界 (discriminated union) / fold の gate で構造的に落とす。
 * - **永続 verified boolean を作らない** (§D5): 検証は tree fingerprint 相対の `passed` であり、
 *   fingerprint が動けば自動的に `stale` へ縮退する。`VerificationState` にそれを表す語彙のみを持つ。
 */
import { z } from "zod";

import { sha256Hex } from "./hash.js";

/**
 * work item の観測ステータス (§D2)。
 * - `removed` は「provider が snapshot に載せなくなった」推定 (inferred)。`cancelled` (宣言的中止) と区別する。
 * - `unknown` は enum 外/未確定を安全側に受ける forward-compat 値 (fold が未知 status を畳む先)。
 */
export const WorkItemStatus = z.enum([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
  "removed",
  "unknown",
]);
export type WorkItemStatus = z.infer<typeof WorkItemStatus>;

/**
 * raw な観測 status を `WorkItemStatus` closed-enum へ gate する**単一正準関数** (§D2)。
 *
 * `work.item.updated` / `turn.plan.updated` の status は必須 closed enum ゆえ、未知/非文字列を素通しすると
 * sink の discriminated-union parse が失敗しイベントが drop される。未知は `"unknown"` へ安全側に倒す
 * (forward-compat)。**sidecar 3 normalizer (CC hook / codex managed / codex rollout) と projection fold が
 * これを共有する** — 手書きコピーを置かない (TDA-B2-1・consolidation-invariant-sweep-all-copies)。
 */
export function coerceWorkItemStatus(v: unknown): WorkItemStatus {
  const r = WorkItemStatus.safeParse(v);
  return r.success ? r.data : "unknown";
}

/**
 * 検証状態 (§D5・closed)。**永続 verified boolean は存在しない**: `passed` は常に
 * `verified_tree_fp` 相対で、fingerprint 変化で `stale` へ自動縮退する。
 * `waived` は operator mutation 面 (P1) のための予約語 (今は enum を完成させ churn を防ぐ)。
 */
export const VerificationState = z.enum(["unverified", "passed", "failed", "stale", "waived"]);
export type VerificationState = z.infer<typeof VerificationState>;

/** 検証チェックの種類 (§D6)。sidecar の分類器 (B1) が emit 時に付与する closed enum。 */
export const CheckKind = z.enum(["test", "lint", "typecheck", "build", "format"]);
export type CheckKind = z.infer<typeof CheckKind>;

/**
 * チェック照合の強さ (§D6)。
 * - `program`: 正規化 program basename が既知チェックツール (vitest/pytest/tsc/eslint…)。
 * - `script`: runner-wrapped の script/target 名がチェック語彙に一致 (`pnpm test` 等・より弱い証拠)。
 */
export const CheckMatch = z.enum(["program", "script"]);
export type CheckMatch = z.infer<typeof CheckMatch>;

/**
 * 観測 availability 軸 (§D7)。`available`=経路配線済 / `unsupported`=このモードで構造的に不能 /
 * `unavailable`=配線失敗 / `permission_denied`=例: rollout dir 読取不可。
 */
export const ObservationAvailability = z.enum([
  "available",
  "unsupported",
  "permission_denied",
  "unavailable",
]);
export type ObservationAvailability = z.infer<typeof ObservationAvailability>;

/** 観測 method 軸 (§D7・どの経路から観測したか)。official ≠ authoritative は fidelity 側で担保。 */
export const ObservationMethod = z.enum([
  "official_hook",
  "official_api",
  "provider_jsonl",
  "local_file",
  "log_parse",
  "heuristic",
]);
export type ObservationMethod = z.infer<typeof ObservationMethod>;

/**
 * 観測 fidelity 軸 (§D7)。P0 では何も `authoritative` を得ない (provider 永続の再読可能な ground truth 予約)。
 * `unknown` は宣言はあるが未検証 (ADR 0014 Phase 5 の unverified を吸収)。
 */
export const ObservationFidelity = z.enum([
  "authoritative",
  "observed",
  "parsed",
  "inferred",
  "unknown",
]);
export type ObservationFidelity = z.infer<typeof ObservationFidelity>;

/** capability snapshot が宣言する観測能力 (§D7・carriage point 1)。将来の能力は additive に追加。 */
export const ObservedCapability = z.enum([
  "work_items",
  "completion_claims",
  "verification_checks",
  "tree_fingerprint",
]);
export type ObservedCapability = z.infer<typeof ObservedCapability>;

/**
 * per-observation スタンプ (§D7・carriage point 2)。同一 capability が session 内で異 fidelity の
 * 経路から届く (task hook vs PostToolUse parse) ため per-event に載る。availability は event が存在＝
 * available ゆえ省略。unknown/enum 外は消費側で undefined へ (= 証拠なし・安全側)。
 */
export const ObservationStamp = z.object({
  method: ObservationMethod,
  fidelity: ObservationFidelity,
});
export type ObservationStamp = z.infer<typeof ObservationStamp>;

/** capability snapshot の 1 能力ぶんの宣言 (§D7・carriage point 1)。 */
export const CapabilityEvidence = z.object({
  availability: ObservationAvailability,
  method: ObservationMethod,
  fidelity: ObservationFidelity,
});
export type CapabilityEvidence = z.infer<typeof CapabilityEvidence>;

/**
 * work-item id の採番スキーム (**観測形状**で命名・provider 名ではない・§D3)。
 * - `task`: declared-id scheme (`work.item.updated`)。連続性 = provider 自身の id。
 * - `plan`: content-derived scheme (`turn.plan.updated` items)。連続性 = step テキスト hash。
 */
export const WorkItemIdScheme = z.enum(["task", "plan"]);
export type WorkItemIdScheme = z.infer<typeof WorkItemIdScheme>;

/** id 内の hash 長 (hex 文字数)。衝突耐性と DOM/testid/URL 安全性 (raw テキスト非含) の両立。 */
const WORK_ITEM_ID_HASH_LEN = 16;

/**
 * work-item id の**単一正準導出** (§D3)。`<scheme>:<sha256(text)[:16]>`。
 *
 * - `plan` scheme は `text.trim()` を hash 入力にする (前後空白の揺れで同一 step が別 item 化しない)。
 * - `task` scheme は provider_task_id を無加工で hash する (provider が同一性を保証する id ゆえ)。
 * - **hash-always**: id に raw provider テキストを一切含めない (sanitization edge case ゼロ・NO-RAW)。
 *
 * ⚠️ **入力は必ず post-redaction テキスト**であること。raw (pre-redaction) を渡すと秘匿値ハッシュ化
 * oracle になる。sidecar は id を採番せず、fold が保存済み (redacted) イベントから再導出する。
 */
export function deriveWorkItemId(scheme: WorkItemIdScheme, text: string): string {
  const normalized = scheme === "plan" ? text.trim() : text;
  return `${scheme}:${sha256Hex(normalized).slice(0, WORK_ITEM_ID_HASH_LEN)}`;
}

/**
 * tree fingerprint の**単一正準導出** (§D5)。`sha256(head_sha ∥ "\0" ∥ diff_hash)`。
 *
 * イベントに保存せず fold で算出する (導出の単一出所)。比較は等価判定のみ (fingerprint 変化 = staleness)。
 * `head_sha` 欠落 (unborn/非 git) 時は **diff_hash-only** へ縮退し、その旨を evidence 軸で示す
 * (head の有無で表現が切り替わり得るが、常に安全側 = 変化 → staleness)。両方欠落なら undefined。
 */
export function treeFingerprint(
  head_sha: string | undefined,
  diff_hash: string | undefined,
): string | undefined {
  if (head_sha === undefined || head_sha === "") {
    // diff_hash-only へ縮退 (head 欠落)。
    return diff_hash !== undefined && diff_hash !== "" ? diff_hash : undefined;
  }
  const base = diff_hash ?? "";
  return sha256Hex(`${head_sha}\u0000${base}`);
}
