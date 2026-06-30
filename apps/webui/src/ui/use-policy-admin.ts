"use client";

/**
 * ADR 019f0eca: per-repo 承認ポリシー **管理** フック (master-detail 設定画面 ApprovalPolicyView 用)。
 *
 * use-policy.ts (SessionDetail の単一 scope get/set) と役割を分ける:
 *  - こちらは **list/set/unset/resolve** を束ね、Default + 全 repo override を 1 ビューで扱う。
 *  - policy は **machine-global** (この端末の全 daemon が共有)。sessionId は relay の宛先解決にのみ使う。
 *  - すべて same-origin BFF proxy 経由 (REALTIME_TOKEN は server-side でのみ付与・本フックは token 非関与)。
 *  - categories は **closed enum (PolicyCategory)** のみ (生コマンドを構造的に含まない・NO-RAW)。
 *  - repo 追加は **方式B** (resolve): 操作者入力の絶対パスを backend/sidecar が git root 解決し scope を返す。
 *    生パスは保存も echo もしない (sidecar が hash 化)。
 *  - 世代ゲートで stale 応答を捨てる。
 *  - **接続ゼロ閲覧** (2026-06-29): list 取得成功時に server raw + 取得時刻を localStorage へ保存し
 *    (policy-cache)、マウント時に last-known を復元する。接続中セッションが 0 でも read-only で閲覧でき、
 *    ApprovalPolicyView が mutation を無効化する。localStorage は **untrusted source** 扱いで、復元は
 *    必ず parsePolicyAdmin (closed-enum 再射影 + repo_scope hex ゲート + repo_label 再サニタイズ) を通す。
 *    本キャッシュは表示専用で sidecar の memory-authoritative live gate に一切影響しない。
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { PolicyCategory, projectPolicyCategories, sanitizeRepoLabel } from "@actradeck/event-model";

import { isPolicyRepoScope, loadPolicyAdminCache, savePolicyAdminCache } from "./policy-cache";

/**
 * ADR 019f1582: policy relay の宛先。`session`=接続中エージェントセッション所有の daemon (従来経路)、
 * `daemon`=接続中 daemon の直指定 (エージェント未稼働でも per-repo 設定可能にする導線)。policy は
 * machine-global ゆえどちらの宛先でも live 反映 + owner disk 永続 + 全 daemon fan-out へ収束する。
 * approve/interrupt は本フックの管轄外 (session-scoped のまま・INV-REALTIME-RELAY-SCOPE)。
 */
export type PolicyRelayTarget =
  | { readonly kind: "session"; readonly id: string }
  | { readonly kind: "daemon"; readonly id: string };

/** 1 scope (Default または repo) の effective ビュー。 */
export interface PolicyScopeView {
  readonly enabled: boolean;
  readonly categories: readonly PolicyCategory[];
  readonly envGateEnabled: boolean;
  /** undefined=Default(マシン基準) / それ以外=repo scope (sha256 短縮)。 */
  readonly repoScope?: string;
  readonly repoLabel?: string;
  /** repo 専用エントリが存在するか (true=Override / false=Default 継承)。Default ビューは false。 */
  readonly isOverride: boolean;
}

/** list 応答の repo override 1 件 (左ペイン)。 */
export interface PolicyRepoSummary {
  readonly repoScope: string;
  readonly repoLabel?: string;
  readonly enabled: boolean;
  readonly categories: readonly PolicyCategory[];
}

/** list 応答全体 (Default + 全 override)。 */
export interface PolicyAdminData {
  readonly defaultView: PolicyScopeView;
  readonly repos: readonly PolicyRepoSummary[];
}

/** resolve (方式B) の結果。生パスは含まない (scope/label/effective のみ)。 */
export interface PolicyResolveResult {
  readonly repoScope: string;
  readonly repoLabel?: string;
  readonly isOverride: boolean;
  readonly enabled: boolean;
  readonly categories: readonly PolicyCategory[];
}

/** !res.ok のとき本文 error を優先して Error を組む (HTTP status へフォールバック)。 */
async function httpError(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => undefined)) as { error?: unknown } | undefined;
  const detail =
    body !== undefined && typeof body.error === "string" && body.error.length > 0
      ? body.error
      : `HTTP ${res.status}`;
  return new Error(detail);
}

