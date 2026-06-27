/**
 * RealtimeClient の動作テスト (fake socket + fake timer, 実ブラウザ不要).
 * 検証: open→frame配送 / close→jitter backoff 再接続 / 再接続後の subscribe 自動再送 /
 * 上限到達で諦め / stop で再接続しない / 壊れフレームは捨てて接続維持。
 */
import { describe, expect, it, vi } from "vitest";

import { RealtimeClient, type SocketLike, type TimerLike } from "../src/realtime/client.js";
import { buildApproveFrame } from "../src/ui/approval-display.js";

import type { ClientFrame, ServerFrame } from "../src/realtime/contract.js";

class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  readonly sent: string[] = [];
  closed = false;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  /** test helper: simulate the transport handshake completing. */
  fireOpen(): void {
    this.onopen?.();
  }
  fireMessage(data: unknown): void {
    this.onmessage?.({ data });
  }
  fireClose(): void {
    this.onclose?.();
  }
}

/** 即時実行ではなく手動で進めるタイマー (backoff スケジュールを観測する)。 */
class ManualTimer implements TimerLike {
  private pending: Array<{ fn: () => void; ms: number }> = [];
  readonly delays: number[] = [];
  setTimeout(fn: () => void, ms: number): unknown {
    this.delays.push(ms);
    const handle = { fn, ms };
    this.pending.push(handle);
    return handle;
  }
  clearTimeout(handle: unknown): void {
    this.pending = this.pending.filter((h) => h !== handle);
  }
  /** 直近にスケジュールされたタイマーを発火する。 */
  flushNext(): void {
    const next = this.pending.shift();
    next?.fn();
  }
}

function makeClient(opts: {
  sockets: FakeSocket[];
  timer: TimerLike;
  onFrame?: (f: ServerFrame) => void;
  onGaveUp?: () => void;
  maxAttempts?: number;
}) {
  let i = 0;
  const client = new RealtimeClient({
    url: "ws://localhost:55400/realtime/ws",
    socketFactory: () => {
      const s = opts.sockets[i];
      i += 1;
      if (!s) throw new Error("ran out of fake sockets");
      return s;
    },
    timer: opts.timer,
    backoff: {
      baseMs: 500,
      factor: 2,
      capMs: 30_000,
      random: () => 1,
      maxAttempts: opts.maxAttempts ?? 12,
    },
    ...(opts.onFrame ? { onFrame: opts.onFrame } : {}),
    ...(opts.onGaveUp ? { onGaveUp: opts.onGaveUp } : {}),
  });
  return client;
}

