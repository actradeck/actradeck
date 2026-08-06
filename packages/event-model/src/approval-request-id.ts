/**
 * approval-request-id — 承認 request_id 採番の **正準実装** (T1・単一出所・Phase 4 監査 R3)。
 *
 * 背景 (SEC-1 H → TDA-R2-1/SEC-R2-4): 旧採番 `${sessionId}:apr-…` は raw session_id を
 * payload.request_id へ露出し、`sess_<uuidv7>` 形 (41 文字の単一 charset run) の session_id が
 * redaction high-entropy ルールで mangle され「宣言 (raw) と at-rest (redacted) の id 空間割れ」
 * を起こした (UI approve no-op + reconcile の生存 pending 誤 retire)。R2 は sidecar 側だけを
 * 直したが backend の safety-demo-driver に旧形の第二採番点が残った (consolidation 違反)。
 * sidecar は backend から import できないため、正準を event-model へ置き両ティアが共有する。
 *
 * ## redaction-stability の根拠 (SEC-R2-3: 「確率的でなく構造的」への格上げ)
 * 形式: `s<sha256(session_id) 先頭12hex>:apr-<32 lowercase hex>`。
 *  - **high-entropy ルール (40+ 文字 run) に対して構造的に安全**: 最長 charset run は
 *    `apr-` + 32hex = 36 文字 < 40。
 *  - **vendor-prefix ルールに対しても構造的に安全**: token charset を [0-9a-f] に限定した。
 *    既知 vendor prefix (xox[baprs]- / AKIA / ghp_ / sk- / glpat- / hf_ 等) はいずれも
 *    hex 外の文字 (g-z の大半・大文字・`_`) を必要とし、token 内に出現し得ない
 *    (R2 の base64url token は `xoxb-…` 形を確率的に含みえた — 実測 ~4.5e-9/id)。
 *  - 残余 (固定リテラル `apr-` を跨ぐ将来ルール等) は sidecar bridge の採番時 re-roll
 *    (redactString(id) === id を確認) と INV-APPROVAL-REQUEST-ID-STABLE (実 redactor pin)
 *    が防衛線。redaction ルールを追加する際は同 INV を必ず通すこと。
 *
 * ## 予測不能性 (3#SEC-1)
 * mint の token は uuid v4 (CSPRNG・122 bit)。foreign request_id 拒否は bridge Map lookup で
 * 行われ、tag (session 相関のデバッグ補助) の解析には依存しない。
 *
 * ## demo 変種
 * safety-demo は「テストが同じ id を再計算できる」決定論的 request_id を要する。
 * `deriveDemoApprovalRequestId` は sha256 由来の決定論 token を使う (session_id は公開の
 * 相関キーであり、demo の id が予測可能でも 3#SEC-1 の脅威 (foreign resolve 総当たり) は
 * demo driver が backend 内部で完結するため該当しない)。形式は mint と同一 = redaction-stable。
 */
import { v4 as uuidv4 } from "uuid";

import { sha256Hex } from "./hash.js";

/** 採番形式の shape (両ティアのテストが charset 構造 pin に使う)。 */
export const APPROVAL_REQUEST_ID_RE = /^s[0-9a-f]{12}:apr-[0-9a-f]{32}$/;

function approvalRequestId(sessionId: string, token32hex: string): string {
  return `s${sha256Hex(sessionId).slice(0, 12)}:apr-${token32hex}`;
}

/** 承認 request_id を採番する (production・CSPRNG token)。 */
export function mintApprovalRequestId(sessionId: string): string {
  return approvalRequestId(sessionId, uuidv4().replace(/-/g, ""));
}

/**
 * safety-demo 用の決定論的 request_id (同一 session_id → 同一 id・テストが再計算可能)。
 * production 承認経路では使わないこと (予測可能性は demo 内部でのみ許容)。
 */
export function deriveDemoApprovalRequestId(sessionId: string): string {
  return approvalRequestId(sessionId, sha256Hex(`demo-approval:${sessionId}`).slice(0, 32));
}
