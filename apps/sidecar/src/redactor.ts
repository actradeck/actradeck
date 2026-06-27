/**
 * Secret redactor (INV-REDACTION) — 保存・送信の「前」に適用する。
 *
 * 設計 (decision 019e8e49-d492):
 * - gitleaks 系ルール + 独自正規表現で key/token/credential/.env/Bearer/AWS/private key を検出・マスク。
 * - マスクは固定トークン `[REDACTED:<kind>]`。原文の長さ・内容は復元不能。
 * - イベント全体 (summary + payload の文字列値) を再帰走査して適用する。
 *
 * ReDoS 不変条件 (再#SEC-1):
 * - **すべての量指定子を有界化**する (`{0,N}` / `{N,M}`)。無界 `+`/`*` を入れ子にしない。
 *   特に「否定先読み × 反復」`((?:(?!q).)+)` や「無界 prefix + alternation」`[..]*(?:kw)` は
 *   catastrophic backtracking (入力長 n に対し O(n^2) 以上) を生む。長さ上限 (MAX_REDACT_INPUT)
 *   は n を縛るだけで n^2 爆発を防がないため、**ガードではなく量指定子の有界化が本対策**。
 * - 値部の最大捕捉長は MAX_VALUE_LEN で頭打ちにする (秘匿対象は十分カバーしつつ線形)。
 * - 新ルール追加時も同じ ReDoS 検査を必ず行う (INV-REDACTION 性能テストで担保)。
 *
 * ⚠️ ここは security-engineer の独立レビュー対象。網羅性の穴は監査自己申告へ。
 */
import {
  REDACTION_KINDS_SET,
  REDACTION_MARKER_PATTERN,
  REDACTION_MARKER_KIND_PATTERN,
  isKnownRedactionKind,
  redactionMarker,
} from "@actradeck/event-model";

/** redaction 後の表示用最大長 (補助的メモリ保護)。redaction を適用した「後」に切り詰める。 */
export const MAX_REDACT_INPUT = 256 * 1024;

/**
 * redaction 適用「前」の先行 slice 長 (3#SEC-2)。
 * MAX_REDACT_INPUT より「最長ルールの最大捕捉長」ぶん広く取る。これにより
 * MAX_REDACT_INPUT 境界を跨ぐ secret も先行 slice では完全に保持され、redaction で
 * 確実にマスクされてから最終 slice される (= 境界跨ぎの未マスク断片を残さない)。
 * 各 credential ルールの最大捕捉は概ね MAX_VALUE_LEN なので 2*MAX_VALUE_LEN の余裕を取る。
 */
export const PRE_REDACT_SLICE = MAX_REDACT_INPUT + 2 * 4096;

/**
 * credential 値・キー名トークンの最大捕捉長 (有界量指定子の上限)。
 * 実在の secret はこの範囲に収まる。これにより各ルールが入力長に対し線形になる。
 */
export const MAX_VALUE_LEN = 4096;
/** credential キー名 prefix/suffix トークンの最大長 (env 名・複合語を十分カバー)。 */
const MAX_KEY_TOKEN = 64;

/**
 * credential キー名に「含まれていれば」秘匿扱いにするキーワード集合 (alternation 断片)。
 * 3 つの credential-assignment ルール (double / single / bare) で共有し、ドリフトを防ぐ。
 *
 * 再#5 SEC-2: cloud 接続文字列 (Azure 等) の `AccountKey=` / `SharedAccessSignature` /
 *   `sas` / `sig` / `connectionstring` を追加し、長尺鍵を keyword 経路でも明示捕捉する
 *   (high-entropy 経路の網羅と二重に守る)。`accountkey`/`account[_-]?key` は AccountKey を、
 *   `\bsas\b`/`\bsig\b` は SAS token / signature を拾う。
 * ReDoS: 純 alternation (固定リテラル + 有界 `[_-]?`)。無界量指定子なし。
 */
const CREDENTIAL_KEYWORDS =
  "secret|passw(?:or)?d|pwd|token|credentials?|api[_-]?key|apikey|access[_-]?key|" +
  "account[_-]?key|accountkey|private[_-]?key|client[_-]?secret|connection[_-]?string|" +
  // 再#5c SEC-A: bare `*_KEY=` / `*-key=` (FERNET_KEY / SIGNING_KEY / ENCRYPTION_KEY 等)。
  //   `[_-]key` 境界で取り込み、`monkey`/`keyboard` (区切りなし) を誤爆しない。
  "[_-]key|" +
  "shared[_-]?access[_-]?signature|sas|sig|auth";

/**
 * high-entropy ルールの **stage-1 構造ガード** (再#5c SEC-C / 再#5d SEC-1,2,3)。
 *
 * `{40}`→`{40,N}`・urlsafe charset 拡張で、`/` を含む深い file path / URL path や
 * 連結 UUID が誤マスクされうる。ActraDeck の存在意義は file diff / command / path /
 * correlation id の可視化 (security.md「見せてよい」) であり、これらの破壊は監督シグナル喪失。
 *
 * ## 確定原則 (再#5d): **under-redaction(leak) の絶対回避 > over-redaction**。
 *   判別不能なケースは必ず **mask 側 (secret 扱い) に倒す = fail-safe**。
 *   keep してよいのは「**確信を持って path / 識別子 / UUID と言える**」場合のみ。
 *
 * keep 条件 (いずれか満たせば mask 見送り):
 *  1. 連結 UUID (`hex8-hex4-hex4-hex4-hex12` の `-` 連結) — `UUID_CONCAT_RE` (SEC-3)。
 *  2. `://` を含む (URL)。
 *  3. 先頭 `/`・`./`・`../` を **剥がした残り** が path-body 的 (SEC-1: 先頭区切りを剥がし
 *     本体を評価。`/aB3xY9…`(3-class secret) は本体が非語的 → mask)。
 *  4. 先頭区切りなしでも path-body 的。
 *
 * path-body 的 = 末尾 `.<ext>` を持つ、または `/` を 1 つ以上含み全 segment が
 *   **語的 (`isWordSegment`)**。1 segment でも非語的 (高エントロピー) なら path でない → mask
 *   (SEC-2: slash 区切りでも各 segment が乱雑なら secret 扱い)。
 *
 * ReDoS: 各部分式は有界量指定子のみ (`{1,40}` 等)・固定アンカー。split / 文字走査は線形。
 */
// 連結 UUID (1 個以上)。hex+dash の構造で secret と区別できる (SEC-3 keep)。
const UUID_CONCAT_RE =
  /^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}(?:-[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}){0,64}$/;
const PATH_PREFIX_RE = /^(?:\/|\.\/|\.\.\/)/;
const PATH_EXT_SUFFIX_RE = /\.[A-Za-z0-9]{1,8}$/;
const PATH_SEGMENT_SHAPE_RE = /^[A-Za-z0-9._-]{1,40}$/;
/** 大文字比率の上限 (超過は camelCase-random な secret 片)。 */
const MAX_SEGMENT_UPPER_RATIO = 0.4;
/** 数字比率の上限 (超過は digit 散在の secret 片。短語の `v2` 等は別途救済)。 */
const MAX_SEGMENT_DIGIT_RATIO = 0.25;
/** 連続子音の上限 (超過は語でない高エントロピー。real word はこれ未満)。 */
const MAX_CONSONANT_RUN = 4;
const VOWEL_RE = /[aeiouAEIOU]/;

/**
 * 1 つの `.`/`_`/`-`/`/` 区切り **sub-word** が「語的 (real word/identifier)」か。
 * fail-safe: 確信を持って語と言えなければ false (= secret 寄り)。
 * 語的条件 (全て満たす):
 *  - 形が `[A-Za-z0-9]{1,40}`。
 *  - 大文字比率 <= 0.4、数字比率 <= 0.25。
 *  - 母音を含む か 長さ <= 4 (短い識別子 `src`/`lib`/`v2` を救済)。
 *  - 連続子音 <= MAX_CONSONANT_RUN (乱雑な base64 片を排除)。
 */
function isWordlikeSubword(w: string): boolean {
  if (w.length === 0) return true; // 連続区切りによる空は中立。
  if (!/^[A-Za-z0-9]{1,40}$/.test(w)) return false;
  let upper = 0;
  let letters = 0;
  let digits = 0;
  let consonantRun = 0;
  for (let i = 0; i < w.length; i++) {
    const c = w.charCodeAt(i);
    const isUpper = c >= 65 && c <= 90;
    const isLower = c >= 97 && c <= 122;
    const isDigit = c >= 48 && c <= 57;
    if (isUpper) upper++;
    if (isUpper || isLower) {
      letters++;
      if (VOWEL_RE.test(w[i]!)) {
        consonantRun = 0;
      } else {
        consonantRun++;
        if (consonantRun > MAX_CONSONANT_RUN) return false;
      }
    } else {
      consonantRun = 0; // 数字で子音 run は途切れる。
    }
    if (isDigit) digits++;
  }
  if (letters === 0) return true; // 純数字 (`5`/`123`) は path index 等。中立で path 寄り。
  if (upper / letters > MAX_SEGMENT_UPPER_RATIO) return false;
  if (digits / w.length > MAX_SEGMENT_DIGIT_RATIO && w.length > 4) return false;
  // 長さ > 4 のとき母音必須 (子音/数字だけの乱雑トークンを排除)。
  if (w.length > 4 && !VOWEL_RE.test(w)) return false;
  return true;
}

/**
 * 1 つの `/`-区切り segment が "path segment 的" か。
 * segment を `.`/`_`/`-` で sub-word 分割し、**全 sub-word が語的**なら true。
 * 1 つでも非語的 (高エントロピー) sub-word があれば false (= secret 寄り、fail-safe)。
 */
