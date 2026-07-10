/**
 * codex-spawn-wire — cockpit からの Codex Managed spawn 要求 (ADR 019f4206 A段) の wire 契約 (T1・単一出所)。
 *
 * 背景: attach daemon が既存 CodexRunner を **in-process** で起動する startManagedCodex を、backend の
 * daemon-addressed control channel 経由で cockpit から誘発する。prompt / cwd は operator 入力ゆえ新しい
 * **実行サーフェス**であり、境界 (webui→backend→daemon) を越える。複数ティアが各々再解釈すると drift が
 * 連続バイパス源になる (security-gate-reuse-canonical-parser) ため、wire 型 + 受信検証 + 失敗 enum をここへ
 * 集約し、backend (route/relay) と sidecar (daemon handler) が**手書きコピーを禁止して共有**する。
 *
 * NO-RAW / transient 契約 (security.md・ADR 契約点6):
 *  - prompt / cwd は制御チャネルの **transient** — ログ・診断・policy at-rest・approval store に残さない。
 *    通常の session イベント (redaction 済・sink.emit 経由) としての保存のみ正当。
 *  - 失敗応答は **closed enum の error code** のみを載せ、prompt / cwd を echo しない
 *    (`CodexSpawnErrorCode` + サーバ固定リテラル)。
 *  - `parseCodexSpawnRequest` は既知 field (prompt / cwd) のみ抽出し**余剰 field を構造的に落とす**ため、
 *    buggy/adversarial peer が追加 field を詰めても parse 境界で消える (NO-RAW by construction)。
 *
 * fail-safe 意味論: 非 object / prompt・cwd の型/長さ/絶対性/NUL 不正 → **undefined** (受信側は値ベース
 * `invalid_request` deny・例外は投げない = SEC-R3-3 契約: control handler の拒否は throw でなく return/値)。
 *
 * 純粋・依存ゼロ・fs/net 非アクセス ＝ browser/edge でも安全。
 */

/** spawn 要求の検証済みパラメータ (daemon が消費・transient・保存しない)。 */
export interface CodexSpawnParams {
  /** turn/start へ渡す初期プロンプト (JSON-RPC 経由・shell/argv 非接触)。 */
  readonly prompt: string;
  /** codex app-server を起動する作業ディレクトリ (絶対パス・二段封じ込め対象)。 */
  readonly cwd: string;
}

/** prompt の最大長 (巨大 payload / DoS を防ぐ・argv 非経由でも上限を設ける)。 */
export const MAX_SPAWN_PROMPT_LEN = 32_768;
/** cwd の最大長 (絶対パスの現実的上限)。 */
export const MAX_SPAWN_CWD_LEN = 4_096;

/**
 * spawn 失敗理由の **closed enum** (公開・原文非依存・prompt/cwd を構造的に含まない)。
 *  - invalid_request: prompt/cwd の検証失敗 (parse undefined)。
 *  - cwd_out_of_scope: 二段封じ込め (backend lexical or daemon 解決済 root 再照合) で拒否。
 *  - spawn_disabled: ACTRADECK_ENABLE_CODEX_SPAWN 未設定 (既定 OFF・out-of-box 安全)。
 *  - spawn_cap_reached: 同時 managed codex 数が cap 超過。
 *  - spawn_failed: 子プロセス起動失敗 (binary 不在等)。
 */
export type CodexSpawnErrorCode =
  | "invalid_request"
  | "cwd_out_of_scope"
  | "spawn_disabled"
  | "spawn_cap_reached"
  | "spawn_failed";

/** error code → サーバ固定の公開メッセージ (prompt/cwd を含まない・UI 表示用)。 */
export const CODEX_SPAWN_ERROR_MESSAGE: Readonly<Record<CodexSpawnErrorCode, string>> = {
  invalid_request: "invalid spawn request",
  cwd_out_of_scope: "cwd outside project scope",
  spawn_disabled: "codex spawn disabled (set ACTRADECK_ENABLE_CODEX_SPAWN=1)",
  spawn_cap_reached: "too many managed codex sessions",
  spawn_failed: "codex spawn failed",
};

/** spawn 要求の結果 (daemon → backend → HTTP)。session_id は resolve 済のときのみ (NO-RAW)。 */
export type CodexSpawnResult =
  | { readonly ok: true; readonly session_id?: string }
  | { readonly ok: false; readonly error: CodexSpawnErrorCode };

const SPAWN_ERROR_CODES: ReadonlySet<string> = new Set<CodexSpawnErrorCode>([
  "invalid_request",
  "cwd_out_of_scope",
  "spawn_disabled",
  "spawn_cap_reached",
  "spawn_failed",
]);

/** 未知文字列を安全側 `spawn_failed` へ縮退しつつ closed enum を保証する (敵対 daemon の未知 code 対策)。 */
export function asCodexSpawnErrorCode(v: unknown): CodexSpawnErrorCode {
  return typeof v === "string" && SPAWN_ERROR_CODES.has(v)
    ? (v as CodexSpawnErrorCode)
    : "spawn_failed";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * wire (untrusted・control frame 由来) を `CodexSpawnParams` へ検証射影する正準パーサ。
 * 既知 2 field (prompt / cwd) のみ抽出し余剰 field を落とす (NO-RAW)。以下のいずれかで **undefined**
 * (受信側が値ベース invalid_request deny・非 throw):
 *  - 非 object。
 *  - prompt が非 string / 空 / NUL 含み / MAX_SPAWN_PROMPT_LEN 超過。
 *  - cwd が非 string / 空 / NUL 含み / 非絶対 (先頭 `/` でない) / MAX_SPAWN_CWD_LEN 超過。
 *
 * 封じ込め (project-scope) 判定は **本パーサの責務ではない** (backend lexical gate + daemon 解決済 root
 * 再照合の二段が担う)。ここは shape/型/絶対性の第一次検証のみ。
 */
export function parseCodexSpawnRequest(raw: unknown): CodexSpawnParams | undefined {
  if (!isPlainObject(raw)) return undefined;
  const prompt = raw.prompt;
  const cwd = raw.cwd;
  if (typeof prompt !== "string" || prompt.length === 0 || prompt.length > MAX_SPAWN_PROMPT_LEN) {
    return undefined;
  }
  if (prompt.includes("\0")) return undefined;
  if (typeof cwd !== "string" || cwd.length === 0 || cwd.length > MAX_SPAWN_CWD_LEN) {
    return undefined;
  }
  if (cwd.includes("\0")) return undefined;
  if (!cwd.startsWith("/")) return undefined; // 絶対パスのみ (相対は cwd 依存で曖昧・scope 判定不能)。
  return { prompt, cwd };
}