/** list 応答 JSON を closed-enum ビューへ畳む。非配列 categories は応答全体を棄却 (前段ガード)。 */
export function parsePolicyAdmin(raw: unknown): PolicyAdminData | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as {
    enabled?: unknown;
    categories?: unknown;
    env_gate_enabled?: unknown;
    repos?: unknown;
  };
  if (!Array.isArray(r.categories)) return undefined;
  const envGateEnabled = r.env_gate_enabled !== false;
  const defaultView: PolicyScopeView = {
    enabled: r.enabled === true,
    categories: projectPolicyCategories(r.categories),
    envGateEnabled,
    isOverride: false,
  };
  const repos: PolicyRepoSummary[] = Array.isArray(r.repos)
    ? r.repos
        .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
        // repo_scope/repo_label は server で検証/sanitize 済だが、本 parser は localStorage
        // キャッシュ (untrusted source) からも呼ばれるため canonical ゲートを再適用する
        // (clean な server 応答には冪等・NO-RAW parity)。QA-1/SEC-1/TDA-1: candidate 経路と
        // 同じ isPolicyRepoScope で repo_scope を hex ゲートし非 hex entry を drop。
        .filter((e) => isPolicyRepoScope(e.repo_scope))
        .map((e) => {
          const label = sanitizeRepoLabel(e.repo_label);
          return {
            repoScope: e.repo_scope as string,
            ...(label !== undefined ? { repoLabel: label } : {}),
            enabled: e.enabled === true,
            categories: projectPolicyCategories(e.categories),
          };
        })
    : [];
  return { defaultView, repos };
}

/** get/set/resolve の単一 scope 応答を closed-enum ビューへ畳む。 */
export function parsePolicyScope(raw: unknown): PolicyResolveResult | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as {
    enabled?: unknown;
    categories?: unknown;
    repo_scope?: unknown;
    repo_label?: unknown;
    is_override?: unknown;
  };
  if (!Array.isArray(r.categories)) return undefined;
  // untrusted source 経路もあるため repo_scope を hex ゲート (candidate/admin-cache と同一規則)。
  if (!isPolicyRepoScope(r.repo_scope)) return undefined;
  const label = sanitizeRepoLabel(r.repo_label);
  return {
    repoScope: r.repo_scope,
    ...(label !== undefined ? { repoLabel: label } : {}),
    isOverride: r.is_override === true,
    enabled: r.enabled === true,
    categories: projectPolicyCategories(r.categories),
  };
}

export interface UsePolicyAdminResult {
  readonly data: PolicyAdminData | undefined;
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly saving: boolean;
  /** Default + 全 override を pull する (パネル展開・保存後)。 */
  readonly reload: () => void;
  /**
   * scope を更新する。repoScope 省略=Default。repoLabel は override 作成時の表示名 (任意)。
   * 成功で list を再取得し badges を最新化する。
   */
  readonly save: (
    repoScope: string | undefined,
    update: {
      enabled?: boolean;
      categories?: readonly PolicyCategory[];
      repoLabel?: string;
    },
  ) => Promise<void>;
  /** repo override を削除し Default 継承へ戻す。成功で list 再取得。 */
  readonly unset: (repoScope: string) => Promise<void>;
  /** 方式B: 絶対パスを git root 解決し scope を得る (override 作成の前段)。失敗は throw。 */
  readonly resolve: (path: string) => Promise<PolicyResolveResult>;
  /** data の出所が localStorage キャッシュの場合の取得時刻 (epoch ms)。未取得/不明は undefined。 */
  readonly cachedAt: number | undefined;
}