function isPathSegment(seg: string): boolean {
  if (seg.length === 0) return true;
  if (!PATH_SEGMENT_SHAPE_RE.test(seg)) return false;
  return seg.split(/[._-]/).every(isWordlikeSubword);
}

/** 候補が "path-body 的" か (先頭区切りを剥がした後の本体評価に使う)。 */
function isPathBody(body: string): boolean {
  if (body.length === 0) return false;
  if (PATH_EXT_SUFFIX_RE.test(body)) return true;
  const slashCount = (body.match(/\//g) ?? []).length;
  // `/` を 1 つ以上含み全 segment が語的なら path。secret 片が混じれば false → mask。
  if (slashCount >= 1 && body.split("/").every(isPathSegment)) return true;
  return false;
}

/** 候補が path/URL/UUID 形か (true なら high-entropy mask を見送る = keep)。 */
function looksLikePath(candidate: string): boolean {
  // 1. 連結 UUID (SEC-3 keep)。
  if (UUID_CONCAT_RE.test(candidate)) return true;
  // 2. URL。
  if (candidate.includes("://")) return true;
  // 3. 先頭 `/`・`./`・`../` を剥がして本体を評価 (SEC-1: 区切りだけで keep しない)。
  const stripped = candidate.replace(PATH_PREFIX_RE, "");
  if (stripped !== candidate && isPathBody(stripped)) return true;
  // 4. 先頭区切りなしでも path-body 的なら keep。
  if (isPathBody(candidate)) return true;
  return false;
}

/**
 * 相関キー (correlation key) フィールドの保持 (LIVE-1, decision 019e956e)。
 *
 * 問題: fallback session_id `sess_<uuidv7>` (例 `sess_019e9529-f154-741e-80d5-d90a205fc82e`) は
 *   high-entropy ルール ([A-Za-z0-9+/_-]{40,} + 3 char-class) に当たり `[REDACTED:high-entropy-secret]`
 *   へ化ける。session_id は **秘密ではなく相関キー** (events / sessions / projection / liveness が
 *   join する唯一の単位。event.ts コメント参照)。redaction されると全 fallback セッションが単一
 *   バケツへ衝突し、Cockpit の projection (セッション分離・degraded 表示) が崩壊する。
 *
 * 方針 B (field-aware allowlist): redaction は **field-aware** (redactObject が構造を歩く)。
 *   構造化イベントの **相関キーフィールド** のキー名 (session_id 等) を **depth 0 (イベント
 *   identity top-level) でのみ** 同定し、その string 値が **相関キーの形** (`isCorrelationKeyValue`)
 *   のときに限り **値を保持**する。形ゲートを満たさない値 (= 本物の secret が紛れた場合) は
 *   従来どおり `redactString` を通すため leak を増やさない。
 *
 * ## leak を増やさない設計 (SEC 重点・redaction 019e98aa BLOCK 反映):
 *   - keep は **depth 0 限定** (SEC-2): nested object / array 要素内の同名 `session_id` は keep せず
 *     従来 redaction 経路へ戻す。攻撃者影響下の payload に `{session_id:<分割secret>}` を仕込む
 *     redaction 回避を塞ぐ。
 *   - 形ゲート `isCorrelationKeyValue` は **構造で secret と判別できる形だけ** を allowlist する:
 *       - 純 UUID 連結 (UUID_CONCAT_RE と同型) → keep (high-entropy override が安全)。
 *       - `<alpha>_<UUID>` (fallback `sess_<uuidv7>`) → keep (hex+dash 構造で secret と判別)。
 *       - `[A-Za-z][A-Za-z0-9_-]{0,127}` の語的トークン (`sess_live_probe_002`/`sess_abc123`/`s1`) は
 *         **full redactString (high-entropy 込み) が値を変えないこと** を最終ゲートにする (SEC-1 charset
 *         対称化): high-entropy run (charset `[A-Za-z0-9+/_-]{40,}` + 3-class) が当たる値は keep しない。
 *         → `_`/`-` で刻んだ 40+ 字 3-class secret は high-entropy が `_`/`-` 込み 1 run でマスクするため確実に弾く。
 *   - したがって `ghp_…`/`sk-ant-…` (特異ルール発火)、`api_key=secret` (charset 不適合)、
 *     `aB3xZ9qK_cD4eF6gH_…` 等の分割 secret (full redactString が high-entropy でマスク) は
 *     相関キーフィールドにあっても **依然マスク**される。
 *   - 相関キー名フィールド **以外** (payload / summary / 任意 nested key) は本ロジックを通らず従来どおり。
 *
 * ReDoS: 形ゲートは有界量指定子 ({0,N}) + 固定アンカーのみ。`+`/`*` 裸出現・否定先読み反復なし。
 *   full redactString 自体は既存の ReDoS 不変条件 (有界量指定子) で線形。
 */
// 相関キーとして扱う **トップレベル (depth 0)** フィールド名 (event.ts の id 系フィールドに一致)。
const CORRELATION_KEY_FIELDS = new Set([
  "session_id",
  "provider_session_id",
  "thread_id",
  "turn_id",
  "agent_id",
]);
// 純 UUID (連結含む)。secret と構造で判別できる (UUID_CONCAT_RE と同型)。
const CORRELATION_UUID_RE = UUID_CONCAT_RE;
// `<alpha>_<UUID>` 形 (fallback `sess_<uuidv7>` 等)。prefix は英字 + `_`、本体は UUID。
const CORRELATION_PREFIXED_UUID_RE =
  /^[A-Za-z]{1,16}_[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;
// 語的トークン id (`sess_live_probe_002` / `sess_abc123` / `s1` / ACTRADECK_SESSION)。
//   厳格 charset `[A-Za-z0-9_-]` のみ・英字始まり・有界長。`=`/`:`/`+`/`/`/`.`/空白を含まない。
const CORRELATION_WORD_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
/**
 * 値が「相関キーの形」か (true なら相関キーフィールドで保持する)。
 * fail-safe: 確信を持って相関 id と言えなければ false (= 従来の redactString 経路へ → 必要なら mask)。
 *
 * ## SEC-1 再修正 (charset 対称化・redaction 019e98aa BLOCK):
 *   旧実装は (a) `isWordlikeIdSegment` の `≤8 → true` 短絡 と (b) G2 が high-entropy を **skip** する
 *   非対称により、`_`/`-` で ≤8 字に刻んだ 40+ 字・3-class secret
 *   (`aB3xZ9qK_cD4eF6gH_…` / `tok_3kJ9-vBn2-…` / AWS secret 風) を相関フィールドで未マスク保持していた
 *   (under-redaction leak)。high-entropy run の charset は `[A-Za-z0-9+/_-]` で `_`/`-` を **run の一部**と
 *   するのに、ゲート側は `_`/`-` を **segment 区切り**として扱う非対称が穴の本質。
 *
 *   対称化方針 (under-redaction 絶対回避): override してよいのは「構造で secret と判別できる」
 *   **純 UUID / `<alpha>_<UUID>`** のみ。それ以外の語的トークン id は
 *   **full redactString (high-entropy 込み) が値を変えないこと** を最終ゲートにする。
 *   = high-entropy ルール (charset `[A-Za-z0-9+/_-]{40,}` + 3-class) が **その値全体としてマスク対象なら keep しない**。
 *   `_`/`-` を含む 40+ 字 3-class run は high-entropy が `_`/`-` 込みで 1 run としてマスクするため確実に弾かれる。
 *
 *   正規 id の救済:
 *     - `sess_<uuidv7>` は high-entropy が `sess_<uuid>` 全体を 1 run でマスクしてしまう (元 LIVE-1 bug) ため、
 *       full redactString では救えない。→ **構造マッチ (CORRELATION_PREFIXED_UUID_RE) で先取りして keep**。
 *       UUID は hex+dash の固定構造で secret と判別でき、override が安全。
 *     - `sess_live_probe_002` / `sess_abc123` / `s1` は 2-class・低エントロピーで high-entropy 非発火 →
 *       full redactString が素通しするので keep される。
 */
function isCorrelationKeyValue(value: string): boolean {
  if (value.length === 0 || value.length > 256) return false;
  // (1) 構造で secret と判別できる UUID / `<alpha>_<UUID>` は keep (high-entropy override が安全)。
  if (CORRELATION_UUID_RE.test(value)) return true;
  if (CORRELATION_PREFIXED_UUID_RE.test(value)) return true;
  // (2) それ以外は厳格 charset の語的トークンに限り、**full redactString (high-entropy 込み) で
  //     値が変わらないこと** を要求する (charset 対称化: high-entropy が当たる値は keep しない)。
  if (!CORRELATION_WORD_ID_RE.test(value)) return false;
  return redactString(value) === value;
}

/**
 * 自動ガード (ADR 019ecc70 D3): `secret_kinds` フィールドの公開 enum 保持。
 *
 * 問題: `secret_kinds` というキー名は credential ヒューリスティック (`isCredentialKey`: `secret`
 *   を含む) に当たり、配下の string 値が **credential 文脈で無条件マスク**される。だが
 *   secret_kinds の値は redactor が出す **公開 enum (REDACTION_KINDS)** であって秘匿値ではない
 *   (例 "github-token")。マスクすると `["[REDACTED:credential-assignment]"]` になり、
 *   event-model の closed-enum schema を満たさず event が drop される (over-redaction による機能破壊)。
 *
 * leak を増やさない設計 (CORRELATION_KEY_FIELDS と同型の **value-shape allowlist gate**):
 *   - keep するのは **`isKnownRedactionKind` を満たす string のみ** (= REDACTION_KINDS 語彙)。
 *     攻撃者影響下の payload に `{secret_kinds:["ghp_<realsecret>"]}` を仕込んでも、値が既知 kind
 *     でなければ keep せず従来 redaction 経路 (redactString) を通る → 依然マスクされる。
 *     よって depth 非依存で leak-safe (値ゲートが唯一の許可条件・深さは問わない)。
 *   - 配列要素のうち既知 kind は素通し、それ以外は redactString。非 string 要素は redactValue。
 *
 * ReDoS: 新規正規表現なし。`isKnownRedactionKind` は Set lookup (線形)。redactString は既存有界。
 */
const SECRET_KIND_FIELDS = new Set(["secret_kinds"]);
function redactSecretKindsValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (!Array.isArray(value)) {
    // 配列でなければ keep の前提を満たさない → 従来 credential 文脈マスクへ委ねる (fail-safe)。
    return redactValue(value, seen, true, depth + 1);
  }
  return value.map((el) => {
    if (typeof el === "string") {
      // 既知 kind (公開 enum) のみ keep。未知/secret 形は redactString でマスク (leak-safe)。
      return isKnownRedactionKind(el) ? el : redactString(el);
    }
    // 非 string 要素 (想定外) は credential 文脈で再帰マスク (fail-safe)。
    return redactValue(el, seen, true, depth + 1);
  });
}

/** 1 件の redaction ルール。 */
export interface RedactionRule {
  readonly kind: string;
  readonly pattern: RegExp;
  /**
   * マスク関数。マッチ全体を受け取り置換文字列を返す。
   * 既定はマッチ全体を `[REDACTED:<kind>]` に置換するが、URL basic-auth や
   * `KEY=VALUE` のように「値部分だけ」をマスクしたい場合にグループを温存する。
   */
  readonly mask?: (match: string, ...groups: string[]) => string;
}

// TDA-5: マスク文字列のラベル書式 (`[REDACTED:`/`]`) は event-model の単一 source から派生
// (write/read で再 type しない)。出力は従来と byte 一致 (`redactionMarker(kind)` = `[REDACTED:${kind}]`)。
const token = (kind: string): string => redactionMarker(kind);

/**
 * ルール表。順序は「より特異なものを先」に並べる (汎用 assignment が
 * 特異トークンを飲み込まないように)。すべて global flag。
 */
export const REDACTION_RULES: readonly RedactionRule[] = [
  // --- 鍵ブロック (複数行) -------------------------------------------------
  {
    kind: "private-key",
    pattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g,
  },

  // --- クラウド / ベンダ固有 token ----------------------------------------
  { kind: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA|AROA|AIDA)[0-9A-Z]{16}\b/g },
  { kind: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,255}\b/g },
  { kind: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "openai-key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "slack-token", pattern: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
  { kind: "stripe-key", pattern: /\b(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g },
  // 3#SEC-3: GitLab Personal/Project/Group Access Token (glpat- + 20 字 base62)。
  // 上限を有界化 ({20,64}) — glpat token は 20 字だが将来形式も含め線形に。
  { kind: "gitlab-token", pattern: /\bglpat-[0-9A-Za-z_-]{20,64}\b/g },
  // 3#SEC-3: SendGrid API key (SG. + 22 字 + . + 43 字)。各セグメント有界。
  { kind: "sendgrid-key", pattern: /\bSG\.[0-9A-Za-z_-]{16,32}\.[0-9A-Za-z_-]{32,64}\b/g },

  // --- Phase 4 (SEC 019e9255): bare vendor token --------------------------
  //   high-entropy gate の「distinct-class>=3 かつ 40 字以上」を満たさない短い/低エントロピーな
  //   vendor token を、特異な固定 prefix + 有界量指定子で確実に捕捉する (high-entropy gate は緩めない)。
  //   いずれも FP≈0 (特異 prefix)・ReDoS linear (固定 prefix + `{N,M}` + 単一 lookahead/lookbehind、
  //   裸の `+`/`*` や入れ子量指定子なし)。末尾が `=`/`-`/`.` になりうる token は `\b` が崩れるため
  //   否定先読みで境界を締める。high-entropy rule より前 (= より特異) に置き正しい kind を付与する。
  // Hugging Face access token (hf_ + 34..40 base62)。gitleaks 2026 同型。
  { kind: "huggingface-token", pattern: /\bhf_[A-Za-z0-9]{34,40}\b/g },
  // Azure AD / Entra client secret。固定 marker `\dQ~` が FP を潰す (gitleaks 同型)。
  //   lookbehind/lookahead で run 中間 start/end を防ぐ (`~`/`.`/`-` を含む token 境界)。
  {
    kind: "azure-ad-client-secret",
    pattern: /(?<![A-Za-z0-9_~.-])[A-Za-z0-9_~.]{3}\dQ~[A-Za-z0-9_~.-]{31,34}(?![A-Za-z0-9_~.-])/g,
  },
  // Databricks personal access token (dapi + 32 hex (+ `-<digit>`))。
  { kind: "databricks-token", pattern: /\bdapi[0-9a-f]{32}(?:-\d)?\b/g },
  // Doppler service/personal token (dp.pt. + 43 base62)。
  { kind: "doppler-token", pattern: /\bdp\.pt\.[A-Za-z0-9]{43}\b/g },
  // PlanetScale token (pscale_tkn_ / pscale_oauth_ + 32..64)。末尾 `=`/`.`/`-` 可ゆえ lookahead 境界。
  {
    kind: "planetscale-token",
    pattern: /\bpscale_(?:tkn|oauth)_[A-Za-z0-9=._-]{32,64}(?![A-Za-z0-9=._-])/g,
  },
  // Fly.io token (fo1_ + 43、または fm[12][ar]?_ + base64{40,200} + padding)。末尾 padding ゆえ lookahead 境界。
  {
    kind: "flyio-token",
    pattern: /\b(?:fo1_[\w-]{43}|fm[12][ar]?_[A-Za-z0-9+/]{40,200}={0,3})(?![A-Za-z0-9+/=])/g,
  },

  // --- URL 埋込 webhook secret (Slack/Discord 等) -------------------------
  // 再#SEC-4: hooks.slack.com/services/T../B../xxxx の末尾トークンを秘匿。
  // ホストとパス前段は温存し、最終のランダムトークン部分のみマスク。
  // ReDoS: 各セグメントは有界量指定子。無界 `+`/入れ子なし。
  {
    kind: "slack-webhook",
    pattern:
      /\b(hooks\.slack\.com\/services\/T[A-Z0-9]{6,16}\/B[A-Z0-9]{6,16}\/)[A-Za-z0-9]{16,48}/g,
    mask: (_m, prefix: string) => `${prefix}${token("slack-webhook")}`,
  },
  {
    kind: "discord-webhook",
    pattern: /\b(discord(?:app)?\.com\/api\/webhooks\/\d{5,24}\/)[A-Za-z0-9_-]{32,128}/g,
    mask: (_m, prefix: string) => `${prefix}${token("discord-webhook")}`,
  },

  // --- JWT (header.payload.signature, base64url) ---------------------------
  {
    kind: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },

  // --- Authorization: Basic <base64> (Bearer より前: "Basic" を先取り) -------
  {
    kind: "basic-auth",
    pattern: /\bBasic\s+[A-Za-z0-9+/]{8,}={0,2}/gi,
    mask: () => token("basic-auth"),
  },

  // --- Authorization / Bearer ---------------------------------------------
  {
    kind: "bearer-token",
    pattern: /\b(?:Bearer|Token)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    mask: () => token("bearer-token"),
  },

  // --- Authorization 系ヘッダ (任意 scheme) — 再#5 SEC-1 ---------------------
  // `Authorization: <scheme> <secret>` で scheme が Bearer/Basic/Token に限らない
  // 場合 (ApiKey / Negotiate / NTLM / ベンダ独自) に、scheme 語を温存し
  // **scheme 語以降の値全体 (改行前まで) を一律マスク**する。Bearer/Basic ルールが
  // 先に処理する scheme は既にマスク済みなので二重マスクされない (値が [REDACTED:…]
  // になっており、本ルールの scheme 直後 \s+ <値> 形に合致しない)。
  // 対象ヘッダ名: Authorization / Proxy-Authorization / WWW-Authenticate。
  // ReDoS: ヘッダ名・scheme 語・値部はすべて有界量指定子 ({N,M})。`+`/`*` 裸出現なし。
  // 値部は否定文字クラス [^\r\n] の有界反復のみ (否定先読み×反復なし)。
  {
    kind: "auth-header-scheme",
    pattern: new RegExp(
      `\\b(Proxy-Authorization|WWW-Authenticate|Authorization)(\\s{0,8}:\\s{0,8})([A-Za-z][A-Za-z0-9._-]{0,${MAX_KEY_TOKEN}})\\s{1,8}[^\\r\\n]{1,${MAX_VALUE_LEN}}`,
      "gi",
    ),
    mask: (_m, header: string, sep: string, scheme: string) =>
      `${header}${sep}${scheme} ${token("auth-header-scheme")}`,
  },

  // --- 値文字列単体の `<scheme> <secret>` (object 経路) — 再#5 SEC-1 ----------
  // object payload で値が `ApiKey live_…` / `Negotiate <tok>` / `NTLM <tok>` のように
  // ヘッダ名なし・`scheme<空白>secret` 形のとき、credential-assignment が key<sep>value
  // を見つけられず素通りする経路を塞ぐ。先頭が既知の auth scheme 語で始まり、空白区切りの
  // 値が続く形を、scheme 語を温存して値全体 (行末まで) をマスクする。
  // scheme 語は誤爆を避けるため既知集合に限定 (任意英単語にしない)。Bearer/Basic/Token は
  // 上のルールで既に処理されるため除外し、ここでは残りの scheme を扱う。
  // 先頭 (行頭) アンカーで「値が scheme 語で始まる」形のみ捕捉し (文中の単語誤爆を回避)、
  // 値部は最初の改行前まで ([^\r\n] 有界反復) に限定する。
  // ReDoS: scheme は固定 alternation、値部は否定文字クラスの有界反復のみ。`g`+`m` で
  // 行頭を多行対応。`all rules use global flag` 不変条件のため `g` を付与する。
  {
    kind: "auth-scheme-value",
    pattern: new RegExp(
      `^(ApiKey|Api-Key|AWS4-HMAC-SHA256|Negotiate|NTLM|Digest|Hawk|SAS|OAuth|Signature|Mac|Kerberos|GoogleLogin|Splunk)\\s{1,8}[^\\r\\n]{1,${MAX_VALUE_LEN}}`,
      "gim",
    ),
    mask: (_m, scheme: string) => `${scheme} ${token("auth-scheme-value")}`,
  },

  // --- Cookie: / Set-Cookie: ヘッダ (値全体を秘匿扱い) ----------------------
  // ヘッダ名は温存し、値 (改行・セミコロン前まで or 行末まで) をマスクする。
  // Set-Cookie の属性 (Path=/ 等) まで飲み込まないよう ; で区切る。
  {
    kind: "cookie",
    pattern: /\b(Set-Cookie|Cookie)(\s*:\s*)([^\r\n;]+)/gi,
    mask: (_m, header: string, sep: string) => `${header}${sep}${token("cookie")}`,
  },

  // --- npm registry _authToken (//host/:_authToken=...) --------------------
  {
    kind: "npm-auth-token",
    pattern: new RegExp(
      `(_authToken\\s{0,8}[:=]\\s{0,8})(["']?)([^\\s"']{6,${MAX_VALUE_LEN}})\\2`,
      "gi",
    ),
    mask: (_m, keyPart: string, quote: string) =>
      `${keyPart}${quote}${token("npm-auth-token")}${quote}`,
  },

  // --- 汎用 key/secret/token/password assignment ---------------------------
  // KEY=VALUE / KEY: VALUE / "key": "value" / key: value(YAML)。VALUE 部のみマスクし
  // KEY は温存 (.env 行・JSON・YAML を幅広くカバー)。
  //
  // キー判定は固定 alternation ではなく **contains 方式**:
  //   キー名トークン ([A-Za-z0-9_.-]{0,N}) が secret/password/passwd/pwd/token/
  //   credential/apikey/api_key/access_key/client_secret/private_key/auth(_token)
  //   等を「含む」なら credential とみなす (AWS_SECRET_ACCESS_KEY / DB_PASSWORD /
  //   npm の _authToken のような _ 境界・複合語を取りこぼさない)。
  //
  // ReDoS (再#SEC-1): prefix/suffix の `*` は `{0,MAX_KEY_TOKEN}` に有界化。値部は
  //   無界 `+` や「否定先読み×反復」を使わず、**単純否定文字クラス + {1,N} 上限**で線形化。
  //   クォート付き値はクォート種別ごとに別ルール (\2 後方参照の動的否定先読みを排除)。
  //   group1=キー名+区切り, group2=値本体 (クォート版は group2=値本体)。
  //
  // クォート付き値: ダブル / シングルを別々のルールに分割し、
  //   それぞれ閉じクォートまで (改行を除く) を **有界** [^"\r\n]{0,N} / [^'\r\n]{0,N} で捕捉。
  {
    kind: "credential-assignment",
    pattern: new RegExp(
      `([A-Za-z0-9_.-]{0,${MAX_KEY_TOKEN}}(?:${CREDENTIAL_KEYWORDS})[A-Za-z0-9_.-]{0,${MAX_KEY_TOKEN}}["']?\\s{0,8}[:=]\\s{0,8})"([^"\\r\\n]{0,${MAX_VALUE_LEN}})"`,
      "gi",
    ),
    mask: (_m, keyPart: string) => `${keyPart}"${token("credential-assignment")}"`,
  },
  {
    kind: "credential-assignment",
    pattern: new RegExp(
      `([A-Za-z0-9_.-]{0,${MAX_KEY_TOKEN}}(?:${CREDENTIAL_KEYWORDS})[A-Za-z0-9_.-]{0,${MAX_KEY_TOKEN}}["']?\\s{0,8}[:=]\\s{0,8})'([^'\\r\\n]{0,${MAX_VALUE_LEN}})'`,
      "gi",
    ),
    mask: (_m, keyPart: string) => `${keyPart}'${token("credential-assignment")}'`,
  },
  // 裸の値: 空白/クォート/区切り (,;) 直前まで。下限は 1 (短い値も秘匿)・上限は有界。
  {
    kind: "credential-assignment",
    pattern: new RegExp(
      `([A-Za-z0-9_.-]{0,${MAX_KEY_TOKEN}}(?:${CREDENTIAL_KEYWORDS})[A-Za-z0-9_.-]{0,${MAX_KEY_TOKEN}}["']?\\s{0,8}[:=]\\s{0,8})([^\\s"',;]{1,${MAX_VALUE_LEN}})`,
      "gi",
    ),
    mask: (_m, keyPart: string) => `${keyPart}${token("credential-assignment")}`,
  },

  // --- Sentry DSN userinfo (https://<publicKey>[:<secret>]@<host>/<projectId>) --
  // 3#SEC-3: Sentry DSN の userinfo (public key / secret) を秘匿。host が sentry.io /
  // *.ingest.sentry.io / *.sentry.io のときに限定し、scheme と host・パスは温存。
  // ReDoS: key/secret/host を有界量指定子 {N,M} で。`+`/入れ子なし。
  {
    kind: "sentry-dsn",
    pattern: new RegExp(
      `\\b(https?:\\/\\/)[0-9a-f]{16,64}(?::[0-9a-f]{16,64})?@((?:[A-Za-z0-9-]{1,63}\\.)*sentry\\.io)`,
      "gi",
    ),
    mask: (_m, scheme: string, host: string) => `${scheme}${token("sentry-dsn")}@${host}`,
  },

  // --- URL basic-auth: scheme://[user]:pass@host (pass のみマスク) ----------
  // 再#5c SEC-B: user 部下限を 0 (`{0,N}`) にし、空ユーザ `scheme://:pass@host`
  //   (redis://:pw@h / amqp://:pw@broker など password-only URL) を捕捉する。
  // ReDoS: user/pass トークンは有界 `{0,N}`/`{1,N}`。直後に literal `:`/`@` 区切りがあり
  //   無界 `+` や否定先読み反復を含まないため、`{0,N}` でも空マッチ暴走 (catastrophic
  //   backtracking) は起きない (単一文字クラスの有界反復 × 固定デリミタ)。
  {
    kind: "url-credential",
    pattern: new RegExp(
      `\\b([a-z][a-z0-9+.-]{0,32}:\\/\\/[^\\s:/@]{0,${MAX_VALUE_LEN}}):([^\\s@/]{1,${MAX_VALUE_LEN}})@`,
      "gi",
    ),
    mask: (_m, userWithScheme: string) => `${userWithScheme}:${token("url-credential")}@`,
  },

  // --- scheme なし bare user:pass@host (上の URL ルールが拾えない形) ---------
  // user:pass@host.tld 形を pass のみマスク。直前が "/" や英数 (= scheme://... の
  // 一部) でない場合に限定し、URL ルールとの二重マスクや誤爆を避ける。
  // ReDoS: user/pass/host トークンを {1,N} で有界化。
  {
    kind: "url-credential",
    pattern: new RegExp(
      `(^|[\\s,;=([])([A-Za-z0-9._-]{1,${MAX_VALUE_LEN}}):([^\\s:/@]{1,${MAX_VALUE_LEN}})@([A-Za-z0-9.-]{1,253}\\.[A-Za-z]{2,24})`,
      "g",
    ),
    mask: (_m, pre: string, user: string, _pass: string, host: string) =>
      `${pre}${user}:${token("url-credential")}@${host}`,
  },

  // --- standalone 高エントロピー credential (AWS secret access key / cloud 鍵) -
  // ラベルなしで現れる長尺 base64 風トークン (AWS secret access key = 40 字、
  // Azure AccountKey = 44/72/88 字 base64 等)。
  // 再#5 SEC-2: 旧実装は長さ 40 ちょうど限定で、44/72/88 字の cloud 接続鍵を取りこぼした。
  //   下限 40・上限 MAX_VALUE_LEN の **有界** {40,N} に緩め、長尺鍵も捕捉する。
  // 再#5b (main probe LEAK 1-3): base64 末尾の `=`/`==` パディングを **マッチに含める**。
  //   旧 `(?![A-Za-z0-9+/=])` は本体直後の `=` で否定先読みが失敗しマッチ自体が消え、
  //   `==` で終わる cloud 鍵 (Azure AccountKey / GCP / 一般 base64 鍵の大半) が standalone
  //   (keyword なし) で素通りしていた。本体 `{40,N}` のあと `={0,2}` を consume し、
  //   その後の境界は `=` を除外した `(?![A-Za-z0-9+/])` で締める (パディング後に base64 が
  //   続かないことのみ要求)。
  // 再#5b LEAK 1 (`key=<base64==>`): lookbehind からも `=` を除外する。旧
  //   `(?<![A-Za-z0-9+/=])` は直前が `=` のとき start を拒否し、代入演算子 `key=<secret>` の
  //   secret を取りこぼした。base64 パディングは必ずトークン末尾にしか現れないため、直前の
  //   `=` は (a) 代入演算子 か (b) 前トークンの末尾パディング のいずれかで、どちらも当該
  //   base64 run の途中ではない (run 途中 start は `[A-Za-z0-9+/]` の除外で別途防がれる)。
  //   よって `=` を lookbehind から外しても run 中間 start は起きず、`key=` 経路を塞げる。
  // 再#5c SEC-A (urlsafe-base64 secret): charset を urlsafe `[A-Za-z0-9+/_-]` へ拡張し、
  //   Fernet (`cw_0x..-..F4e4=`) / Google refresh token / JWT 風 urlsafe 鍵を捕捉する。
  //   lookbehind/lookahead も同 charset に揃え run 中間 start/end を防ぐ。
  //
  // two-stage gate (再#5c SEC-A × SEC-C 両立):
  //   stage-1 `looksLikePath`: 候補が path/URL 形なら mask しない (SEC-C: deep path/URL keep)。
  //   stage-2 entropy gate: **distinct char class >= 3** (uppercase/lowercase/digit/symbol)。
  //     symbol は urlsafe/base64 記号 `[+_=-]` のみ (path 区切り `/` は **数えない**)。
  //     これにより path (lower+upper の 2 class) は除外、secret (mixed-case+digit+symbol で
  //     3+ class) は捕捉。`/` を symbol から外すことで `/usr/Local/...` 風 path も 2 class 維持。
  //   2 段とも通過した場合のみマスク (over-redaction 相殺)。
  // パディング `={0,2}` は維持。`=` は symbol class に数える (urlsafe 鍵の末尾 `=`)。
  // ReDoS: lookbehind で run 先頭のみ start、{40,N}/{0,2} は有界、貪欲だが backtrack は
  //   高々 (N-40+2) 歩/run start で線形 (`+`/`*` 裸出現なし)。
  {
    kind: "high-entropy-secret",
    pattern: new RegExp(
      `(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{40,${MAX_VALUE_LEN}}={0,2}(?![A-Za-z0-9+/_-])`,
      "g",
    ),
    mask: (match: string) => {
      // stage-1: path/URL 形は温存 (SEC-C リグレッション防止)。
      if (looksLikePath(match)) return match;
      // stage-2: distinct char class >= 3。`/` は symbol に数えない (path を 2 class に保つ)。
      const hasLower = /[a-z]/.test(match);
      const hasUpper = /[A-Z]/.test(match);
      const hasDigit = /[0-9]/.test(match);
      const hasSym = /[+_=-]/.test(match);
      const classes = [hasLower, hasUpper, hasDigit, hasSym].filter(Boolean).length;
      return classes >= 3 ? token("high-entropy-secret") : match;
    },
  },
];

/**
 * redaction が残す出力マーカーの正規表現 (`[REDACTED:<kind>]`)。**redaction の結果**であり
 * 原文 (秘匿値そのもの) は一切含まない。kind は `token()` が出す安定 enum で、文字クラスは
 * **event-model の正典 source `REDACTION_MARKER_PATTERN` から派生**する (TDA-2: 文字クラス
 * `[a-z0-9-]+` を各層で再ハードコードせず単一化し SQL↔TS forward-drift を構造閉塞)。masking
 * (`token`/`REDACTION_RULES`) はこの import に依存しない — write 側 marker 生成は本ファイル内に閉じる。
 * 正典側は全 kind ⊆ charset を pin 済 (inv-redaction-kinds)。派生の同一性 (RE.source ==
 * REDACTION_MARKER_PATTERN) と mask↔read の round-trip は INV-REDACTION-MARKER-ROUNDTRIP で pin する。
 *
 * 唯一の定義点 (DRY)。diff-provider の secret_detected 件数化 (DiffResult.redactionCount) と
 * sink の event 単位件数観測 (NormalizedEvent.redaction_count) の双方がこれを参照し、件数化ロジックの
 * ドリフトを防ぐ。**新しい正規表現を増やさない** (redaction 面は増えない・観測のみ)。
 */
export const REDACTION_MARKER_RE = new RegExp(REDACTION_MARKER_PATTERN, "g");

/**
 * REDACTION_MARKER_RE の **kind 捕捉版** (`[REDACTED:<kind>]` の `<kind>` を group 1 に取る)。
 * 文字クラスは event-model の正典 source `REDACTION_MARKER_KIND_PATTERN` から派生し
 * REDACTION_MARKER_RE と**同一**を共有する (件数化と kind 別集計のドリフトを防ぐ)。kind は `token()`
 * が出す安定 enum (redactor マーカー由来) のみ。**原文 (秘匿値そのもの) は一切捕捉しない** — 捕捉
 * 対象は kind 名 (公開可能な enum) だけ。
 */
export const REDACTION_MARKER_KIND_RE = new RegExp(REDACTION_MARKER_KIND_PATTERN, "g");

/**
 * 既知 kind 集合 (allowlist)。**event-model の正典語彙 `REDACTION_KINDS` を単一出所**とする
 * (ハードコード禁止・層をまたぐドリフト防止)。`token()` が `[REDACTED:<kind>]` を出す kind はこの
 * 集合に限られるため、by-kind 集計はこの集合に帰属したマーカーのみを計上する。
 *
 * ## 単一出所の昇格 (SEC-3): 以前は `REDACTION_RULES.map(r => r.kind)` から導いていたが、kind 語彙の
 *   権威を event-model (T1) へ昇格した。redactor / projection / (将来) UI が**同じ**集合を参照し、
 *   projection ingest 経路の closed-enum gate と redactor 側 allowlist が必ず一致する。
 *   `REDACTION_RULES.kind ⊆ REDACTION_KINDS` は inv-redaction-kinds テストで pin する
 *   (rule が語彙外 kind を出さない = 別名であって import の再エクスポートではない実体ガード)。
 *
 * ## SEC-2 (phantom-kind 注入の遮断): REDACTION_MARKER_KIND_RE は redactor 由来か raw 由来かを
 *   区別しないため、良性入力 `[REDACTED:foo-bar]` が phantom kind として by_kind に紛れうる
 *   (charset `[a-z0-9-]+` ゆえ raw-secret は載らないが、嘘の「秘匿の種類」を計上してしまう)。
 *   既知 kind だけを通すことで phantom kind を捨てる (二重防御の一方。もう一方は Object.create(null))。
 *
 * 注: redaction-before-emit 不変条件 (INV-REDACTION) は redactString / redactValue が担保し、
 *   本 allowlist は **件数の可視化** (by_kind) の正しさだけを縛る。redaction 面は一切増やさない。
 */
export const KNOWN_REDACTION_KINDS: ReadonlySet<string> = REDACTION_KINDS_SET;

/**
 * redaction 済み文字列に含まれる `[REDACTED:*]` マーカーの件数を数える (純関数)。
 *
 * **契約**: 入力は redaction を**適用した後**の文字列であること。出力は非負整数のみで、秘匿値
 * そのものは一切返さない (件数 = redaction が秘匿を潰した回数の指標)。new RegExp を都度生成せず
 * 共有 global 正規表現の lastIndex を使う `match` 経由なので状態汚染しない (match は lastIndex を
 * 参照しない)。
 */
export function countRedactionMarkers(redacted: string): number {
  if (redacted.length === 0) return 0;
  const matches = redacted.match(REDACTION_MARKER_RE);
  return matches ? matches.length : 0;
}

/**
 * redaction 済み文字列の `[REDACTED:<kind>]` マーカーを **kind 別**に集計する (純関数)。
 *
 * **契約**: 入力は redaction を**適用した後**の文字列であること。返すのは `kind 名 → 件数` の
 * record のみで、**秘匿値そのものは一切返さない** (kind 名は `token()` が出す公開 enum)。
 * countRedactionMarkers と同じマーカー文字クラスを REDACTION_MARKER_KIND_RE 経由で共有する (DRY)。
 * 空入力 / マーカーなしは `{}`。
 *
 * ## 正直な不変条件 (QA-1/TDA-2): `sum(values) <= countRedactionMarkers(redacted)`。
 *   等号は「全マーカーが**既知 kind** (KNOWN_REDACTION_KINDS) のとき」のみ成立する。by_kind は
 *   既知 kind に帰属した件数の**部分集合**であり、未知/phantom kind (SEC-2) を捨てるため scalar
 *   (全 `[REDACTED:*]` 数) と一致するとは限らない。`===` を全層で構造保証する旧主張は誇張だった。
 *
 * ## SEC-1 (prototype 継承プロパティ読み出しの遮断): 蓄積オブジェクトを `Object.create(null)` に
 *   する。素の `{}` だと kind="constructor" 等で `out["constructor"]` が継承
 *   `Object.prototype.constructor` (関数) に解決され `関数 + 1` → **文字列**になり、由来の
 *   redaction_count_by_kind が文字列化 → parse reject → event drop を招く。null-proto + 既知 kind
 *   allowlist の二重防御で原理的に排除する。
 *
 * ReDoS: 正規表現は固定リテラル + 単一文字クラスの有界反復のみ (`+` 裸出現は `[a-z0-9-]+` の
 * 1 個のみで catastrophic backtracking なし)。lastIndex は exec ループ前後で 0 へリセットし
 * 共有 global RegExp の状態汚染を防ぐ。
 */
export function countRedactionMarkersByKind(redacted: string): Record<string, number> {
  const out: Record<string, number> = Object.create(null);
  if (redacted.length === 0) return out;
  REDACTION_MARKER_KIND_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = REDACTION_MARKER_KIND_RE.exec(redacted)) !== null) {
    const kind = m[1]!;
    // SEC-2: 未知/phantom kind (REDACTION_RULES に無い) は捨てる。既知 kind のみ計上。
    if (!KNOWN_REDACTION_KINDS.has(kind)) continue;
    out[kind] = (out[kind] ?? 0) + 1;
  }
  REDACTION_MARKER_KIND_RE.lastIndex = 0;
  return out;
}

