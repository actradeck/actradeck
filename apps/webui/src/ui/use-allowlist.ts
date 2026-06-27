"use client";

/**
 * PAL-v2 (ADR 019ee147): 永続承認 allowlist を **オンデマンドで pull** し、in-UI で失効するフック。
 *
 * 設計 (use-session-body.ts の diff pull と同型):
 *  - 常時 push せず、UI の明示操作 (パネル展開) で fetch する。
 *  - fetch 先は same-origin BFF proxy 経由 (REALTIME_TOKEN は server-side でのみ付与・browser へ渡さない)。
 *    本フックは token を一切扱わない。
 *  - 応答 entries は backend/sidecar の NO-RAW ビュー (sha256 署名/scope/basename/risk/時刻)。
 *    生コマンドは構造的に含まれない。
 *  - allowlist は **machine-global** (この端末の全 daemon が共有)。session_id は relay の宛先解決のみ。
 *  - revoke は POST (除去のみ・新規 grant を作らない)。revoke 応答が最新一覧を返すので 1 往復で更新。
 *  - session/対象が変わるたび世代ゲートで stale 応答を捨てる。
 */
import { useCallback, useRef, useState } from "react";

import type { AllowlistEntry } from "../realtime/contract";

/** allowlist 応答 (list/revoke 共通)。enabled=false は disk エントリが dormant の意。 */
export interface AllowlistView {
  readonly enabled: boolean;
  readonly entries: readonly AllowlistEntry[];
}

/** 応答 JSON を NO-RAW ビューへ畳む (既知フィールドのみ・型不一致は除外)。export はテスト用。 */
export function parseAllowlist(raw: unknown): AllowlistView | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as { enabled?: unknown; entries?: unknown };
  if (!Array.isArray(r.entries)) return undefined;
  const entries: AllowlistEntry[] = [];
  for (const e of r.entries) {
    if (typeof e !== "object" || e === null) continue;
    const x = e as Record<string, unknown>;
    if (typeof x.signature !== "string" || typeof x.repo_scope !== "string") continue;
    entries.push({
      signature: x.signature,
      repo_scope: x.repo_scope,
      ...(typeof x.repo_label === "string" ? { repo_label: x.repo_label } : {}),
      risk: typeof x.risk === "string" ? x.risk : "",
      created_at_ms: typeof x.created_at_ms === "number" ? x.created_at_ms : 0,
      expires_at_ms: typeof x.expires_at_ms === "number" ? x.expires_at_ms : 0,
    });
  }
  return { enabled: r.enabled === true, entries };
}

export interface UseAllowlistResult {
  readonly view: AllowlistView | undefined;
  readonly loading: boolean;
  readonly error: string | undefined;
  /** 永続承認一覧を pull する (パネル展開等の明示操作)。 */
  readonly load: () => void;
  /** 指定署名を失効する (POST)。成功で最新一覧へ更新。revoking 中は true。 */
  readonly revoke: (signature: string, repoScope?: string) => void;
  readonly revoking: boolean;
}

export function useAllowlist(sessionId: string | null): UseAllowlistResult {
  const [view, setView] = useState<AllowlistView | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [revoking, setRevoking] = useState(false);
  // 世代ゲート: session/対象が変わったら旧 fetch の応答を捨てる。
  const gen = useRef(0);

  const base = useCallback(
    (sid: string): string => `/realtime/sessions/${encodeURIComponent(sid)}/approvals/allowlist`,
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
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const parsed = parseAllowlist(await res.json());
        if (g !== gen.current) return;
        if (!parsed) throw new Error("invalid allowlist response");
        setView(parsed);
      } catch (err) {
        if (g === gen.current) {
          setError((err as Error).message);
        }
      } finally {
        if (g === gen.current) setLoading(false);
      }
    })();
  }, [sessionId, base]);

  const revoke = useCallback(
    (signature: string, repoScope?: string) => {
      if (!sessionId) return;
      const g = ++gen.current;
      setRevoking(true);
      setError(undefined);
      void (async () => {
        try {
          const res = await fetch(`${base(sessionId)}/revoke`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              signature,
              ...(repoScope !== undefined ? { repo_scope: repoScope } : {}),
            }),
          });
          if (g !== gen.current) return;
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const parsed = parseAllowlist(await res.json());
          if (g !== gen.current) return;
          if (parsed) setView(parsed); // revoke 応答は revoke 後の最新一覧。
        } catch (err) {
          if (g === gen.current) setError((err as Error).message);
        } finally {
          if (g === gen.current) setRevoking(false);
        }
      })();
    },
    [sessionId, base],
  );

  // TDA-2: clear() は持たない。allowlist は machine-global (この端末の全 daemon が同一ファイルを共有) で
  // session 非依存ゆえ、session 切替で保持ビューを破棄する必要がない (diff pull の clear と異なり stale 概念が無い)。
  // 保持するのも NO-RAW (sha256 署名/scope/basename) のみで跨セッション秘匿残留も無い。
  return { view, loading, error, load, revoke, revoking };
}
