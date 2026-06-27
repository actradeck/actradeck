/**
 * allowlist-relay — PAL-v2 (ADR 019ee147) の allowlist.request → allowlist.response 変換の単一出所。
 *
 * managed (sidecar.ts) / attach (attach-daemon.ts) の両 daemon が同一処理を使うため共有する
 * (再利用道具は汎用化する規律)。NO-RAW マッピング (PersistedApprovalView → ワイヤ snake_case) を
 * **1 箇所に集約**し、relay 応答に生コマンドが載らない境界を単一の監査面に閉じる。
 *
 * セキュリティ (ADR 019ee147 / security.md):
 * - entries は ApprovalBridge.listPersistedApprovals の NO-RAW ビュー (sha256 署名 / repoScope /
 *   basename ラベル / risk / 時刻) のみ。生コマンド・絶対パス・secret は構造的に含まない。
 * - revoke は除去のみ (新規 grant を作らない)。署名なし revoke は no-op (誤って全消去しない fail-safe)。
 * - token 認可は呼び元 (WsClient.handleInbound) が diff.request と同一境界で済ませている前提。
 */
import type { ApprovalBridge } from "./approval-bridge.js";
import type { AllowlistRequestMsg, AllowlistResponseMsg } from "./ws-client.js";

/**
 * allowlist.request を ApprovalBridge 経由で処理し allowlist.response を組む。
 * 戻り値 undefined = request_id 不正で黙殺 (diff handler と同じ挙動)。
 * revoke のときは revoke 後の一覧を返す (UI が 1 応答で最新状態へ更新できる)。
 */
export function buildAllowlistResponse(
  bridge: ApprovalBridge,
  msg: AllowlistRequestMsg,
): AllowlistResponseMsg | undefined {
  if (typeof msg.request_id !== "string" || msg.request_id.length === 0) return undefined;

  let removed: number | undefined;
  if (msg.op === "revoke") {
    removed =
      typeof msg.signature === "string" && msg.signature.length > 0
        ? bridge.revokePersistedApproval(
            msg.signature,
            typeof msg.repo_scope === "string" && msg.repo_scope.length > 0
              ? msg.repo_scope
              : undefined,
          )
        : 0; // 署名なし revoke は no-op
  }

  const entries = bridge.listPersistedApprovals().map((e) => ({
    signature: e.signature,
    repo_scope: e.repoScope,
    ...(e.repoLabel !== undefined ? { repo_label: e.repoLabel } : {}),
    risk: e.risk,
    created_at_ms: e.createdAtMs,
    expires_at_ms: e.expiresAtMs,
  }));

  return {
    type: "allowlist.response",
    request_id: msg.request_id,
    enabled: bridge.persistEnabled,
    entries,
    ...(removed !== undefined ? { removed } : {}),
  };
}
