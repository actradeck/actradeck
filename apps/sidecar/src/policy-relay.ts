/**
 * policy-relay — ADR 019f0c3e Phase 2 / 019f0eca の policy.request → policy.response 変換の単一出所。
 *
 * managed (sidecar.ts) / attach (attach-daemon.ts) の両 daemon が同一処理を使うため共有する
 * (再利用道具は汎用化する規律・allowlist-relay と対称)。closed-enum 投影 (categories の sanitize) を
 * **1 箇所に集約**し、relay 応答に生コマンドが載らない境界 (NO-RAW) を単一の監査面に閉じる。
 *
 * セキュリティ (ADR 019f0c3e / 019f0eca / security.md):
 * - categories は **closed enum (PolicyCategory) のみ**。生コマンド・絶対パス・secret は構造的に含まない。
 * - set の wire categories (untrusted string[]) は sanitizeCategories で未知値を捨ててから適用する
 *   (sidecar が authoritative な最終 sanitize 点)。
 * - **repo_scope は relay でも検証** (/^[0-9a-f]{1,64}$/)。不正値 (絶対パス/raw 混入) は error 応答で
 *   変更しない (NO-RAW 多層・backend realtime-server の検証と二段)。
 * - get/list/resolve は現状読取りのみ (変更しない)。op が "set"/"unset" 以外は変更しない (fail-safe)。
 * - "resolve" (方式B) は操作者入力の path を git root 解決し scope+effective policy を返す。**生 path は
 *   保存も echo もしない** (NO-RAW)。封じ込めは backend (ACTRADECK_PROJECT_SCOPE) が事前検証済み前提。
 * - token 認可は呼び元 (WsClient.handleInbound) が allowlist.request と同一境界で済ませている前提。
 */
import { orderPolicyCategories, sanitizeRepoLabel } from "@actradeck/event-model";

import type { ApprovalBridge, PolicyConfigView } from "./approval-bridge.js";
import { sanitizeCategories } from "./approval-policy-store.js";
import type { PolicyRepoWire, PolicyRequestMsg, PolicyResponseMsg } from "./ws-client.js";

/** repo_scope の検証 (allowlist と同一・scopeHash は 12 hex だが {1,64} で許容)。 */
const REPO_SCOPE_RE = /^[0-9a-f]{1,64}$/;

/** PolicyConfigView を policy.response へ整形する (categories は安定順・NO-RAW)。 */
function viewToResponse(requestId: string, view: PolicyConfigView): PolicyResponseMsg {
  return {
    type: "policy.response",
    request_id: requestId,
    enabled: view.enabled,
    categories: orderPolicyCategories(view.categories),
    env_gate_enabled: view.envGateEnabled,
    ...(view.repoScope !== undefined ? { repo_scope: view.repoScope } : {}),
    ...(view.repoLabel !== undefined ? { repo_label: view.repoLabel } : {}),
    ...(view.isOverride !== undefined ? { is_override: view.isOverride } : {}),
    ...(view.persistError !== undefined ? { error: view.persistError } : {}),
  };
}

/** op="list": default + 全 repo override 一覧 (UI 左ペイン)。 */
function buildListResponse(bridge: ApprovalBridge, requestId: string): PolicyResponseMsg {
  const def = bridge.getPolicyConfig();
  const repos: PolicyRepoWire[] = bridge.listPolicyRepos().map((e) => ({
    repo_scope: e.scope,
    ...(e.label !== undefined ? { repo_label: e.label } : {}),
    enabled: e.enabled,
    categories: orderPolicyCategories(e.categories),
  }));
  return {
    type: "policy.response",
    request_id: requestId,
    enabled: def.enabled,
    categories: orderPolicyCategories(def.categories),
    env_gate_enabled: def.envGateEnabled,
    repos,
  };
}