/**
 * redacted ツリー (redactDeep の戻り) を 1 回歩いて `[REDACTED:<kind>]` を **kind 別**に集計する。
 * countRedactionMarkersDeep の kind 別版。全 string (object キー名 + 値) の **既知 kind** 件数を
 * 合算する。SEC-1/SEC-2 に揃え、蓄積を `Object.create(null)` にし未知/phantom kind を捨てる
 * (KNOWN_REDACTION_KINDS allowlist)。
 *
 * ## 正直な不変条件 (QA-1/TDA-2): `sum(by_kind) <= countRedactionMarkersDeep(redacted)`。
 *   等号は全マーカーが既知 kind のときのみ。未知/phantom kind を捨てるため scalar (全マーカー数)
 *   とは一致するとは限らない。`===` を構造保証する旧主張は誇張だった。
 * **redaction しない** (集計のみ・原文非依存・新 redaction 面ゼロ)。
 */
export function countRedactionMarkersByKindDeep(value: unknown): Record<string, number> {
  const out: Record<string, number> = Object.create(null);
  const mergeInto = (s: string): void => {
    if (s.length === 0) return;
    REDACTION_MARKER_KIND_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = REDACTION_MARKER_KIND_RE.exec(s)) !== null) {
      const kind = m[1]!;
      // SEC-2: 未知/phantom kind は捨てる。既知 kind のみ計上。
      if (!KNOWN_REDACTION_KINDS.has(kind)) continue;
      out[kind] = (out[kind] ?? 0) + 1;
    }
  };
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      mergeInto(v);
      return;
    }
    if (v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      // キー名も redactString を通る (4#SEC-1) ため key 側のマーカーも数える。
      mergeInto(k);
      walk(x);
    }
  };
  walk(value);
  REDACTION_MARKER_KIND_RE.lastIndex = 0;
  return out;
}

