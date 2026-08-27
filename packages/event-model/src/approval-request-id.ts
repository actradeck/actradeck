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
 *  - 残余 (固定リテラル `apr-` / tag 枠を跨ぐ将来ルール等) の防衛線は **構造 metatest**
 *    (INV-APPROVAL-REQUEST-ID-STABLE: 全 REDACTION_RULES × id 形状 corpus で 0 マッチを pin —
 *    該当ルールを追加した日に CI で赤くなる)。sidecar bridge の採番時 re-roll は token 依存
 *    ルールの runtime 緩和にすぎない (固定部マッチには無力・bridge docstring 参照・SEC-R3-2)。
 *    redaction ルールを追加する際は同 INV を必ず通すこと。
 *
 * ## 予測不能性 (3#SEC-1)
 * mint の token は uuid v4 (CSPRNG)。**実効エントロピーは 122 bit** (128 bit 中 6 bit は
 * version/variant 固定 — R2 の randomBytes(16) 比で 6 bit 減だが要件に対し十分・正直開示
 * SEC-R3-8)。foreign request_id 拒否は bridge Map lookup で行われ、tag (session 相関の
 * デバッグ補助) の解析には依存しない。
 *
 * ## demo 変種
 * safety-demo は「テストが同じ id を再計算できる」決定論的 request_id を要する。
 * `deriveDemoApprovalRequestId` は sha256 由来の決定論 token を使う。予測可能でも
 * 3#SEC-1 (foreign resolve 総当たり) が成立しないのは、demo hold の解決が per-connection
 * 256bit controlToken 検証 (safety-demo-driver の tokenMatches) で gate されるため
 * (SEC-R3-8: 「backend 内部で完結」は誤り — driver は WS 越しの別プロセス)。
 * 形式は mint と同一 = redaction-stable。
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

/**
 * **出荷済みの旧採番形 (known-legacy・閉じた列挙)** — reconciler の DB 側 request_id ゲート
 * (SEC-R5-2) が「合成 retire してよい id」を決めるために消費する。
 *
 * 背景: backend reconciler は「hello 宣言に無い DB pending」を合成 cancel するが、宣言側は
 * `parseActivePendingRequestIds` が正準 RE を宣言単位で強制する。at-rest 側に同じゲートが無いと、
 * 適合宣言に**載り得ない** id (redaction で mangle された id / 別 namespace の id) が
 * 「宣言に無い」だけで stale 扱いされ、生きている承認が retire される (fail-unsafe 非対称)。
 * 「宣言に無い」が staleness の証拠になるのは、その id が適合宣言に載り得る形をしているときだけ。
 *
 * 一方 CHANGELOG (0.7.0) は「旧 daemon が永続した pending は coordinated upgrade 後の初回 hello で
 * relay_lost として retire される (designed recovery)」を契約している。正準のみのゲートは
 * この回収を壊すため、**過去に出荷した採番形を閉じた列挙で retire 対象に含める**。
 *
 *  - v0.1.0 〜 v0.6.0 (sidecar bridge): `${sessionId}:apr-<base64url 22 文字>`
 *    (`randomBytes(16).toString("base64url")`・v0.1.0 tag 時点で既にこの形)。
 *  - v0.4.0 〜 v0.6.0 (backend safety-demo-driver): `${sessionId}:apr-<n>` (固定連番 `apr-1`・
 *    SEC-V9-2: production src の第 2 採番点で、この形の demo pending は base では retire されていた)。
 *  - tag 以前 (コード履歴のみ): `${sessionId}:apr-<Date.now()>-<seq>`。
 *
 * session prefix は plausible な session id 文字集合 (`[A-Za-z0-9_.-]`) に限る — redaction marker
 * (`[REDACTED:…]` 等・`[` `]` `:` を含む) に置換された prefix はここで**構造的に排除**される
 * (mangled legacy id を「legacy 形」として誤って retire しない)。
 *
 * 規律: これは**過去の**列挙。新形式を足すことは無い (現行は `APPROVAL_REQUEST_ID_RE`)。
 * 削除も禁止 — 削除した形の pending が旧 DB に残っていれば恒久 pending 化する (安全側だが
 * designed recovery の契約違反)。
 */
export const LEGACY_APPROVAL_REQUEST_ID_RES: readonly RegExp[] = Object.freeze([
  /^[A-Za-z0-9_.-]{1,128}:apr-[A-Za-z0-9_-]{22}$/,
  /^[A-Za-z0-9_.-]{1,128}:apr-\d{1,9}$/,
  /^[A-Za-z0-9_.-]{1,128}:apr-\d{13}-\d{1,9}$/,
]);

/**
 * DB pending の request_id が **合成 retire の対象になりうる形** か (正準 OR known-legacy)。
 *
 * false = 「適合宣言に載り得ない id」— 宣言に無くても staleness の証拠にならないため、
 * reconciler は合成 cancel せず skip する (fail-safe: 消さない方向)。該当例:
 *  - redaction で mangle された id (`[REDACTED:…]:apr-…` / token 部が marker 化)。
 *  - `tu:<tool_use_id>` (command 相関の別 namespace・INV-REQUEST-ID-NAMESPACE)。
 *  - 任意の未知形。
 */
export function isRetirableApprovalRequestId(id: string): boolean {
  if (APPROVAL_REQUEST_ID_RE.test(id)) return true;
  for (const re of LEGACY_APPROVAL_REQUEST_ID_RES) if (re.test(id)) return true;
  return false;
}