/**
 * policy.request を ApprovalBridge 経由で処理し policy.response を組む。
 * 戻り値 undefined = request_id 不正で黙殺 (allowlist handler と同じ挙動)。
 * set/unset のときは更新後の最新状態を返す (UI が 1 応答で最新へ更新できる)。
 * "resolve" は path を git root 解決するため **async** (findRepoRoot/execFile)。
 */
export async function buildPolicyResponse(
  bridge: ApprovalBridge,
  msg: PolicyRequestMsg,
): Promise<PolicyResponseMsg | undefined> {
  if (typeof msg.request_id !== "string" || msg.request_id.length === 0) return undefined;

  // repo_scope の検証 (NO-RAW)。指定があり不正なら変更せず error 応答。
  let repoScope: string | undefined;
  if (msg.repo_scope !== undefined) {
    if (typeof msg.repo_scope !== "string" || !REPO_SCOPE_RE.test(msg.repo_scope)) {
      return {
        type: "policy.response",
        request_id: msg.request_id,
        enabled: false,
        categories: [],
        error: "invalid repo_scope",
      };
    }
    repoScope = msg.repo_scope;
  }

  // op="list" は default + repos 一覧 (変更しない)。
  if (msg.op === "list") return buildListResponse(bridge, msg.request_id);

  // op="resolve" (方式B): path を git root 解決し scope+effective policy を返す (変更しない)。
  // SEC-1 (decision 019f0f2f): backend が渡す resolve_scope (ACTRADECK_PROJECT_SCOPE prefix 群) で、解決済の
  // 物理 git root を二段封じ込め再照合する。symlink/ancestor で root が scope 外へ抜ける経路を構造遮断する。
  if (msg.op === "resolve") {
    const path = typeof msg.path === "string" ? msg.path : "";
    const resolveScope = Array.isArray(msg.resolve_scope)
      ? msg.resolve_scope.filter((s): s is string => typeof s === "string")
      : [];
    const resolved =
      path.length > 0 ? await bridge.getPolicyConfigForPath(path, resolveScope) : undefined;
    if (resolved === undefined) {
      // 生 path は echo しない (固定文言)。git 管理外/解決不能/空を 1 メッセージへ畳む。
      return {
        type: "policy.response",
        request_id: msg.request_id,
        enabled: false,
        categories: [],
        error: "path is not a resolvable git repository",
      };
    }
    return viewToResponse(msg.request_id, resolved);
  }

  // TDA-1 (decision 019f0f2f): multi-daemon fan-out の伝播コピーは persist:false で届く。受信 daemon は
  // memory のみ反映し disk を書かない (authoritative な disk 書込は owner 一点に限定し、stale daemon が
  // 厳格 override を黙って消す silent downgrade を防ぐ)。省略=true で従来どおり owner が永続する。
  const persist = msg.persist !== false;

  let view: PolicyConfigView;
  if (msg.op === "set") {
    // 指定フィールドのみ partial update。untrusted categories は sanitize で closed enum へ。
    // SEC-R2-1 (decision 019f0f64): repo_label も sidecar 側で sanitize し二重防御 (control-token 直送の
    // 自由文字列が at-rest/UI へ raw で載るのを防ぐ・backend と同一 helper でドリフト無し)。
    const repoLabel = sanitizeRepoLabel(msg.repo_label);
    view = bridge.setPolicyConfig({
      ...(typeof msg.enabled === "boolean" ? { enabled: msg.enabled } : {}),
      ...(msg.categories !== undefined ? { categories: sanitizeCategories(msg.categories) } : {}),
      ...(repoScope !== undefined ? { repoScope } : {}),
      ...(repoLabel !== undefined ? { repoLabel } : {}),
      persist,
    });
  } else if (msg.op === "unset" && repoScope !== undefined) {
    // repo override を削除し default 継承へ戻す。repo_scope 無しの unset は no-op (get 扱い)。
    view = bridge.removePolicyRepo(repoScope, { persist });
  } else {
    // get / 未知 / 不在 → 現状読取り (fail-safe・変更しない)。
    view = bridge.getPolicyConfig(repoScope);
  }
  return viewToResponse(msg.request_id, view);
}
