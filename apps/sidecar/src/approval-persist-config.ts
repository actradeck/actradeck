/**
 * approval-persist-config — 承認永続化 (ADR 019ee0c0) の env 解決 + repo スコープ解決の単一出所。
 *
 * managed (sidecar.ts) / attach (attach-daemon.ts) の両構築点で同一設定を使うため factory 化する
 * (再利用道具は汎用化する規律)。store は pure に保ち、git/fs 依存 (findRepoRoot) は本モジュールに閉じる。
 *
 * opt-in 既定 OFF: `ACTRADECK_PERSIST_APPROVALS` が "1"/"true" のときのみ有効。OFF のとき
 * ApprovalBridge は disk エントリを一切 honor しない (真の kill-switch)。
 * TTL: `ACTRADECK_PERSIST_APPROVALS_TTL_MS` (既定 7 日・[1分, 90日] に clamp)。
 */
import { ApprovalAllowlistStore, repoLabelOf } from "./approval-allowlist-store.js";
import type { ApprovalPersistConfig, RepoScopeResolver } from "./approval-bridge.js";
import { scopeHash } from "./daemon-state.js";
import { findRepoRoot } from "./git-watcher.js";

/**
 * cwd → repo スコープ解決器を組む (ADR 019ee0c0 永続 allowlist / ADR 019f0eca per-repo policy 共有)。
 * findRepoRoot で git root を解決し `{ scope: scopeHash(root) (12 hex), label: basename, root }` を返す。
 * cwd 無し / git 管理外は undefined。**永続 allowlist と per-repo policy が同一の repo 同定器を共有**する
 * ことで scope キーの drift を防ぐ (security-gate-reuse-canonical-parser)。
 *
 * `root` (SEC-1・decision 019f0f2f): findRepoRoot は `git rev-parse --show-toplevel` の **物理 (symlink
 * 解決済み) git root** を返す。resolve 二段封じ込めが「解決済 root が project-scope 配下か」を再照合するのに
 * 使う (符号化前の生 root を渡すのは containment 判定のためで、echo/永続はしない)。
 */
export function makeRepoScopeResolver(
  resolveRepoRoot: (cwd: string) => Promise<string | undefined> = findRepoRoot,
): RepoScopeResolver {
  return async (cwd) => {
    if (cwd === undefined || cwd.length === 0) return undefined;
    const root = await resolveRepoRoot(cwd);
    if (root === undefined) return undefined;
    return { scope: scopeHash(root), label: repoLabelOf(root), root };
  };
}

/** 永続 grant の既定 TTL = 7 日。 */
export const DEFAULT_PERSIST_TTL_MS = 7 * 24 * 60 * 60_000;
/** TTL 下限 = 1 分 (誤設定で実質無効化されるのを防ぐ)。 */
const MIN_PERSIST_TTL_MS = 60_000;
/** TTL 上限 = 90 日 (無期限に近い standing grant を作らせない)。 */
const MAX_PERSIST_TTL_MS = 90 * 24 * 60 * 60_000;

/** opt-in フラグ判定 (既定 OFF)。 */
export function isPersistApprovalsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.ACTRADECK_PERSIST_APPROVALS;
  return v === "1" || v === "true";
}

/** TTL(ms) 解決。未設定/不正は既定 7 日。範囲外は [1分, 90日] に clamp。 */
export function resolvePersistTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ACTRADECK_PERSIST_APPROVALS_TTL_MS;
  if (raw === undefined) return DEFAULT_PERSIST_TTL_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PERSIST_TTL_MS;
  return Math.min(MAX_PERSIST_TTL_MS, Math.max(MIN_PERSIST_TTL_MS, n));
}

export interface BuildPersistConfigOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly store?: ApprovalAllowlistStore;
  /** repo root 解決 (テスト差し替え用)。既定 findRepoRoot。 */
  readonly resolveRepoRoot?: (cwd: string) => Promise<string | undefined>;
}

/**
 * ApprovalBridge へ渡す永続設定を組む。enabled=false でも構築する (env を後で flip すれば有効化)。
 * resolveRepoScope: cwd → git root を解決し `{ scope: sha256短縮, label: basename }`。git 管理外/cwd 無しは
 * undefined を返し、ApprovalBridge は **永続化不可** と判定する (unscoped grant を作らない fail-safe)。
 */
export function buildApprovalPersistConfig(
  opts: BuildPersistConfigOptions = {},
): ApprovalPersistConfig {
  const env = opts.env ?? process.env;
  const store = opts.store ?? new ApprovalAllowlistStore();
  const resolveRepoRoot = opts.resolveRepoRoot ?? findRepoRoot;
  return {
    store,
    enabled: isPersistApprovalsEnabled(env),
    ttlMs: resolvePersistTtlMs(env),
    resolveRepoScope: makeRepoScopeResolver(resolveRepoRoot),
  };
}