/** 1 文字列に全ルールを順次適用する。 */
export function redactString(input: string): string {
  if (input.length === 0) return input;

  // 3#SEC-2 (truncation-before-redaction): メモリ/ReDoS 保護のための長さ上限切り詰めは
  //   **redaction を適用した後** に行う。先に slice すると MAX_REDACT_INPUT 境界を跨ぐ
  //   secret の断片が cut で短くなり (例: ghp_… が最小長ルールを下回り) 未マッチのまま
  //   残留しうる。INV-REDACTION の順序 (redact→truncate) を厳守する。
  // ガード: 入力が極端に巨大な場合のみ、redaction が確実に効く十分なマージンを残して
  //   先行 slice する (n^2 防止は量指定子の有界化が担保。長さ上限は補助)。境界跨ぎの
  //   断片残留を避けるため、先行 slice は MAX_REDACT_INPUT より 1 ルール最大捕捉長ぶん
  //   広めに取り (PRE_REDACT_SLICE)、最終 slice (= 表示用上限) を最後に適用する。
  let value = input;
  let truncatedTail = 0;
  if (value.length > PRE_REDACT_SLICE) {
    truncatedTail = value.length - PRE_REDACT_SLICE;
    value = value.slice(0, PRE_REDACT_SLICE);
  }

  for (const rule of REDACTION_RULES) {
    // lastIndex を都度リセット (global RegExp の状態汚染防止)。
    rule.pattern.lastIndex = 0;
    const mask = rule.mask;
    value = value.replace(rule.pattern, (match: string, ...rest: unknown[]) => {
      if (mask) {
        // rest 末尾は offset/string/groups。文字列グループのみ渡す。
        const groups = rest.filter((r): r is string => typeof r === "string");
        return mask(match, ...groups);
      }
      return token(rule.kind);
    });
  }

  // redaction 後に表示用上限へ切り詰める (マスク済み = 断片は [REDACTED:…] になっている)。
  let truncatedSuffix = "";
  if (value.length > MAX_REDACT_INPUT) {
    truncatedTail += value.length - MAX_REDACT_INPUT;
    value = value.slice(0, MAX_REDACT_INPUT);
  }
  if (truncatedTail > 0) {
    truncatedSuffix = ` [REDACT-TRUNCATED:${truncatedTail}]`;
  }
  return value + truncatedSuffix;
}

