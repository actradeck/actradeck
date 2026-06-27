/**
 * BFF relay core (server-side only, transport 抽象を注入してテスト可能).
 *
 * ADR 019e92b7: ブラウザ socket と backend upstream socket を **双方向 pipe** する。
 * REALTIME_TOKEN は upstream factory (resolveUpstreamConfig 経由) でのみ触れ、ブラウザにも
 * ログにも出さない。
 *
 * SEC-A (audit a2626d5e): この core は `src/server/**` に置き coverage gate へ載せる
 * (旧 server.ts 直書きは coverage glob 外で 0% だった)。upstream 接続を **factory 注入**
 * (client.ts の SocketFactory と同型の発想) にして実 backend 無しで赤化できるようにする。
 * server.ts は app.prepare()/listen と upgrade 配線、および本 core への注入だけを担う。
 *
 * ⚠️ server 専用。ブラウザバンドルに載せてはならない (src/server/** は INV-TOKEN-ISOLATION の
 * BROWSER_GLOBS = ui/ realtime/ app の外なので走査対象外)。
 */

import {
  InvalidUpstreamUrlError,
  MissingRealtimeTokenError,
  resolveUpstreamConfig,
  type UpstreamConfig,
} from "../realtime/bff.js";
import { redactUpstreamForLog } from "./upgrade-routing.js";

/** リレーで運ぶペイロード (ws の message data 型に一致)。 */
export type RelayData = Buffer | ArrayBuffer | Buffer[];

/**
 * リレーが必要とする最小 socket 抽象 (ブラウザ socket / upstream socket の両対応)。
 * `ws` の WebSocket を充足しつつ、テストでは fake で差し替える (実サーバ不要)。
 */
