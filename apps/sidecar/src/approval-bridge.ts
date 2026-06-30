/**
 * 承認ブリッジ (土台) — 高リスク操作の承認なし自動実行を防ぐ。
 *
 * フロー (plan.md §12):
 *   Claude Code PreToolUse/PermissionRequest → Sidecar → (UI approval card) → User
 *   → Sidecar が hook 応答で allow/deny を返す。
 *
 * 安全側ポリシー (security.md):
 * - 高リスク操作 (rm -rf / chmod / migration / production / .env/secret access) は
 *   常に UI 承認を必要とする。応答なしタイムアウトは deny。
 * - low リスクかつ auto/acceptEdits/bypassPermissions モードでは defer (allow) して
 *   通常フローを妨げない (Managed の体験を壊さない)。
 *
 * MVP の土台: UI 接続 (WsClient.approval) を resolve 経路として配線。UI 未接続時は
 * タイムアウト → 安全側 (deny)。これは Phase 3/4 で UI が来るまでの最小実装。
 */
import { createHash, randomBytes } from "node:crypto";

import type { ApprovalDecision, ApprovalTrigger, PolicyCategory } from "@actradeck/event-model";
import {
  DEFAULT_GATED_CATEGORIES,
  isKnownRedactionKind,
  isPathWithinScope,
} from "@actradeck/event-model";

import type { ApprovalAllowlistStore } from "./approval-allowlist-store.js";
import {
  classifyCommandCategories,
  classifyCommandRisk,
  classifyTool,
  isNetworkEgressCommand,
  isPersistDeniedCommand,
} from "./normalize.js";
import type { HookCommonInput } from "./normalize.js";
import { countRedactionMarkersByKind, redactString } from "./redactor.js";

/**
 * 秘匿ファイル (path ベースの広め一致・over-approval が安全側)。`requiresDestructiveApproval` と
 * secret-file-edit カテゴリ判定 (ADR 019f0c3e) で共有する単一ソース (ドリフト防止)。
 * anchor (^/$) を足すと網が狭まり "mysecret_notes" 等を取りこぼすため部分一致のまま (CodeQL 指摘は不採用)。
 */
const SECRET_FILE_PATH_RE =
  /\.env|secret|credential|\.pem|\.key|\.p12|\.pfx|\.jks|id_(?:rsa|ed25519|ecdsa|dsa)|\.pgpass|\.netrc|\.npmrc|kubeconfig/i;

/**
 * 承認結果の behavior:
 * - allow: UI で明示承認された (allow / allow_for_session)、または同一署名の session-allow
 *   キャッシュ命中で自動承認された → tool を通す。
 * - deny: UI で拒否 (deny / cancel) / タイムアウト / shutdown → tool をブロック。
 * - defer: ゲート対象外 (low-risk) → Claude Code の通常 permission flow に委ねる。
 *   ⚠️ INV-APPROVAL: 「allow を勝手に返さない」。force-allow はユーザー自身の
 *   permission 設定を上書きしてしまうため、ゲート不要時は必ず defer を返す
 *   (decision 019e8e4b)。明示 allow は人間の UI 承認 or その人間が許可した同一署名のみ。
 */
export interface ApprovalResult {
  readonly behavior: "allow" | "deny" | "defer";
  readonly reason?: string;
  /** 段階③: UI が選んだ 4 値 decision (resolved イベントの表示用)。timeout/drain/auto は省略。 */
  readonly decision?: ApprovalDecision;
  /**
   * 段階③: emitRequest を経ずに同一署名 session-allow キャッシュで即 allow したか。
   * true のとき hook-receiver は resolved イベントを出さず通常観測 (command.started 等) する
   * (request_id 無しの resolved で他 pending を誤消去しないため)。
   */
  readonly autoAllowed?: boolean;
  /**
   * 永続 allowlist (ADR 019ee0c0) のディスク署名命中で即 allow したか。autoAllowed と併用し、
   * 観測イベントに persist_grant マーカーを付けて「再起動跨ぎ grant 由来」を監査識別可能にする。
   */
  readonly persistGrant?: boolean;
}

/**
 * 自動ガード (ADR 019ecc70 段階1): なぜ pause したか (理由) を承認要求に添える。
 * emitRequest コールバックの第 2 引数で渡し、hook-receiver → normalize 経由で
 * `tool.permission.requested` payload (trigger / secret_kinds) に載せる。
 *
 * INV-AUTOGUARD-NO-RAW: secretKinds は **redacted 文字列由来の kind 名のみ** (REDACTION_KINDS
 * allowlist)。原文 (秘匿値そのもの) はここにも emit にもログにも一切残さない。
 */
export interface GuardReason {
  /** "destructive" | "secret" | "both"。destructive と secret の OR・両立で "both"。 */
  readonly trigger: ApprovalTrigger;
  /** secret-trigger の kind 名 (REDACTION_KINDS allowlist のみ・原文ゼロ)。非 secret 時は []。 */
  readonly secretKinds: readonly string[];
  /**
   * 永続 allowlist (ADR 019ee0c0) 対象か。UI はこれが true のときのみ「再起動後も許可」を提示する
   * (medium-bash + 非 secret + repo 解決可 + feature-ON のときだけ true)。それ以外は false で、
   * 既存 4 値 (allow/allow_for_session/deny/cancel) のみ。codex/PermissionRequest は常に false。
   */
  readonly persistable: boolean;
}

/**
 * requiresHumanApproval の戻り値 (ADR 019ecc70 D4)。boolean を構造化し、destructive と
 * secret の検出結果を分解して保持する。`gated=false` のとき trigger は無く secretKinds は []。
 */
interface GateDecision {
  readonly gated: boolean;
  /** gated のときのみ意味を持つ理由 (gated=false では undefined)。 */
  readonly trigger?: ApprovalTrigger;
  readonly secretKinds: readonly string[];
}

interface PendingApproval {
  resolve: (r: ApprovalResult) => void;
  timer: NodeJS.Timeout;
  /** 段階③: allow_for_session 命中時に session-allow キャッシュへ登録する操作署名。 */
  readonly signature: string;
  /**
   * ADR 019ecc70 D5: この承認が allow_for_session で署名キャッシュへ登録**可能**か。
   * secret-trigger (secret|both) は false (auto-allow 非対象)。destructive-only は true。
   */
  readonly cacheable: boolean;
  /**
   * ADR 019ee0c0: 永続 allowlist へディスク登録**可能**か (medium-bash + 非 secret + repo 解決可
   * + feature-ON)。resolve で persist=true が来たときこの値が真のときのみディスクへ書く (degrade)。
   */
  readonly persistable: boolean;
  /** persistable のとき確定済みの repo スコープ (sha256 短縮) と表示用 basename。 */
  readonly repoScope?: string;
  readonly repoLabel?: string;
}

/**
 * 段階③ SEC-1 (ADR 019e9b83): 操作署名のエンコード単一出所 (collision-proof)。
 *
 * 3 フィールドを **JSON 配列でエンコード**してから sha256 する。JSON は各要素を quote/escape で
 * 曖昧さなく区切るため、どんな文字 (空白/quote/backslash/`,`/`]`/NUL 等) が operand に出現しても
 * **異なる (kind, risk, operand) が同一署名へ潰れることが構造的に不能** (語彙非依存の injectivity)。
 *
 * computeSignature から分離して **export** するのは、この injectivity 契約を behavior 経由でなく
 * 直接の単体テストで falsifiable にゲートするため (kind/risk が空白なし固定語彙のため behavior
 * 経由では delimiter-smear 衝突が到達不能 = naive-join mutation を赤化できなかった QA-A 所見)。
 * 例: `["bash","high","b c"]` と `["bash","high b","c"]` は素朴な空白連結なら同一文字列
 * `bash high b c` に潰れるが、JSON 配列なら別エンコードで別署名になる (テストがこれをゲートする)。
 */
