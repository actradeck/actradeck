/**
 * 検証用の最小 WS sink (backend Phase 3 未完の代替)。
 *
 * Sidecar の WsClient が送るイベントを受け、メモリに溜める。E2E 検証で「正規化→redaction
 * →SQLite→WS sink まで貫通」したことを確認するために使う。本番 backend ではない。
 *
 * 承認ブリッジ検証用に、接続クライアントへ approval/interrupt メッセージを送れる。
 */
import { type AddressInfo } from "node:net";

import { WebSocketServer, type WebSocket } from "ws";

export interface SinkReceived {
  readonly raw: string;
  readonly event: Record<string, unknown>;
}

export class VerificationWsSink {
  private wss: WebSocketServer | undefined;
  private readonly clients = new Set<WebSocket>();
  readonly received: SinkReceived[] = [];
  /** TDA-2 (egress): 受信した hello handshake フレーム (検証用; event とは分離)。 */
  readonly helloFrames: Record<string, unknown>[] = [];
  private boundPort = 0;

  listen(port = 0, host = "127.0.0.1"): Promise<number> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ port, host });
      wss.on("error", reject);
      wss.on("listening", () => {
        const addr = wss.address() as AddressInfo;
        this.boundPort = addr.port;
        this.wss = wss;
        resolve(this.boundPort);
      });
      wss.on("connection", (ws) => {
        this.clients.add(ws);
        ws.on("message", (data: Buffer) => {
          const raw = data.toString("utf8");
          let event: Record<string, unknown> = {};
          try {
            event = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            /* keep raw only */
          }
          // TDA-2 (egress): 本番 backend と同様に hello handshake フレームは event として
          // 記録しない (isHelloFrame 相当)。received は redaction 済 NormalizedEvent のみ。
          if (event["type"] === "hello") {
            this.helloFrames.push(event);
            return;
          }
          this.received.push({ raw, event });
        });
        ws.on("close", () => this.clients.delete(ws));
      });
    });
  }

  get port(): number {
    return this.boundPort;
  }

  get url(): string {
    return `ws://127.0.0.1:${this.boundPort}`;
  }

  /** 接続中の全クライアントへ承認決定 / interrupt を送る (承認ブリッジ検証用)。 */
  broadcast(msg: unknown): void {
    const payload = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(payload);
    }
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      for (const ws of this.clients) ws.terminate();
      this.clients.clear();
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
  }
}
