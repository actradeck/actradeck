"use client";

/**
 * ADR 019f0c3e Phase 2: bypass/YOLO 承認ポリシー (どの high-risk カテゴリを明示承認に落とすか) を
 * **オンデマンドで pull** し、in-UI で更新するフック (use-allowlist.ts と同型)。
 *
 * 設計:
 *  - 常時 push せず、UI の明示操作 (パネル展開) で fetch する。
 *  - fetch 先は same-origin BFF proxy 経由 (REALTIME_TOKEN は server-side でのみ付与・browser へ渡さない)。
 *    本フックは token を一切扱わない。
 *  - categories は **closed enum (PolicyCategory)** のみ (生コマンドを構造的に含まない・NO-RAW)。
 *  - policy は **machine-global** (この端末の全 daemon が共有)。session_id は relay の宛先解決のみ。
 *  - get は GET、set は POST (.../policy/set)。set 応答が更新後の最新状態を返すので 1 往復で更新。
 *  - enabled は **file-level** (operator 設定値)。env kill-switch (envGateEnabled=false) は別概念で、
 *    OFF のときは file-level 設定に関わらず全体パススルー (UI で警告表示する)。
 *  - 対象が変わるたび世代ゲートで stale 応答を捨てる。
 */
import { useCallback, useRef, useState } from "react";

import { PolicyCategory, projectPolicyCategories } from "@actradeck/event-model";

/** policy 応答 (get/set 共通)。enabled は file-level・envGateEnabled は env kill-switch の現状。 */
export interface PolicyView {
  readonly enabled: boolean;
  readonly categories: readonly PolicyCategory[];
  readonly envGateEnabled: boolean;
}

/** 全 policy カテゴリ (UI チェックボックスの母集合・T1 enum の単一ソース)。 */
export const ALL_POLICY_CATEGORIES: readonly PolicyCategory[] = PolicyCategory.options;

/** 応答 JSON を closed-enum ビューへ畳む (未知 category は除外)。export はテスト用。 */
export function parsePolicy(raw: unknown): PolicyView | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as { enabled?: unknown; categories?: unknown; env_gate_enabled?: unknown };
  // 非配列の categories は応答全体を棄却する (webui 固有の前段ガード・他境界は空扱い)。
  if (!Array.isArray(r.categories)) return undefined;
  // 投影は event-model の単一出所に集約 (TDA-1・options 安定順・未知/非 string を構造的に落とす)。
  const categories = projectPolicyCategories(r.categories);
  return {
    enabled: r.enabled === true,
    categories,
    // 既定 true (省略 = kill-switch 非関与)。明示 false のみ警告対象。
    envGateEnabled: r.env_gate_enabled !== false,
  };
}

/**
 * SEC-R2-2 (decision 019f0d22): !res.ok のとき本文 JSON の `error` を優先して Error を組む。
 * これがないと operator は `HTTP 404` だけを見て、例えば policy が memory に適用済みでも disk 永続に
 * 失敗した（"policy applied in memory but failed to persist to disk"）等の実際の理由を得られない。
 * 本文が無い/壊れている場合は HTTP ステータスへフォールバックする。
 */
async function httpError(res: Response): Promise<Error> {
  const body = (await res.json().catch(() => undefined)) as { error?: unknown } | undefined;
  const detail =
    body !== undefined && typeof body.error === "string" && body.error.length > 0
      ? body.error
      : `HTTP ${res.status}`;
  return new Error(detail);
}

export interface UsePolicyResult {
  readonly view: PolicyView | undefined;
  readonly loading: boolean;
  readonly error: string | undefined;
  /** 承認ポリシーを pull する (パネル展開等の明示操作)。 */
  readonly load: () => void;
  /** ポリシーを更新する (POST)。partial: enabled / categories のどちらか/両方。成功で最新へ更新。 */
  readonly save: (update: { enabled?: boolean; categories?: readonly PolicyCategory[] }) => void;
  readonly saving: boolean;
}

export function usePolicy(sessionId: string | null): UsePolicyResult {
  const [view, setView] = useState<PolicyView | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  // 世代ゲート: session/対象が変わったら旧 fetch の応答を捨てる。
  const gen = useRef(0);

  const base = useCallback(
    (sid: string): string => `/realtime/sessions/${encodeURIComponent(sid)}/approvals/policy`,
    [],
  );

  const load = useCallback(() => {
    if (!sessionId) return;
    const g = ++gen.current;
    setLoading(true);
    setError(undefined);
    void (async () => {
      try {
        const res = await fetch(base(sessionId));
        if (g !== gen.current) return;
        if (!res.ok) throw await httpError(res);
        const parsed = parsePolicy(await res.json());
        if (g !== gen.current) return;
        if (!parsed) throw new Error("invalid policy response");
        setView(parsed);
      } catch (err) {
        if (g === gen.current) setError((err as Error).message);
      } finally {
        if (g === gen.current) setLoading(false);
      }
    })();
  }, [sessionId, base]);

  const save = useCallback(
    (update: { enabled?: boolean; categories?: readonly PolicyCategory[] }) => {
      if (!sessionId) return;
      const g = ++gen.current;
      setSaving(true);
      setError(undefined);
      void (async () => {
        try {
          const res = await fetch(`${base(sessionId)}/set`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              ...(update.enabled !== undefined ? { enabled: update.enabled } : {}),
              ...(update.categories !== undefined ? { categories: [...update.categories] } : {}),
            }),
          });
          if (g !== gen.current) return;
          if (!res.ok) throw await httpError(res);
          const parsed = parsePolicy(await res.json());
          if (g !== gen.current) return;
          if (parsed) setView(parsed); // set 応答は更新後の最新状態。
        } catch (err) {
          if (g === gen.current) setError((err as Error).message);
        } finally {
          if (g === gen.current) setSaving(false);
        }
      })();
    },
    [sessionId, base],
  );

  return { view, loading, error, load, save, saving };
}