export interface RelaySocket {
  /**
   * `ws` WebSocket.send(data, options) と整合。`binary` でフレーム型 (text/binary) を指定する。
   * 透過リレーでは受信時の isBinary をここへ渡してフレーム型を保存する (binary 化で
   * ブラウザの text-only 受信を壊さない)。未指定は ws 既定に委ねる。
   */
  send(data: RelayData, opts?: { binary?: boolean }): void;
  close(): void;
  /** ws の readyState (OPEN/CONNECTING のときのみ close する safeClose 判定に使う)。 */
  readonly readyState: number;
  on(event: "open", listener: () => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  /** `ws` は message listener に (data, isBinary) を渡す。フレーム型保存のため isBinary を受ける。 */
  on(event: "message", listener: (data: RelayData, isBinary: boolean) => void): void;
}

/** pending バッファ要素: フレーム型 (isBinary) を flush まで保持する。 */
interface PendingFrame {
  readonly data: RelayData;
  readonly isBinary: boolean;
}

/**
 * upstream socket を生成する factory (実装は server.ts が `new WebSocket(url, { headers })`)。
 * config error を relay 内で扱えるよう、URL/headers は relay が resolveUpstreamConfig で解決して渡す。
 */
export type UpstreamFactory = (config: UpstreamConfig) => RelaySocket;

/** ws の readyState 定数 (ws / browser WebSocket と同値)。テスト fake もこれに合わせる。 */
export const WS_CONNECTING = 0;
export const WS_OPEN = 1;

/**
 * upstream open 前にブラウザから来たメッセージを取りこぼさないためのバッファ上限 (SEC-A の DoS 緩和)。
 * - 件数と総バイトの **両方** で上限。どちらか超過でブラウザ socket を safeClose する
 *   (悪意あるピアが open しない upstream へ大量送信してメモリを食う DoS を塞ぐ)。
 * - 実運用では upstream は即 open するので、健全なクライアントがこの上限に当たることはない。
 */
export const MAX_PENDING_MESSAGES = 64;
export const MAX_PENDING_BYTES = 1 << 20; // 1 MiB

/** RelayData のバイト長を求める (ArrayBuffer / Buffer / Buffer[] の各形に対応)。 */
function byteLength(data: RelayData): number {
  if (Array.isArray(data)) {
    let total = 0;
    for (const b of data) total += b.byteLength;
    return total;
  }
  return data.byteLength;
}

/**
 * env 不備で resolveUpstreamConfig が投げるのは MissingRealtimeToken / InvalidUpstreamUrl のみ。
 * これらは「設定 error → ブラウザ socket を正常 close して再接続に委ねる」扱い (throw しない)。
 */
function isConfigError(err: unknown): boolean {
  return err instanceof MissingRealtimeTokenError || err instanceof InvalidUpstreamUrlError;
}

export interface RelayOptions {
  /** upstream を作る factory (server.ts: ws、test: fake)。 */
  readonly upstreamFactory: UpstreamFactory;
  /** env (resolveUpstreamConfig へ渡す。既定 process.env)。 */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** redaction 済みログ出力 (既定 console)。token を含めてはならない。 */
  readonly log?: (msg: string) => void;
  readonly logError?: (msg: string) => void;
}

/**
 * ブラウザ socket を backend upstream へ双方向中継する。
 *
 * 契約 (T1, test/relay.test.ts で固定):
 *  (a) upstream open 前の browser メッセージは pending に積み、open で flush する。
 *  (b) upstream error → browser socket を close (RealtimeClient のバックオフ再接続に委ねる)。
 *  (c) どちらか close → 両方 close (half-open を残さない)。
 *  (d) config error (MissingRealtimeToken / InvalidUpstreamUrl) → browser を close し **throw しない**。
 *  (e) pending が件数/バイト上限を超過 → browser を safeClose (SEC-A DoS 緩和)。
 */
export function relayToUpstream(browserSocket: RelaySocket, opts: RelayOptions): void {
  const log = opts.log ?? ((m: string) => console.log(m));
  const logError = opts.logError ?? ((m: string) => console.error(m));

  let config: UpstreamConfig;
  try {
    config = resolveUpstreamConfig(opts.env ?? process.env);
  } catch (err) {
    if (isConfigError(err)) {
      // env 不備は err 名のみログ (値は出さない)。ブラウザを正常 close し再接続に委ねる。
      logError(`[bff] upstream config error: ${(err as Error).name}`);
      safeClose(browserSocket);
      return;
    }
    throw err; // 想定外は握り潰さない。
  }

  let upstream: RelaySocket;
  try {
    log(`[bff] relaying /realtime/ws -> ${redactUpstreamForLog(config.url)}`);
    upstream = opts.upstreamFactory(config);
  } catch {
    // factory 自体の失敗 (URL 構築不能等) も安全側に倒す: ブラウザを閉じ再接続へ。
    logError("[bff] upstream factory error; closing browser socket for reconnect");
    safeClose(browserSocket);
    return;
  }

  const pending: PendingFrame[] = [];
  let pendingBytes = 0;
  let upstreamOpen = false;

  // 片方 close/error で他方も閉じる (双方向の寿命を揃える / half-open を残さない)。
  const closeBoth = (): void => {
    safeClose(browserSocket);
    safeClose(upstream);
  };

  upstream.on("open", () => {
    upstreamOpen = true;
    // flush 時も各フレームの型 (text/binary) を保存して送る。
    for (const frame of pending) upstream.send(frame.data, { binary: frame.isBinary });
    pending.length = 0;
    pendingBytes = 0;
  });

  // browser -> upstream (isBinary を透過保存)
  browserSocket.on("message", (data: RelayData, isBinary: boolean) => {
    if (upstreamOpen) {
      upstream.send(data, { binary: isBinary });
      return;
    }
    // open 前: バッファ。件数/バイト上限超過は DoS とみなしブラウザを閉じる (SEC-A)。
    pending.push({ data, isBinary });
    pendingBytes += byteLength(data);
    if (pending.length > MAX_PENDING_MESSAGES || pendingBytes > MAX_PENDING_BYTES) {
      logError("[bff] pending buffer limit exceeded before upstream open; closing browser socket");
      closeBoth();
    }
  });

  // upstream -> browser (isBinary を透過保存: backend の text フレームを binary 化しない)
  upstream.on("message", (data: RelayData, isBinary: boolean) => {
    if (browserSocket.readyState === WS_OPEN) browserSocket.send(data, { binary: isBinary });
  });

  browserSocket.on("close", closeBoth);
  upstream.on("close", closeBoth);
  upstream.on("error", () => {
    logError("[bff] upstream socket error; closing browser socket for reconnect");
    closeBoth();
  });
  browserSocket.on("error", closeBoth);
}

/** OPEN/CONNECTING のときのみ close する (二重 close 競合を避ける)。 */
export function safeClose(socket: RelaySocket): void {
  if (socket.readyState === WS_OPEN || socket.readyState === WS_CONNECTING) {
    try {
      socket.close();
    } catch {
      // close 競合は無視 (既に閉じている)。
    }
  }
}
