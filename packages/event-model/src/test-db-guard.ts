/**
 * test harness 用 production-DB 接続ガード (SEC-2・裁定 019fc4c6)。
 *
 * 背景: 各 workspace の vitest setup が root .env を process.env へ流し込み、real-PG テスト群は
 * dbReachable() (SELECT 1) のみで gate していたため、ローカル vitest が production PG
 * (ACTRADECK_PG_PORT 既定 55432) へ接続し INSERT / afterAll DELETE を実行しうる事故が実際に
 * 起きた (Phase3b-2 実装検証中・旧 schema の column-not-exist throw で偶然 net-zero)。
 *
 * 方針 (裁定 019fc4c6 の (b)+(c) 複合):
 * - `applyDotenvForTests` は .env から DATABASE_URL を採用しない (主修正)。テストへ DB を渡すのは
 *   (1) 実環境変数への明示注入 (CI の使い捨てコンテナ経路) か
 *   (2) ACTRADECK_TEST_DATABASE_URL (明示 opt-in・.env 記載も可) のみ。
 * - `applyTestDatabaseGuard` はどの経路で来た DATABASE_URL でも production port
 *   (55432 / ACTRADECK_PG_PORT) を指す接続文字列を fail-loud (throw) で拒否する。
 *   判定は URL parse に依存しない数字境界 substring 照合 — multi-host (`h1:5432,h2:55432`) /
 *   key=value conninfo (`port=55432`) / URL parser が扱えない形でも port の数字は文字列に残る。
 *   過剰一致 (パスワード内に port 数字が現れる等) は「拒否」= 安全側に倒れる。
 * - エラーメッセージへ接続文字列を echo しない (credential を含みうるため・NO-RAW)。
 *
 * 配置: backend / webui / db / sidecar の 4 harness が共有する security gate ゆえ event-model に
 * 単一出所化する (security-gate-reuse-canonical-parser・手書きコピーは 3 面 drift の実績あり)。
 * イベント契約そのものではない (test harness 専用・runtime コードからは import しない)。
 */

/** 明示 opt-in のテスト用 DB URL。設定時は DATABASE_URL より優先してテストへ渡す。 */
export const TEST_DB_URL_ENV_KEY = "ACTRADECK_TEST_DATABASE_URL";

/** production PG の既定 port (docs/getting-started の ACTRADECK_PG_PORT 既定と一致)。 */
export const DEFAULT_PROD_PG_PORT = "55432";

const NUMERIC_PORT_RE = /^[0-9]+$/;

/**
 * テストが接続してはならない port 集合。既定の 55432 に加え、operator が ACTRADECK_PG_PORT で
 * production port を変えていればそれも含める (数字列のみ採用 — RegExp へ interpolate するため
 * ここで検証し、非数字は無視する)。
 */
export function forbiddenTestDbPorts(env: Record<string, string | undefined>): readonly string[] {
  const ports = new Set<string>([DEFAULT_PROD_PG_PORT]);
  const operatorPort = env["ACTRADECK_PG_PORT"]?.trim();
  if (operatorPort !== undefined && operatorPort !== "" && NUMERIC_PORT_RE.test(operatorPort)) {
    ports.add(operatorPort);
  }
  return [...ports];
}

/** 数字境界で port token を検出 (":55432" / "port=55432" / multi-host のどこに現れても一致)。 */
function containsPortToken(url: string, port: string): boolean {
  // port は forbiddenTestDbPorts で数字列に検証済み (regex injection 不能)。
  const re = new RegExp(`(^|[^0-9])${port}([^0-9]|$)`);
  return re.test(url);
}

/**
 * 接続文字列が forbidden port を指すなら該当 port を返す (指さなければ undefined)。
 * 判定境界は「port の数字列が数字境界で現れるか」— false positive (DB 名等に同数字列) は
 * 安全側 (拒否) と割り切る。
 */
export function isForbiddenTestDatabaseUrl(
  url: string,
  env: Record<string, string | undefined>,
): string | undefined {
  for (const port of forbiddenTestDbPorts(env)) {
    if (containsPortToken(url, port)) return port;
  }
  return undefined;
}

/**
 * test harness の DB 接続を確定しガードする:
 * 1. ACTRADECK_TEST_DATABASE_URL が設定されていれば DATABASE_URL へ写す (明示 test URL が優先)。
 * 2. 最終的な DATABASE_URL が forbidden port を指すなら throw (fail-loud)。未設定/空なら何もしない
 *    (real-PG テストは従来どおり describe.skipIf の skip 経路へ)。
 * 3. DATABASE_URL が有効なとき、libpq 互換 fallback の PGPORT が forbidden port を指すなら
 *    同様に throw する — node-pg は接続文字列に port が無いと env PGPORT へフォールバックするため、
 *    「port なし URL + shell の PGPORT=55432」が (2) をすり抜けて production へ届きうる。
 *    URL 側に明示 port があるケースでは PGPORT は実際には使われないが、判定を URL parse に
 *    依存させない方針を保ち、その組合せも安全側 (拒否) に倒す。
 *
 * throw メッセージに接続文字列は含めない (credential NO-RAW)。
 */
export function applyTestDatabaseGuard(env: Record<string, string | undefined>): void {
  const testUrl = env[TEST_DB_URL_ENV_KEY]?.trim();
  if (testUrl !== undefined && testUrl !== "") {
    env["DATABASE_URL"] = testUrl;
  }
  const url = env["DATABASE_URL"];
  if (url === undefined || url.trim() === "") return;
  const port = isForbiddenTestDatabaseUrl(url, env);
  if (port !== undefined) {
    throw new Error(
      `Refusing to run tests against a production-port database: DATABASE_URL targets port ${port} ` +
        `(the production PostgreSQL port on this machine). Tests must use a disposable database — ` +
        `start a throwaway PostgreSQL (container) on another port and pass it via ` +
        `${TEST_DB_URL_ENV_KEY} (preferred) or DATABASE_URL. ` +
        `The connection string is not echoed here because it may contain credentials.`,
    );
  }
  const pgPort = env["PGPORT"]?.trim();
  if (pgPort !== undefined && NUMERIC_PORT_RE.test(pgPort)) {
    const forbidden = forbiddenTestDbPorts(env);
    if (forbidden.includes(pgPort)) {
      throw new Error(
        `Refusing to run tests: PGPORT targets port ${pgPort} (the production PostgreSQL port ` +
          `on this machine), and node-pg falls back to PGPORT when the connection string omits ` +
          `a port. Unset PGPORT or point it at a disposable database port.`,
      );
    }
  }
}

/**
 * root .env のテスト用最小 dotenv 適用 (旧 backend/webui/db setup-env 3 コピーの単一出所化)。
 * - 既に環境へ設定済みの key は上書きしない (CI の env 注入経路を尊重)。
 * - 値の両端 quote ('" / ') は 1 層だけ剥がす。コメント行・空行・`=` 無し行は無視。
 * - DATABASE_URL は .env から採用しない (SEC-2 の主修正 — production posture の .env を
 *   テストが黙って拾わない)。ACTRADECK_TEST_DATABASE_URL は明示 opt-in ゆえ採用する。
 */
export function applyDotenvForTests(raw: string, env: Record<string, string | undefined>): void {
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key === "DATABASE_URL") continue; // SEC-2: prod への接続情報を .env から採用しない
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (env[key] === undefined) {
      env[key] = value;
    }
  }
}