/**
 * 任意の JSON 互換値を再帰的に redact する。
 * - string: redactString を適用。
 * - array / object: 各要素・値を再帰。**キー名にも redactString を適用** (4#SEC-1)。
 * - number / boolean / null / undefined: そのまま。
 * 循環参照は WeakSet でガード (循環時は null 化)。
 *
 * 4#SEC-1 (INV-REDACTION 構造穴): secret をキーに持つ object payload
 *   (例 `{ "ghp_…": "v" }`、token を key にした JSON、env を key にした tool 出力) が
 *   choke point を素通りして SQLite / 送信路へ未マスクで残らないよう、値と同じ
 *   `redactString` をキー名にも通す。
 *
 * ReDoS (4#SEC-1, memory 教訓1): キーは値と「同一の」`redactString` を通すだけ。
 *   新しい正規表現は足さない。redactString の量指定子は一切変更しない。
 *
 * キー衝突回避: 2 つの異なる secret キーがマスク後に同一 `[REDACTED:…]` へ潰れると
 *   後勝ちで値が失われる。出力先 `out` に**既に同名キーが存在する場合**
 *   (masked / passthrough を問わず) サフィックス (`#2`, `#3`, …) で一意化し、
 *   データ損失を防ぐ。
 *   SEC-v1: 通常キー (rk === k) も、先行 secret がマスクされて生成した
 *   `[REDACTED:…]` キーと文字列一致しうる (例 `{ "ghp_…": v1, "[REDACTED:github-token]": v2 }`)。
 *   `rk !== k` で gate すると、この passthrough↔masked 衝突を見逃し先行 secret の
 *   値を黙って上書き破棄する。通常キー同士は元 object 内で一意なので、`out` 在否
 *   のみで判定しても正規キーが誤って一意化されることはない (決定的キー順序を維持)。
 *   SEC-v2 (perf): 衝突 suffix 探索を baseKey 毎の counter で下限化し O(N) 償却にする
 *   (旧実装は毎回 2 から再走査で O(N^2)、規定サイズ adversarial payload で redaction
 *   choke point が DoS 化した)。出力キー・値・順序は旧実装とバイト等価。INV-REDACTION-PERF。
 */
