/**
 * BFF relay core の契約検証 (TDA-3 / =QA-1/QA-3, audit a84a090c/ad14a947).
 *
 * upstream 接続を factory 注入にして実 backend 無しで赤化する。契約 (T1):
 *  (a) upstream open 前の browser メッセージは buffer され open 後 flush。
 *  (b) upstream error → browser socket close (再接続契約)。
 *  (c) どちらか close → 両方 close (half-open 無し)。
 *  (d) config error (MissingRealtimeToken / InvalidUpstreamUrl) → browser close・throw しない。
 *  (e) SEC-A: pending 上限超過 → browser close。
 *
 * 各々を mutation で赤化確認済み (返り値レポート参照)。
 */
import { describe, expect, it, vi } from "vitest";

import {
  MAX_PENDING_BYTES,
  MAX_PENDING_MESSAGES,
  relayToUpstream,
  WS_CONNECTING,
  WS_OPEN,
  type RelayData,
  type RelaySocket,
  type RelayOptions,
} from "../src/server/relay.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 各 overload を受ける実装側シグネチャ
type Listener = (...args: any[]) => void;

/** 手動でイベントを emit できる fake RelaySocket (実 ws 不要)。 */
class FakeSocket implements RelaySocket {
  readyState = WS_CONNECTING;
  readonly sent: RelayData[] = [];
  /** sent[i] と同 index で、その送信が binary フレーム指定だったか (text=false)。 */
  readonly sentBinary: boolean[] = [];
  closeCount = 0;
  private readonly listeners = new Map<string, Listener[]>();

  send(data: RelayData, opts?: { binary?: boolean }): void {
    this.sent.push(data);
    // ws の send(data, { binary }) と同義: binary 未指定は ws 既定 (text=false 相当) に倒す。
    this.sentBinary.push(opts?.binary === true);
  }
  close(): void {
    this.closeCount += 1;
    this.readyState = 3; // CLOSED
  }
  on(event: "open", listener: () => void): void;
  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "message", listener: (data: RelayData, isBinary: boolean) => void): void;
  on(event: string, listener: Listener): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(listener);
    this.listeners.set(event, arr);
  }
  /** message は (data, isBinary) を渡せる。他イベントは arg 単独で互換。 */
  emit(event: string, arg?: unknown, isBinary?: boolean): void {
    for (const l of this.listeners.get(event) ?? []) {
      if (event === "message") l(arg, isBinary ?? false);
      else l(arg);
    }
  }
}

const VALID_ENV = {
  REALTIME_TOKEN: "t0ken",
  BACKEND_REALTIME_WS_URL: "ws://127.0.0.1:8787/realtime/ws",
};

/** factory が返す upstream を捕捉できるようにした共通セットアップ。 */
function setup(opts?: Partial<RelayOptions>): {
  browser: FakeSocket;
  upstream: FakeSocket;
  logError: ReturnType<typeof vi.fn>;
} {
  const browser = new FakeSocket();
  browser.readyState = WS_OPEN;
  const upstream = new FakeSocket();
  upstream.readyState = WS_CONNECTING;
  const logError = vi.fn();
  relayToUpstream(browser, {
    env: VALID_ENV,
    upstreamFactory: () => upstream,
    log: () => {},
    logError,
    ...opts,
  });
  return { browser, upstream, logError };
}

describe("relayToUpstream (a) open 前 buffer → open 後 flush", () => {
  it("buffers browser messages until upstream open, then flushes in order", () => {
    const { browser, upstream } = setup();
    // open 前に 2 件届く → upstream へは未送信 (buffer)。
    browser.emit("message", Buffer.from("a"));
    browser.emit("message", Buffer.from("b"));
    expect(upstream.sent).toEqual([]); // open 前は送らない

    upstream.readyState = WS_OPEN;
    upstream.emit("open");
    expect(upstream.sent.map((d) => (d as Buffer).toString())).toEqual(["a", "b"]); // flush 順序保持

    // open 後はバッファせず即送信。
    browser.emit("message", Buffer.from("c"));
    expect(upstream.sent.map((d) => (d as Buffer).toString())).toEqual(["a", "b", "c"]);
  });

  it("upstream -> browser forwards only when browser is OPEN", () => {
    const { browser, upstream } = setup();
    upstream.emit("message", Buffer.from("x"));
    expect(browser.sent.map((d) => (d as Buffer).toString())).toEqual(["x"]);
    browser.readyState = 3; // CLOSED
    upstream.emit("message", Buffer.from("y"));
    expect(browser.sent.length).toBe(1); // closed browser には送らない
  });
});

