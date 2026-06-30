/**
 * approval-policy-store — bypass/YOLO 承認ポリシー (ADR 019f0c3e) の永続 (read) + env 解決の単一出所。
 *
 * **memory-authoritative**: sidecar 起動時に `~/.actradeck/approvals/policy.json` を **once だけ** 読み、
 * ApprovalBridge へ memory 注入する。実行中はディスクを hot-reload **しない** (YOLO 中のエージェントが
 * policy.json を書換えても live gate を弱められないようにするため・SEC-3 と同じ single-operator/local-fs/
 * loopback の信頼境界)。Phase 2: 認証済み control channel 経由の setPolicy は ApprovalBridge.setPolicyConfig
 * が memory を権威更新し、persistDelta→applyPolicyDelta (delta ベース RMW・withFileLock) で disk を追従
 * させる (本ファイルが disk writer の単一出所・full-overwrite は TDA-R1/decision 019f0f64 で廃止)。
 *
 * fail-safe: ファイル無し/壊れ/categories 空 → 既定プリセット DEFAULT_GATED_CATEGORIES (silent に全 OFF へ
 * 倒さない = out-of-box 安全)。kill-switch env `ACTRADECK_BYPASS_CATASTROPHIC_GATE=0` で enabled=false
 * (純パススルー・decision 019eace6 等価)。
 *
 * managed (sidecar.ts) / attach (attach-daemon.ts) の両構築点で `buildBridgePolicyOptions` を共有し、
 * file-level config と env kill-switch を **分離して** bridge へ渡す (env-AND は bridge に一元化・Phase 2 で
 * UI set 後の live 再構築を正しく行うため)。再利用道具は汎用化する規律。
 */
import { homedir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_GATED_CATEGORIES,
  type PolicyCategory,
  orderPolicyCategories,
  projectPolicyCategories,
  sanitizeRepoLabel,
} from "@actradeck/event-model";

import type {
  ApprovalPolicyConfig,
  LayeredApprovalPolicy,
  PolicyDelta,
  RepoPolicyEntry,
  RepoScopeResolver,
} from "./approval-bridge.js";
import { makeRepoScopeResolver } from "./approval-persist-config.js";
import { withFileLock } from "./file-lock.js";
import { readJsonObject, writeJson0600 } from "./fs-atomic.js";

/** policy.json の schema version。v2 = per-repo overlay (ADR 019f0eca)。v1 (flat) は load 時に default へ移行。 */
const POLICY_FILE_VERSION = 2;
/** repo_scope キーの検証 (allowlist の repo_scope と同一・scopeHash は 12 hex だが {1,64} で許容)。 */
const REPO_SCOPE_RE = /^[0-9a-f]{1,64}$/;

/** ポリシーファイルの dir/path (`~/.actradeck/approvals/policy.json`)。allowlist と同じ approvals dir。 */
export function approvalsPolicyDir(home: string = homedir()): string {
  return join(home, ".actradeck", "approvals");
}
export function approvalsPolicyPath(home: string = homedir()): string {
  return join(approvalsPolicyDir(home), "policy.json");
}

/**
 * 読み込んだ categories を closed enum へ投影する (load(disk) と Phase 2 relay(untrusted wire) の両入口で共有)。
 * 投影ロジックは event-model の `projectPolicyCategories` に集約 (TDA-1・3 トラスト境界の drift 防止)。
 * Set で返す (setPolicyConfig が membership 判定に使う・順序非依存・serialize 時に options 順へ整列)。
 * 配列でない/非 string/未知値は projectPolicyCategories が構造的に落とす。
 */
export function sanitizeCategories(raw: unknown): Set<PolicyCategory> {
  return new Set<PolicyCategory>(projectPolicyCategories(raw));
}

