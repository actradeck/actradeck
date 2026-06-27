"use client";

/**
 * Approval Inbox の集約 pull フック (ADR 019ead14 D1)。
 *
 * same-origin `/realtime/approvals` を fetch する。**token は載せない** — BFF (custom server) が
 * server-side で Bearer を付与して backend `/realtime/approvals` へ中継する (ADR 019e92b7)。
 * backend は connected かつ pending 非空の session の承認待ちだけを返す (sidecar redaction 済 DTO)。
 *
 * - `enabled=false` (Inbox 非表示) のときは fetch せず保持中の pending も破棄する
 *   (承認本文をメモリに残さない衛生。SessionDetail の session 切替時 body 破棄と同方針)。
 * - `refreshKey` の変化 (例: needs_attention 件数の増減) で再 fetch する (live nudge は既存 delta.list)。
 * - `refresh()` は手動再取得 (承認 ack 後などに呼ぶ)。
 */
import { parsePendingApprovals } from "@actradeck/projection";
import { useCallback, useEffect, useState } from "react";

import type { SessionApprovals } from "../realtime/contract";

const APPROVALS_PATH = "/realtime/approvals";

function isString(v: unknown): v is string {
  return typeof v === "string";
}

/**
 * `/realtime/approvals` 応答を **寛容に** 検証する (LIVE-FOUND-3 教訓 019e98fc: 必須キーを
 * 増やしすぎて全黙殺しない)。request_id を持たない要素・session_id を持たない行のみ落とす。
 * 表示する値は backend が redaction 済みで載せた allow-list のみ (生 payload は存在しない)。
 *
 * 要素 (PendingApproval) の allow-list 7 キー projection は canonical な
 * `parsePendingApprovals` (packages/projection・単一出所) に委譲し、本関数は envelope
 * (approvals[] / session_id / provider / cwd) の検証だけを inbox 固有に持つ (TDA-1)。
 * canonical は欠落 session_id を "" に倒すため、ここで group の session_id を補完する。
 */
export function parseApprovalsResponse(raw: unknown): SessionApprovals[] {
  if (typeof raw !== "object" || raw === null) return [];
  const arr = (raw as { approvals?: unknown }).approvals;
  if (!Array.isArray(arr)) return [];
  const out: SessionApprovals[] = [];
  for (const item of arr) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    if (!isString(o.session_id)) continue;
    const sessionId = o.session_id;
    const pending = parsePendingApprovals(o.pending_approvals).map((p) =>
      p.session_id === "" ? { ...p, session_id: sessionId } : p,
    );
    if (pending.length === 0) continue;
    out.push({
      session_id: sessionId,
      provider: isString(o.provider) ? o.provider : "",
      cwd: isString(o.cwd) ? o.cwd : undefined,
      pending_approvals: pending,
    });
  }
  return out;
}

export interface UseApprovalInboxResult {
  readonly approvals: readonly SessionApprovals[];
  readonly loading: boolean;
  readonly error: string | undefined;
  /** 手動再取得 (承認 ack 後など)。 */
  readonly refresh: () => void;
}

export function useApprovalInbox(opts: {
  readonly enabled: boolean;
  readonly refreshKey?: number;
}): UseApprovalInboxResult {
  const { enabled, refreshKey = 0 } = opts;
  const [approvals, setApprovals] = useState<readonly SessionApprovals[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!enabled) {
      // 非表示時は保持中の承認本文を破棄 (メモリ衛生)。
      setApprovals([]);
      setError(undefined);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    void fetch(APPROVALS_PATH, { headers: { accept: "application/json" } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`approvals ${res.status}`);
        return (await res.json()) as unknown;
      })
      .then((data) => {
        if (!cancelled) setApprovals(parseApprovalsResponse(data));
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "approvals fetch failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, refreshKey, nonce]);

  return { approvals, loading, error, refresh };
}