/**
 * SEC-FINAL-2: credential 文脈フラグ `cred` を再帰へ伝播する。
 *   credential キー (または auth ヘッダキー) の値が array / nested object のとき、その配下の
 *   **全 string を entropy/charset 不問で無条件マスク**する (文脈 fail-safe)。
 *   `cred=true` の下では string は無条件マスク、array/object はさらに `cred=true` で再帰。
 */
export function redactValue(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
  cred = false,
  depth = 0,
): unknown {
  if (typeof value === "string") {
    // credential 文脈下の string は中身不問でマスク (空文字は温存)。
    if (cred) return value.length === 0 ? value : token("credential-assignment");
    return redactString(value);
  }
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    // SEC-2: array は identity top-level ではない。配下を depth+1 で再帰し
    //   array 要素内の同名 `session_id` キーで correlation-keep が発火しないようにする。
    return value.map((v) => redactValue(v, seen, cred, depth + 1));
  }
  return redactObject(value as Record<string, unknown>, seen, cred, depth);
}

/**
 * auth ヘッダ名 (Authorization / Proxy-Authorization / WWW-Authenticate) を **キー名**で
 * 同定する正規表現 (再#5b LEAK 4)。大小無視・前後の余分なし。
 * object 経路でキー名が auth ヘッダと確定する場合、値 `<任意 word> <secret>` は scheme が
 * 未知 (string 経路の auth-scheme-value 既知集合外) でも値全体をマスクしてよい
 * (キー名で auth と確定するため未知 scheme 許容でも誤爆しない)。
 * ReDoS: 固定 alternation のみ。量指定子なし。
 */
const AUTH_HEADER_KEY_RE = /^(?:proxy-|www-)?authenticate$|^(?:proxy-)?authorization$/i;