export function usePolicyAdmin(target: PolicyRelayTarget | null): UsePolicyAdminResult {
  const [data, setData] = useState<PolicyAdminData | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  // data の出所がキャッシュのときの取得時刻 (SEC-2: offline stale 度表示)。live 取得で undefined へ戻す。
  const [cachedAt, setCachedAt] = useState<number | undefined>(undefined);
  // 世代ゲート: session/対象が変わったら旧 fetch の応答を捨てる。
  const gen = useRef(0);

  // 接続ゼロでも last-known を見せる: マウント時に localStorage キャッシュを復元する
  // (untrusted ゆえ parsePolicyAdmin で closed-enum 再射影 + label 再サニタイズ)。network 取得で上書き。
  useEffect(() => {
    // マウント時 1 回のみ (空依存)。setData は安定。
    const cache = loadPolicyAdminCache();
    if (cache === undefined) return;
    const parsed = parsePolicyAdmin(cache.raw);
    if (parsed === undefined) return;
    setData((prev) => prev ?? parsed);
    setCachedAt((prev) => prev ?? (cache.fetchedAt > 0 ? cache.fetchedAt : undefined));
  }, []);

  // ADR 019f1582: relay-target で base path を分岐 (primitive string ゆえ deps に直接載せられる)。
  // session 経路は従来どおり、daemon 経路はエージェント未稼働時の per-repo 設定導線 (machine-global policy)。
  const baseUrl: string | null =
    target === null
      ? null
      : target.kind === "daemon"
        ? `/realtime/daemons/${encodeURIComponent(target.id)}/approvals/policy`
        : `/realtime/sessions/${encodeURIComponent(target.id)}/approvals/policy`;

  const reload = useCallback(() => {
    if (!baseUrl) return;
    const g = ++gen.current;
    setLoading(true);
    setError(undefined);
    void (async () => {
      try {
        const res = await fetch(`${baseUrl}/list`);
        if (g !== gen.current) return;
        if (!res.ok) throw await httpError(res);
        const rawJson = (await res.json()) as unknown;
        const parsed = parsePolicyAdmin(rawJson);
        if (g !== gen.current) return;
        if (!parsed) throw new Error("invalid policy list response");
        setData(parsed);
        setCachedAt(undefined); // live 取得ゆえ stale 表示を消す。
        // last-known を取得時刻と共に永続 (接続ゼロ時の read-only 閲覧用)。parser 同一ゆえ revive も同射影。
        savePolicyAdminCache(rawJson, Date.now());
      } catch (err) {
        if (g === gen.current) setError((err as Error).message);
      } finally {
        if (g === gen.current) setLoading(false);
      }
    })();
  }, [baseUrl]);

  const save = useCallback(
    async (
      repoScope: string | undefined,
      update: { enabled?: boolean; categories?: readonly PolicyCategory[]; repoLabel?: string },
    ): Promise<void> => {
      if (!baseUrl) return;
      setSaving(true);
      setError(undefined);
      try {
        const res = await fetch(`${baseUrl}/set`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...(update.enabled !== undefined ? { enabled: update.enabled } : {}),
            ...(update.categories !== undefined ? { categories: [...update.categories] } : {}),
            ...(repoScope !== undefined ? { repo_scope: repoScope } : {}),
            ...(repoScope !== undefined && update.repoLabel !== undefined
              ? { repo_label: update.repoLabel }
              : {}),
          }),
        });
        if (!res.ok) throw await httpError(res);
      } catch (err) {
        setError((err as Error).message);
        throw err;
      } finally {
        setSaving(false);
      }
      reload(); // badges/状態を最新化。
    },
    [baseUrl, reload],
  );

  const unset = useCallback(
    async (repoScope: string): Promise<void> => {
      if (!baseUrl) return;
      setSaving(true);
      setError(undefined);
      try {
        const res = await fetch(`${baseUrl}/unset`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ repo_scope: repoScope }),
        });
        if (!res.ok) throw await httpError(res);
      } catch (err) {
        setError((err as Error).message);
        throw err;
      } finally {
        setSaving(false);
      }
      reload();
    },
    [baseUrl, reload],
  );

  const resolve = useCallback(
    async (path: string): Promise<PolicyResolveResult> => {
      if (!baseUrl) throw new Error("no relay target");
      setError(undefined);
      const res = await fetch(`${baseUrl}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path }),
      });
      if (!res.ok) {
        const err = await httpError(res);
        setError(err.message);
        throw err;
      }
      const parsed = parsePolicyScope(await res.json());
      if (!parsed) {
        const err = new Error("invalid resolve response");
        setError(err.message);
        throw err;
      }
      return parsed;
    },
    [baseUrl],
  );

  return { data, loading, error, saving, reload, save, unset, resolve, cachedAt };
}
