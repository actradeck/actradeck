/**
 * BFF custom server の upgrade ルーティング純ロジック (server-side only, transport 非依存).
 *
 * ADR 019e92b7: ブラウザは same-origin で `/realtime/ws` に繋ぎ、custom server がそれだけを掴んで
 * backend `/realtime/ws` へ server-side Bearer 中継する。**それ以外の upgrade (Next.js の HMR =
 * `/_next/webpack-hmr` 等) は必ず Next に委ねる** — さもないと dev の HMR WebSocket が壊れる
 * (WebSearch: 同一ポートで別 WS サーバを動かすと webpack-hmr が pending になる既知の落とし穴)。
 *
 * ここは「どの upgrade を掴むか」「どのポートで serve するか」の判定だけを純関数で切り出し、
 * vitest で実サーバ無しに赤化できるようにする。実際の socket pipe は server.ts が担う。
 *
 * ⚠️ server 専用。ブラウザバンドルに載せてはならない (本ファイルは src/server/** にあり、
 * INV-TOKEN-ISOLATION の BROWSER_GLOBS = ui/ realtime/ app の外なので走査対象外)。
 */

/** ブラウザが BFF に繋ぐ same-origin パス (publicClientConfig().path と一致させる)。 */
export const REALTIME_WS_PATH = "/realtime/ws";

/** webui がリッスンする既定ポート (ACTRADECK_WEBUI_PORT で上書き可)。 */
export const DEFAULT_WEBUI_PORT = 55400;

/**
 * webui の既定 bind host = loopback (SEC-A, audit a2626d5e)。
 * server.listen() の host を省略すると Node は全インターフェース (0.0.0.0/::) に bind し、LAN ピアが
 * REALTIME_TOKEN 無しで backend 認証済 realtime (approve/interrupt relay) に到達できてしまう
 * (Bearer 認証バイパス / INV-APPROVAL 領域)。既定を 127.0.0.1 に固定し、明示 env のときのみ広げる。
 * backend (.env.example: ACTRADECK_BACKEND_HOST=127.0.0.1) と同じ loopback 既定に揃える。
 */
export const DEFAULT_WEBUI_HOST = "127.0.0.1";

/**
 * upgrade リクエストの URL が BFF relay 対象 (`/realtime/ws`) かを判定する純関数。
 *
 * - pathname のみで判定し、query string は無視する (`/realtime/ws?foo=bar` も対象)。
 * - **完全一致のみ** relay する (`/realtime/ws/extra` や `/realtime/wsx` は対象外 = Next へ委譲)。
 *   prefix 一致にすると `/realtime/ws-internal` 等を誤って掴むため。
 * - 解析不能 / 空 URL は false (掴まず Next に委ねる = 安全側、relay の取りこぼしより誤捕捉回避)。
 *
 * @param rawUrl req.url (Node の http upgrade では path+query の相対 URL が来る)。
 */
export function shouldRelayUpgrade(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  // 相対 URL を解析するため任意の base を付ける (host は判定に使わない)。
  let pathname: string;
  try {
    pathname = new URL(rawUrl, "http://internal.invalid").pathname;
  } catch {
    return false;
  }
  return pathname === REALTIME_WS_PATH;
}

/**
 * env から webui のリッスンポートを解決する純関数。
 * - `ACTRADECK_WEBUI_PORT` が正の整数ならそれを使う。
 * - 未設定 / 不正値は DEFAULT_WEBUI_PORT にフォールバック (起動を止めない)。
 */
export function resolveWebuiPort(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env["ACTRADECK_WEBUI_PORT"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_WEBUI_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 65535) return DEFAULT_WEBUI_PORT;
  return n;
}

/**
 * server.listen() に渡す bind host を env から解決する純関数 (SEC-A, audit a2626d5e)。
 * - 既定は **127.0.0.1** (loopback)。env が host を **明示したときのみ** それを使う
 *   (例 LAN 公開時に `ACTRADECK_WEBUI_HOST=0.0.0.0`)。
 * - 空文字 / 空白のみは未設定扱い (誤った全 bind を防ぐ安全側)。
 *
 * これにより既定の起動で LAN ピアが BFF 経由で backend 認証済 realtime に到達できない
 * (Bearer 認証バイパス防止)。明示的に広げる運用判断のみ LAN bind を許す。
 *
 * @param env 読み取り元 (既定 process.env; テスト注入用)。
 */
export function resolveBindHost(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const raw = env["ACTRADECK_WEBUI_HOST"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_WEBUI_HOST;
  return raw.trim();
}

/**
 * ログ用に upstream 構成を **redaction** する純関数 (token を stdout/ログへ出さないため)。
 *
 * security.md: REALTIME_TOKEN/secret を stdout に出さない。server.ts が relay の接続先を
 * ログする際は必ずこれを通し、Authorization (Bearer) を含むヘッダを伏せる。
 * 返り値に Bearer 実値が **絶対に含まれない** ことを INV テストで固定する。
 *
 * @param url upstream の WS URL (query は付かない契約だが、念のため authorization 系の
 *            query があっても伏せる)。
 */
export function redactUpstreamForLog(url: string): string {
  try {
    const u = new URL(url);
    // token を query で運ぶ契約ではない (SEC-1) が、万一付いていたら伏せる。
    for (const key of [...u.searchParams.keys()]) {
      if (/token|auth|secret|key|bearer/i.test(key)) u.searchParams.set(key, "[REDACTED]");
    }
    // userinfo (user:pass@host) も伏せる。
    if (u.username || u.password) {
      u.username = u.password ? "[REDACTED]" : u.username;
      u.password = u.password ? "[REDACTED]" : u.password;
    }
    return u.toString();
  } catch {
    // 解析不能 URL はそのまま返さず伏せる (誤って secret 片を出さない安全側)。
    return "[unparseable-upstream-url]";
  }
}