export function encodeOperationSignature(kind: string, risk: string, operand: string): string {
  return createHash("sha256")
    .update(JSON.stringify([kind, risk, operand]))
    .digest("hex");
}

/**
 * cwd → repo スコープ解決器の型 (ADR 019ee0c0 永続 allowlist / ADR 019f0eca per-repo policy 共有)。
 * git root を解決し `{ scope: sha256短縮(12 hex), label: basename, root: 物理 git root }` を返す。解決不能
 * (cwd 無し / git 管理外) なら undefined。永続 allowlist と per-repo policy が **同一の repo 同定器**を共有する
 * ことで scope キーの drift を防ぐ (security-gate-reuse-canonical-parser)。実体は approval-persist-config の
 * makeRepoScopeResolver (findRepoRoot + scopeHash + repoLabelOf の合成)。
 *
 * `root` (SEC-1・decision 019f0f2f): `git rev-parse --show-toplevel` の **物理 (symlink 解決済み) root**。
 * resolve endpoint の二段封じ込めで「解決済 root が project-scope 配下か」の再照合に使う (符号化前の生 root
 * は echo/永続しない・containment 判定にのみ消費)。permit-path の persist 経路は root を使わない (任意)。
 */
export type RepoScopeResolver = (
  cwd: string | undefined,
) => Promise<{ scope: string; label?: string; root?: string } | undefined>;

/**
 * 永続 allowlist 設定 (ADR 019ee0c0)。未指定なら永続化機能は完全に無効 (既存挙動・非退行)。
 * eligibility (medium-bash 判定) は ApprovalBridge が行い、ストアは署名の保存/参照のみ担う。
 */
export interface ApprovalPersistConfig {
  /** 永続ストア (~/.actradeck/approvals/allowlist.json)。 */
  readonly store: ApprovalAllowlistStore;
  /** opt-in フラグ。false のとき disk エントリを honor しない (真の kill-switch)。 */
  readonly enabled: boolean;
  /** 永続 grant の TTL (ms)。add 時 expiresAt = now + ttlMs。 */
  readonly ttlMs: number;
  /**
   * cwd → repo スコープ解決。git root を解決し `{ scope: sha256短縮, label: basename }` を返す。
   * 解決不能 (cwd 無し / git 管理外) なら undefined = **永続化不可** (unscoped grant を作らない fail-safe)。
   */
  readonly resolveRepoScope: RepoScopeResolver;
  /** 現在時刻 (epoch ms)。テスト決定論化のため注入可。既定 Date.now。 */
  readonly now?: () => number;
}

/**
 * PAL-v2 (ADR 019ee147): 永続 allowlist の NO-RAW ビュー (UI/relay 用)。
 * **生コマンドを構造的に含まない** (signature=sha256 / repoScope=sha256短縮 / repoLabel=basename)。
 * PersistedApproval をそのまま使わず view を分けるのは、relay/表示の境界で「載せてよい値」を
 * 型で固定するため (将来 store に raw 隣接フィールドが増えても view が漏らさない)。
 */
export interface PersistedApprovalView {
  readonly signature: string;
  readonly repoScope: string;
  readonly repoLabel?: string;
  readonly risk: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

/**
 * 承認ポリシー (ADR 019f0c3e): bypassPermissions/YOLO で「どの high-risk カテゴリを明示承認に落とすか」。
 * memory-authoritative — sidecar 起動時に store から読み memory 保持し、実行中はディスクを毎回 hot-reload
 * せず relay (Phase 2) でのみ更新する (YOLO 中のエージェントが policy.json を書換えても live gate を
 * 弱められないようにするため)。未指定 (undefined) または `enabled=false` (kill-switch
 * `ACTRADECK_BYPASS_CATASTROPHIC_GATE=0`) で bypass は従来どおり全 defer (純パススルー・decision 019eace6)。
 */
export interface ApprovalPolicyConfig {
  /** kill-switch。false で bypass を全 defer に戻す (純パススルー)。 */
  readonly enabled: boolean;
  /** ゲートするカテゴリ集合 (DEFAULT_GATED_CATEGORIES が既定プリセット)。 */
  readonly categories: ReadonlySet<PolicyCategory>;
}

/**
 * per-repo オーバーライド 1 件 (ADR 019f0eca §1)。default を **full override** する (緩和も可・hard-floor
 * 無し・decision 019f0ecd)。空 categories は「この repo では何も gate しない」という正当な選択
 * (default の empty→DEFAULT fail-safe は repo entry には適用しない)。label は表示専用 (basename)。
 */
export interface RepoPolicyEntry extends ApprovalPolicyConfig {
  /** 表示用 repo basename (絶対パス/secret 非含・load-bearing でない)。 */
  readonly label?: string;
}

/**
 * 承認ポリシーの階層構造 (ADR 019f0eca)。default = マシン基準 (従来の machine-global)。repos =
 * repoScope(sha256短縮) でキーした per-repo オーバーライド。gate は操作ごとに cwd→repoScope を解決し
 * `repos.get(scope) ?? default` を effective とする。repo 内ファイルは読まない (中央 file のみ・
 * memory-authoritative の床維持)。
 */
export interface LayeredApprovalPolicy {
  readonly default: ApprovalPolicyConfig;
  readonly repos: ReadonlyMap<string, RepoPolicyEntry>;
}

/**
 * disk 永続の **単一 delta** (TDA-R1・decision 019f0f64)。set/unset を full layered の overwrite でなく
 * 「変更した 1 キーだけ」を表現する。永続側 (applyPolicyDelta) が disk を read-modify-write することで、
 * fan-out を取りこぼした stale daemon が後続 set の owner になっても、自分の memory に無い**他の repo
 * override を disk から落とさない** (multi-writer disk-completeness・silent security-control downgrade 防止)。
 */
export type PolicyDelta =
  | { readonly kind: "set-default"; readonly config: ApprovalPolicyConfig }
  | { readonly kind: "set-repo"; readonly scope: string; readonly entry: RepoPolicyEntry }
  | { readonly kind: "remove-repo"; readonly scope: string };

/**
 * ADR 019f0c3e Phase 2: getPolicyConfig / setPolicyConfig が返す承認ポリシーの **file-level** ビュー。
 * enabled は operator が設定した file レベルの値 (env kill-switch は適用しない)・categories は実際に
 * ゲートされる集合 (空→DEFAULT の fail-safe 適用後)・envGateEnabled は env kill-switch の現状
 * (false=全体パススルー中・UI 警告用)。
 */
export interface PolicyConfigView {
  readonly enabled: boolean;
  readonly categories: ReadonlySet<PolicyCategory>;
  readonly envGateEnabled: boolean;
  /**
   * ADR 019f0eca: このビューが指す repo スコープ (省略=default/マシン基準)。set/get の repo_scope を
   * そのまま反映する (UI が「どの scope を表示中か」を知る)。
   */
  readonly repoScope?: string;
  /** ADR 019f0eca: repo の表示用 basename (override が存在する場合のみ)。 */
  readonly repoLabel?: string;
  /**
   * ADR 019f0eca: repoScope 指定時に **その repo 専用エントリが存在するか** (true=override / false=default
   * を継承)。default ビュー (repoScope 省略) では false。UI の Override/Default バッジに使う。
   */
  readonly isOverride?: boolean;
  /**
   * SEC-1 (ADR 019f0c3e Phase 2 監査・decision 019f0d07): setPolicyConfig で disk 永続 (persistDelta→applyPolicyDelta)
   * が失敗したときのみ載る固定メッセージ。**memory (live gate) は更新済み**で、再起動で disk の旧値へ
   * 戻ることを UI へ伝える。get では決して付かない (set 専用)。生の fs エラー文字列 (パス等) は載せない
   * (SEC-2 と同方針: 原文非依存の固定文言)。
   */
  readonly persistError?: string;
}

export interface ApprovalBridgeOptions {
  /** UI 応答待ちタイムアウト (ms)。超過で安全側へ倒す。 */
  readonly timeoutMs?: number;
  /** タイムアウト時の既定動作 (security.md: ask/deny の安全側)。 */
  readonly timeoutBehavior?: "deny";
  /** 承認の再起動跨ぎ永続化 (ADR 019ee0c0)。未指定で無効。 */
  readonly persist?: ApprovalPersistConfig;
  /**
   * bypass/YOLO の high-risk カテゴリ承認ポリシー (ADR 019f0c3e)。未指定で bypass=全 defer。
   * **file-level** 設定 (enabled = operator が設定した値)。env kill-switch は `policyEnvEnabled` で別途渡す。
   */
  readonly policy?: ApprovalPolicyConfig;
  /**
   * ADR 019f0eca: per-repo オーバーライド (repoScope→entry)。未指定/空で従来どおり default のみ
   * (machine-global 等価)。gate は操作ごとに cwd→repoScope を解決し repos[scope] を default に優先する。
   */
  readonly policyRepos?: ReadonlyMap<string, RepoPolicyEntry>;
  /**
   * ADR 019f0eca: 操作の cwd→repoScope 解決器 (per-repo policy 用)。未指定なら per-repo 解決を行わず
   * 常に default を使う (後方互換)。persist の resolveRepoScope と同一実体を daemon 配線で共有する。
   * repos が空のときは呼ばれない (git を叩かない最適化)。
   */
  readonly resolveRepoScope?: RepoScopeResolver;
  /**
   * ADR 019f0c3e Phase 2: env kill-switch (`ACTRADECK_BYPASS_CATASTROPHIC_GATE`) の解決結果。
   * 既定 true。false なら live gate の enabled へ AND で OFF を強制する (file-level enabled は保持)。
   * file-level と env を分離して持つことで、UI set 後の live 再構築 (file.enabled && env) を正しく行う。
   */
  readonly policyEnvEnabled?: boolean;
  /**
   * ADR 019f0c3e Phase 2 / 019f0eca / TDA-R1 (019f0f64): setPolicyConfig/removePolicyRepo が変更した
   * **単一 delta** を disk へ永続するコールバック (daemon が approval-policy-store.applyPolicyDelta を渡す)。
   * full layered の overwrite でなく delta を read-modify-write することで、stale daemon が他 daemon の
   * override を disk から落とす silent downgrade を防ぐ。未指定なら memory のみ更新 (テスト用)。
   * env kill-switch は **渡さない** (非永続)。
   */
  readonly persistPolicy?: (delta: PolicyDelta) => void;
  /**
   * L2(b) (decision 019f0e5d): safePersist が disk-write 失敗を吸収したときに **件数のみ** operator へ
   * surface するコールバック (daemon が cli の stderr `[approval-persist]` へ配線)。未指定なら計上のみ
   * (persistFailureCount は依然 queryable)。NO-RAW: 生 fs エラーは渡さない (非負整数の累計のみ)。
   */
  readonly onPersistFailure?: (count: number) => void;
}

export class ApprovalBridge {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly timeoutMs: number;
  /**
   * 段階③: allow_for_session で人間が許可した操作の署名集合 (セッション内 = この sidecar
   * プロセスの寿命内のみ)。命中した同一署名の以降の要求は UI を経ず即 allow する。
   * **同一署名 (tool+risk+command/path) のみ**で、別 tool/別 risk/別コマンドは命中しない
   * (過剰 allow 防止・ADR 019e99ad scope=exact-signature)。プロセス終了で消える (永続しない)。
   */
  private readonly sessionAllowSignatures = new Set<string>();