/**
 * credential キー名同定 (SEC-FINAL-1 + SEC-FINAL-3): object のキー名が credential を指すなら
 * その値を secret 文脈として扱う (string は無条件マスク、array/object は文脈伝播)。
 * **key→value 対称化** (auth ヘッダの redactAuthHeaderValue と同型)。
 *
 * SEC-FINAL-3/4/5 (network of credential-key orientations): 短曖昧 keyword の素朴な substring/末尾
 *   判定は orientation ごとに穴が空く。3 つの独立監査が **同一 family 内で穴が移動する**ことを実証した:
 *     - tail   : `accessToken`/`csrfToken`     (keyword が末尾 segment)            … SEC-FINAL-4
 *     - fused  : `signingkey`/`userpwd`/`blobsas` (区切りも camelCase 境界も無い連結) … TDA-1
 *     - head   : `tokenValue`/`keyData`/`sasUrl`/`pwdHash` (keyword が先頭 + 非 benign suffix) … SEC-FINAL-5
 *   個別パッチを重ねず、**単一の正準ロジック**に集約する (TDA 根本是正提案):
 *   (a) **特異 compound keyword** (`secret`/`password`/`api[_-]?key`/`access[_-]?key`/
 *       `client[_-]?secret`/`connection[_-]?string` 等、誤爆しにくい) は contains-match で即 credential。
 *   (b) キー名を **camelCase 境界 (lower/digit → Upper) + `[_\-.]`** で word-segment 分割し、
 *       **いずれかの segment が短曖昧 keyword (`auth`/`token`/`pwd`/`sig`/`sas`/`key`)** であれば、
 *       **末尾 segment が benign-metadata suffix allowlist** (`id`/`count`/`type`/`name`/`version`/`scheme`/
 *       `expiry` 等、値が secret でないと確定する語) **でない限り credential** とみなす (fail-safe:
 *       未知 suffix は mask 側)。→ `accessToken`/`tokenValue`/`keyData`/`sasUrl` は credential、
 *       `tokenCount`/`keyId`/`tokenType`/`keyName`/`author`/`sigmaValue` は benign。
 *   (c) **小文字 fused** (区切りも camelCase 境界も無い単一 segment) は末尾が短曖昧 keyword で終われば
 *       credential (fail-safe)。一般英単語の偶然一致 (`monkey`/`donkey`/`oauth` 等) のみ小 allowlist で控除。
 *   迷う場合は credential 側 (mask) に倒す。under-redaction(leak) 絶対回避 > over-redaction。
 *
 * ReDoS: 新規の **値走査** regex を足さない。キー名 (有界長) への contains-match + split + set lookup。線形。
 */
// (a) 特異 compound keyword (contains-match で誤爆しにくいもの)。短曖昧語 (auth/token/sig/sas) は含めない。
//   SEC-OBS-2: keyword 集合外で漏れていた曖昧性の低い credential 語 (passphrase/bearer/hmac) を追加。
const CREDENTIAL_COMPOUND_RE =
  /secret|passphrase|passw(?:or)?d|bearer|hmac|credentials?|api[_-]?key|apikey|access[_-]?key|account[_-]?key|accountkey|private[_-]?key|client[_-]?secret|connection[_-]?string|shared[_-]?access[_-]?signature/i;
// (b) 短く曖昧な keyword (word-segment 単位でのみ credential 扱い)。
//   SEC-OBS-2: salt/nonce/otp/mfa を追加 (compound contains は basalt/footprint 等を誤爆するため
//   word-segment 単位で扱う)。
const CREDENTIAL_SHORT_WORDS = new Set([
  "auth",
  "token",
  "pwd",
  "sig",
  "sas",
  "key",
  "salt",
  "nonce",
  "otp",
  "mfa",
]);
// (b2) ウォレット / PCI 系の短曖昧語 (Phase 4 / SEC 019e9255)。**word-segment 完全一致のみ**で
//   credential 扱いし、fused 経路 (endsWith/startsWith) には載せない (`mnemonicabc` 等の偶然一致回避)。
//   採用は cvv / cvc / mnemonic の **曖昧性の低い 3 語のみ**。
//   `seed` / `pin` は **不採用** (Phase 4 SEC probe + ユーザー裁定 2026-06-16):
//     ActraDeck の中核は「開発作業の可視性」であり、`pin` は GPIO/ハードウェアピン (gpio_pin/led_pin/
//     reset_pin) や UI pin、`seed` は RNG/DB seed (randomSeed/seedData/dbSeed/seedScript) として dev で
//     多用される。これらを過剰マスクすると可視性 (security.md「見せてよい」) を損ない、かつ主要な実 leak 形
//     `WALLET_SEED=<phrase>` (raw text/env) は object-key でないため元々取りこぼす = コスト>便益。
//     wallet は `mnemonic` でカバー、PIN は単体低価値ゆえ over-redaction を避け keep に倒す。
//   `{cvvId}`/`{mnemonicName}` 等の識別子・メタは CREDENTIAL_KEEP_SUFFIX の既存ガードで温存される。
const CREDENTIAL_SEGMENT_ONLY_WORDS = new Set(["mnemonic", "cvv", "cvc"]);
// (c-head) fused-head 判定用: keyword 先頭 + これらの secret-bearing suffix なら credential
//   (`tokendata`/`keydata`/`sasurl`/`pwdhash`)。`keyword`/`keyboard`/`signal` 等は suffix 非該当で温存。
const CREDENTIAL_MASK_SUFFIX = new Set([
  "data",
  "blob",
  "bytes",
  "material",
  "value",
  "hash",
  "secret",
  "string",
  "url",
  "payload",
  "body",
  "content",
  "raw",
  "info",
  "store",
  "vault",
  "cred",
  "token",
  "key",
  "sig",
  "pwd",
]);
// (b) benign-metadata suffix: keyword segment があっても末尾がこれらなら値は識別子/メタ (非 secret)。
//   fail-safe: ここに無い未知 suffix は credential 側に倒す。`code`(auth code)/`url`(sasUrl) は機密寄りゆえ
//   敢えて含めない (mask 側)。
const CREDENTIAL_KEEP_SUFFIX = new Set([
  "id",
  "count",
  "index",
  "idx",
  "type",
  "kind",
  "name",
  "label",
  "layout",
  "length",
  "len",
  "size",
  "version",
  "ver",
  "status",
  "state",
  "order",
  "mode",
  "level",
  "scheme",
  "format",
  "fmt",
  "prefix",
  "suffix",
  "limit",
  "total",
  "page",
  "offset",
  "expiry",
  "ttl",
  "timestamp",
  "ts",
  "at",
  "date",
  "time",
  "enabled",
  "flag",
]);
// (c) 短曖昧 keyword で末尾一致するが credential ではない一般英単語 (fused 判定の誤爆控除)。
const CREDENTIAL_FUSED_BENIGN = new Set([
  "monkey",
  "donkey",
  "turkey",
  "whiskey",
  "jockey",
  "hockey",
  "lackey",
  "hotkey",
  "oauth",
]);

/** object のキー名が credential を指すか (SEC-FINAL-1/3/4/5 統合・正準判定)。 */
function isCredentialKey(k: string): boolean {
  if (CREDENTIAL_COMPOUND_RE.test(k)) return true;
  // word-segment 分割: camelCase 境界 (lower/digit → Upper) + `_`/`-`/`.`。
  const segs = k
    .split(/(?<=[a-z0-9])(?=[A-Z])|[_\-.]/)
    .map((s) => s.toLowerCase())
    .filter(Boolean);
  const last = segs[segs.length - 1] ?? "";
  // (b) いずれかの segment が短曖昧 keyword。末尾 segment が benign-metadata suffix でなければ credential。
  //   = tail (`accessToken`) / head (`tokenValue`) / 中間 (`myTokenBlob`) を一括カバー。
  //   (b2) mnemonic/cvv/cvc は word-segment 完全一致のみ (fused 経路は下の (c) で踏ませない)。
  if (
    segs.some((s) => CREDENTIAL_SHORT_WORDS.has(s) || CREDENTIAL_SEGMENT_ONLY_WORDS.has(s)) &&
    !CREDENTIAL_KEEP_SUFFIX.has(last)
  ) {
    return true;
  }
  // (c) 小文字 fused (単一 segment): camelCase 境界も区切りも無いため接頭/接尾で判定。
  //   - tail: 末尾が短曖昧 keyword で終われば credential (`signingkey`/`accesstoken`)。
  //   - head: 先頭が keyword + 残りが secret-bearing suffix なら credential (`tokendata`/`sasurl`)。
  //   一般英単語の偶然一致 (monkey/oauth/keyword/signal) は控除/suffix 非該当で温存。
  if (segs.length === 1) {
    const w = segs[0]!;
    if (!CREDENTIAL_FUSED_BENIGN.has(w)) {
      for (const kw of CREDENTIAL_SHORT_WORDS) {
        if (w.length <= kw.length) continue;
        if (w.endsWith(kw)) return true; // fused-tail (TDA-1)
        if (w.startsWith(kw) && CREDENTIAL_MASK_SUFFIX.has(w.slice(kw.length))) return true; // fused-head (TDA-RE-1)
      }
    }
  }
  return false;
}

/**
 * auth ヘッダ値 `<scheme word> <secret...>` を scheme 不問でマスクする (object 経路専用)。
 * 先頭 word (英数記号の有界トークン) を温存し、空白以降の値全体 (改行前まで) をマスク。
 * 値が `<word> <...>` 形でない (空白なし単一トークン等) 場合は redactString に委譲して
 * 既存ルール (Bearer/Basic/credential 等) を効かせる (over-mask しない)。
 * ReDoS: scheme トークン {1,MAX_KEY_TOKEN}・値部 [^\r\n]{1,MAX_VALUE_LEN} はいずれも有界。
 */
const AUTH_HEADER_VALUE_RE = new RegExp(
  `^([A-Za-z][A-Za-z0-9._-]{0,${MAX_KEY_TOKEN}})\\s{1,8}[^\\r\\n]{1,${MAX_VALUE_LEN}}$`,
);

/** 文字列値を auth ヘッダ値として redact する (キー名が auth ヘッダと確定済みの場合)。 */
function redactAuthHeaderValue(v: string): string {
  const m = AUTH_HEADER_VALUE_RE.exec(v);
  if (m) {
    // scheme 語を温存し値全体をマスク。さらに念のため redactString も重ねて
    // scheme 語自体が secret だった場合 (`Bearer <tok>` 等) も既存ルールで二重に守る。
    return redactString(`${m[1]} ${token("auth-header-scheme")}`);
  }
  // `<word> <...>` 形でなければ通常の文字列 redaction に委譲 (over-mask 回避)。
  return redactString(v);
}

