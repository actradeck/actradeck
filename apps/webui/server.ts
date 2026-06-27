/**
 * ActraDeck WebUI — Next.js 16 custom server (BFF for realtime WS).
 *
 * 目的 (ADR 019e92b7): ブラウザは same-origin で `ws(s)://<webui>/realtime/ws` に繋ぎ、この custom
 * server だけが REALTIME_TOKEN を server env から読んで backend `/realtime/ws` へ
 * `Authorization: Bearer` を付けて中継する。**token はブラウザに一切渡さない**
 * (NEXT_PUBLIC_ にしない・HTML/JS バンドルに出さない・ログに出さない)。
 *
 * なぜ custom server か:
 *  - backend `/realtime/ws` は upgrade 前に Bearer を要求するが (realtime-server.ts)、ブラウザ
 *    native WebSocket はカスタムヘッダを付けられない。BFF が server-side で Bearer を吸収する。
 *  - Next.js 16 の Route Handler は serverless 想定で long-lived WS upgrade を保持できない
 *    (WebSearch 確認)。custom server + `ws` の `noServer` upgrade が標準解。
 *
 * HMR との共存 (重要な落とし穴): 同一ポートで別 WS サーバを動かすと Next の `/_next/webpack-hmr`
 * が壊れる (WebSearch)。そのため **`/realtime/ws` だけ**を掴み、それ以外の upgrade は必ず
 * `app.getUpgradeHandler()` へ委ねる。
 *
 * このファイルは apps/webui/ 直下 = INV-TOKEN-ISOLATION の BROWSER_GLOBS (ui/ realtime/ app) の
 * 外なので bff.ts を value-import してよい (唯一の正規 relay 配線点)。
 *
 * --- 起動手順 (実ライブ疎通) ---
 * 実データ疎通には PostgreSQL + backend (ingestion/realtime) + 実 sidecar が必要:
 *   1. cp .env.example .env し REALTIME_TOKEN / BACKEND_REALTIME_WS_URL を設定。
 *   2. pnpm db:migrate でスキーマ適用、backend を起動 (/realtime/ws を mount)。
 *   3. sidecar を実 Claude Code hooks に接続しイベントを流す。
 *   4. pnpm --filter @actradeck/webui run dev  (= tsx server.ts, :55400)。
 *      本番は pnpm --filter @actradeck/webui run build → run start。
 *   ブラウザ http://localhost:55400 が same-origin /realtime/ws 経由で実 session を購読する。
 */
import { createServer } from "node:http";

import next from "next";
import { WebSocket, WebSocketServer } from "ws";

import { relayToUpstream, type RelaySocket, type UpstreamFactory } from "./src/server/relay.js";
import { proxyReplayHistory, shouldProxyReplayRequest } from "./src/server/replay-proxy.js";
import {
  REALTIME_WS_PATH,
  resolveBindHost,
  resolveWebuiPort,
  shouldRelayUpgrade,
} from "./src/server/upgrade-routing.js";

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

const dev = process.env.NODE_ENV !== "production";
const port = resolveWebuiPort();
const host = resolveBindHost();

const app = next({ dev });

/**
 * SEC-A (audit a2626d5e): upstream payload 上限。backend 由来の巨大フレームでメモリを食わない
 * よう sane な maxPayload を設定する (realtime のイベント JSON は十分この内側)。
 */
const MAX_WS_PAYLOAD = 1 << 20; // 1 MiB

/**
 * 実 backend へ繋ぐ upstream factory。relay core は config 解決済みの URL/headers を渡してくるので、
 * ここは `ws` の WebSocket を生成するだけ。token は config.headers にのみ載り、ここでは触れない。
 * `ws` の WebSocket は RelaySocket を構造的に充足する。
 */
const wsUpstreamFactory: UpstreamFactory = (config) =>
  new WebSocket(config.url, { headers: config.headers, maxPayload: MAX_WS_PAYLOAD }) as RelaySocket;

async function main(): Promise<void> {
  await app.prepare();

  // getRequestHandler / getUpgradeHandler は prepare() 完了後にのみ取得できる
  // (Next の API 契約: prepare 前に呼ぶと "prepare() must be called before" で throw)。
  const handle = app.getRequestHandler();
  const upgradeHandler = app.getUpgradeHandler();

  const server = createServer((req, res) => {
    if (shouldProxyReplayRequest(req.url)) {
      void proxyReplayHistory(req, res);
      return;
    }
    handle(req, res);
  });

  // `ws` の noServer モード: HTTP server の upgrade を自分でルーティングし、対象だけ handleUpgrade。
  // SEC-A: maxPayload を設定し巨大ブラウザフレームでメモリを食わせない。
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (shouldRelayUpgrade(req.url)) {
      // /realtime/ws のみ BFF が掴む。ブラウザ socket を確立してから upstream へ中継。
      wss.handleUpgrade(req, socket, head, (browserSocket) => {
        relayToUpstream(browserSocket as RelaySocket, { upstreamFactory: wsUpstreamFactory });
      });
      return;
    }
    // それ以外 (Next の HMR = /_next/webpack-hmr 等) は必ず Next に委ねる。
    // 委ねないと dev の HMR WebSocket が pending になる (WebSearch の既知落とし穴)。
    void upgradeHandler(req, socket, head);
  });

  // SEC-A: host を既定 127.0.0.1 (loopback)。env 明示時のみ LAN bind。
  server.listen(port, host, () => {
    console.log(`[webui] ready on http://${host}:${port} (dev=${dev})`);
    console.log(`[webui] realtime BFF relaying ${REALTIME_WS_PATH} (token server-side only)`);
  });
}

main().catch((err) => {
  console.error("[webui] fatal:", (err as Error).message);
  process.exit(1);
});