  /** 永続 allowlist 設定 (ADR 019ee0c0)。未指定 (undefined) で機能無効。 */
  private readonly persist: ApprovalPersistConfig | undefined;
  /** 現在時刻 (注入可・既定 Date.now)。永続 TTL/expiry 判定に使う。 */
  private readonly now: () => number;
  /**
   * ADR 019f0c3e Phase 2 / 019f0eca: **file-level** の default policy (operator 設定値・env 非適用)。
   * 未指定で bypass=全 defer。live は effectiveLivePolicy(scope) が deriveLivePolicy(file) で env-AND 後に
   * 操作ごと導出する (machine-global の単一 live フィールドは廃止し per-op 解決へ)。
   */
  private policyDefaultFile: ApprovalPolicyConfig | undefined;
  /**
   * ADR 019f0eca: per-repo オーバーライド (repoScope→entry) の **file-level** map。setPolicyConfig/
   * removePolicyRepo で更新するため mutable。空なら gate は git を叩かず default のみを使う。
   */
  private policyRepos: Map<string, RepoPolicyEntry>;
  /** ADR 019f0c3e Phase 2: env kill-switch の解決結果 (process 寿命内不変・既定 true)。 */
  private readonly policyEnvEnabled: boolean;
  /** ADR 019f0c3e Phase 2 / 019f0eca / TDA-R1: 変更した単一 delta の永続コールバック (未指定なら memory のみ)。 */
  private readonly persistPolicy: ((delta: PolicyDelta) => void) | undefined;
  /** ADR 019f0eca: 操作の cwd→repoScope 解決器 (未指定なら per-repo 解決せず default のみ)。 */
  private readonly resolveRepoScope: RepoScopeResolver | undefined;
  /** L2(b) (decision 019f0e5d): persist 失敗の operator surface コールバック (未指定なら計上のみ)。 */
  private readonly onPersistFailure: ((count: number) => void) | undefined;

  constructor(opts: ApprovalBridgeOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.persist = opts.persist;
    this.now = opts.persist?.now ?? (() => Date.now());
    this.policyEnvEnabled = opts.policyEnvEnabled ?? true;
    this.persistPolicy = opts.persistPolicy;
    this.onPersistFailure = opts.onPersistFailure;
    this.policyDefaultFile = opts.policy;
    this.policyRepos = new Map(opts.policyRepos ?? []);
    this.resolveRepoScope = opts.resolveRepoScope;
  }

  /**
   * TDA-3 (decision 019f0e2d): file-level policy から **live** policy を導出する単一出所。
   * env kill-switch を AND する (`file.enabled && policyEnvEnabled`)。categories は env 非依存でそのまま。
   * constructor と setPolicyConfig が共有し env-AND ロジックの 2 重インラインを排除する
   * (将来 live 導出規則を変えても片側漏れしない)。policyEnvEnabled は呼出前に確定している前提。
   */
  private deriveLivePolicy(file: ApprovalPolicyConfig): ApprovalPolicyConfig {
    return { enabled: file.enabled && this.policyEnvEnabled, categories: file.categories };
  }

  /**
   * ADR 019f0eca: 操作の resolved repoScope から **live** な effective policy を導出する単一出所。
   * file-level effective = `repos.get(scope) ?? default` を deriveLivePolicy で env-AND する。
   * default 未設定なら undefined (= bypass 全 defer)。scope undefined / repo 未登録は default へフォール
   * バック (fail-safe: 非 git/解決不能は厳格側 default・decision 019f0ecd)。
   */
  private effectiveLivePolicy(scope: string | undefined): ApprovalPolicyConfig | undefined {
    if (this.policyDefaultFile === undefined) return undefined;
    const file =
      (scope !== undefined ? this.policyRepos.get(scope) : undefined) ?? this.policyDefaultFile;
    return this.deriveLivePolicy(file);
  }