/**
 * object のキー・値を redact する。
 * - 親 `cred=true` (credential 文脈下) のときは **全 string 値を無条件マスク**し、array/object も
 *   `cred=true` で再帰する (SEC-FINAL-2: 文脈伝播)。
 * - `cred=false` のときはキー名で判定: auth ヘッダ / credential キーの値が string なら無条件マスク、
 *   array/object なら `cred=true` で再帰 (配下 string を文脈マスク)。非該当キーは従来どおり。
 */
function redactObject(
  value: Record<string, unknown>,
  seen: WeakSet<object>,
  cred = false,
  depth = 0,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // 4#SEC-v2 (perf): baseKey → 次に試す `#suffix` 値を記憶し、衝突毎の 2..k 再走査を排除する。
  //   `out` は本呼び出し内で append-only (キーは消えない) なので、ある baseKey の
  //   「最小の空き suffix」は単調非減少。よって counter を下限として持てば、線形走査が
  //   選んだはずの slot を飛ばすことはなく、出力キー・値・順序はバイト等価のまま O(N) 償却。
  //   literal `rk#5` 等が input に実在する病的ケースでも、candidate が既出なら next を
  //   進めて衝突を回避する (out 在否チェックを維持)。
  const nextSuffix = new Map<string, number>();
  for (const [k, v] of Object.entries(value)) {
    const rk = redactString(k);
    // 出力先に既出のキー (masked/passthrough 一様) と衝突する場合のみ一意化する (SEC-v1)。
    let outKey = rk;
    if (Object.prototype.hasOwnProperty.call(out, outKey)) {
      let suffix = nextSuffix.get(rk) ?? 2;
      while (Object.prototype.hasOwnProperty.call(out, `${rk}#${suffix}`)) suffix++;
      outKey = `${rk}#${suffix}`;
      // 次回 (同一 baseKey) はこの suffix の直後から探索を再開する。
      nextSuffix.set(rk, suffix + 1);
    }
    // 自動ガード (ADR 019ecc70 D3): `secret_kinds` は公開 enum (REDACTION_KINDS) フィールド。
    //   キー名が credential ヒューリスティックに当たり配下が無条件マスクされると closed-enum schema を
    //   満たさず event drop する。value-shape gate (isKnownRedactionKind) で既知 kind のみ keep し、
    //   それ以外 (攻撃者注入の secret 形) は redactString で依然マスクする (leak-safe・深さ非依存)。
    //   cred 文脈下でも値ゲートが leak を防ぐため keep を優先する。
    if (SECRET_KIND_FIELDS.has(k)) {
      out[outKey] = redactSecretKindsValue(v, seen, depth);
      continue;
    }
    // 親が credential 文脈 (cred=true) なら、キー名によらず全値を文脈マスク (SEC-FINAL-2)。
    if (cred) {
      out[outKey] =
        typeof v === "string"
          ? v.length === 0
            ? v
            : token("credential-assignment")
          : redactValue(v, seen, true, depth + 1);
      continue;
    }
    // cred=false: キー名コンテキストで判定 (key→value 対称化):
    //   - auth ヘッダキー (再#5b LEAK 4): string は scheme 不問マスク、array/object は文脈伝播。
    //   - credential キー (SEC-FINAL-1/3): string は無条件マスク、array/object は文脈伝播 (SEC-FINAL-2)。
    //   - それ以外: 従来どおり通常 redaction (構造保持)。
    const isAuthKey = AUTH_HEADER_KEY_RE.test(k);
    const isCredKey = !isAuthKey && isCredentialKey(k);
    // LIVE-1 + SEC-2: 相関キーフィールド (session_id 等) の keep は **depth 0 (イベント identity
    //   top-level) 限定**。credential/auth でなく、かつ再帰ルートでのみ評価する。
    //   nested object / array 要素内の同名 `session_id` は depth>0 のため keep せず従来 redaction
    //   経路へ戻す (攻撃者影響下の payload に `{session_id:<分割secret>}` を仕込む redaction 回避を防ぐ)。
    const isCorrelationKey =
      depth === 0 && !isAuthKey && !isCredKey && CORRELATION_KEY_FIELDS.has(k);
    if (typeof v === "string") {
      if (isAuthKey) {
        out[outKey] = redactAuthHeaderValue(v);
      } else if (isCredKey) {
        // 空文字は温存 (マスクする中身がない)。それ以外は無条件マスク。
        out[outKey] = v.length === 0 ? v : token("credential-assignment");
      } else if (isCorrelationKey && isCorrelationKeyValue(v)) {
        // 相関キー名フィールド (top-level) × 相関キー形 → 保持 (LIVE-1)。形ゲートを満たさない値は
        //   else 経路で従来どおり redactString を通る (= 紛れた secret は依然マスク)。
        out[outKey] = v;
      } else {
        out[outKey] = redactString(v);
      }
    } else if (isAuthKey || isCredKey) {
      // array / nested object 値: credential 文脈を配下へ伝播 (配下全 string をマスク)。
      out[outKey] = redactValue(v, seen, true, depth + 1);
    } else {
      out[outKey] = redactValue(v, seen, false, depth + 1);
    }
  }
  return out;
}

/** redaction を適用した深いコピーを返す (元オブジェクトは変更しない)。 */
export function redactDeep<T>(value: T): T {
  return redactValue(value) as T;
}

/**
 * TDA-1 (hot-path): `redactDeep` と**同一の redacted 値**を返しつつ、その走査結果に含まれる
 * `[REDACTED:*]` マーカー件数を**同じ 1 回の走査内**で集計して返す counting variant。
 *
 * 動機: sink.emit が全 event で `JSON.stringify(redacted)` (件数用) と store.append 側の
 *   `JSON.stringify(event)` (永続用) を**二重**に実行していた。本関数は redacted 結果ツリーを
 *   1 回だけ歩いて件数を得るため、sink は別途 `JSON.stringify` を回さずに済む。
 *
 * 不変性の担保:
 *   - `value` は `redactDeep(input)` の**戻り値 (= redacted 済みツリー)** を前提とする。
 *     redaction 自体は `redactDeep` が唯一実施し、本関数は**再 redaction しない**
 *     (redaction 挙動は一切変わらない)。
 *   - マーカー `[REDACTED:<kind>]` は `token()` の戻り (= string) としてのみ出現する。よって
 *     redacted ツリーの**全 string (object のキー名 + 値)** に `countRedactionMarkers` を適用した
 *     総和は `countRedactionMarkers(JSON.stringify(redacted))` と一致する (JSON のエスケープは
 *     `[REDACTED:...]` の文字に影響しない)。INV-REDACTDEEP-COUNT-PARITY で pin。
 *   - 循環は redactDeep が既に WeakSet で除去 (循環は null 化済み) のため再帰は有限。
 */
export function countRedactionMarkersDeep(value: unknown): number {
  if (typeof value === "string") return countRedactionMarkers(value);
  if (value === null || typeof value !== "object") return 0;
  if (Array.isArray(value)) {
    let n = 0;
    for (const v of value) n += countRedactionMarkersDeep(v);
    return n;
  }
  let n = 0;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // キー名も redactString を通る (4#SEC-1) ため key 側のマーカーも数える。
    n += countRedactionMarkers(k);
    n += countRedactionMarkersDeep(v);
  }
  return n;
}

/**
 * TDA-1: `redactDeep` と同値の redacted コピーを返しつつ、その redacted 値の `[REDACTED:*]`
 * マーカー件数を**追加の JSON.stringify なし**で同梱して返す。sink.emit 専用 (hot-path)。
 * `value` は redacted 値と件数のペア。redaction 挙動は `redactDeep` と完全一致 (差分なし)。
 *
 * 強み(a)③ (redaction 可視化): scalar `redactionCount` に加え `redactionCountByKind` (kind 別件数)
 * も同梱する。
 *
 * ## scalar の意味論 (方針 A・ADR・QA-1/TDA-2/SEC-1):
 *   - `redactionCount` は **全 `[REDACTED:*]` マーカー数** を `countRedactionMarkersDeep(redacted)`
 *     から導く (= 元 decision 019ec558 の意味論に復帰)。by-kind の総和からは導かない。
 *   - `redactionCountByKind` は **既知 kind に帰属した件数の部分集合**
 *     (countRedactionMarkersByKindDeep: Object.create(null) + allowlist)。
 *   - 正直な不変条件: `sum(by_kind) <= redactionCount` (等号は全マーカーが既知 kind のとき)。
 *   - これにより by_kind の型崩壊 (SEC-1) や phantom kind 除去 (SEC-2) が scalar に伝播せず、
 *     scalar は常に number。TDA-1 (countRedactionMarkersDeep が dead code 化) も解消する。
 * **原文は一切載らない** (kind 名 = 公開 enum + 件数のみ)。redaction 自体は redactValue が唯一実施。
 */
export function redactDeepWithCount<T>(value: T): {
  value: T;
  redactionCount: number;
  redactionCountByKind: Record<string, number>;
} {
  const redacted = redactValue(value) as T;
  // scalar count は全マーカー数から導く (方針 A: by-kind 総和に依存しない → 型崩壊が伝播しない)。
  const redactionCount = countRedactionMarkersDeep(redacted);
  const redactionCountByKind = countRedactionMarkersByKindDeep(redacted);
  return { value: redacted, redactionCount, redactionCountByKind };
}
