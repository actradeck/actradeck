/**
 * approval-reconcile-wire — hello frame に相乗りする承認 reconciliation 宣言
 * (`runtime_epoch` / `active_pending_request_ids`) の wire 構築 + 受信検証の **正準実装**
 * (T1・単一出所・ADR 0014 Phase 4)。
 *
 * 背景 (TDA-2・decision 019fd705): 送信 (sidecar ws-client の hello builder) と受信 (backend
 * SidecarRegistry.handleHello) が field 名・上限を手書きミラーすると、片側の改名/変更で
 * 「field 欠落 = 旧 daemon」の fail-safe 解釈に落ち **reconcile が黙って無効化** される
 * (silent-off・誰も落ちない)。agent_visibility (`parseAgentVisibilityWire`) と同じく、wire
 * 構築・受信検証・上限定数をここへ集約し両側で共有する (security-gate-reuse-canonical-parser)。
 *
 * fail-safe 意味論 (「消さない」方向へ倒す):
 *  - field 欠落 (旧 sidecar / observe-only daemon / provider 未生成) → undefined = reconcile しない。
 *  - 非配列 / 要素に非 string / 空文字 / 長さ超過 / 件数超過 → undefined = 宣言全体を捨てる
 *    (不正な宣言を根拠に pending を合成 cancel しない)。
 *  - 空配列は正当な「pending ゼロ」宣言 (受入#7 の根拠) — undefined と区別する。
 *  - 送信側も同一 cap を共有し、超過時は **切り詰めでなく field 省略** (TDA-9: 切り詰めると
 *    宣言に載らなかった生存 pending が偽 stale になる。省略なら受信側が reconcile しない=同義)。
 *
 * NO-RAW: 宣言に載るのは bridge 採番の相関 request_id (`mintApprovalRequestId` 由来・
 * redaction-stable) のみ。runtime_epoch は uuid shape のみ受理 (SEC-6: 任意文字列を
 * conn メタとして保持しない)。
 *
 * 純粋・fs/net 非アクセス (依存は同 package の正準 APPROVAL_REQUEST_ID_RE のみ)。
 */
import { APPROVAL_REQUEST_ID_RE } from "./approval-request-id.js";

/**
 * 1 hello 宣言に載せられる pending request_id の上限 (超過は宣言ごと無効 = reconcile しない)。
 * 根拠 (TDA-R2-4): 宣言は **daemon 単位** (全 session 分)。projection の per-session cap は
 * MAX_PENDING_APPROVALS=64 (packages/projection) ゆえ、1024 = 64/session × 16 sessions 相当。
 * 正規 daemon の同時 session はこの遥か下で、超過は malformed とみなし fail-safe (消さない)。
 */
export const MAX_ACTIVE_PENDING_IDS = 1024;

/** 宣言 request_id 1 件の長さ上限 (bridge 採番形は数十文字・十分な余裕)。 */
export const MAX_REQUEST_ID_LEN = 256;

/**
 * hello frame 上の field 名。正直な scope (TDA-R2-3): 送信側 (buildApprovalReconcileHelloFields)
 * はこの定数を消費するが、受信側 (backend HelloFrame) は型付き named field で読むため
 * 「構造的な単一出所」は cap と検証ロジックのみ。field 名の改名 drift は両側のテスト
 * (egress-handshake P4-* / backend inv-approval-reconcile A 群) のリテラル pin が赤化で防ぐ。
 */
export const ACTIVE_PENDING_FIELD = "active_pending_request_ids";
export const RUNTIME_EPOCH_FIELD = "runtime_epoch";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * hello frame へ相乗りさせる宣言 field 群を構築する (sidecar ws-client 用・単一出所)。
 * - `ids === undefined` (provider 未配線 / bridge 未生成) → field 自体を載せない (reconcile 対象外)。
 * - cap 超過 → field 省略 (TDA-9: 切り詰め禁止)。
 * - epoch は uuid shape のときのみ載せる (受信 gate と対称・非 uuid を送っても捨てられるだけ)。
 */
export function buildApprovalReconcileHelloFields(
  runtimeEpoch: string | undefined,
  ids: readonly string[] | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (runtimeEpoch !== undefined && UUID_RE.test(runtimeEpoch)) {
    out[RUNTIME_EPOCH_FIELD] = runtimeEpoch;
  }
  if (ids !== undefined && ids.length <= MAX_ACTIVE_PENDING_IDS) {
    out[ACTIVE_PENDING_FIELD] = [...ids];
  }
  return out;
}

/**
 * hello frame (untrusted) の `active_pending_request_ids` を検証射影する正準パーサ。
 * 有効なら Set (空 Set = 正当な「pending ゼロ」宣言)、欠落/malformed は undefined (reconcile しない)。
 *
 * SEC-R4-8: 各 id は正準 `APPROVAL_REQUEST_ID_RE` (bridge 採番形) を要求し、非適合が 1 件でも
 * あれば**宣言ごと**捨てる (security-gate-reuse-canonical-parser)。id 単位で落とすと「宣言に無い」
 * 扱いになった生存 pending が合成 cancel される (fail-unsafe) ため、必ず宣言単位で拒否する。
 * rollout 注意: 旧形式 (R2 base64url 以前) の id を宣言する旧 dist daemon は宣言が無効化され
 * reconcile 対象外になる (= stale pending が残る従来挙動へ縮退・安全方向。coordinated deploy で解消)。
 */
export function parseActivePendingRequestIds(raw: unknown): Set<string> | undefined {
  if (!Array.isArray(raw) || raw.length > MAX_ACTIVE_PENDING_IDS) return undefined;
  const out = new Set<string>();
  for (const id of raw) {
    if (
      typeof id !== "string" ||
      id.length === 0 ||
      id.length > MAX_REQUEST_ID_LEN ||
      !APPROVAL_REQUEST_ID_RE.test(id)
    ) {
      return undefined; // malformed → 宣言全体を捨てる (fail-safe)
    }
    out.add(id);
  }
  return out;
}

/**
 * hello frame (untrusted) の `runtime_epoch` を検証する正準パーサ (SEC-6: uuid shape gate)。
 * daemon プロセス毎の randomUUID 診断識別子のみ受理し、任意文字列の conn メタ持ち込みを遮断する。
 */
export function parseRuntimeEpoch(raw: unknown): string | undefined {
  if (typeof raw !== "string" || !UUID_RE.test(raw)) return undefined;
  return raw;
}