describe("relayToUpstream (f) フレーム型 (text/binary) を透過保存する", () => {
  /**
   * 回帰 (decision 019e9905, supersedes 019e98fc):
   * backend realtime-server.ts は snapshot.list を **テキストフレーム** (string) で送る。
   * `ws` は text フレームでも message listener に Buffer + isBinary=false を渡す。
   * relay が isBinary を保存せず `send(Buffer)` すると `ws` は **binary フレーム**として送出し、
   * ブラウザは `ev.data` が Blob になり client.ts:148 で `typeof !== "string"` 破棄 → 一覧が空。
   * relay は isBinary を `send(data, { binary: isBinary })` で透過保存しなければならない。
   */
  it("upstream -> browser: text frame (isBinary=false) stays text", () => {
    const { browser, upstream } = setup();
    upstream.emit("message", Buffer.from('{"type":"snapshot.list","sessions":[]}'), false);
    expect(browser.sent.length).toBe(1);
    expect(browser.sentBinary[0]).toBe(false); // text のまま転送 (binary 化しない)
  });

  it("upstream -> browser: binary frame (isBinary=true) stays binary", () => {
    const { browser, upstream } = setup();
    upstream.emit("message", Buffer.from([0x01, 0x02]), true);
    expect(browser.sent.length).toBe(1);
    expect(browser.sentBinary[0]).toBe(true); // binary は binary のまま
  });

  it("browser -> upstream (open 後): text frame stays text", () => {
    const { browser, upstream } = setup();
    upstream.readyState = WS_OPEN;
    upstream.emit("open");
    browser.emit("message", Buffer.from('{"type":"subscribe"}'), false);
    expect(upstream.sent.length).toBe(1);
    expect(upstream.sentBinary[0]).toBe(false);
  });

  it("browser -> upstream (open 後): binary frame stays binary", () => {
    const { browser, upstream } = setup();
    upstream.readyState = WS_OPEN;
    upstream.emit("open");
    browser.emit("message", Buffer.from([0xff]), true);
    expect(upstream.sent.length).toBe(1);
    expect(upstream.sentBinary[0]).toBe(true);
  });

  it("browser -> upstream: pending flush preserves per-frame text/binary type", () => {
    const { browser, upstream } = setup();
    // open 前に text と binary が混在 → pending に積まれる。
    browser.emit("message", Buffer.from("text-a"), false);
    browser.emit("message", Buffer.from([0x00]), true);
    expect(upstream.sent).toEqual([]); // open 前は未送信

    upstream.readyState = WS_OPEN;
    upstream.emit("open");
    // flush 時に各フレームの型 (text/binary) が個別に保存される。
    expect(upstream.sent.length).toBe(2);
    expect(upstream.sentBinary).toEqual([false, true]);
  });
});

describe("relayToUpstream (b) upstream error → browser close", () => {
  it("closes both sockets on upstream error (reconnect contract)", () => {
    const { browser, upstream, logError } = setup();
    upstream.readyState = WS_OPEN;
    upstream.emit("error", new Error("ECONNREFUSED"));
    expect(browser.closeCount).toBeGreaterThan(0);
    expect(upstream.closeCount).toBeGreaterThan(0);
    expect(logError).toHaveBeenCalled();
  });
});

describe("relayToUpstream (c) どちらか close → 両方 close", () => {
  it("browser close closes upstream too", () => {
    const { browser, upstream } = setup();
    upstream.readyState = WS_OPEN;
    browser.emit("close");
    expect(upstream.closeCount).toBeGreaterThan(0);
  });

  it("upstream close closes browser too", () => {
    const { browser, upstream } = setup();
    upstream.readyState = WS_OPEN;
    upstream.emit("close");
    expect(browser.closeCount).toBeGreaterThan(0);
  });

  it("browser error closes both", () => {
    const { browser, upstream } = setup();
    upstream.readyState = WS_OPEN;
    browser.emit("error", new Error("boom"));
    expect(browser.closeCount).toBeGreaterThan(0);
    expect(upstream.closeCount).toBeGreaterThan(0);
  });
});

