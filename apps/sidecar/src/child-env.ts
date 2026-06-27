/**
 * 子プロセス spawn 用の env allowlist (SEC-1, 最小権限).
 *
 * Sidecar が managed CLI (codex app-server / claude) を spawn する際、sidecar 自身の **全 env を
 * 継承させない**。`INGEST_TOKEN` (backend ingestion の Bearer) や `ACTRADECK_*` 制御変数は
 * sidecar→backend 認証/制御の機密であり、被監督エージェントの子プロセスへ渡す必要がない
 * (最小権限違反・credential 露出面)。
 *
 * 方針 (allowlist > denylist):
 *  - **allowlist** で「子が正当に必要とする env」(PATH/HOME/locale/proxy/terminal 等 + 当該 CLI が
 *    必要とする変数) のみ通す。未知の env は **既定で落とす** (新しい機密 env を将来追加しても
 *    自動で漏れない fail-safe)。
 *  - sidecar 固有の機密 (`INGEST_TOKEN` / `ACTRADECK_*`) は allowlist に**含めない**ため確実に strip。
 *
 * 本ヘルパは codex/claude 両経路で使う (codex=codex-runner, claude=managed-runner, task 019ea341 済)。
 * provider 別の追加許可キー (extraAllowedKeys) / 追加許可 prefix (extraAllowedPrefixes) を引数で渡せる
 * よう **汎用化** してある (TDA-3 訂正: 元コメントは「後続 task で claude に適用する」だったが適用済)。
 */

/**
 * どの子プロセスでも安全に継承してよい基盤 env キー (大小区別: process.env は POSIX で
 * case-sensitive。Windows 互換は将来課題)。CLI 動作・ロケール・端末・プロキシ・一時ディレクトリ等。
 * 機密 (token/credential/secret) は**一切含めない**。
 */
const BASE_ALLOWED_ENV_KEYS: readonly string[] = [
  // 実行・探索
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  // 端末
  "TERM",
  "COLORTERM",
  "TERMINFO",
  // Node / nvm (codex/claude は node 実行系)
  "NODE_OPTIONS",
  "NVM_DIR",
  "NVM_BIN",
  // プロキシ (外部 API 到達に必要な場合がある。値は URL であり sidecar 固有機密ではない)
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  // XDG (config/cache パス)
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  // SEC-2: `GIT_*` (GIT_EXTERNAL_DIFF / GIT_PAGER / GIT_CONFIG_* 等の exec 駆動面) は
  // allowlist に**非列挙**で遮断する。攻撃者制御の repo が git 子経由で任意コマンドを起動する
  // 余地を最小化するため、git 子へ余分な GIT_* を継承させない (git ヘルパは env: buildChildEnv())。
];

/**
 * sidecar 固有の機密プレフィックス。allowlist に無いので元々落ちるが、**二重防御**として
 * 明示的に拒否し、将来 allowlist を緩めても確実に strip されることを保証する (deny は allow に勝つ)。
 */
const SIDECAR_SECRET_PREFIXES: readonly string[] = ["ACTRADECK_"];
const SIDECAR_SECRET_KEYS: readonly string[] = ["INGEST_TOKEN"];

/** あるキーが sidecar 固有機密 (常に strip 対象) か。 */
function isSidecarSecretKey(key: string): boolean {
  if (SIDECAR_SECRET_KEYS.includes(key)) return true;
  return SIDECAR_SECRET_PREFIXES.some((prefix) => key.startsWith(prefix));
}

export interface BuildChildEnvOptions {
  /** 親 env (既定 process.env)。テストで注入可能。 */
  readonly source?: NodeJS.ProcessEnv;
  /**
   * 当該 CLI が追加で必要とする env キー (例: codex の `CODEX_*` / `OPENAI_*` などが必要なら明示)。
   * allowlist に union される。**機密を安易に足さない** (足すなら正当性を監査で確認)。
   */
  readonly extraAllowedKeys?: readonly string[];
  /**
   * 当該 CLI が追加で必要とする env **prefix** (例: `VERTEX_REGION_CLAUDE_`)。これらの prefix で
   * 始まる source のキーを通す。**isSidecarSecretKey が prefix より優先** (機密は prefix 一致でも drop)。
   * open-ended (per-model 等) で個別列挙できないキー群にのみ使う。**機密 prefix を安易に足さない**。
   */
  readonly extraAllowedPrefixes?: readonly string[];
}

