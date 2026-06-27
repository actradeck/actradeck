/**
 * 再接続バックオフの境界テスト (jitter / cap / 上限 / reset).
 * reconnect storm を避ける契約 (固定間隔でない・上限で諦める) を赤化可能に固定。
 */
import { describe, expect, it } from "vitest";

import { ReconnectBackoff } from "../src/realtime/backoff.js";

describe("ReconnectBackoff", () => {
  it("grows exponentially under full jitter upper bound (random=1 → upper)", () => {
    const b = new ReconnectBackoff({ baseMs: 500, factor: 2, capMs: 30_000, random: () => 1 });
    // random()=1 → jittered = floor(upper). upper = min(base*2^attempt, cap).
    expect(b.nextDelayMs()).toBe(500); // attempt 0: 500
    expect(b.nextDelayMs()).toBe(1000); // attempt 1: 1000
    expect(b.nextDelayMs()).toBe(2000); // attempt 2: 2000
    expect(b.nextDelayMs()).toBe(4000); // attempt 3
  });

  it("caps at capMs", () => {
    const b = new ReconnectBackoff({ baseMs: 1000, factor: 10, capMs: 5000, random: () => 1 });
    expect(b.nextDelayMs()).toBe(1000);
    expect(b.nextDelayMs()).toBe(5000); // 10_000 capped to 5000
    expect(b.nextDelayMs()).toBe(5000);
  });

  it("applies full jitter (random=0 → 0, random=0.5 → half of upper)", () => {
    const b0 = new ReconnectBackoff({ baseMs: 800, random: () => 0 });
    expect(b0.nextDelayMs()).toBe(0); // jitter can be 0 (desync)
    const bh = new ReconnectBackoff({ baseMs: 800, random: () => 0.5 });
    expect(bh.nextDelayMs()).toBe(400); // floor(0.5 * 800)
  });

  it("stops after maxAttempts (no infinite retry)", () => {
    const b = new ReconnectBackoff({ maxAttempts: 3, random: () => 0.5 });
    expect(b.nextDelayMs()).not.toBeNull();
    expect(b.nextDelayMs()).not.toBeNull();
    expect(b.nextDelayMs()).not.toBeNull();
    expect(b.canRetry).toBe(false);
    expect(b.nextDelayMs()).toBeNull(); // give up
    expect(b.attempts).toBe(3);
  });

  it("reset restores attempts to 0", () => {
    const b = new ReconnectBackoff({ random: () => 1 });
    b.nextDelayMs();
    b.nextDelayMs();
    expect(b.attempts).toBe(2);
    b.reset();
    expect(b.attempts).toBe(0);
    expect(b.nextDelayMs()).toBe(500);
  });
});
