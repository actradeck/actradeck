/**
 * BFF (Backend-for-Frontend) リレー設定の純ロジック (server-side only).
 *
 * ADR 019e92b7: ブラウザは same-origin で Next.js custom server の `/realtime/ws` に繋ぎ、
 * custom server が backend `/realtime/ws` へ **server-side で Bearer を付けて** 中継する。
 * REALTIME_TOKEN は **server env のみ**で読み、ブラウザへは絶対に渡さない (security.md)。
 *
 * このスライスでは custom server (`server.ts`) 本体は配線しない (server/コミットしない方針)。
 * ここでは「backend へ繋ぐ URL と Authorization ヘッダをどう作るか」という transport 非依存の
 * 純関数だけを切り出し、token がヘッダ経由 (query でない: SEC-1) であることをテストで固定する。
 *
 * ⚠️ このモジュールは **server 専用**。ブラウザバンドルに含めてはならない
 * (含めると token が露出する)。client.ts はこれを import しない。
 */

/** BFF が backend へ張る upstream 接続の構成。 */
export interface UpstreamConfig {
  /** backend の realtime WS URL (例: `ws://127.0.0.1:8787/realtime/ws`)。 */
  readonly url: string;
  /** upgrade リクエストに付けるヘッダ。Bearer はここにのみ載る (query 禁止: SEC-1)。 */
  readonly headers: Readonly<Record<string, string>>;
}

/** BFF が backend へ張る replay REST fetch 構成。 */
export interface UpstreamHttpConfig {
  /** backend の replay HTTP URL。token を query に含めてはならない。 */
  readonly url: string;
  /** fetch に付けるヘッダ。Bearer はここにのみ載る。 */
  readonly headers: Readonly<Record<string, string>>;
}

export class MissingRealtimeTokenError extends Error {
  constructor() {
    super("REALTIME_TOKEN is required server-side (BFF must not run without it)");
    this.name = "MissingRealtimeTokenError";
  }
}

/** upstream URL が ws:/wss: でない (誤配・平文ダウングレード防止)。 */
export class InvalidUpstreamUrlError extends Error {
  constructor(url: string) {
    super(`BACKEND_REALTIME_WS_URL must be a ws:// or wss:// URL, got: ${url}`);
    this.name = "InvalidUpstreamUrlError";
  }
}

/** replay proxy へ渡せるのは same-origin の origin-form path だけ。 */
export class InvalidReplayRequestPathError extends Error {
  constructor(path: string) {
    super(`Replay request path must be an origin-form /realtime path, got: ${path}`);
    this.name = "InvalidReplayRequestPathError";
  }
}

/**
 * server env から upstream 構成を組む。
 * - `REALTIME_TOKEN` 必須 (無ければ throw: 無認証で backend へ繋がない)。
 * - token は **Authorization: Bearer ヘッダにのみ** 載せる。URL の query には絶対に入れない
 *   (SEC-1: query はアクセスログ/プロキシログに漏れる)。
 *
 * @param env  読み取り元 (既定 process.env; テスト注入用)。
 * @param backendUrl backend realtime WS URL (既定 env.BACKEND_REALTIME_WS_URL)。
 */
export function resolveUpstreamConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  backendUrl: string | undefined = undefined,
): UpstreamConfig {
  const token = env["REALTIME_TOKEN"];
  if (!token || token.length === 0) throw new MissingRealtimeTokenError();

  const url = backendUrl ?? env["BACKEND_REALTIME_WS_URL"] ?? "ws://127.0.0.1:8787/realtime/ws";
  // SEC-3 (防御的検証): token を載せる前に upstream URL を構造検証する。
  //  - scheme は ws:/wss: のみ (http(s):// への誤配や平文ダウングレードで Bearer を誤送しない)。
  //  - 不正な env はここで throw (token をヘッダに載せない)。url は素の endpoint で query は付けない。
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InvalidUpstreamUrlError(url);
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new InvalidUpstreamUrlError(url);
  }
  return {
    url,
    headers: { authorization: `Bearer ${token}` },
  };
}

function httpProtocolForWs(protocol: string): string | null {
  if (protocol === "ws:") return "http:";
  if (protocol === "wss:") return "https:";
  return null;
}

/**
 * Replay BFF へ入った HTTP request-target を backend へ転送してよい path に正規化する。
 * SEC: absolute-form / protocol-relative request-target は upstream origin を上書きできるため拒否する。
 */