  /**
   * 永続化対象 (medium-risk bash) か。high/secret/.env編集/MCP/WebFetch は false。
   * codex/CC PermissionRequest は呼び元で hook_event_name により除外するため、ここは bash 判定のみ。
   *
   * ADR 019ee0c0 / SEC-1/1a/1b/1c: medium でも **構造ゲート** (isPersistDeniedCommand) が永続不可と
   * 判定したものは false。合成メタ文字 (パイプ/置換/連結/リダイレクト/サブシェル)・危険 program
   * (権限昇格/インタプリタ inline/publish/network-exec/shell/ラッパ・version 接尾辞や `\`/クォートも
   * 分類器と同一正規化で正規化)・find -exec を排除する。承認ゲート自体は不変で「再起動後も無人
   * auto-allow」だけを禁じ「危険でないものに限り永続」の脅威モデル前提を守る。
   */
  private isPersistableBash(input: HookCommonInput): boolean {
    const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
    if (classifyTool(toolName) !== "bash") return false;
    const command = (input.tool_input as { command?: unknown } | undefined)?.command;
    if (typeof command !== "string") return false;
    if (classifyCommandRisk(command) !== "medium") return false;
    if (isPersistDeniedCommand(command)) return false; // SEC-1/1a/1b/1c: 構造ゲートで永続不可 (degrade)
    return true;
  }

  /**
   * 段階③: 操作の署名を算出する (allow_for_session の同一性判定キー)。
   * `sha256(JSON.stringify([kind, risk, operand]))`。**operand (command/path/args) を平文保持しない**
   * ためハッシュ化する (cache はメモリ内のみだが secret 混入の二重防御)。
   *
   * SEC-1 (ADR 019e9b7a): 3 フィールドを **JSON 配列でエンコード**してから hash する。JSON は
   * 各要素を quote/escape で曖昧さなく区切るため、どんな文字が operand に出現しても異なる
   * (kind, risk, operand) が同一署名に潰れることが**構造的に不能** (語彙非依存の collision-proof)。
   * 同一操作 → 同一署名、別操作 (別コマンド/別パス/別 risk/別 tool) → 必ず別署名で scope 越境を防ぐ。
   */
  private computeSignature(input: HookCommonInput): string {
    const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
    const kind = classifyTool(toolName);
    const toolInput = (input.tool_input ?? {}) as { command?: unknown; file_path?: unknown };
    let risk = "n/a";
    let operand: string;
    if (kind === "bash" && typeof toolInput.command === "string") {
      risk = classifyCommandRisk(toolInput.command);
      operand = toolInput.command;
    } else if (kind === "edit" && typeof toolInput.file_path === "string") {
      operand = toolInput.file_path;
    } else {
      // mcp / websearch / other: tool 名 + 入力全体で識別 (args 差異を別署名にする)。
      let inputJson = "";
      try {
        inputJson = JSON.stringify(input.tool_input ?? null);
      } catch {
        inputJson = "<unserializable>"; // 異常入力は fail-safe で固定文字列 (別操作と衝突しても再承認側)。
      }
      operand = `${toolName}\0${inputJson}`;
    }
    return encodeOperationSignature(kind, risk, operand);
  }

  /**
   * request_id を高エントロピーで採番する (3#SEC-1)。
   *
   * 旧実装は `${sessionId}:apr-${Date.now()}-${seq}` で Date.now/連番が予測容易だった。
   * inbound 制御チャネル (WsClient) は同チャネルに request_id を observable にするため、
   * 予測可能な id は「foreign request_id 拒否 (SEC-2)」ゲートを総当たりで突破されうる。
   * 16 byte (128bit) の暗号乱数を base64url 化し、sessionId プレフィックスは「自セッション
   * スコープ判定 (SEC-2)」のために残す (突合は乱数部で行う)。
   */
  private nextRequestId(sessionId: string): string {
    return `${sessionId}:apr-${randomBytes(16).toString("base64url")}`;
  }

  /**
   * 既存の destructive 判定 (rm -rf / .env 編集 / MCP / WebFetch)。secret 判定とは独立で、
   * 自動ガード (D4) はこの結果を保持しつつ secret 検出を OR する。挙動は従来と非退行。
   */
  private requiresDestructiveApproval(input: HookCommonInput): boolean {
    const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
    const kind = classifyTool(toolName);
    const toolInput = (input.tool_input ?? {}) as { command?: unknown; file_path?: unknown };
    if (kind === "bash" && typeof toolInput.command === "string") {
      return classifyCommandRisk(toolInput.command) !== "low";
    }
    // .env / secret / credential ファイルへの編集は常に承認。
    // fail-safe ゲート: secret らしき path は「広めの部分一致」で承認に倒す。
    //   - 部分一致は意図的: over-approval が安全側。anchor (^/$) を足すと網が狭まり
    //     "mysecret_notes" 等を取りこぼすため、CodeQL の missing-anchor 指摘は本ゲートでは
    //     不採用 (anchoring は coverage を縮小する=安全と逆)。
    //   - `.key` は末尾固定にしない: "server.key.bak" 等の鍵バックアップも承認に含める。
    //   - SSH 秘密鍵は 4 種 (rsa/ed25519/ecdsa/dsa)、keystore (.p12/.pfx/.jks)、credential
    //     file (.netrc/.pgpass/.npmrc)、kubeconfig も対象 (QA-1/SEC-2: 取りこぼし防止)。
    if (kind === "edit" && typeof toolInput.file_path === "string") {
      return SECRET_FILE_PATH_RE.test(toolInput.file_path);
    }
    // 再#SEC-3: MCP tool 呼び出しは高リスク (副作用・credential server を含む)。
    // 個々の MCP server の安全性を sidecar は判定できない → 判定不能は high に倒す
    // (fail-safe; security.md「判定不能→high」)。
    if (kind === "mcp") return true;
    // 再#SEC-3: WebFetch は外部/内部 URL へ到達しうる (SSRF / メタデータ endpoint)。承認必須。
    // WebSearch (検索クエリのみ) は副作用が無いため defer のまま。
    if (kind === "websearch" && toolName === "WebFetch") return true;
    return false;
  }

  /**
   * 自動ガード (ADR 019ecc70 D1/D2): tool_input に secret が含まれるか検出する。
   *
   * - 検出述語は **単一出所** = redactor の既存 `redactString`。新正規表現は作らない。
   *   判定は `redactString(x) !== x` (= 何かマスクされた = secret 検出。ReDoS 既存有界)。
   * - 対象フィールドは ADR D2 の **閉じたリスト**のみ:
   *     Bash → command / Write・Edit 系 → content (+ new_string/new_str) + file_path /
   *     MCP (mcp__*) → tool_input payload (JSON.stringify を redactString に通す・bounded)。
   *   それ以外の tool は段階1 ではスキャンしない (段階2 拡張・D8)。
   * - secretKinds は **redacted 文字列から** countRedactionMarkersByKind で算出し、
   *   REDACTION_KINDS allowlist (isKnownRedactionKind) のみ採る。**raw 値からは作らない**
   *   (INV-AUTOGUARD-NO-RAW)。raw は述語評価のために読むが戻り値/emit/ログに残さない。
   *
   * 戻り値: { secret: boolean; kinds: string[] }。secret=false のとき kinds=[]。
   */
  private detectSecretInInput(input: HookCommonInput): { secret: boolean; kinds: string[] } {
    const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
    const kind = classifyTool(toolName);
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;

    // D2: スキャン対象フィールドを閉じたリストで収集する (それ以外は段階1 で見ない)。
    const fields: string[] = [];
    if (kind === "bash") {
      if (typeof toolInput.command === "string") fields.push(toolInput.command);
    } else if (kind === "edit") {
      // Write/Edit/MultiEdit/NotebookEdit の本文系 + file_path。
      for (const key of ["content", "new_string", "new_str"]) {
        const v = toolInput[key];
        if (typeof v === "string") fields.push(v);
      }
      if (typeof toolInput.file_path === "string") fields.push(toolInput.file_path);
    } else if (kind === "mcp") {
      // MCP payload 全体を JSON 文字列化して走査 (失敗時は fail-safe で空文字 = 非検出側だが
      // MCP は destructive ゲートで別途必ず gated になるため secret 未検出でも承認は出る)。
      try {
        fields.push(JSON.stringify(input.tool_input ?? null));
      } catch {
        // 直列化不能な入力は走査不能。MCP は requiresDestructiveApproval=true で gated 済。
      }
    }
    // それ以外の tool (websearch/other): 段階1 はスキャンしない。

    const kinds = new Set<string>();
    let secret = false;
    for (const field of fields) {
      if (field.length === 0) continue;
      // 単一述語: redactString が値を変えた = secret 検出 (raw は保持しない)。
      const redacted = redactString(field);
      if (redacted !== field) {
        secret = true;
        // kind は **redacted 文字列由来** (raw 由来でない)。allowlist のみ採る。
        for (const k of Object.keys(countRedactionMarkersByKind(redacted))) {
          if (isKnownRedactionKind(k)) kinds.add(k);
        }
      }
    }
    return { secret, kinds: [...kinds] };
  }