/** 既定プリセット (out-of-box 安全・fail-safe)。 */
function defaultPreset(): ApprovalPolicyConfig {
  return { enabled: true, categories: new Set<PolicyCategory>(DEFAULT_GATED_CATEGORIES) };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * `{enabled, categories}` を ApprovalPolicyConfig へ。enabled は既定 true (明示 false のみ無効)。
 * failsafeEmpty=true (default scope 用) なら空 categories を DEFAULT_GATED_CATEGORIES へ縮退 (out-of-box
 * 安全・silent 全 OFF を防ぐ)。false (per-repo entry 用) なら空を許容 (= その repo は何も gate しない・
 * full override・decision 019f0ecd)。
 */
function parseScopeConfig(
  raw: Record<string, unknown>,
  failsafeEmpty: boolean,
): ApprovalPolicyConfig {
  const enabled = raw.enabled !== false;
  const categories = sanitizeCategories(raw.categories);
  const cats =
    categories.size > 0 || !failsafeEmpty
      ? categories
      : new Set<PolicyCategory>(DEFAULT_GATED_CATEGORIES);
  return { enabled, categories: cats };
}

/**
 * v2 repos map をパース。key は repo_scope (REPO_SCOPE_RE) のみ許容 (絶対パス/secret 混入を構造遮断)。
 * categories が配列でない malformed エントリは drop (= default を継承・fail-safe)。
 * SEC-R2-1 (decision 019f0f64): label は **load 時にも sanitizeRepoLabel** で basename へ畳む。手編集された
 * policy.json に絶対パス/secret 様 label があっても at-rest memory/UI へ raw で載せない (relay set と二重防御)。
 */
function parseRepos(raw: unknown): Map<string, RepoPolicyEntry> {
  const out = new Map<string, RepoPolicyEntry>();
  if (!isPlainObject(raw)) return out;
  for (const [scope, val] of Object.entries(raw)) {
    if (!REPO_SCOPE_RE.test(scope)) continue;
    if (!isPlainObject(val)) continue;
    if (!Array.isArray(val.categories)) continue; // categories 必須 (malformed/絶対パスを drop)
    const base = parseScopeConfig(val, false); // repo entry は空 categories 許容
    const label = sanitizeRepoLabel(val.label);
    out.set(scope, { ...base, ...(label !== undefined ? { label } : {}) });
  }
  return out;
}

/**
 * policy.json を読み **階層** LayeredApprovalPolicy (default + per-repo) を作る (ADR 019f0eca)。
 * env kill-switch 適用なし＝純粋な file → config (env-AND は ApprovalBridge の live 導出)。
 *
 * migration: ファイル無し→default プリセット/repos 空。v2 (`default`/`repos` キーあり)→そのまま解釈。
 * v1 flat (top-level `{enabled, categories}`)→top-level を default として移行・repos 空 (後方互換)。
 * **repo 内ファイルは読まない**: 本関数は中央 ~/.actradeck/approvals/policy.json のみを読む
 * (self-bypass 防止・memory-authoritative の床維持・decision 019f0ecd)。
 */
export function loadApprovalPolicy(path: string = approvalsPolicyPath()): LayeredApprovalPolicy {
  const parsed = readJsonObject(path);
  if (parsed === undefined) {
    return { default: defaultPreset(), repos: new Map() };
  }
  // v2 判定: default/repos キーのいずれかが object なら v2。
  if (isPlainObject(parsed.default) || isPlainObject(parsed.repos)) {
    const def = isPlainObject(parsed.default)
      ? parseScopeConfig(parsed.default, true)
      : defaultPreset();
    return { default: def, repos: parseRepos(parsed.repos) };
  }
  // v1 flat: top-level {enabled, categories} を default として移行 (repos 無し)。
  return { default: parseScopeConfig(parsed, true), repos: new Map() };
}

/**
 * **階層** LayeredApprovalPolicy (default + per-repo) を policy.json へ **0600 atomic 書込**する
 * (Phase 2 / ADR 019f0eca setPolicy の永続側)。
 *
 * **file-level enabled を書く**: ここで永続するのは operator が設定した file レベルの enabled であり、env
 * kill-switch (`ACTRADECK_BYPASS_CATASTROPHIC_GATE`) は ApprovalBridge が live 導出時に AND する
 * **非永続**の概念。env-解決後の値を渡してはならない (kill-switch を恒久化してしまう)。TDA-R1 後の
 * 唯一の production 呼び元は applyPolicyDelta で、disk を read し operator の単一 delta (default or 当該
 * repo_scope) を適用した layered を渡す (setPolicyConfig/removePolicyRepo は delta を persistDelta 経由で
 * applyPolicyDelta へ渡す・full map の overwrite はしない)。
 *
 * categories は T1 enum の安定順 (`PolicyCategory.options`) でシリアライズし、Set 挿入順に依存しない決定論的
 * な出力にする (diff 安定)。approvals dir は 0o700 (allowlist と同規約・policy 自体は secret 非含だが統一)。
 */
export function saveApprovalPolicy(
  policy: LayeredApprovalPolicy,
  path: string = approvalsPolicyPath(),
): void {
  const repos: Record<string, { label?: string; enabled: boolean; categories: PolicyCategory[] }> =
    {};
  for (const [scope, e] of policy.repos) {
    repos[scope] = {
      ...(e.label !== undefined ? { label: e.label } : {}),
      enabled: e.enabled,
      categories: orderPolicyCategories(e.categories),
    };
  }
  writeJson0600(
    path,
    {
      version: POLICY_FILE_VERSION,
      default: {
        enabled: policy.default.enabled,
        categories: orderPolicyCategories(policy.default.categories),
      },
      repos,
    },
    { dirMode: 0o700 },
  );
}

/**
 * TDA-R1 (decision 019f0f64): 単一 delta を policy.json へ **read-modify-write** で永続する。
 * `saveApprovalPolicy(currentLayered())` の full overwrite は、fan-out を取りこぼした stale daemon が
 * 後続 set の owner になると自 memory に無い他 repo override を disk から落とす (silent security-control
 * downgrade)。本関数は **withFileLock** で disk を読み→変更した 1 キー (default or 当該 repo_scope) だけを
 * 適用→書き戻すため、他 daemon/operator の override を保全する (multi-writer disk-completeness)。
 * 直列化 (withFileLock) で concurrent daemon の TOCTOU も縮小する (allowlist store の RMW と同パターン)。
 * lock 取得失敗 / write 失敗は throw する (呼び元 ApprovalBridge.safePersist が吸収・memory は保持)。
 */
export function applyPolicyDelta(delta: PolicyDelta, path: string = approvalsPolicyPath()): void {
  withFileLock(path, () => {
    const disk = loadApprovalPolicy(path);
    const repos = new Map(disk.repos);
    let def = disk.default;
    if (delta.kind === "set-default") {
      def = delta.config;
    } else if (delta.kind === "set-repo") {
      repos.set(delta.scope, delta.entry);
    } else {
      repos.delete(delta.scope);
    }
    saveApprovalPolicy({ default: def, repos }, path);
  });
}

/** kill-switch 判定 (既定 ON・`ACTRADECK_BYPASS_CATASTROPHIC_GATE=0`/`false` で OFF)。 */
export function isBypassCatastrophicGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.ACTRADECK_BYPASS_CATASTROPHIC_GATE;
  return !(v === "0" || v === "false");
}

