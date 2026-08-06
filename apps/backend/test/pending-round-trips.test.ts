/**
 * PendingRoundTrips<T> — 制御チャネル round-trip envelope 単一出所の unit
 * (TDA-1 M・decision 019f4241 の抽出着地)。
 *
 * sidecar-registry の 4 面 (diff/allowlist/policy/spawn) が共有する envelope 意味論を
 * falsifiable に固定する。各挙動は抽出前の 4 実装と同一 (変更しないこと):
 *  - timeout: 満了で先に delete → timeoutResult() で解決 (以後の settle は黙殺)。
 *  - settle: clearTimeout + delete (満了しても二重解決しない)・未知 id は undefined。
 *  - abort: send 失敗経路の即時解決 (未知 id は no-op)。
 *  - rejectAll: dispose で全 pending を shutdown 値で解決し clear。
 * 既存の per-type INV (inv-detail-diff-lifecycle / inv-allowlist-relay / inv-policy-relay /
 * inv-codex-spawn-relay) が統合面の安全網。
 */
import { describe, expect, it, vi } from "vitest";

import { PendingRoundTrips } from "../src/pending-round-trips.js";

type R = { ok: boolean; error?: string };

describe("PendingRoundTrips (envelope 単一出所)", () => {
  it("timeout 満了で delete → timeoutResult で解決し、以後の settle は黙殺する", () => {
    vi.useFakeTimers();
    try {
      const p = new PendingRoundTrips<R>(50);
      const results: R[] = [];
      p.register(
        "r1",
        (r) => results.push(r),
        () => ({ ok: false, error: "timed out" }),
      );
      expect(p.size).toBe(1);
      vi.advanceTimersByTime(60);
      expect(results).toEqual([{ ok: false, error: "timed out" }]);
      expect(p.size).toBe(0);
      // 満了後の応答 (遅延到達) は未知 id として黙殺 = 二重解決しない。
      expect(p.settle("r1")).toBeUndefined();
      expect(results.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settle は clearTimeout + delete して resolver を返す (満了しても二重解決しない)", () => {
    vi.useFakeTimers();
    try {
      const p = new PendingRoundTrips<R>(50);
      const results: R[] = [];
      p.register(
        "r1",
        (r) => results.push(r),
        () => ({ ok: false, error: "timed out" }),
      );
      const resolve = p.settle("r1");
      expect(resolve).toBeDefined();
      resolve!({ ok: true });
      expect(p.size).toBe(0);
      // タイマは解除済み: 満了時刻を過ぎても timeout 解決は走らない。
      vi.advanceTimersByTime(100);
      expect(results).toEqual([{ ok: true }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("未知 id の settle は undefined (二重応答・タイムアウト済の黙殺)", () => {
    const p = new PendingRoundTrips<R>(1_000);
    expect(p.settle("unknown")).toBeUndefined();
  });

  it("abort (send 失敗経路) は即時解決 + 破棄・未知 id は no-op", () => {
    vi.useFakeTimers();
    try {
      const p = new PendingRoundTrips<R>(50);
      const results: R[] = [];
      p.register(
        "r1",
        (r) => results.push(r),
        () => ({ ok: false, error: "timed out" }),
      );
      p.abort("r1", { ok: false, error: "relay send failed" });
      expect(results).toEqual([{ ok: false, error: "relay send failed" }]);
      expect(p.size).toBe(0);
      // 満了しても二重解決しない。
      vi.advanceTimersByTime(100);
      expect(results.length).toBe(1);
      // 未知 id は no-op (throw しない)。
      expect(() => p.abort("unknown", { ok: false })).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejectAll (dispose) は全 pending を shutdown 値で解決し clear する (タイマも解除)", () => {
    vi.useFakeTimers();
    try {
      const p = new PendingRoundTrips<R>(50);
      const results: R[] = [];
      p.register(
        "r1",
        (r) => results.push(r),
        () => ({ ok: false, error: "timed out" }),
      );
      p.register(
        "r2",
        (r) => results.push(r),
        () => ({ ok: false, error: "timed out" }),
      );
      expect(p.size).toBe(2);
      p.rejectAll(() => ({ ok: false, error: "server shutting down" }));
      expect(results).toEqual([
        { ok: false, error: "server shutting down" },
        { ok: false, error: "server shutting down" },
      ]);
      expect(p.size).toBe(0);
      // shutdown 後にタイマが走って二重解決しない。
      vi.advanceTimersByTime(100);
      expect(results.length).toBe(2);
      // factory は entry ごとに呼ばれ、新しい値を返す (共有 mutation を作らない)。
      expect(results[0]).not.toBe(results[1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("size は register/settle/timeout/rejectAll のすべてで正しく増減する", () => {
    vi.useFakeTimers();
    try {
      const p = new PendingRoundTrips<R>(50);
      p.register(
        "a",
        () => undefined,
        () => ({ ok: false }),
      );
      p.register(
        "b",
        () => undefined,
        () => ({ ok: false }),
      );
      p.register(
        "c",
        () => undefined,
        () => ({ ok: false }),
      );
      expect(p.size).toBe(3);
      p.settle("a");
      expect(p.size).toBe(2);
      vi.advanceTimersByTime(60); // b/c timeout
      expect(p.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("QA-1: timer.unref の pin (shutdown 衛生・mutation survivor の閉塞)", () => {
  it("register が武装する timer は unref される (dispose 忘れでも event loop を掴まない)", () => {
    // fake timers では unref の有無が観測不能 (event loop 保持を元々バイパスする) ため、
    // real timer + globalThis.setTimeout wrap で返り timer の unref 呼び出しを spy する。
    const realSetTimeout = globalThis.setTimeout;
    const unrefSpies: Array<ReturnType<typeof vi.fn>> = [];
    const wrapped = ((fn: () => void, ms?: number) => {
      const timer = realSetTimeout(fn, ms);
      const spy = vi.fn(() => timer.unref());
      unrefSpies.push(spy);
      return new Proxy(timer, {
        get(target, prop, receiver) {
          if (prop === "unref") return spy;
          const v = Reflect.get(target, prop, receiver);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
    }) as typeof globalThis.setTimeout;
    globalThis.setTimeout = wrapped;
    try {
      const p = new PendingRoundTrips<R>(5_000);
      p.register(
        "r1",
        () => undefined,
        () => ({ ok: false }),
      );
      expect(unrefSpies.length).toBe(1);
      expect(unrefSpies[0]).toHaveBeenCalledTimes(1);
      // armed な real timer を掃く (テストプロセスを保持させない)。
      p.rejectAll(() => ({ ok: false }));
      expect(p.size).toBe(0);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });
});