  /**
   * この hook が UI 承認を要するか (ADR 019ecc70 D4)。
   * destructive 判定 (従来) と secret 検出 (新規) を **OR** し、両立で trigger="both"。
   * gated=false のときは従来どおり defer (force-allow しない)。
   */
  private requiresHumanApproval(input: HookCommonInput): GateDecision {
    const destructive = this.requiresDestructiveApproval(input);
    const { secret, kinds } = this.detectSecretInInput(input);
    if (!destructive && !secret) return { gated: false, secretKinds: [] };
    const trigger: ApprovalTrigger =
      destructive && secret ? "both" : secret ? "secret" : "destructive";
    // secretKinds は secret-trigger のときのみ意味を持つ (destructive-only は [])。
    return { gated: true, trigger, secretKinds: secret ? kinds : [] };
  }

  /**
   * PermissionRequest (CC PermissionRequest / codex 承認 ServerRequest) のゲート判定 (ADR 019ecc70
   * 段階2)。要求自体が承認を要するため **常時 gated**。これは不変 (codex は既に承認を要求している)。
   * 加えて tool_input に secret があれば trigger を destructive→both へ昇格し secretKinds を付与する:
   *   - 承認カードに secret 種別 (REDACTION_KINDS 名) を表示できる。
   *   - secret-trigger (both) は D5 で allow_for_session の auto-allow 非対象になる。
   * secret 無しは従来どおり destructive-only (非退行)。codex で tool_input が無い承認
   * (file/permissions) は detectSecretInInput が空を返し従来挙動。
   */
  private gatePermissionRequest(input: HookCommonInput): GateDecision {
    const { secret, kinds } = this.detectSecretInInput(input);
    return {
      gated: true,
      trigger: secret ? "both" : "destructive",
      secretKinds: secret ? kinds : [],
    };
  }

  /**
   * ADR 019f0c3e: この操作が該当する high-risk カテゴリ集合。command 系は分類器 (classifyCommandCategories・
   * 単一ソース) を使い、secret-egress (network-egress program + secret-in-input) / secret-file-edit (秘匿
   * path) / external-tool (MCP・WebFetch) は approval-bridge 側で composite 判定する。
   */
  private opCategories(input: HookCommonInput): Set<PolicyCategory> {
    const out = new Set<PolicyCategory>();
    const toolName = typeof input.tool_name === "string" ? input.tool_name : "";
    const kind = classifyTool(toolName);
    const toolInput = (input.tool_input ?? {}) as { command?: unknown; file_path?: unknown };
    if (kind === "bash" && typeof toolInput.command === "string") {
      for (const c of classifyCommandCategories(toolInput.command)) out.add(c);
      // secret-egress: 外部送出 program + tool_input の **inline** secret (composite)。raw は保持しない
      //   (述語評価のみ)。限界 (SEC-2): コマンド文字列に直接含まれる secret のみ検出し、`curl --data @.env` /
      //   `scp .env host:` のファイル参照 exfil は非対象 (redaction と同じ inline 検出の限界・security.md 開示)。
      if (isNetworkEgressCommand(toolInput.command) && this.detectSecretInInput(input).secret) {
        out.add("secret-egress");
      }
    } else if (kind === "edit" && typeof toolInput.file_path === "string") {
      if (SECRET_FILE_PATH_RE.test(toolInput.file_path)) out.add("secret-file-edit");
    } else if (kind === "mcp") {
      out.add("external-tool");
    } else if (kind === "websearch" && toolName === "WebFetch") {
      out.add("external-tool");
    }
    return out;
  }

  /**
   * ADR 019f0c3e: 操作の category ∩ ポリシーで有効化された category。空なら bypass で defer。
   * ADR 019f0eca: enabled set は effectiveLivePolicy(scope) の categories を呼び元が渡す (per-op)。
   */
  private matchedPolicyCategories(
    input: HookCommonInput,
    enabled: ReadonlySet<PolicyCategory>,
  ): Set<PolicyCategory> {
    const matched = new Set<PolicyCategory>();
    for (const c of this.opCategories(input)) if (enabled.has(c)) matched.add(c);
    return matched;
  }

  /**
   * ADR 019f0c3e: bypass policy match から GateDecision を作る。secret 系 category (secret-egress /
   * secret-file-edit) が絡むと trigger を secret/both へ昇格し secretKinds を付与する (承認カードに
   * 種別表示 + D5 で allow_for_session auto-allow 非対象)。destructive-only は trigger="destructive"。
   */
  private policyGateDecision(matched: Set<PolicyCategory>, input: HookCommonInput): GateDecision {
    const secretInvolved = matched.has("secret-egress") || matched.has("secret-file-edit");
    const destructiveInvolved = [...matched].some(
      (c) => c !== "secret-egress" && c !== "secret-file-edit",
    );
    const kinds = secretInvolved ? this.detectSecretInInput(input).kinds : [];
    const trigger: ApprovalTrigger =
      secretInvolved && destructiveInvolved ? "both" : secretInvolved ? "secret" : "destructive";
    return { gated: true, trigger, secretKinds: secretInvolved ? kinds : [] };
  }