describe("relayToUpstream (d) config error → browser close, no throw", () => {
  it("MissingRealtimeToken: closes browser, does not throw, never builds upstream", () => {
    const browser = new FakeSocket();
    browser.readyState = WS_OPEN;
    const factory = vi.fn();
    const logError = vi.fn();
    expect(() =>
      relayToUpstream(browser, {
        env: {}, // REALTIME_TOKEN 無し
        upstreamFactory: factory,
        log: () => {},
        logError,
      }),
    ).not.toThrow();
    expect(browser.closeCount).toBeGreaterThan(0);
    expect(factory).not.toHaveBeenCalled(); // upstream を作らない
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("MissingRealtimeToken"));
  });

  it("InvalidUpstreamUrl: closes browser, does not throw", () => {
    const browser = new FakeSocket();
    browser.readyState = WS_OPEN;
    const factory = vi.fn();
    const logError = vi.fn();
    expect(() =>
      relayToUpstream(browser, {
        env: { REALTIME_TOKEN: "t", BACKEND_REALTIME_WS_URL: "http://nope/realtime/ws" },
        upstreamFactory: factory,
        log: () => {},
        logError,
      }),
    ).not.toThrow();
    expect(browser.closeCount).toBeGreaterThan(0);
    expect(factory).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("InvalidUpstreamUrl"));
  });
});

describe("relayToUpstream (e) SEC-A pending 上限超過 → browser close", () => {
  it("closes when pending message COUNT exceeds MAX_PENDING_MESSAGES (upstream never opens)", () => {
    const browser = new FakeSocket();
    browser.readyState = WS_OPEN;
    const up = new FakeSocket(); // open しない
    const logError = vi.fn();
    relayToUpstream(browser, {
      env: VALID_ENV,
      upstreamFactory: () => up,
      log: () => {},
      logError,
    });
    // 1 バイトずつ MAX+1 件 → 件数超過 (バイト上限には届かない)。
    for (let i = 0; i < MAX_PENDING_MESSAGES + 1; i++) browser.emit("message", Buffer.from("x"));
    expect(browser.closeCount).toBeGreaterThan(0);
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("pending buffer limit"));
  });

  it("closes when pending BYTES exceed MAX_PENDING_BYTES even with few messages", () => {
    const browser = new FakeSocket();
    browser.readyState = WS_OPEN;
    const up = new FakeSocket();
    const logError = vi.fn();
    relayToUpstream(browser, {
      env: VALID_ENV,
      upstreamFactory: () => up,
      log: () => {},
      logError,
    });
    browser.emit("message", Buffer.alloc(MAX_PENDING_BYTES + 1)); // 1 件でバイト超過
    expect(browser.closeCount).toBeGreaterThan(0);
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("pending buffer limit"));
  });

  it("does NOT close when pending stays within both limits", () => {
    const browser = new FakeSocket();
    browser.readyState = WS_OPEN;
    const up = new FakeSocket();
    relayToUpstream(browser, {
      env: VALID_ENV,
      upstreamFactory: () => up,
      log: () => {},
      logError: () => {},
    });
    for (let i = 0; i < MAX_PENDING_MESSAGES; i++) browser.emit("message", Buffer.from("x"));
    expect(browser.closeCount).toBe(0); // 上限以内は閉じない
  });

  it("counts fragmented Buffer[] payload bytes toward the byte limit", () => {
    const browser = new FakeSocket();
    browser.readyState = WS_OPEN;
    const up = new FakeSocket();
    const logError = vi.fn();
    relayToUpstream(browser, {
      env: VALID_ENV,
      upstreamFactory: () => up,
      log: () => {},
      logError,
    });
    // Buffer[] (fragmented frame) の合計バイトでも上限判定が効くこと。
    const half = Buffer.alloc(MAX_PENDING_BYTES / 2 + 1);
    browser.emit("message", [half, half]);
    expect(browser.closeCount).toBeGreaterThan(0);
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("pending buffer limit"));
  });
});

describe("relayToUpstream: upstream factory throw → browser close, no throw", () => {
  it("closes browser and logs when the factory itself throws (defensive)", () => {
    const browser = new FakeSocket();
    browser.readyState = WS_OPEN;
    const logError = vi.fn();
    expect(() =>
      relayToUpstream(browser, {
        env: VALID_ENV,
        upstreamFactory: () => {
          throw new Error("dial failed");
        },
        log: () => {},
        logError,
      }),
    ).not.toThrow();
    expect(browser.closeCount).toBeGreaterThan(0);
    expect(logError).toHaveBeenCalledWith(expect.stringContaining("upstream factory error"));
  });
});