export function normalizeReplayRequestPath(requestPath: string): string {
  if (!requestPath.startsWith("/") || requestPath.startsWith("//")) {
    throw new InvalidReplayRequestPathError(requestPath);
  }

  let parsed: URL;
  try {
    parsed = new URL(requestPath, "http://local");
  } catch {
    throw new InvalidReplayRequestPathError(requestPath);
  }
  // 許可する backend read/pull endpoint (段階2 で diff / command output を追加・ADR 019ea4ba D2/D8)。
  //   いずれも REALTIME_TOKEN gate 背後の同一 origin path。session/event セグメントは `[^/]+`
  //   (path traversal は `/` 不在で構造的に塞ぐ)。**新 path を足すときはここに anchored 追記する**
  //   (SSRF/path-confusion 防止: allowlist を緩めない・ワイルドカード化しない)。
  const allowed =
    /^\/realtime\/sessions\/[^/]+\/events$/.test(parsed.pathname) ||
    /^\/realtime\/sessions\/[^/]+\/diff$/.test(parsed.pathname) ||
    /^\/realtime\/sessions\/[^/]+\/commands\/[^/]+\/output$/.test(parsed.pathname) ||
    // 段階1 (ADR 019ead14 D1): 横断 Approval Inbox の集約 pull。query/segment 無しの固定 path。
    /^\/realtime\/approvals$/.test(parsed.pathname) ||
    // 段階1 (ADR 019ead7a D1): Live Wall の横断フィード集約 pull。固定 path (segment なし)。
    //   normalize は pathname 照合ゆえ query は素通しで保持される。backend は per_session query を
    //   受理可能だが現状 client UI は未送出 (常に既定 N=50)。ワイルドカード化しない (TDA-5)。
    /^\/realtime\/wall$/.test(parsed.pathname) ||
    // 強み(a) 監査ビュー (ADR 019ed1f9): 期間集計 (query from/to/limit/format は search で保持) と
    //   per-session 詳細。session セグメントは `[^/]+` (path traversal は `/` 不在で構造的に塞ぐ)。
    /^\/realtime\/audit\/sessions$/.test(parsed.pathname) ||
    /^\/realtime\/audit\/sessions\/[^/]+$/.test(parsed.pathname) ||
    // ガバナンス証跡 drill-down (decision 019f03cc): kind 別件数→個別イベント (query kind/limit は
    //   search で保持)。session セグメントは [^/]+ (traversal は `/` 不在で構造的に塞ぐ)。anchored。
    /^\/realtime\/audit\/sessions\/[^/]+\/redactions$/.test(parsed.pathname) ||
    // PAL-v2 (ADR 019ee147): 永続承認 allowlist の in-UI 一覧 (GET) / 失効 (POST)。
    //   session セグメントは `[^/]+`。revoke は mutating ゆえ proxy 側で method=POST を厳格に絞る
    //   (isAllowlistRevokePath)。allowlist (一覧) は GET-only。allowlist を緩めない (anchored)。
    /^\/realtime\/sessions\/[^/]+\/approvals\/allowlist$/.test(parsed.pathname) ||
    /^\/realtime\/sessions\/[^/]+\/approvals\/allowlist\/revoke$/.test(parsed.pathname) ||
    // ADR 019f0c3e Phase 2 + 019f0eca per-repo: bypass/YOLO 承認ポリシーの取得 (GET) / 一覧 (GET) /
    //   更新 (POST) / 削除 (POST)。allowlist と対称に method-pure な別 path で mutating を分離する
    //   (get/list は GET-only・set/unset は POST-only=isPolicySetPath/isPolicyUnsetPath)。
    //   session セグメントは `[^/]+`。anchored で緩めない (SSRF/path-confusion 防止)。
    /^\/realtime\/sessions\/[^/]+\/approvals\/policy$/.test(parsed.pathname) ||
    /^\/realtime\/sessions\/[^/]+\/approvals\/policy\/list$/.test(parsed.pathname) ||
    /^\/realtime\/sessions\/[^/]+\/approvals\/policy\/set$/.test(parsed.pathname) ||
    /^\/realtime\/sessions\/[^/]+\/approvals\/policy\/unset$/.test(parsed.pathname) ||
    // ADR 019f0eca 方式B: repo 追加導線の path→scope 解決。読取りのみだが path を body で運ぶため POST
    //   (query へ載せない=SEC-1)。proxy が POST-only + CSRF を強制 (isPolicyResolvePath)。anchored。
    /^\/realtime\/sessions\/[^/]+\/approvals\/policy\/resolve$/.test(parsed.pathname) ||
    // ADR 019f1582: daemon-addressed policy relay (エージェント未稼働でも設定可)。接続中 daemon の id 一覧
    //   (GET 固定 path) + daemon 宛 policy get/list/set/unset/resolve。daemonId セグメントは `[^/]+`
    //   (traversal は `/` 不在で構造遮断)。set/unset/resolve は session 版と同じ method-pure POST 分離
    //   (isPolicySetPath/Unset/Resolve が `(?:sessions|daemons)` 両方を拾う)。**approve/interrupt の daemon
    //   path は存在しない** (session-scoped 維持・INV-REALTIME-RELAY-SCOPE)。
    /^\/realtime\/daemons$/.test(parsed.pathname) ||
    /^\/realtime\/daemons\/[^/]+\/approvals\/policy$/.test(parsed.pathname) ||
    /^\/realtime\/daemons\/[^/]+\/approvals\/policy\/list$/.test(parsed.pathname) ||
    /^\/realtime\/daemons\/[^/]+\/approvals\/policy\/set$/.test(parsed.pathname) ||
    /^\/realtime\/daemons\/[^/]+\/approvals\/policy\/unset$/.test(parsed.pathname) ||
    /^\/realtime\/daemons\/[^/]+\/approvals\/policy\/resolve$/.test(parsed.pathname);
  if (!allowed) {
    throw new InvalidReplayRequestPathError(requestPath);
  }
  return `${parsed.pathname}${parsed.search}`;
}