  /**
   * 承認を要求する。emitRequest は「承認要求イベント」を発行するコールバック
   * (UI が承認カードを出せる)。UI から resolve() が来るか、タイムアウトで安全側に倒す。
   *
   * PreToolUse の low-risk は即 allow (defer 相当) で通常フローを妨げない。
   */
  async requestApproval(
    input: HookCommonInput,
    emitRequest: (requestId: string, reason: GuardReason) => void,
  ): Promise<ApprovalResult> {
    // bypassPermissions (`--dangerously-skip-permissions`): ユーザーが全 permission を明示的に
    // スキップしている。ActraDeck は CC が選んだモードより強いゲートを課さず純観測に徹する
    // (ユーザー指示・decision 019eace6)。force-allow せず **defer** = native flow へ委譲する
    // ため INV-APPROVAL を維持しつつ、bypass では即実行される (承認カード=emitRequest を出さない)。
    // 観測は呼び元 hook-receiver の defer 経路が PreToolUse を従来どおり ingest する。
    // ⚠️ 注意: 既定/acceptEdits/plan など bypassPermissions 以外のモードでは従来どおり高リスクを
    // ゲートする (decision 019e8e71 の破壊的操作ゲートを当該モードでは温存)。
    // ADR 019f0c3e: bypassPermissions (`--dangerously-skip-permissions`) では従来 (decision 019eace6) は
    //   全 defer (純観測) だった。本変更で **operator がポリシーで有効化した high-risk カテゴリのみ** 既存
    //   Web UI 承認フローへ落とす (それ以外は従来どおり defer)。policy 未設定 / enabled=false (kill-switch
    //   ACTRADECK_BYPASS_CATASTROPHIC_GATE=0) では従来どおり全 defer (純パススルー)。
    //   CC の PreToolUse フック deny は bypassPermissions でも honor される (検証済) ため、ここでのゲートは
    //   alert でなく **本物の予防** (timeout→deny で無人 YOLO は安全側に縮退)。
    let bypassPolicyGate: GateDecision | undefined;
    if (input.permission_mode === "bypassPermissions") {
      // ADR 019f0eca: 操作ごとに cwd→repoScope を解決し effective = repos[scope] ?? default を引く。
      //   repos が空なら git を叩かず default のみ (最適化・従来挙動と同等)。解決不能 (非 git/cwd 無し)
      //   は scope undefined → effectiveLivePolicy が default へフォールバック (fail-safe・厳格側)。
      let scope: string | undefined;
      if (this.policyRepos.size > 0 && this.resolveRepoScope !== undefined) {
        const resolved = await this.resolveRepoScope(input.cwd);
        scope = resolved?.scope;
      }
      const live = this.effectiveLivePolicy(scope);
      if (live === undefined || !live.enabled) {
        return {
          behavior: "defer",
          reason: "bypassPermissions: user opted out of approval gating",
        };
      }
      const matched = this.matchedPolicyCategories(input, live.categories);
      if (matched.size === 0) {
        return { behavior: "defer", reason: "bypassPermissions: no policy-gated category matched" };
      }
      bypassPolicyGate = this.policyGateDecision(matched, input);
    }

    // PermissionRequest は常にゲート (要求自体が承認要)。PreToolUse は requiresHumanApproval。
    // ADR 019ecc70 段階2: PermissionRequest でも tool_input があれば secret-in-input を検出し、
    //   destructive 常時ゲートに secret-trigger を OR する (codex 承認経路の secret 可視化 + D5)。
    // ADR 019f0c3e: bypass policy match のときは policyGateDecision を優先する (broad な destructive gate
    //   でなく operator が選んだ category のみゲート)。
    const gate: GateDecision =
      bypassPolicyGate ??
      (input.hook_event_name === "PermissionRequest"
        ? this.gatePermissionRequest(input)
        : this.requiresHumanApproval(input));

    if (!gate.gated) {
      // ゲート対象外: force-allow せず通常 permission flow に委ねる (INV-APPROVAL)。
      return { behavior: "defer", reason: "not gated; defer to normal permission flow" };
    }

    const trigger: ApprovalTrigger = gate.trigger ?? "destructive";

    // ADR 019ecc70 D5: secret-trigger (secret|both) は allow_for_session の auto-allow 非対象。
    // secret 露出は sensitive・文脈依存ゆえ「一度許可=同型無人 allow」を許さない (放牧の安全性)。
    // destructive-only は従来どおり cache を使う。
    const secretTriggered = trigger === "secret" || trigger === "both";

    const signature = this.computeSignature(input);

    // 段階③: 同一署名を allow_for_session で人間が許可済みなら、UI を経ず即 allow する
    // (in-memory・cheap・先に確認)。**同一署名のみ**命中するため、別操作は依然ゲートされる。
    // D5: secret-trigger は cache をバイパスし常に UI 承認を要求する。
    // ADR 019f0c3e (SEC-1): bypass policy ゲートでは session-allow cache も無効化する。永続 allowlist
    //   (下記) と対称に、YOLO で一度 allow_for_session した catastrophic を以降 UI を経ず無人 auto-allow
    //   しない (bypass では cacheable=false で登録もされないが、明示ガードで二重に塞ぐ)。
    if (
      bypassPolicyGate === undefined &&
      !secretTriggered &&
      this.sessionAllowSignatures.has(signature)
    ) {
      return {
        behavior: "allow",
        reason: "allow_for_session: matching signature previously approved this session",
        autoAllowed: true,
      };
    }

    // ADR 019ee0c0: 永続 allowlist (再起動跨ぎ)。eligibility = feature-ON + 非 secret +
    // **PreToolUse の medium-bash** (codex/PermissionRequest・high・edit・mcp・websearch は構造的に除外)
    // + repo 解決可。repo スコープ解決は eligible なときだけ行う (非対象では git を叩かない)。
    let persistable = false;
    let repoScope: string | undefined;
    let repoLabel: string | undefined;
    if (
      // ADR 019f0c3e: 永続 allowlist は通常モード用。bypass policy ゲートでは無効化する (YOLO で
      //   catastrophic grant を再起動跨ぎ無人 auto-allow しない)。
      bypassPolicyGate === undefined &&
      this.persist?.enabled === true &&
      !secretTriggered &&
      input.hook_event_name === "PreToolUse" &&
      this.isPersistableBash(input)
    ) {
      const resolved = await this.persist.resolveRepoScope(input.cwd);
      if (resolved !== undefined) {
        repoScope = resolved.scope;
        repoLabel = resolved.label;
        persistable = true;
        // ディスク署名命中 → UI を経ず即 allow (persistGrant)。期限切れは has が false を返す。
        if (this.persist.store.has(signature, repoScope, this.now())) {
          return {
            behavior: "allow",
            reason: "persistent allowlist: matching signature previously persisted for this repo",
            autoAllowed: true,
            persistGrant: true,
          };
        }
      }
    }

    const reason: GuardReason = { trigger, secretKinds: gate.secretKinds, persistable };

    const requestId = this.nextRequestId(input.session_id);
    emitRequest(requestId, reason);

    return new Promise<ApprovalResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ behavior: "deny", reason: "approval timeout (safe default: deny)" });
      }, this.timeoutMs);
      // D5: secret-trigger は resolve で allow_for_session が来ても署名を登録しない
      // (cacheable=false)。destructive-only のみ後で cache 登録しうる。
      // ADR 019f0c3e (SEC-1): bypass policy ゲート (bypassPolicyGate !== undefined) も cacheable=false。
      //   YOLO で人間が allow_for_session しても session cache へ署名登録せず、同型 catastrophic 再要求でも
      //   毎回 UI 承認を要求する (永続 allowlist の bypass 無効化と対称)。
      // ADR 019ee0c0: persistable / repoScope を保持し、resolve の persist=true で disk 登録する。
      this.pending.set(requestId, {
        resolve,
        timer,
        signature,
        cacheable: bypassPolicyGate === undefined && !secretTriggered,
        persistable,
        ...(repoScope !== undefined ? { repoScope } : {}),
        ...(repoLabel !== undefined ? { repoLabel } : {}),
      });
    });
  }

  /**
   * SEC-R2-1 (decision 019f0d22): disk 永続の副作用を **crash-safe** に実行する共有ヘルパ。
   * 戻り値 = 成功なら true / 同期 throw を吸収したら false。
   *
   * 承認永続 (store.add)・allowlist 失効 (store.revoke)・policy 永続 (persistDelta→applyPolicyDelta) はいずれも
   * `withFileLock`→`writeJson0600` 経由で ENOSPC/EACCES/EROFS や mkdirSync/openSync の **同期 throw** を
   * しうる。これらの control handler は同期 emit (ws-client) で呼ばれるため、throw を素通しさせると
   * uncaughtException → daemon crash になる。primary な in-memory 効果 (承認解決 / live gate 更新) は
   * 呼び元で throw の前に確定させ、本ヘルパで disk 失敗のみ吸収する (per-site try/catch の散在を防ぐ
   * 単一出所・ws-client の emit chokepoint backstop と二段構え)。
   *
   * TDA-R3-3 / SEC-R3-1: 吸収した失敗は `persistFailures` に計上する。観測製品ゆえ系統的 disk 障害
   * (disk full 等) が無 signal にならないよう **件数のみ**可視化する (生 fs エラーは NO-RAW で保持しない)。
   * L2(b) (decision 019f0e5d): 計上に加え `onPersistFailure(count)` で operator へ即 surface する
   * (daemon が cli stderr `[approval-persist]` へ配線・件数=非負整数のみ・queryable な getter も併存)。
   */
  private persistFailures = 0;

  private safePersist(fn: () => void): boolean {
    try {
      fn();
      return true;
    } catch {
      this.persistFailures += 1;
      // L2(b): operator へ件数のみ surface (NO-RAW: catch は error を束縛しない=生 fs エラー非伝播)。
      // SEC-1 (decision 019f0e7d): surface (cli stderr の同期 write) が ENOSPC/EPIPE 等で同期 throw しても
      // safePersist の no-throw 契約 (SEC-R2-1 layer-1) を貫通させない。best-effort 診断は crash-safety と
      // 後続の primary 効果 (p.resolve / live-gate 更新) を壊してはならない (相関 disk 障害でこそ壊れる自己矛盾を防ぐ)。
      try {
        this.onPersistFailure?.(this.persistFailures);
      } catch {
        /* surface 失敗は握り潰す: 診断は best-effort・吸収層 (return false) を弱めない。 */
      }
      return false;
    }
  }

  /** 吸収した永続失敗の累計件数 (診断用・TDA-R3-3 / SEC-R3-1・非負整数・原文非依存)。 */
  get persistFailureCount(): number {
    return this.persistFailures;
  }

  /**
   * UI からの承認決定 (4 値 ApprovalDecision) を解決する (WsClient.approval から呼ばれる)。
   * 段階③:
   *  - allow            → allow。
   *  - allow_for_session → allow + 当該操作の署名を session-allow キャッシュへ登録
   *                        (以降この署名は UI を経ず即 allow)。
   *  - deny             → deny。
   *  - cancel           → deny (安全側。hook には deny を返し pending を破棄)。
   * 4 値以外は呼び出し側 (sidecar.ts) で enum 検証して破棄するため、ここには届かない。
   *
   * ADR 019ee0c0: 第 4 引数 persist=true (UI「再起動後も許可」) は decision=allow_for_session かつ
   * persistable のときのみディスク永続 allowlist へ登録する (非対象は session-only に degrade)。
   */
  resolve(
    requestId: string,
    decision: ApprovalDecision,
    reason?: string,
    persist = false,
  ): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    const behavior: "allow" | "deny" =
      decision === "allow" || decision === "allow_for_session" ? "allow" : "deny";
    // allow_for_session のみ署名を登録 (allow/deny/cancel は登録しない)。
    // D5: secret-trigger (cacheable=false) は allow_for_session でも署名を登録しない
    // (同型 secret 再要求でも UI 承認を要求する = auto-allow 非対象)。
    if (decision === "allow_for_session" && p.cacheable) {
      this.sessionAllowSignatures.add(p.signature);
      // ADR 019ee0c0: persist=true かつ persistable (medium-bash + repo 解決済 + feature-ON) のときのみ
      // ディスクへ永続する。非 persistable で persist=true が来ても session-only に degrade (fail-safe)。
      // 署名は sha256 のみ・生コマンドは保存しない (NO-RAW)。
      if (persist && p.persistable && p.repoScope !== undefined && this.persist?.enabled === true) {
        const store = this.persist.store;
        const ttlMs = this.persist.ttlMs;
        const repoScope = p.repoScope;
        const now = this.now();
        // SEC-R2-1: store.add (withFileLock→writeJson0600) の同期 disk throw を吸収する。永続失敗でも
        // 下の p.resolve は必ず実行し承認を解決する (approval が timeout までハングせず・daemon crash しない)。
        this.safePersist(() =>
          store.add({
            signature: p.signature,
            repoScope,
            ...(p.repoLabel !== undefined ? { repoLabel: p.repoLabel } : {}),
            risk: "medium",
            ttlMs,
            now,
          }),
        );
      }
    }
    p.resolve({ behavior, decision, ...(reason !== undefined ? { reason } : {}) });
    return true;
  }

  /** 保留中の承認件数 (検証・shutdown 用)。 */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * PAL-v2 (ADR 019ee147): 永続化 honor フラグ (UI が dormant 表示するため)。
   * persist 未設定 (機能完全無効) でも false を返す。
   */
  get persistEnabled(): boolean {
    return this.persist?.enabled === true;
  }

  /**
   * PAL-v2: 永続 allowlist を一覧する (期限内のみ・NO-RAW ビュー)。
   * **enabled 非依存**: 管理パネルは実 disk 状態を見せ、無効化中の dormant エントリも掃除できる
   * (honor flag は persistEnabled で別途返す)。persist 未設定なら空。
   */
  listPersistedApprovals(): PersistedApprovalView[] {
    if (this.persist === undefined) return [];
    return this.persist.store.list(this.now()).map((e) => ({
      signature: e.signature,
      repoScope: e.repoScope,
      ...(e.repoLabel !== undefined ? { repoLabel: e.repoLabel } : {}),
      risk: e.risk,
      createdAtMs: e.createdAt,
      expiresAtMs: e.expiresAt,
    }));
  }

  /**
   * PAL-v2: 永続 allowlist の署名を失効する (戻り=除去件数)。repoScope 指定でその scope のみ、
   * 省略で全 scope の同一署名を除去。**enabled 非依存** (除去は新規 grant を作らない安全方向ゆえ、
   * kill-switch OFF でも dormant エントリを掃除できる)。persist 未設定なら 0。
   */
  revokePersistedApproval(signature: string, repoScope?: string): number {
    if (this.persist === undefined) return 0;
    const store = this.persist.store;
    // SEC-R2-1: store.revoke (withFileLock→writeJson0600) の同期 disk throw を吸収する。失敗時は 0 件除去を
    // 返し handler は現状一覧で応答する (daemon crash しない・revoke は除去のみの安全方向ゆえ握り潰して可)。
    let removed = 0;
    this.safePersist(() => {
      removed = store.revoke(signature, repoScope);
    });
    return removed;
  }

  /**
   * ADR 019f0c3e Phase 2: 現在の承認ポリシー (file-level ビュー) を返す。UI 設定パネルが現状表示に使う。
   * enabled は **file-level** (operator 設定値・env kill-switch 非適用)。categories は実際にゲートされる
   * 集合 (空→DEFAULT の fail-safe 適用後)。envGateEnabled は env kill-switch の現状 (false=全体パススルー)。
   * policy 未設定なら enabled=false / 空 categories (= bypass 全 defer を表す)。
   */
  getPolicyConfig(repoScope?: string): PolicyConfigView {
    const def = this.policyDefaultFile;
    // ADR 019f0eca: repoScope 指定時は repo override を返す (無ければ default を継承し isOverride=false)。
    if (repoScope !== undefined) {
      const entry = this.policyRepos.get(repoScope);
      if (entry !== undefined) {
        return {
          enabled: entry.enabled,
          categories: entry.categories,
          envGateEnabled: this.policyEnvEnabled,
          repoScope,
          isOverride: true,
          ...(entry.label !== undefined ? { repoLabel: entry.label } : {}),
        };
      }
      // override 無し → default を継承して表示 (UI が「Default 継承」を示せる)。
      return {
        enabled: def?.enabled ?? false,
        categories: def?.categories ?? new Set<PolicyCategory>(),
        envGateEnabled: this.policyEnvEnabled,
        repoScope,
        isOverride: false,
      };
    }
    return {
      enabled: def?.enabled ?? false,
      categories: def?.categories ?? new Set<PolicyCategory>(),
      envGateEnabled: this.policyEnvEnabled,
    };
  }

  /**
   * ADR 019f0eca 方式B (repo 追加導線): 操作者が入力した絶対パスを **gate と同一の canonical resolver**
   * (resolveRepoScope) で git root 解決し、その repo の effective policy ビューを返す。
   *
   * セキュリティ:
   *  - scope の drift を防ぐため per-op gate と同じ resolveRepoScope を使う (別実装の repo 同定をしない・
   *    security-gate-reuse-canonical-parser)。findRepoRoot は execFile(git・shell 不使用・allowlist env)。
   *  - **生パスは保存しない**。戻り値は scope(sha256短縮)+label(basename)+effective categories のみ
   *    (NO-RAW・file 内容/secret 非開示)。path 文字列自体は echo しない。
   *  - git 管理外 / 解決不能 / resolver 未配線 → undefined (呼び元 policy-relay が error 応答へ)。
   *  - **二段封じ込め (SEC-1・decision 019f0f2f)**: backend の入口 lexical gate (入力 path) は symlink/ancestor
   *    で git root が scope 外へ抜けうる (`git rev-parse --show-toplevel` は symlink を物理解決し祖先へ遡る)。
   *    よって `scope` が渡されたら、解決済の **物理 root** を同 helper (isPathWithinScope) で再照合し、scope 外
   *    (symlink 脱出) や scope の **上位** (ancestor-root) を undefined で拒否する。root が取れない解決結果も
   *    安全側で拒否する。scope 省略/空 = 封じ込め無し (backend が default-off のとき)。
   */
  async getPolicyConfigForPath(
    path: string,
    scope: readonly string[] = [],
  ): Promise<PolicyConfigView | undefined> {
    if (this.resolveRepoScope === undefined) return undefined;
    const resolved = await this.resolveRepoScope(path);
    if (resolved === undefined) return undefined;
    // SEC-1: 解決済 root を scope と再照合 (二段封じ込め)。scope 非空のとき root 必須・配下のみ許可。
    if (scope.length > 0 && !isPathWithinScope(resolved.root, scope)) return undefined;
    const view = this.getPolicyConfig(resolved.scope);
    // override 未存在でも UI が repo 名を表示できるよう resolver の basename を補う。
    if (resolved.label !== undefined && view.repoLabel === undefined) {
      return { ...view, repoLabel: resolved.label };
    }
    return view;
  }

  /** ADR 019f0eca: per-repo オーバーライド一覧 (UI の左ペイン用)。label→scope の安定順。 */
  listPolicyRepos(): Array<{ scope: string } & RepoPolicyEntry> {
    return [...this.policyRepos.entries()]
      .map(([scope, e]) => ({ scope, ...e }))
      .sort(
        (a, b) =>
          (a.label ?? a.scope).localeCompare(b.label ?? b.scope) || a.scope.localeCompare(b.scope),
      );
  }

  /**
   * ADR 019f0c3e Phase 2 / 019f0eca: 承認ポリシーを更新する (**認証済み control channel relay からのみ**呼ぶ)。
   * partial update — 指定フィールドのみ変更し未指定は現状維持。memory (live gate) と disk
   * (persistDelta→applyPolicyDelta 経由・delta ベース RMW で当該 1 キーのみ永続) の双方を追従させる。
   *
   * scope 指定時 (repoScope) は **per-repo オーバーライド** を更新/作成する。default と異なり categories が
   * 空でも DEFAULT へ縮退しない (空=「この repo は何も gate しない」という正当な選択・full override・
   * hard-floor 無し・decision 019f0ecd)。scope 省略時は **default** を更新し、空→DEFAULT_GATED_CATEGORIES
   * へ縮退する fail-safe を維持する (out-of-box 安全・load と一致)。env kill-switch は非永続で live にのみ AND。
   * 戻り値は更新後の当該 scope ビュー。
   */
  setPolicyConfig(update: {
    readonly enabled?: boolean;
    readonly categories?: ReadonlySet<PolicyCategory>;
    readonly repoScope?: string;
    readonly repoLabel?: string;
    /**
     * TDA-1 (decision 019f0f2f): false なら memory (live gate) のみ更新し disk へ永続しない。
     * multi-daemon fan-out の伝播コピー (backend fanOutPolicyMutation) からのみ false で渡る。
     * 省略=true で従来どおり owner が disk を権威更新する。受信 daemon が disk を書かないことで、
     * 再接続後の stale daemon が full layered を書戻して厳格 override を黙って消す downgrade を防ぐ。
     */
    readonly persist?: boolean;
  }): PolicyConfigView {
    if (update.repoScope !== undefined) {
      // per-repo オーバーライド: partial update (既存エントリを base に)。空 categories も honor。
      const base = this.policyRepos.get(update.repoScope);
      const enabled = update.enabled ?? base?.enabled ?? true;
      const categories =
        update.categories !== undefined
          ? new Set<PolicyCategory>(update.categories)
          : new Set<PolicyCategory>(base?.categories ?? []);
      const label = update.repoLabel ?? base?.label;
      const entry: RepoPolicyEntry = {
        enabled,
        categories,
        ...(label !== undefined ? { label } : {}),
      };
      this.policyRepos.set(update.repoScope, entry);
      const persistError =
        update.persist === false
          ? undefined
          : this.persistDelta({ kind: "set-repo", scope: update.repoScope, entry });
      return {
        ...this.getPolicyConfig(update.repoScope),
        ...(persistError !== undefined ? { persistError } : {}),
      };
    }
    // default: 空→DEFAULT へ fail-safe (load と同一・silent 全 OFF を防ぐ)。無効化は enabled=false で。
    const enabled = update.enabled ?? this.policyDefaultFile?.enabled ?? true;
    const rawCats =
      update.categories ?? this.policyDefaultFile?.categories ?? new Set<PolicyCategory>();
    const categories =
      rawCats.size > 0
        ? new Set<PolicyCategory>(rawCats)
        : new Set<PolicyCategory>(DEFAULT_GATED_CATEGORIES);
    this.policyDefaultFile = { enabled, categories };
    const persistError =
      update.persist === false
        ? undefined
        : this.persistDelta({ kind: "set-default", config: this.policyDefaultFile });
    return {
      ...this.getPolicyConfig(undefined),
      ...(persistError !== undefined ? { persistError } : {}),
    };
  }

  /**
   * ADR 019f0eca: per-repo オーバーライドを削除し default 継承へ戻す (UI「Default に戻す」)。memory+disk
   * を追従。戻り値は当該 scope のビュー (isOverride=false で default を継承)。
   *
   * TDA-1 (decision 019f0f2f): opts.persist===false は memory のみ反映し disk を書かない (fan-out 受信側)。
   */
  removePolicyRepo(repoScope: string, opts?: { readonly persist?: boolean }): PolicyConfigView {
    this.policyRepos.delete(repoScope);
    const persistError =
      opts?.persist === false
        ? undefined
        : this.persistDelta({ kind: "remove-repo", scope: repoScope });
    return {
      ...this.getPolicyConfig(repoScope),
      ...(persistError !== undefined ? { persistError } : {}),
    };
  }

  /**
   * 変更した **単一 delta** を disk へ crash-safe に永続する。成功なら undefined、失敗なら固定文言の
   * persistError (生 fs パス非含) を返す。setPolicyConfig/removePolicyRepo の disk 追従の単一出所。
   *
   * TDA-R1 (decision 019f0f64): full layered の overwrite でなく delta を渡す。永続側 (applyPolicyDelta) が
   * disk を withFileLock で read-modify-write し、自 memory に無い他 daemon の override を**落とさない**
   * (multi-writer disk-completeness)。SEC-1 (019f0d07) + SEC-R2-1 (019f0d22): safePersist で
   * ENOSPC/EACCES/RO-fs/lock 失敗を吸収し daemon を落とさない (memory=live gate は呼び元で更新済み)。
   */
  private persistDelta(delta: PolicyDelta): string | undefined {
    const persisted = this.safePersist(() => this.persistPolicy?.(delta));
    return persisted ? undefined : "policy applied in memory but failed to persist to disk";
  }

  /** shutdown 時に保留を安全側 (deny) で解決。 */
  drain(): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ behavior: "deny", reason: "sidecar shutdown (safe default: deny)" });
    }
    this.pending.clear();
    // TDA-1 (ADR 019e9b7a): session-allow 署名キャッシュも破棄する。allow_for_session は
    // 「セッション内のみ」の意図で、shutdown/drain 後に持ち越さない (次回起動は再承認)。
    this.sessionAllowSignatures.clear();
    // ADR 019ee0c0: 永続 allowlist (disk) は **意図的にクリアしない**。再起動跨ぎ永続が機能の目的で、
    // 失効は TTL 自動失効 / CLI revoke|clear が担う (drain で消すと「再起動後も許可」が無意味になる)。
  }
}
