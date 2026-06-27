/**
 * WS client 再送 (ネット断耐性) + output collector を実 WS sink で検証。
 *
 * - sink (VerificationWsSink) を後から起動 → WsClient が再接続して未送信を順序どおり flush。
 * - markSent 後は二度送らない (at-least-once + 冪等 event_id)。
 */
import { afterEach, describe, expect, it } from "vitest";

import { buildEvent } from "../src/event-factory.js";
import { OutputCollector } from "../src/output-collector.js";
import { SessionIdentity } from "../src/session-identity.js";
import { EventStore } from "../src/store.js";
import { VerificationWsSink } from "../src/ws-sink.js";
import { WsClient } from "../src/ws-client.js";

/** ADR 019e9462: 即確定 identity (explicit モード)。canonical = sessionId で固定。 */
function resolvedIdentity(sessionId: string): SessionIdentity {
  return new SessionIdentity({ fallbackSessionId: sessionId, explicitSessionId: sessionId });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let sink: VerificationWsSink | undefined;
let client: WsClient | undefined;
afterEach(async () => {
  client?.close();
  await sink?.close();
  sink = client = undefined;
});

describe("WsClient re-send after network outage", () => {
  it("buffers while offline and flushes in order on (re)connect", async () => {
    const store = new EventStore(":memory:");
    // 1) sink がまだ無い状態でイベントを積む (ネット断相当)。
    for (let i = 0; i < 3; i++) {
      store.append(
        buildEvent({
          session_id: "s1",
          event_type: "heartbeat",
          summary: `h${i}`,
          payload: { kind: "heartbeat" },
        }),
      );
    }
    expect(store.unsentCount()).toBe(3);

    // 2) sink を起動し、その URL へ接続。
    sink = new VerificationWsSink();
    const port = await sink.listen();
    client = new WsClient({ url: `ws://127.0.0.1:${port}`, store, reconnectBaseMs: 20 });
    client.connect();

    // 3) flush 完了を待つ。
    for (let i = 0; i < 50 && sink.received.length < 3; i++) await sleep(20);
    expect(sink.received.length).toBe(3);
    expect(sink.received.map((r) => (r.event as { summary: string }).summary)).toEqual([
      "h0",
      "h1",
      "h2",
    ]);
    expect(store.unsentCount()).toBe(0);

    // 4) 追加イベントは接続中なので即送信。重複送信なし。
    store.append(
      buildEvent({
        session_id: "s1",
        event_type: "heartbeat",
        summary: "h3",
        payload: { kind: "heartbeat" },
      }),
    );
    client.notifyAppended();
    for (let i = 0; i < 50 && sink.received.length < 4; i++) await sleep(20);
    expect(sink.received.length).toBe(4);
    store.close();
  });
});

describe("OutputCollector → command.output.delta", () => {
  it("emits buffered PTY output as command.output.delta", async () => {
    const events: ReturnType<typeof buildEvent>[] = [];
    const collector = new OutputCollector({
      identity: resolvedIdentity("s1"),
      flushMs: 10,
      onEvent: (e) => events.push(e),
    });
    collector.push("line1\n");
    collector.push("line2\n");
    await sleep(30);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]!.event_type).toBe("command.output.delta");
    expect(events[0]!.payload.stream).toBe("stdout");
    expect(collector.totalBytes).toBe(Buffer.byteLength("line1\nline2\n"));
    collector.stop();
  });

  it("flushes immediately when buffer exceeds maxChunk", () => {
    const events: ReturnType<typeof buildEvent>[] = [];
    const collector = new OutputCollector({
      identity: resolvedIdentity("s1"),
      maxChunk: 8,
      onEvent: (e) => events.push(e),
    });
    collector.push("0123456789"); // > 8
    expect(events.length).toBe(1);
    collector.stop();
  });
});
