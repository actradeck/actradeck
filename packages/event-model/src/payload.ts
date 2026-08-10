/**
 * event_type ごとの payload 型 (plan.md §6, T1 正典).
 *
 * 方針 (MVP):
 * - payload は `kind` 判別子 (= event_type の文字列) を持つ discriminated union。
 *   O(1) 判別で reducer / UI が型安全に分岐できる。
 * - 過度に厳密にしない: 各 variant は MVP で必要な構造化フィールドのみ必須化し、
 *   それ以外の正規化済み付随情報は loose (追加キー許容) で持てるようにする。
 *   provider 固有の生データはここに素通ししない (正規化層で吸収済み前提)。
 * - NormalizedEvent.payload 自体は緩い record も受理する (後方互換 / 段階導入)。
 *   厳密な型が欲しい呼び出し側はこの discriminated union を使う。
 */
import { z } from "zod";

import { EventType } from "./event-type.js";
import { REDACTION_KINDS } from "./redaction-kinds.js";
import {
  CapabilityEvidence,
  CheckKind,
  CheckMatch,
  ObservationStamp,
  ObservedCapability,
  WorkItemStatus,
} from "./work-item.js";

/** リスク区分 (command / file の危険度。plan.md §18 Risk Lens の素地)。 */
export const RiskLevel = z.enum(["low", "medium", "high"]);
export type RiskLevel = z.infer<typeof RiskLevel>;

