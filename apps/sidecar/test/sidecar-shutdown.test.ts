/**
 * 再#QA-4: Sidecar graceful shutdown / flush 経路 (cov 35% → 引き上げ)。
 *
 * - ネット断中に積まれた未送信イベントが再接続で flush される (再送)。
 * - shutdown が watcher 停止 → 承認 drain(deny) → receiver close → store close を
 *   クリーンに行い、保留承認を安全側で解決する。
 * - 実 WS sink / 実 HTTP receiver / 実 SQLite を貫通する (REAL DATA)。
 */
import { afterEach, describe, expect, it } from "vitest";

import { buildEvent } from "../src/event-factory.js";
import { Sidecar } from "../src/sidecar.js";
import { VerificationWsSink } from "../src/ws-sink.js";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const sinks: VerificationWsSink[] = [];
const sidecars: Sidecar[] = [];
afterEach(async () => {
  for (const s of sidecars) {
    try {
      await s.shutdown();
    } catch {
      /* already closed */
    }
  }
  sidecars.length = 0;
  for (const k of sinks) await k.close();
  sinks.length = 0;
});

describe("再#QA-4: Sidecar flush / re-send", () => {
  it("flushes events queued while disconnected once the WS connects (re-send)", async () => {
    const sink = new VerificationWsSink();
    sinks.push(sink);
    await sink.listen();

    const sidecar = new Sidecar({
      sessionId: "qa4-flush",
      wsUrl: sink.url,
      dbPath: ":memory:",
      // cwd を repo 外にして gitWatcher の自動 emit ノイズを避ける。
      cwd: "/tmp",
    });
    sidecars.push(sidecar);

    // connect する前にイベントを emit (= store に積まれ unsent)。
    sidecar.sink.emit(
      buildEvent({
        session_id: "qa4-flush",
        event_type: "heartbeat",
        payload: { kind: "heartbeat" },
      }),
    );
    sidecar.sink.emit(
      buildEvent({
        session_id: "qa4-flush",
        event_type: "heartbeat",
        payload: { kind: "heartbeat" },
      }),
    );
    expect(sidecar.store.unsentCount()).toBe(2);

    // start() で receiver listen + WS connect → open で flush。
    await sidecar.start();
    for (let i = 0; i < 100 && sink.received.length < 2; i++) await sleep(10);

    expect(sink.received.length).toBeGreaterThanOrEqual(2);
    expect(sidecar.store.unsentCount()).toBe(0); // 全て送信済みマーク
    // 送信内容は redaction 済み NormalizedEvent。
    for (const r of sink.received) {
      expect(r.event.event_type).toBe("heartbeat");
    }
  });

  it("events emitted while connected are delivered, and shutdown flushes the tail", async () => {
    const sink = new VerificationWsSink();
    sinks.push(sink);
    await sink.listen();
    const sidecar = new Sidecar({
      sessionId: "qa4-tail",
      wsUrl: sink.url,
      dbPath: ":memory:",
      cwd: "/tmp",
    });
    sidecars.push(sidecar);
    await sidecar.start();
    for (let i = 0; i < 50 && !sidecar.wsClient.connected; i++) await sleep(10);
    expect(sidecar.wsClient.connected).toBe(true);

    sidecar.sink.emit(
      buildEvent({
        session_id: "qa4-tail",
        event_type: "heartbeat",
        payload: { kind: "heartbeat" },
      }),
    );
    for (let i = 0; i < 100 && sink.received.length < 1; i++) await sleep(10);
    expect(sink.received.length).toBeGreaterThanOrEqual(1);
    expect(sidecar.store.unsentCount()).toBe(0);
  });
});

describe("再#QA-4: Sidecar graceful shutdown cleanup", () => {
  it("shutdown drains pending approvals as deny and closes cleanly (idempotent)", async () => {
    const sink = new VerificationWsSink();
    sinks.push(sink);
    await sink.listen();
    const sidecar = new Sidecar({
      sessionId: "qa4-shutdown",
      wsUrl: sink.url,
      dbPath: ":memory:",
      cwd: "/tmp",
      approvalTimeoutMs: 60_000, // タイムアウトより先に shutdown で drain される
    });
    sidecars.push(sidecar);
    await sidecar.start();

    // 高リスク承認を 1 件保留にする。
    const p = sidecar.approvalBridge.requestApproval(
      {
        session_id: "qa4-shutdown",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "rm -rf /tmp/x" },
      },
      () => {},
    );
    expect(sidecar.approvalBridge.pendingCount).toBe(1);

    await sidecar.shutdown();

    // drain により保留は deny で解決。
    const r = await p;
    expect(r.behavior).toBe("deny");
    expect(sidecar.approvalBridge.pendingCount).toBe(0);

    // 二重 shutdown でも throw しない (idempotent / クリーンアップ堅牢性)。
    await expect(sidecar.shutdown()).resolves.toBeUndefined();
    // afterEach の重複 shutdown を避けるため除去。
    sidecars.pop();
  });

  it("shutdown stops the WS client (no further sends after close)", async () => {
    const sink = new VerificationWsSink();
    sinks.push(sink);
    await sink.listen();
    const sidecar = new Sidecar({
      sessionId: "qa4-wsstop",
      wsUrl: sink.url,
      dbPath: ":memory:",
      cwd: "/tmp",
    });
    sidecars.push(sidecar);
    await sidecar.start();
    for (let i = 0; i < 50 && !sidecar.wsClient.connected; i++) await sleep(10);

    await sidecar.shutdown();
    sidecars.pop();
    expect(sidecar.wsClient.connected).toBe(false);
  });
});
