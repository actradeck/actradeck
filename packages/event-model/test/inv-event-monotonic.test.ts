/**
 * INV-EVENT-MONOTONIC: 同一 session 内の timestamp 単調性を強制する。
 *
 * 契約 (T1):
 * - 同一 session で timestamp は非減少 (>=)。同時刻 (=) は at-least-once 再送のため許容。
 * - 時間の巻き戻り (<) は違反。
 * - セッション間は独立 (別 session の時刻は干渉しない)。
 * - 無効な timestamp は違反扱い。
 */
import { describe, expect, it } from "vitest";

import { MonotonicTimestampChecker, isMonotonicNonDecreasing } from "../src/index.js";

describe("INV-EVENT-MONOTONIC", () => {
  it("accepts strictly increasing timestamps in a session", () => {
    const c = new MonotonicTimestampChecker();
    expect(c.accept("s1", "2026-05-30T12:00:00.000Z")).toBe(true);
    expect(c.accept("s1", "2026-05-30T12:00:01.000Z")).toBe(true);
    expect(c.accept("s1", "2026-05-30T12:00:01.500Z")).toBe(true);
  });

  it("accepts equal timestamps (at-least-once redelivery)", () => {
    const c = new MonotonicTimestampChecker();
    expect(c.accept("s1", "2026-05-30T12:00:00.000Z")).toBe(true);
    expect(c.accept("s1", "2026-05-30T12:00:00.000Z")).toBe(true);
  });

  it("rejects a backwards timestamp (clock rollback) without advancing the high-water mark", () => {
    const c = new MonotonicTimestampChecker();
    expect(c.accept("s1", "2026-05-30T12:00:05.000Z")).toBe(true);
    expect(c.accept("s1", "2026-05-30T12:00:04.999Z")).toBe(false);
    // 巻き戻りでは high-water mark を後退させない
    expect(c.lastSeen("s1")).toBe(Date.parse("2026-05-30T12:00:05.000Z"));
    // 後続の正当な前進は引き続き受理される
    expect(c.accept("s1", "2026-05-30T12:00:06.000Z")).toBe(true);
  });

  it("tracks sessions independently", () => {
    const c = new MonotonicTimestampChecker();
    expect(c.accept("s1", "2026-05-30T12:00:10.000Z")).toBe(true);
    // 別セッションは s1 の時刻に影響されない
    expect(c.accept("s2", "2026-05-30T11:00:00.000Z")).toBe(true);
    expect(c.accept("s2", "2026-05-30T11:00:01.000Z")).toBe(true);
  });

  it("reset clears tracking for a session", () => {
    const c = new MonotonicTimestampChecker();
    c.accept("s1", "2026-05-30T12:00:10.000Z");
    c.reset("s1");
    expect(c.lastSeen("s1")).toBeUndefined();
    // reset 後は過去時刻でも新たな起点として受理
    expect(c.accept("s1", "2026-05-30T09:00:00.000Z")).toBe(true);
  });

  it("rejects invalid timestamps", () => {
    const c = new MonotonicTimestampChecker();
    expect(c.accept("s1", "not-a-date")).toBe(false);
  });

  describe("isMonotonicNonDecreasing (pure batch checker)", () => {
    it("returns true for a non-decreasing sequence", () => {
      expect(
        isMonotonicNonDecreasing([
          "2026-05-30T12:00:00.000Z",
          "2026-05-30T12:00:00.000Z",
          "2026-05-30T12:00:01.000Z",
        ]),
      ).toBe(true);
    });

    it("returns false when the sequence goes backwards", () => {
      expect(
        isMonotonicNonDecreasing(["2026-05-30T12:00:01.000Z", "2026-05-30T12:00:00.000Z"]),
      ).toBe(false);
    });

    it("returns true for empty / single-element sequences", () => {
      expect(isMonotonicNonDecreasing([])).toBe(true);
      expect(isMonotonicNonDecreasing(["2026-05-30T12:00:00.000Z"])).toBe(true);
    });
  });
});