/**
 * PAL-v2 (ADR 019ee147): POST (mutating) を許す唯一の path = allowlist revoke。
 * proxy はこの判定で「revoke のみ POST 可・他の allow-list path は GET-only」を強制する
 * (mutating endpoint を最小化・他経路への POST 注入を構造的に塞ぐ)。
 */
export function isAllowlistRevokePath(requestPath: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(requestPath, "http://local");
  } catch {
    return false;
  }
  return /^\/realtime\/sessions\/[^/]+\/approvals\/allowlist\/revoke$/.test(parsed.pathname);
}

/**
 * ADR 019f0c3e Phase 2: POST (mutating) を許す承認ポリシー更新 path = `.../approvals/policy/set`。
 * allowlist revoke と同じく method-pure に分離し、proxy が「policy set のみ POST 可・policy get は
 * GET-only」を強制できるようにする (mutating endpoint を最小化・他経路への POST 注入を構造的に塞ぐ)。
 */
export function isPolicySetPath(requestPath: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(requestPath, "http://local");
  } catch {
    return false;
  }
  // ADR 019f1582: session 版に加え daemon-addressed (`/realtime/daemons/:id/...`) も mutating-POST 扱い。
  return /^\/realtime\/(?:sessions|daemons)\/[^/]+\/approvals\/policy\/set$/.test(parsed.pathname);
}

/**
 * ADR 019f0eca per-repo: POST (mutating) を許す承認ポリシー削除 path = `.../approvals/policy/unset`。
 * set と同じく method-pure に分離し、proxy が「unset のみ POST 可・policy get/list は GET-only」を
 * 強制できるようにする (mutating endpoint を最小化・他経路への POST 注入を構造的に塞ぐ)。
 */
export function isPolicyUnsetPath(requestPath: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(requestPath, "http://local");
  } catch {
    return false;
  }
  // ADR 019f1582: session 版に加え daemon-addressed も mutating-POST 扱い。
  return /^\/realtime\/(?:sessions|daemons)\/[^/]+\/approvals\/policy\/unset$/.test(
    parsed.pathname,
  );
}

/**
 * ADR 019f0eca 方式B: POST (path を body で運ぶ) repo 解決 path = `.../approvals/policy/resolve`。
 * 読取りのみだが path を query に載せないため POST。proxy が「resolve のみ POST 可・CSRF 同一オリジン」を
 * 強制する (set/unset と同じ mutating-class ゲート扱い・cross-site の任意パス探索を構造遮断)。
 */
export function isPolicyResolvePath(requestPath: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(requestPath, "http://local");
  } catch {
    return false;
  }
  // ADR 019f1582: session 版に加え daemon-addressed も mutating-class (POST-only + CSRF) 扱い。
  return /^\/realtime\/(?:sessions|daemons)\/[^/]+\/approvals\/policy\/resolve$/.test(
    parsed.pathname,
  );
}

/**
 * same-origin browser fetch `/realtime/sessions/:id/events?...` を backend REST URL へ変換する。
 * `BACKEND_REALTIME_WS_URL` を source of truth とし、host/port だけを共有して HTTP(S) 化する。
 */
export function resolveReplayHttpConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  requestPath: string,
  backendUrl: string | undefined = undefined,
): UpstreamHttpConfig {
  const safePath = normalizeReplayRequestPath(requestPath);
  const ws = resolveUpstreamConfig(env, backendUrl);
  const parsed = new URL(ws.url);
  const httpProtocol = httpProtocolForWs(parsed.protocol);
  if (httpProtocol === null) throw new InvalidUpstreamUrlError(ws.url);
  const upstream = new URL(safePath, `${httpProtocol}//${parsed.host}`);
  return {
    url: upstream.toString(),
    headers: ws.headers,
  };
}

/**
 * ブラウザへ渡してよい公開構成だけを返す (token を含まないことを型で保証)。
 * ブラウザ側 RealtimeClient はこの same-origin path を使う。
 */
export function publicClientConfig(): { readonly path: string } {
  return { path: "/realtime/ws" };
}