/**
 * claude managed-runner が子へ追加で通してよい env キー (SEC, task 019ea341-270f)。
 *
 * これらは **claude (被監督エージェント) 自身の provider 認証/設定** であり、
 * sidecar→backend の機密 (`INGEST_TOKEN` / `ACTRADECK_*`) とは**別物**。被監督エージェントが
 * 自分の資格情報で API/Bedrock/Vertex に到達するために必要なので継承して良い (公式 docs 2026-06 確認)。
 *
 * 一方、親 Claude Code セッション由来の **runtime 変数** (`CLAUDE_CODE_SESSION_ID` /
 * `CLAUDE_CODE_CHILD_SESSION` / `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` / `CLAUDE_CODE_EXECPATH` 等)
 * は **意図的に列挙しない**。これらは sidecar を起動した親 CC セッションの実行コンテキストであり、
 * managed 子へ継承すると子が「親セッションの一部」と誤認・混線する。allowlist に無い → fail-safe で
 * drop される (本配列に書かないこと自体が意思表示)。`ACTRADECK_SESSION` も同様に含めない —
 * child の session は env 継承でなく `opts.identity` (SessionIdentity) 経路で得るため env から除外で良い。
 */
export const CLAUDE_EXTRA_ENV_KEYS: readonly string[] = [
  // --- Anthropic API (direct) ---
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL", // deprecated alias of ANTHROPIC_DEFAULT_HAIKU_MODEL (TDA-1)
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  // model alias override (Bedrock/Vertex 等で per-tier model を指定。TDA-2: Haiku だけ通る非対称を解消)
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_FABLE_MODEL",
  // --- Amazon Bedrock ---
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_PROFILE",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  // --- Google Vertex AI ---
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "ANTHROPIC_VERTEX_BASE_URL",
  "CLOUD_ML_REGION",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "GOOGLE_APPLICATION_CREDENTIALS",
  // 注意: tuning 系 (CLAUDE_CODE_MAX_OUTPUT_TOKENS / DISABLE_PROMPT_CACHING 等) は **意図的に
  // 非継承**。auth/routing でなく CLI を壊しもしないため、最小権限スコープ外として列挙しない (TDA-2)。
];

/**
 * claude managed-runner が子へ追加で通してよい env **prefix** (TDA-2)。
 *
 * Vertex の per-model region override (`VERTEX_REGION_CLAUDE_<MODEL>`) は model 名ごとに
 * open-ended に増えるため個別キー列挙が不可能。prefix-allow で対応する。
 * **isSidecarSecretKey が prefix より優先**するので、`ACTRADECK_` で始まる偽 prefix を渡しても
 * sidecar 機密は drop される (二重防御を貫通させない)。
 */
export const CLAUDE_EXTRA_ENV_PREFIXES: readonly string[] = ["VERTEX_REGION_CLAUDE_"];

/**
 * allowlist に基づき子プロセス spawn 用の env を構築する。
 * - BASE_ALLOWED_ENV_KEYS ∪ extraAllowedKeys に含まれる、または extraAllowedPrefixes のいずれかで
 *   始まる source キーで、かつ sidecar 固有機密でないキーのみ通す。
 * - undefined 値のキーは落とす (exactOptionalPropertyTypes 整合)。
 * - **isSidecarSecretKey は allowlist/prefix の双方より優先** (機密は一致しても必ず drop)。
 */
export function buildChildEnv(opts: BuildChildEnvOptions = {}): NodeJS.ProcessEnv {
  const source = opts.source ?? process.env;
  const allowed = new Set<string>([...BASE_ALLOWED_ENV_KEYS, ...(opts.extraAllowedKeys ?? [])]);
  const prefixes = opts.extraAllowedPrefixes ?? [];
  const out: NodeJS.ProcessEnv = {};

  // (1) 明示 allowlist キー。
  for (const key of allowed) {
    if (isSidecarSecretKey(key)) continue; // 二重防御: 機密は allowlist にあっても落とす。
    const value = source[key];
    if (value !== undefined) out[key] = value;
  }

  // (2) prefix-allow (open-ended なキー群)。source 側を走査し prefix 一致を通す。
  //     isSidecarSecretKey を必ず先に評価し、偽 prefix (ACTRADECK_ 等) で機密を再混入させない。
  if (prefixes.length > 0) {
    for (const key of Object.keys(source)) {
      if (key in out) continue; // 既に allowlist で採用済み。
      if (isSidecarSecretKey(key)) continue; // 二重防御 (prefix より優先)。
      if (!prefixes.some((p) => key.startsWith(p))) continue;
      const value = source[key];
      if (value !== undefined) out[key] = value;
    }
  }

  return out;
}