export interface BuildPolicyConfigOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly path?: string;
}

/** ApprovalBridge へ渡す承認ポリシー関連オプション一式 (ADR 019f0c3e Phase 2 / 019f0eca)。 */
export interface BridgePolicyOptions {
  /** file-level **default** config (loadApprovalPolicy().default・env 非適用)。 */
  readonly policy: ApprovalPolicyConfig;
  /** ADR 019f0eca: file-level per-repo オーバーライド (loadApprovalPolicy().repos)。 */
  readonly policyRepos: ReadonlyMap<string, RepoPolicyEntry>;
  /** ADR 019f0eca: cwd→repoScope 解決器 (persist と同一実体・makeRepoScopeResolver)。 */
  readonly resolveRepoScope: RepoScopeResolver;
  /** env kill-switch の解決結果 (bridge が live = file.enabled && env を導出する)。 */
  readonly policyEnvEnabled: boolean;
  /**
   * Phase 2/019f0eca/TDA-R1 (019f0f64) setPolicyConfig/removePolicyRepo の永続側。変更した単一 delta を
   * disk へ read-modify-write (applyPolicyDelta) する (env 非永続・stale memory で全 map を overwrite しない)。
   */
  readonly persistPolicy: (delta: PolicyDelta) => void;
}

/**
 * ApprovalBridge へ渡すポリシー関連オプションを組む (managed/attach 両 daemon で共有・DRY)。
 *
 * Phase 1 の buildApprovalPolicyConfig (file.enabled と env を **AND して flat 化**) を置換する。
 * Phase 2 では UI set 後に live = file.enabled && env を **正しく再構築**する必要があり、env-AND 済の flat
 * 値からは file-level enabled を復元できない。そこで file-level (loadApprovalPolicy) と env kill-switch
 * (isBypassCatastrophicGateEnabled) を **分離して** bridge へ渡し、env-AND は bridge 側に一元化する。
 * persistPolicy は applyPolicyDelta を path 束縛したもの (setPolicyConfig が memory + disk delta 追従に使う・
 * TDA-R1: full overwrite でなく単一 delta の RMW)。
 */
export function buildBridgePolicyOptions(opts: BuildPolicyConfigOptions = {}): BridgePolicyOptions {
  const env = opts.env ?? process.env;
  const path = opts.path;
  const layered = loadApprovalPolicy(path);
  return {
    policy: layered.default,
    policyRepos: layered.repos,
    resolveRepoScope: makeRepoScopeResolver(),
    policyEnvEnabled: isBypassCatastrophicGateEnabled(env),
    persistPolicy: (delta) => applyPolicyDelta(delta, path),
  };
}