describe("RealtimeClient", () => {
  it("does not embed any token in the URL (token stays server-side via BFF)", () => {
    const urls: string[] = [];
    const client = new RealtimeClient({
      url: "ws://localhost:55400/realtime/ws",
      socketFactory: (u) => {
        urls.push(u);
        return new FakeSocket();
      },
    });
    client.start();
    expect(urls[0]).toBe("ws://localhost:55400/realtime/ws");
    expect(urls[0]).not.toContain("token");
    expect(urls[0]).not.toContain("Bearer");
    client.stop();
  });

  it("delivers parsed frames and drops malformed ones while staying open", () => {
    const frames: ServerFrame[] = [];
    const s = new FakeSocket();
    const timer = new ManualTimer();
    const client = makeClient({ sockets: [s], timer, onFrame: (f) => frames.push(f) });
    client.start();
    s.fireOpen();
    expect(client.connectionStatus).toBe("open");
    s.fireMessage("{broken");
    s.fireMessage(JSON.stringify({ type: "delta.list", session: badItem() }));
    expect(frames).toHaveLength(0); // both dropped
    s.fireMessage(JSON.stringify({ type: "snapshot.list", sessions: [] }));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.type).toBe("snapshot.list");
    expect(client.connectionStatus).toBe("open"); // still open after garbage
  });

  it("reconnects with backoff on close and re-subscribes after reopen", () => {
    const s1 = new FakeSocket();
    const s2 = new FakeSocket();
    const timer = new ManualTimer();
    const client = makeClient({ sockets: [s1, s2], timer });
    client.start();
    s1.fireOpen();
    client.subscribe("sess-1");
    expect(JSON.parse(s1.sent[0] ?? "{}")).toMatchObject({
      type: "subscribe",
      session_id: "sess-1",
    });

    s1.fireClose();
    expect(client.connectionStatus).toBe("reconnecting");
    expect(timer.delays).toEqual([500]); // first backoff = base (random=1)

    timer.flushNext(); // fire reconnect → opens s2
    s2.fireOpen();
    expect(client.connectionStatus).toBe("open");
    // 再接続後に購読を自動再送している。
    expect(JSON.parse(s2.sent[0] ?? "{}")).toMatchObject({
      type: "subscribe",
      session_id: "sess-1",
    });
  });

  it("gives up after maxAttempts without infinite retry storm", () => {
    const sockets = Array.from({ length: 4 }, () => new FakeSocket());
    const timer = new ManualTimer();
    const gaveUp = vi.fn();
    const client = makeClient({ sockets, timer, onGaveUp: gaveUp, maxAttempts: 3 });
    client.start();
    sockets[0]!.fireOpen();
    // close 1 → schedule(attempt0), flush → open s2 fails immediately, etc.
    sockets[0]!.fireClose();
    timer.flushNext();
    sockets[1]!.fireClose();
    timer.flushNext();
    sockets[2]!.fireClose();
    timer.flushNext();
    sockets[3]!.fireClose(); // 4th close → backoff exhausted (maxAttempts=3)
    expect(gaveUp).toHaveBeenCalledTimes(1);
    expect(client.connectionStatus).toBe("closed");
  });

  it("stop() prevents any reconnect", () => {
    const s = new FakeSocket();
    const timer = new ManualTimer();
    const client = makeClient({ sockets: [s], timer });
    client.start();
    s.fireOpen();
    client.stop();
    expect(s.closed).toBe(true);
    s.fireClose(); // close after stop must not schedule reconnect
    expect(timer.delays).toHaveLength(0);
    expect(client.connectionStatus).toBe("closed");
  });

  it("does not send control frames while disconnected (no stale queue)", () => {
    const s = new FakeSocket();
    const timer = new ManualTimer();
    const client = makeClient({ sockets: [s], timer });
    client.start();
    // not opened yet
    const frame: ClientFrame = { type: "interrupt", session_id: "x" };
    client.send(frame);
    expect(s.sent).toHaveLength(0);
  });

  // ADR 019e9999 段階②: use-realtime.approve / interrupt が send する制御フレームの wire 形。
  // (フックの送信経路は buildApproveFrame → client.send。ここで実シリアライズを固定する。)
  it("serializes approve frame on the wire when connected (request_id 突合キー同梱)", () => {
    const s = new FakeSocket();
    const timer = new ManualTimer();
    const client = makeClient({ sockets: [s], timer });
    client.start();
    s.fireOpen();
    client.send(buildApproveFrame("sess-1", "req-1", "deny", "looks risky"));
    expect(JSON.parse(s.sent[0] ?? "{}")).toEqual({
      type: "approve",
      session_id: "sess-1",
      request_id: "req-1",
      decision: "deny",
      reason: "looks risky",
    });
  });

  it("serializes interrupt frame on the wire when connected", () => {
    const s = new FakeSocket();
    const timer = new ManualTimer();
    const client = makeClient({ sockets: [s], timer });
    client.start();
    s.fireOpen();
    client.send({ type: "interrupt", session_id: "sess-1" });
    expect(JSON.parse(s.sent[0] ?? "{}")).toEqual({ type: "interrupt", session_id: "sess-1" });
  });
});

/** session_id 以外を欠いた不正 list item (parse で弾かれるべき)。 */
function badItem(): Record<string, unknown> {
  return { session_id: "s1" };
}