/** 承認の決定 (Codex: accept/acceptForSession/decline/cancel, Claude: allow/deny を正規化)。 */
export const ApprovalDecision = z.enum(["allow", "allow_for_session", "deny", "cancel"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecision>;
/**
 * decision の正準 closed-set 配列 (TDA-R4-3・Phase 4 R4 監査)。監査集計 (backend audit-contract)
 * と表示層 (webui) の membership/tally はこの配列を消費する — 手書きミラーを作らない
 * (decision 追加時に片側が黙って落とし、署名済み manifest が誤った台帳を attest する drift の
 * 構造遮断)。
 *
 * SEC-R6-4: sidecar 承認ゲートの実行時依存になったため **frozen copy** で export する
 * (zod 内部配列 `ApprovalDecision.options` を直接晒すと in-process mutation で受理集合が広がる —
 * single-operator 境界内ゆえ新規 exploit class ではないが、gate 依存の正準値は不変にする)。
 * `.options` 自体は zod 内部の可変配列のまま (backend の `new Set(ApprovalDecision.options)` 派生は
 * import 時 snapshot で独立)。
 */
export const APPROVAL_DECISIONS: readonly ApprovalDecision[] = Object.freeze([
  ...ApprovalDecision.options,
]);

/**
 * ADR 0014 Phase 4 (decision 019fd705): 承認解決の **出所 (誰が/何が解決したか)**。
 * 「deny を送った」と偽らないための正直性メタデータ (closed enum・NO-RAW)。
 * - "operator":   UI の人間決定 (allow/allow_for_session/deny/cancel)。
 * - "timeout":    承認タイムアウトの安全側 deny (30s 既定)。
 * - "policy":     ポリシー由来の自動解決 (語彙のみ確保・現行 emitter は未使用 — auto-allow 経路は
 *                 requested 自体を emit しない設計を維持。projection の request_id 無し resolved
 *                 全消し挙動と衝突させないため)。
 * - "shutdown":   sidecar graceful shutdown の drain (安全側 deny)。
 * - "child_exit": agent プロセス消失 (codex child exit / CC hook クライアント切断) の安全側 deny。
 * - "relay_lost": daemon crash 等で中継が失われ、backend が stale pending を **合成 cancel** で
 *                 非 actionable 化したもの (誰も決定していない・deny を偽装しない)。
 * additive optional。未設定は「(旧 sidecar) 出所情報なし」の後方互換値。
 */
export const ResolutionOrigin = z.enum([
  "operator",
  "timeout",
  "policy",
  "shutdown",
  "child_exit",
  "relay_lost",
]);
export type ResolutionOrigin = z.infer<typeof ResolutionOrigin>;
/**
 * resolution_origin の正準 closed-set 配列 (TDA-R3-2/SEC-R3-3・いずれも Phase 4 R3 監査所見)。
 * 表示層 (webui) の membership gate はこの配列を import する — 手書きミラーを作らない
 * (origin 追加時に表示層が黙って未知値を落とし、operator success トーンへ誤縮退する drift の
 * 構造遮断)。frozen copy の理由は APPROVAL_DECISIONS (SEC-R6-4) と同じ。
 */
export const RESOLUTION_ORIGINS: readonly ResolutionOrigin[] = Object.freeze([
  ...ResolutionOrigin.options,
]);
/**
 * backend 合成 retire を示す sentinel の正準定数 (TDA-R4-5・Phase 4 R4 監査)。
 * この値の比較は「synthetic_retired vs by_decision (→hard_gate)」の分類・liveness/coverage の
 * 活動除外を決める境界判定であり、リテラルの再打鍵を禁止する (rename/第二 synthetic origin 追加で
 * 合成 retire が operator 決定へ silent 再分類される drift の構造遮断)。TS 消費点は
 * `isSyntheticRetireOrigin` を、SQL リテラルは INV metatest (backend) がこの定数との一致を pin する。
 */
export const SYNTHETIC_RETIRE_ORIGIN = "relay_lost" satisfies ResolutionOrigin;
/** resolution_origin が backend 合成 retire かの正準判定 (unknown 受け・型システム外の行値にも安全)。 */
export function isSyntheticRetireOrigin(v: unknown): v is typeof SYNTHETIC_RETIRE_ORIGIN {
  return v === SYNTHETIC_RETIRE_ORIGIN;
}

/**
 * ADR 0014 Phase 4: 決定が **agent へ実際に届いたか** (書込結果から導出・偽らない)。
 * - "sent":     応答書込がソケット/transport 層に受理された (CC: hook HTTP 応答 write 成功、
 *               codex: JSON-RPC Response 送出成功)。「相手が読んだ」までは主張しない。
 * - "not_sent": 書けなかった / 書かなかった (クライアント切断・suppressed・合成 cancel)。
 * - "unknown":  送信を試みたが成否を判定できない。
 * additive optional。未設定は「(旧 sidecar) 配送情報なし」の後方互換値。
 */
export const DeliveryStatus = z.enum(["sent", "not_sent", "unknown"]);
export type DeliveryStatus = z.infer<typeof DeliveryStatus>;

/**
 * 自動ガード (ADR 019ecc70 段階1): 承認 pause の **理由 (trigger)**。
 * - "destructive": 既存の破壊的コマンド/ファイル/MCP/WebFetch ゲート (rm -rf 等) で pause。
 * - "secret": tool_input に secret が検出されたため pause (新規・D1/D4)。
 * - "both": destructive かつ secret の両立。
 * additive optional。未設定は「(従来どおり) 理由情報なし」を意味する後方互換値。
 */
export const ApprovalTrigger = z.enum(["destructive", "secret", "both"]);
export type ApprovalTrigger = z.infer<typeof ApprovalTrigger>;

/**
 * 自動ガード (ADR 019ecc70 D3): secret-trigger の **kind 名のみ** (REDACTION_KINDS 語彙)。
 * INV-AUTOGUARD-NO-RAW: 原文 (秘匿値そのもの) は一切載せない。値は redacted 文字列の
 * `[REDACTED:<kind>]` マーカーから算出した公開可能 enum に限る (closed-enum allowlist)。
 */
export const SecretKind = z.enum(REDACTION_KINDS);
export type SecretKind = z.infer<typeof SecretKind>;

/**
 * 承認ポリシーの high-risk カテゴリ (ADR 019f0c3e・T1 単一ソース).
 *
 * operator が設定ページ (Phase 2) のチェックボックスで「YOLO/bypassPermissions でも明示承認を要する」
 * カテゴリを選ぶ。sidecar の分類器 (normalize.ts `classifyCommandCategories`) が各操作の該当カテゴリを
 * 算出し、approval-bridge が **enabled-categories と交差したらゲート**する (それ以外は従来どおり defer)。
 *
 * - recursive-rm:     rm -rf / find -delete・-exec 等の再帰強制削除・mass file 削除
 * - disk-destroy:     mkfs/dd/shred/wipefs/parted/cryptsetup/nvme format/zfs destroy/block-device 書込
 * - history-rewrite:  git push --force / git reset --hard / git clean -f
 * - db-drop:          DROP TABLE / DROP DATABASE / TRUNCATE TABLE
 * - fork-bomb:        `:(){ :|:& };:` 等の自己増殖
 * - secret-egress:    network-egress program (curl/wget/nc/scp…) に secret を同梱 (composite・approval-bridge)
 * - perm-change:      chmod -R / world-writable chmod / recursive chown
 * - inline-code:      sh -c / python -c / eval / `curl|sh` / `$(...)` / `<(...)` の動的コード実行
 * - secret-file-edit: .env / *.pem / id_rsa / kubeconfig 等の秘匿ファイル編集 (approval-bridge)
 * - external-tool:    MCP 呼び出し / WebFetch (approval-bridge)
 * - migrate-prod:     DB マイグレーション / "production" 言及 (曖昧・既定 OFF)
 * - high-risk-other:  上記 named に該当しない high、または実行形を安全に解析できない残余
 *                     (silent hole 防止 backstop)
 *
 * 後方互換 additive。値は公開可能 enum (原文非依存・redaction 件数と同カテゴリの安全な enum)。
 */
export const PolicyCategory = z.enum([
  "recursive-rm",
  "disk-destroy",
  "history-rewrite",
  "db-drop",
  "fork-bomb",
  "secret-egress",
  "perm-change",
  "inline-code",
  "secret-file-edit",
  "external-tool",
  "migrate-prod",
  "high-risk-other",
]);
export type PolicyCategory = z.infer<typeof PolicyCategory>;

/**
 * 既定でゲートする (チェック ON) カテゴリ (ADR 019f0c3e). 設定ファイル欠落/不正時の **fail-safe 既定**でもある。
 *
 * 不可逆×ブラスト半径大の群に加え、任意コードを内包する inline-code を既定 ON にする。
 * perm-change / secret-file-edit / external-tool / migrate-prod は誤検知寄りゆえ既定 OFF
 * (operator が必要なら設定ページで ON)。secret-egress は leak 製品ゆえ既定 ON (operator は外せるが
 * UI が強警告)。high-risk-other は high または安全に解析不能な残余を取りこぼさない backstop ゆえ既定 ON。
 */
export const DEFAULT_GATED_CATEGORIES: readonly PolicyCategory[] = [
  "recursive-rm",
  "disk-destroy",
  "history-rewrite",
  "db-drop",
  "fork-bomb",
  "secret-egress",
  "inline-code",
  "high-risk-other",
];

/**
 * TDA-S1-3 (decision 019f0e5d): categories 集合を `PolicyCategory.options` の安定順へ整列する **単一出所**。
 * 投影 (projectPolicyCategories) とは別操作 — 既に typed な `ReadonlySet<PolicyCategory>` の serialize
 * (approval-policy-store.saveApprovalPolicy / policy-relay.buildPolicyResponse) と、投影の最終整列の両方が
 * 本関数を共有し、順序規則の 3 箇所重複を排除する。`ReadonlySet<string>` を受け PolicyCategory ⊆ string で
 * typed-Set も present-set も渡せる (戻りは常に closed enum・order/membership は options に従う)。
 */
export function orderPolicyCategories(set: ReadonlySet<string>): PolicyCategory[] {
  return PolicyCategory.options.filter((c) => set.has(c));
}

/**
 * TDA-1 (decision 019f0e2d): untrusted 入力を closed-enum `PolicyCategory[]` へ投影する **単一出所**。
 * `PolicyCategory.options` の安定順を保ち、非配列→`[]`・非 string・未知値を構造的に落とす (NO-RAW)。
 *
 * 3 トラスト境界 — sidecar `sanitizeCategories` (disk/wire load) / backend `resolvePolicy` (sidecar relay) /
 * webui `parsePolicy` (BFF 応答) — が本関数を共有し、投影ロジックの drift を防ぐ (純関数ゆえ境界ごとの
 * 多層防御は保たれる)。各境界固有の前段ガード (例: webui の「非配列は応答全棄却」) は呼び元に残す。
 * 最終整列は orderPolicyCategories に委譲 (TDA-S1-3・順序規則の単一出所)。
 */
export function projectPolicyCategories(raw: unknown): PolicyCategory[] {
  if (!Array.isArray(raw)) return [];
  const present = new Set<string>(raw.filter((c): c is string => typeof c === "string"));
  return orderPolicyCategories(present);
}

/**
 * 承認ポリシー **preset** (ADR 019f23e1・P3): 既存 PolicyCategory 集合への「名前付き展開テンプレート」。
 *
 * pure-expand: preset 名は wire/policy.json/live gate のどこにも保存しない。operator が preset を選ぶと
 * UI は **既存の set 経路**で `categories = presetCategories(name)` をセットするだけ (enforcement 機構は不変)。
 * UI は保存済/ドラフトの categories から `matchPreset` で現在 preset を逆引き表示する (categories が唯一の真実)。
 *
 * 各 preset 値は `orderPolicyCategories` で `PolicyCategory.options` の安定順に固定する
 * (手書き順序に依存しない・diff 安定)。`balanced` は `DEFAULT_GATED_CATEGORIES` から導出し二重定義しない
 * (ドリフト防止)。`demo` は破滅的不可逆 floor のみ (非空ゆえ empty→DEFAULT fail-safe に触れない)。
 */
export type PolicyPresetName = "strict" | "balanced" | "demo";

/** UI 表示順 (strict → balanced → demo)。 */
export const PRESET_ORDER: readonly PolicyPresetName[] = ["strict", "balanced", "demo"];

/**
 * preset → 展開後 PolicyCategory 集合 (options 安定順)。
 * - strict:   全 PolicyCategory (検出できる全カテゴリを止める・プロンプト増)。
 * - balanced: DEFAULT_GATED_CATEGORIES と同一 (out-of-box 既定=推奨)。二重定義しない。
 * - demo:     破滅的不可逆 floor {recursive-rm, disk-destroy, fork-bomb} のみ。それ以外は素通し。
 */
export const POLICY_PRESETS: Readonly<Record<PolicyPresetName, readonly PolicyCategory[]>> = {
  strict: orderPolicyCategories(new Set<PolicyCategory>(PolicyCategory.options)),
  balanced: orderPolicyCategories(new Set<PolicyCategory>(DEFAULT_GATED_CATEGORIES)),
  demo: orderPolicyCategories(
    new Set<PolicyCategory>(["recursive-rm", "disk-destroy", "fork-bomb"]),
  ),
};

/** preset 名 → 展開後 categories (呼び元が変更しても共有 const を汚さないよう新配列で返す・順序安定)。 */
export function presetCategories(name: PolicyPresetName): PolicyCategory[] {
  return [...POLICY_PRESETS[name]];
}

/**
 * 与えられた categories 集合が **厳密一致**する preset 名を返す (逆引き)。どの preset とも不一致なら
 * undefined (= custom)。入力は `orderPolicyCategories` で closed-enum の安定順へ正規化してから
 * size + 要素で比較するため、未知文字列/非 enum 値は構造的に落として評価する (NO-RAW)。
 */
export function matchPreset(cats: ReadonlySet<string>): PolicyPresetName | undefined {
  const normalized = orderPolicyCategories(cats);
  for (const name of PRESET_ORDER) {
    const preset = POLICY_PRESETS[name];
    if (preset.length === normalized.length && preset.every((c, i) => c === normalized[i])) {
      return name;
    }
  }
  return undefined;
}

/**
 * variant ビルダー: `kind` リテラル + 固有フィールド。
 * looseObject で「正規化済みの追加キー」を許容する (MVP の前方互換)。
 */
function variant<K extends EventType, S extends z.ZodRawShape>(kind: K, shape: S) {
  return z.looseObject({ kind: z.literal(kind), ...shape });
}

// --- セッション ---------------------------------------------------------
const SessionStarted = variant("session.started", {
  repo: z.string().optional(),
  branch: z.string().optional(),
  // ADR 0015 §D7 carriage point 1: capture 経路ごとの観測能力 snapshot。sidecar が「何を / どの
  //   fidelity で観測できるか」を session に宣言し、後で配線が変わっても監査証跡の保証水準を保つ
  //   (ADR 0014 Phase 5 の manifest ファイルを in-band 化)。closed enum のみ (NO-RAW)。
  //   partialRecord: 宣言する capability だけを載せる (全 capability 必須ではない・additive)。
  observation_evidence: z.partialRecord(ObservedCapability, CapabilityEvidence).optional(),
});
const SessionEnded = variant("session.ended", {
  reason: z.string().optional(),
});

// --- ターン -------------------------------------------------------------
const TurnStarted = variant("turn.started", {
  prompt_summary: z.string().optional(),
});
const TurnPlanUpdated = variant("turn.plan.updated", {
  plan: z.string().optional(),
  steps: z.array(z.string()).optional(),
  // ADR 0015 §D2: Codex plan の snapshot 観測に **per-step status** を載せる typed items。
  //   legacy `steps` (文字列のみ) は旧 consumer 向けに維持し、`items` が gap を埋める upgrade path。
  //   ordinal は配列 index。plan-scheme id は step テキスト hash (§D3・fold で導出)。
  items: z.array(z.object({ step: z.string(), status: WorkItemStatus })).optional(),
});
const TurnCompleted = variant("turn.completed", {
  // 応答要約 (エージェント公開メッセージの有界要約・plan.md「エージェントの公開メッセージ」表示許可)。
  //   出所は adapter/normalizer が summarize(prompt_response, N) で有界化した文字列。projection
  //   `deriveActionSubject` が current_action_subject / replay subject の出所に使う (TurnStarted の
  //   prompt_summary と対・ADR 019f47c2)。**秘匿値は含まない** (backend ingress 床で redaction 済)。
  response_summary: z.string().optional(),
});
const TurnFailed = variant("turn.failed", {
  // `error` が正典の失敗要因フィールド (UI / projection subject の出所)。
  error: z.string().optional(),
  // TDA-2: codex rollout の turn_aborted は失敗要因を `reason` にも載せる
  //   (normalize-codex-rollout.ts: error=asString(reason) ?? "turn aborted", reason=p.reason)。
  //   sidecar の実挙動を T1 に明示するための additive optional (`session.ended` の reason とは別 variant)。
  //   消費側 (projection deriveActionSubject) は error を優先し reason を後方互換 fallback に使う。
  reason: z.string().optional(),
});

// --- モデル出力 (streaming) ---------------------------------------------
const AgentMessageDelta = variant("agent.message.delta", {
  delta: z.string(),
});
const AgentReasoningSummaryDelta = variant("agent.reasoning_summary.delta", {
  delta: z.string(),
});

// --- 汎用ツール ---------------------------------------------------------
const ToolStarted = variant("tool.started", {
  tool_name: z.string(),
  input: z.unknown().optional(),
});
const ToolOutputDelta = variant("tool.output.delta", {
  delta: z.string(),
});
const ToolCompleted = variant("tool.completed", {
  tool_name: z.string().optional(),
  output: z.unknown().optional(),
});
const ToolFailed = variant("tool.failed", {
  tool_name: z.string().optional(),
  error: z.string().optional(),
  // Bash 等の失敗時に tool_response から取れたとき (実在時のみ) command.* と整合させる。
  command: z.string().optional(),
  exit_code: z.number().int().optional(),
  request_id: z.string().optional(),
});

// --- 承認 ---------------------------------------------------------------
/**
 * INV-REQUEST-ID-NAMESPACE (T1 契約・TDA-1 decision 019ebc07):
 * `request_id` フィールドには **2 つの非交差キー空間** が同居する:
 *  1. **承認キー** (`s<hash12>:apr-…`。採番の正準は event-model `approval-request-id.ts` の
 *     `mintApprovalRequestId` (sidecar 承認ブリッジ) / `deriveDemoApprovalRequestId`
 *     (backend safety-demo) — raw session_id は含めない。redaction-stable 契約は同ファイルの
 *     docstring 参照): tool.permission.requested / tool.permission.resolved のみが持つ。
 *  2. **`tu:<tool_use_id>`** (CC hook の tool_use_id 由来・`tu:` prefix で構造分離):
 *     command.started / command.completed / tool.failed が持つ。
 * 両者は同一フィールドを共有して下流 (projection / replay-store / UI) へ混在して流れるのが
 * **正常**。consumer は突合の前に必ず **event_type でゲート** し、namespace を跨いだ
 * request_id 突合をしてはならない (例: pending_approvals の解決は permission.* のみ、
 * command ペアリングは command.* と tool.failed のみ)。`request_id の有無` をゲートに
 * 使うのは退行 (QA-1/QA-2 decision 019ebc01 が赤テストで固定)。
 */
const ToolPermissionRequested = variant("tool.permission.requested", {
  // 承認ブリッジが採番する相関 ID (高エントロピー)。UI が承認カード→approve frame で
  // 突合する正本キー。outbound 承認経路 (ADR 019e9999) の必須要素。looseObject なので
  // 省略可だが、UI 契約として明示する (PreToolUse/PermissionRequest の双方で付与される)。
  request_id: z.string().optional(),
  tool_name: z.string().optional(),
  command: z.string().optional(),
  path: z.string().optional(),
  risk_level: RiskLevel.optional(),
  // 自動ガード (ADR 019ecc70 段階1・D3): なぜ pause したか / どの secret kind か。
  // additive optional (provider_session_id/capture_mode と同じ後方互換パターン)。
  // trigger/secret_kinds を読まない consumer は無影響。resolved には載せない (request_id 突合のみ)。
  trigger: ApprovalTrigger.optional(),
  // INV-AUTOGUARD-NO-RAW: REDACTION_KINDS allowlist の **語彙名のみ** (原文ゼロ)。
  // 空配列/未設定は「secret 起因でない」。
  secret_kinds: z.array(SecretKind).optional(),
});
const ToolPermissionResolved = variant("tool.permission.resolved", {
  // どの pending approval を解決したか (request_id 突合)。reducer が pending_approvals から
  // 該当 request_id を除去するために必要 (ADR 019e9999)。
  request_id: z.string().optional(),
  decision: ApprovalDecision,
  // ADR 0014 Phase 4 (decision 019fd705): 解決の出所と配送結果 (正直性メタデータ)。
  // additive optional (trigger/secret_kinds と同じ後方互換パターン)。closed enum のみ (NO-RAW)。
  // 読まない consumer は無影響。語彙は coordinated deploy 前提。
  // SEC-4 (Phase 4 監査 R2) 正直な開示: この strict enum が未知値を拒否するのは **EventPayload を
  // 実際に parse する境界** (sidecar producer の assertPayloadConsistency / backend 合成 producer の
  // 検証 / 型付き consumer) のみ。backend ingress の `parseEvent` は payload を looseObject で
  // 素通しするため、ingress 単体では未知値は落ちない (INV テストが両実態を pin する)。
  resolution_origin: ResolutionOrigin.optional(),
  delivery_status: DeliveryStatus.optional(),
});

// --- コマンド実行 -------------------------------------------------------
const CommandStarted = variant("command.started", {
  command: z.string(),
  cwd: z.string().optional(),
  risk_level: RiskLevel.optional(),
  // tool_use_id 由来の相関キー (`tu:<tool_use_id>`)。command.completed と同値で結ぶ。
  request_id: z.string().optional(),
  // ADR 0015 §D6: チェック分類 (sidecar が emit 時に canonical tokenizer で付与する closed enum・
  //   B1 で配線)。started 側にも載せるのは run_dirty 判定 (start↔completed 間の diff 変化) のため。
  check_kind: CheckKind.optional(),
  check_match: CheckMatch.optional(),
});
const CommandOutputDelta = variant("command.output.delta", {
  stream: z.enum(["stdout", "stderr"]),
  delta: z.string(),
});
const CommandCompleted = variant("command.completed", {
  command: z.string().optional(),
  exit_code: z.number().int().optional(),
  // tool_use_id 由来の相関キー (`tu:<tool_use_id>`)。command.started と同値で結ぶ。
  request_id: z.string().optional(),
  // ADR 0015 §D6: チェック分類 (started と対・completed の exit_code と合わせ検証遷移を駆動)。
  check_kind: CheckKind.optional(),
  check_match: CheckMatch.optional(),
});

// --- ファイル変更 -------------------------------------------------------
const FileChangeProposed = variant("file.change.proposed", {
  path: z.string(),
  diff: z.string().optional(),
  risk_level: RiskLevel.optional(),
});
const FileChangeApproved = variant("file.change.approved", {
  path: z.string(),
  decision: ApprovalDecision.optional(),
});
const FileChangeApplied = variant("file.change.applied", {
  path: z.string(),
  added_lines: z.number().int().optional(),
  removed_lines: z.number().int().optional(),
});
const DiffUpdated = variant("diff.updated", {
  diff_hash: z.string().optional(),
  changed_files: z.number().int().optional(),
  added_lines: z.number().int().optional(),
  removed_lines: z.number().int().optional(),
  // ADR 0015 §D5: snapshot 時点の `git rev-parse HEAD` (B1 で配線)。tree fingerprint
  //   = sha256(head ∥ \0 ∥ diff_hash) の素。unborn/非 git では欠落 → diff_hash-only へ縮退。
  //   commit id は content-free (秘匿値でない)。
  head_sha: z.string().optional(),
});

// --- MCP / Web ----------------------------------------------------------
const McpCallStarted = variant("mcp.call.started", {
  server: z.string(),
  tool: z.string(),
  arguments: z.unknown().optional(),
});
const McpCallCompleted = variant("mcp.call.completed", {
  server: z.string().optional(),
  tool: z.string().optional(),
  result: z.unknown().optional(),
});
const WebSearchStarted = variant("web.search.started", {
  query: z.string(),
});

// --- サブエージェント ---------------------------------------------------
const SubagentStarted = variant("subagent.started", {
  subagent_id: z.string().optional(),
  task: z.string().optional(),
});
const SubagentCompleted = variant("subagent.completed", {
  subagent_id: z.string().optional(),
});

// --- コンテキスト圧縮 ---------------------------------------------------
const ContextCompacted = variant("context.compacted", {
  trigger: z.enum(["auto", "manual"]).optional(),
});

// --- 作業項目 (ADR 0015 evidence-based completion) ----------------------
/**
 * per-item の work item 観測 (§D2)。CC task list や、item id を宣言する adapter が emit する。
 *
 * **INV-WORKITEM-NO-STATE (§D1)**: この variant を持つイベントは NormalizedEvent.state を **常に
 * 持たない** (純観測ゆえ session 状態機械を動かさない)。state は top-level field ゆえ payload schema
 * では強制できないが、emitter (A2/B2) はこの契約を守り、fold (INV-WORKITEM-NO-STATE テスト) が回帰固定する。
 *
 * - `provider_task_id`: provider の task id (CC の session-scoped serial 等)。fold が
 *   `deriveWorkItemId("task", …)` で hash-only id へ畳む (raw を id/DOM へ持ち込まない・§D3)。
 * - `subject` / `description`: free text。既存 sink choke (redact→persist) を通った **redacted** 値
 *   のみが at-rest に載る (INV-REDACTION-WORKITEM・§D10)。
 * - `observation`: per-observation の method/fidelity スタンプ (§D7・carriage point 2)。
 */
const WorkItemUpdated = variant("work.item.updated", {
  provider_task_id: z.string(),
  status: WorkItemStatus,
  subject: z.string().optional(),
  description: z.string().optional(),
  observation: ObservationStamp.optional(),
});

// --- Liveness / 運用 ----------------------------------------------------
const Heartbeat = variant("heartbeat", {
  process_alive: z.boolean().optional(),
});
const StalledDetected = variant("stalled.detected", {
  // plan.md §5 / §18: 停止を断定せず根拠を分解して保持する。
  no_model_delta_ms: z.number().int().optional(),
  no_stdout_ms: z.number().int().optional(),
  no_event_ms: z.number().int().optional(),
  process_alive: z.boolean().optional(),
  last_item: z.string().optional(),
  inference: z.string().optional(),
});
const ErrorPayload = variant("error", {
  message: z.string(),
  retryable: z.boolean().optional(),
});

/**
 * 全 event_type を網羅した payload の discriminated union。
 * 判別キーは `kind` (= event_type)。
 */
export const EventPayload = z.discriminatedUnion("kind", [
  SessionStarted,
  SessionEnded,
  TurnStarted,
  TurnPlanUpdated,
  TurnCompleted,
  TurnFailed,
  AgentMessageDelta,
  AgentReasoningSummaryDelta,
  ToolStarted,
  ToolOutputDelta,
  ToolCompleted,
  ToolFailed,
  ToolPermissionRequested,
  ToolPermissionResolved,
  CommandStarted,
  CommandOutputDelta,
  CommandCompleted,
  FileChangeProposed,
  FileChangeApproved,
  FileChangeApplied,
  DiffUpdated,
  McpCallStarted,
  McpCallCompleted,
  WebSearchStarted,
  SubagentStarted,
  SubagentCompleted,
  ContextCompacted,
  WorkItemUpdated,
  Heartbeat,
  StalledDetected,
  ErrorPayload,
]);
export type EventPayload = z.infer<typeof EventPayload>;
