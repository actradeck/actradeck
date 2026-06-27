/**
 * Redaction kind 語彙の T1 正典 (single source of truth).
 *
 * 「redaction の種類 (kind)」は、sidecar redactor が `[REDACTED:<kind>]` マーカーで出す**公開可能な
 * 安定 enum**であり、原文 (秘匿値そのもの) は一切含まない。この語彙を **event-model に一箇所**で定義し、
 * 以下が**すべて同じこの集合を参照**することで層をまたいだドリフトを防ぐ:
 *
 * - sidecar redactor (`KNOWN_REDACTION_KINDS`): redacted ツリー走査時の by-kind allowlist (sink choke)。
 *   redactor は `REDACTION_KINDS` を import し allowlist を導出する (`REDACTION_RULES.map(...)` からの
 *   導出を置換済)。`REDACTION_RULES` の各 kind が `REDACTION_KINDS` の**部分集合**であることはテストで pin する。
 * - projection (`mergeRedactionCountByKind`): network 受信イベントを `session_state` jsonb / DTO / WS へ
 *   畳む**唯一の書込点**。ここで `REDACTION_KINDS` に無い kind を graceful に捨てる
 *   (SEC-3 の closed-enum enforcement の choke。`Object.create(null)` と二重防御)。
 *
 * ## 依存方向 (重要)
 * event-model / projection は **sidecar を import 不可** (層の依存方向)。よって kind 語彙の権威を
 * event-model に置き、sidecar 側がこれを import する (逆ではない)。これが「redaction の種類」語彙の
 * 単一権威 (T1)。
 *
 * ## closed-enum 契約 (SEC-3)
 * `redaction_count_by_kind` の値は件数 (非負整数) のみで、kind 名 (key) は本集合に限られる。
 * crafted event が任意の kind 名 (phantom / secret 形文字列の key 注入) を載せても、projection gate が
 * 捨てるため `session_state` 永続・DTO・WS 配信には漏れない。**未知 kind は reject でなく strip
 * (graceful)** とし、旧 sidecar 由来 event を絶対に落とさない (forward-compat 厳守)。
 *
 * ## 集合を増やすとき
 * redactor に新ルール (kind) を追加したら、本集合にも追加する。追加し忘れると
 * `REDACTION_RULES.kind ⊆ REDACTION_KINDS` の pin テストが赤くなり検出される。
 * 値は `[a-z0-9-]+` (redactor マーカー文字クラスと両立) で、prototype 名 (constructor / __proto__ 等) と
 * 衝突しないことを前提とする。
 */

/**
 * 既知 redaction kind の正典集合 (canonical vocabulary)。
 * sidecar `REDACTION_RULES` が出す全 kind を網羅する (= rule の kind の上位集合 / 現状は一致)。
 */
export const REDACTION_KINDS = [
  // 鍵ブロック
  "private-key",
  // クラウド / ベンダ固有 token
  "aws-access-key-id",
  "github-token",
  "anthropic-key",
  "openai-key",
  "google-api-key",
  "slack-token",
  "stripe-key",
  "gitlab-token",
  "sendgrid-key",
  // Phase 4 (019e9255): bare vendor token (high-entropy gate の 3-class/40字 死角を固定 prefix で補完)
  "huggingface-token",
  "azure-ad-client-secret",
  "databricks-token",
  "doppler-token",
  "planetscale-token",
  "flyio-token",
  // URL 埋込 webhook secret
  "slack-webhook",
  "discord-webhook",
  // JWT
  "jwt",
  // Authorization 系
  "basic-auth",
  "bearer-token",
  "auth-header-scheme",
  "auth-scheme-value",
  // Cookie
  "cookie",
  // npm registry token
  "npm-auth-token",
  // 汎用 credential 代入 / URL credential / 高エントロピー / sentry
  "credential-assignment",
  "url-credential",
  "high-entropy-secret",
  "sentry-dsn",
] as const;

/** 1 つの redaction kind 名 (closed-enum)。 */
export type RedactionKind = (typeof REDACTION_KINDS)[number];

/**
 * 既知 kind の高速判定用集合。`mergeRedactionCountByKind` / redactor allowlist の gate に使う。
 * `ReadonlySet<string>` として公開し、任意の string を照合できる (closed-enum gate)。
 */
export const REDACTION_KINDS_SET: ReadonlySet<string> = new Set(REDACTION_KINDS);

/** 与えられた文字列が既知の redaction kind か判定する。 */
export function isKnownRedactionKind(kind: string): kind is RedactionKind {
  return REDACTION_KINDS_SET.has(kind);
}

/**
 * redaction マーカー `[REDACTED:<kind>]` の `<kind>` 部が取りうる文字クラス**内容**の単一の真実
 * (TDA-2: SQL↔TS forward-drift 構造閉塞)。
 *
 * sidecar redactor が `token()` で出す kind 名 (= 公開 enum・原文非含有) と、それを at-rest から
 * 数え直す read 側 counter (sidecar の `REDACTION_MARKER_RE` / `REDACTION_MARKER_KIND_RE`、backend の
 * `ALL_MARKERS_REGEX`) が**この 1 定数を共有**し、各層が独自に `[a-z0-9-]+` を再ハードコードしない。
 * 文字クラス末尾の `-` は character class 内でリテラル。**masking はこの文字クラス定数には依存しない**
 * (write の `token()`=`redactionMarker()` は `<kind>` を label に挟むだけで charset を参照しない)。label の
 * 接頭/接尾 `REDACTION_MARKER_PREFIX`/`SUFFIX` は write/read が**共有**する (下記・TDA-5)。本定数は read
 * (計数) 側の kind 認識契約のみを司る。
 * 両者の round-trip (mask が産むマーカーを read が完全捕捉する) は inv-redaction-kinds /
 * INV-REDACTION-MARKER-ROUNDTRIP で pin する。
 */
export const REDACTION_MARKER_KIND_CHARSET = "a-z0-9-";

/**
 * redaction マーカーのラベル接頭 `[REDACTED:` / 接尾 `]` の単一の真実 (TDA-5: 接頭/接尾の書式を
 * 各層で再 type しない)。write 側 (sidecar redactor の `token()`=`redactionMarker()`)・read 側
 * (backend audit-store の literal/SQL marker)・下の regex pattern が**この 2 定数を共有**する。
 * `redactionMarker(kind)` がマスク文字列を産み、pattern が同じ接頭/接尾から構築されるので、
 * 「mask が産むマーカーを read が完全捕捉する」round-trip は**構造上**保証される (手動同期でなく単一
 * source)。INV-REDACTION-MARKER-ROUNDTRIP / inv-redaction-kinds で pin。
 */
export const REDACTION_MARKER_PREFIX = "[REDACTED:";
export const REDACTION_MARKER_SUFFIX = "]";

/**
 * マスク文字列 `[REDACTED:<kind>]` を産む唯一のビルダ。write (redactor `token()`) と
 * read 側の literal-search (audit-store drill-down の bind-param marker) が共有し、ラベル書式の
 * ドリフトを構造閉塞する (TDA-5)。`<kind>` は呼び出し側が closed-enum から渡す (本ビルダは検証しない)。
 */
export const redactionMarker = (kind: string): string =>
  `${REDACTION_MARKER_PREFIX}${kind}${REDACTION_MARKER_SUFFIX}`;

/** literal を正規表現 source へエスケープ (接頭の `[` / 接尾の `]` を含むため必須)。 */
const escapeRegexLiteral = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 全マーカー (任意 known/unknown kind) を捕捉する正規表現の **source 文字列** (kind 捕捉なし)。
 * read 側 scalar counter (sidecar `REDACTION_MARKER_RE` / backend `ALL_MARKERS_REGEX` =
 * Postgres `regexp_count`) が派生する。接頭/接尾は `REDACTION_MARKER_PREFIX`/`SUFFIX` を
 * エスケープして構築し、文字クラスは `REDACTION_MARKER_KIND_CHARSET` 由来 — どちらも 1 箇所。
 */
export const REDACTION_MARKER_PATTERN = `${escapeRegexLiteral(REDACTION_MARKER_PREFIX)}[${REDACTION_MARKER_KIND_CHARSET}]+${escapeRegexLiteral(REDACTION_MARKER_SUFFIX)}`;

/**
 * 全マーカーを捕捉し `<kind>` を **group 1** に取る正規表現の source 文字列。
 * read 側 kind 別 counter (sidecar `REDACTION_MARKER_KIND_RE`) が派生する。接頭/接尾・文字クラスは
 * `REDACTION_MARKER_PATTERN` と同一 source (`REDACTION_MARKER_PREFIX`/`SUFFIX`/`KIND_CHARSET` 由来)。
 */
export const REDACTION_MARKER_KIND_PATTERN = `${escapeRegexLiteral(REDACTION_MARKER_PREFIX)}([${REDACTION_MARKER_KIND_CHARSET}]+)${escapeRegexLiteral(REDACTION_MARKER_SUFFIX)}`;

/**
 * 受信 / jsonb 由来の「kind 別件数」record を**信頼境界で gate する単一 helper** (SEC-1r / SEC-3)。
 *
 * read/carry (ingest parse / realtime DTO / webui parse) と write/集計/merge (projection /
 * audit) が**同一の gate**を共有し、key allowlist と値述語のドリフトを構造的に排除する
 * (TDA-1/TDA-2: 旧実装は 4〜5 箇所に同型 gate が重複し値述語が >=0 / >0 / isFinite に割れていた)。
 *
 * - **key**: closed-enum allowlist (`REDACTION_KINDS_SET`) に在る kind のみ採用。語彙外
 *   (phantom / secret 形 / `__proto__` / `constructor` 等の prototype 名) は捨てる。
 * - **value**: **正の整数のみ** (`Number.isInteger(v) && v > 0`)。count=0 は「観測なし」= 落とす。
 *   負 / 非整数 / 非有限 / 非数値も捨てる。kind 別件数の値域を全層で一意にする。
 * - **nullProto=true**: 出力を `Object.create(null)` にする (prototype 汚染の二重防御。
 *   write/集計/merge 経路で kind="constructor" 等の継承プロパティ解決を原理的に塞ぐ)。
 *
 * **原文 (秘匿値そのもの) は一切含まない**: key は公開 enum、value は件数のみ。redaction を
 * **しない** (集計の gate のみ・新 redaction 面ゼロ)。INV-REDACTION は redactString が担保する。
 */
export function gateRedactionCountByKind(raw: unknown, nullProto = false): Record<string, number> {
  const out: Record<string, number> = nullProto
    ? (Object.create(null) as Record<string, number>)
    : {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!REDACTION_KINDS_SET.has(k)) continue; // 語彙外 (phantom / prototype 名) を遮断。
    if (typeof v === "number" && Number.isInteger(v) && v > 0) out[k] = v; // 正の整数のみ。
  }
  return out;
}
