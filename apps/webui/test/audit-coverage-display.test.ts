/**
 * ADR 019f4cdb 後続 UI: audit-coverage-display の純表示派生 INV。
 * gap severity の閾値境界 / null gap 非警告 / 相対受信経過 (generated_at 基準・client clock 非依存)。
 */
import { describe, expect, it } from "vitest";

import {
  compactDuration,
  formatSeqDrop,
  GAP_CRITICAL_MS,
  GAP_WARN_MS,
  gapSeverity,
  relativeReceivedAge,
  SEQ_DROP_DISPLAY_CAP,
} from "../src/ui/audit-coverage-display.js";

describe("gapSeverity — 閾値境界 (amber ≥60s / red ≥300s)", () => {
  it("閾値定数は 60s / 300s (INV-STALLED の 60s とは独立・TDA-2)", () => {
    expect(GAP_WARN_MS).toBe(60_000);
    expect(GAP_CRITICAL_MS).toBe(300_000);
  });

  it("null gap は idle (非稼働/無受信 = 警告しない・誤警報しない)", () => {
    expect(gapSeverity(null)).toBe("idle");
  });

  it("0 〜 WARN 未満は ok", () => {
    expect(gapSeverity(0)).toBe("ok");
    expect(gapSeverity(GAP_WARN_MS - 1)).toBe("ok");
  });

  it("WARN ちょうど 〜 CRITICAL 未満は warn (境界は含む)", () => {
    expect(gapSeverity(GAP_WARN_MS)).toBe("warn");
    expect(gapSeverity(GAP_CRITICAL_MS - 1)).toBe("warn");
  });

  it("CRITICAL 以上は critical (境界は含む)", () => {
    expect(gapSeverity(GAP_CRITICAL_MS)).toBe("critical");
    expect(gapSeverity(GAP_CRITICAL_MS * 10)).toBe("critical");
  });
});

describe("relativeReceivedAge — generated_at 基準 (client clock 非依存)", () => {
  const GEN = "2026-04-02T12:00:00.000Z";

  it("last_received が null (無受信) は null を返す (呼び出し側が no events を出す)", () => {
    expect(relativeReceivedAge(null, GEN)).toBeNull();
  });

  it("秒オーダーは Ns (generated_at − last_received)", () => {
    expect(relativeReceivedAge("2026-04-02T11:59:48.000Z", GEN)).toBe("12s"); // 12s 前
    expect(relativeReceivedAge("2026-04-02T11:59:59.000Z", GEN)).toBe("1s");
  });

  it("分オーダーは Nm", () => {
    expect(relativeReceivedAge("2026-04-02T11:57:00.000Z", GEN)).toBe("3m"); // 3 分前
    expect(relativeReceivedAge("2026-04-02T11:00:30.000Z", GEN)).toBe("60m"); // 59.5 分 → 四捨五入 60m
  });

  it("時オーダーは Nh", () => {
    expect(relativeReceivedAge("2026-04-02T10:00:00.000Z", GEN)).toBe("2h"); // 2 時間前
  });

  it("基準は generated_at のみ (Date.now を参照しない・skew 非依存)", () => {
    // 実時刻から遠い過去/未来の GEN でも、両端 ISO 差だけで決まる。
    const gen2 = "2000-01-01T00:00:30.000Z";
    expect(relativeReceivedAge("2000-01-01T00:00:00.000Z", gen2)).toBe("30s");
  });

  it("未来 skew (last_received > generated) は 0s へ clamp (負にしない)", () => {
    expect(relativeReceivedAge("2026-04-02T12:05:00.000Z", GEN)).toBe("0s");
  });

  it("パース不能な時刻は null (誤った経過を出さない fail-safe)", () => {
    expect(relativeReceivedAge("not-a-date", GEN)).toBeNull();
    expect(relativeReceivedAge("2026-04-02T11:59:48.000Z", "not-a-date")).toBeNull();
  });
});

describe("compactDuration — ms 差の compact 整形 (relativeReceivedAge と共通・staleness バナー流用)", () => {
  it("秒オーダーは Ns (< 60s)", () => {
    expect(compactDuration(0)).toBe("0s");
    expect(compactDuration(12_000)).toBe("12s");
    expect(compactDuration(59_400)).toBe("59s");
  });

  it("分オーダーは Nm (60s 〜 < 3600s)", () => {
    expect(compactDuration(60_000)).toBe("1m");
    expect(compactDuration(180_000)).toBe("3m");
    expect(compactDuration(3_570_000)).toBe("60m"); // 59.5 分 → 四捨五入
  });

  it("時オーダーは Nh (>= 3600s)", () => {
    expect(compactDuration(3_600_000)).toBe("1h");
    expect(compactDuration(7_200_000)).toBe("2h");
  });

  it("負値は 0s へ clamp (未来 skew を負表示しない)", () => {
    expect(compactDuration(-5_000)).toBe("0s");
  });

  // GFI #19: 各呼び元の従来出力を境界値で pin し、共有化が output-preserving であることを固定する。
  it("GFI #19 境界 (既定 = SessionList relativeAge / staleness バナーと同一出力): 59s/60s/3599s/3600s", () => {
    expect(compactDuration(59_000)).toBe("59s");
    expect(compactDuration(60_000)).toBe("1m");
    expect(compactDuration(3_599_000)).toBe("60m"); // 3599s = 59.98 分 → 四捨五入 60m (h 未満)
    expect(compactDuration(3_600_000)).toBe("1h");
  });

  it("GFI #19 maxUnit:'m' (SessionDetail ageLabel の従来出力): 1h 以上も分で出し続ける", () => {
    const opts = { maxUnit: "m" } as const;
    expect(compactDuration(59_000, opts)).toBe("59s");
    expect(compactDuration(60_000, opts)).toBe("1m");
    expect(compactDuration(3_600_000, opts)).toBe("60m"); // 旧 ageLabel: h へ畳まない
    expect(compactDuration(4_320_000, opts)).toBe("72m");
  });

  it("GFI #19 clampNegative:false (SessionDetail ageLabel の従来出力): 時計 skew は符号付き秒", () => {
    expect(compactDuration(-3_000, { clampNegative: false })).toBe("-3s");
    expect(compactDuration(-3_000)).toBe("0s"); // 既定は従来どおり clamp
  });
});

describe("formatSeqDrop — seq-drop chip 整形 (SEC-1 UI cap)", () => {
  it("null / 0 / 負 は null (chip を出さない・誤警報しない)", () => {
    expect(formatSeqDrop(null)).toBeNull();
    expect(formatSeqDrop(0)).toBeNull();
    expect(formatSeqDrop(-5)).toBeNull();
  });

  it("1 〜 cap は { count, capped:false }", () => {
    expect(formatSeqDrop(1)).toEqual({ count: 1, capped: false });
    expect(formatSeqDrop(42)).toEqual({ count: 42, capped: false });
    expect(formatSeqDrop(SEQ_DROP_DISPLAY_CAP)).toEqual({
      count: SEQ_DROP_DISPLAY_CAP,
      capped: false,
    });
  });

  it("cap 超は { count: CAP, capped:true } (桁溢れ表示にしない)", () => {
    expect(formatSeqDrop(SEQ_DROP_DISPLAY_CAP + 1)).toEqual({
      count: SEQ_DROP_DISPLAY_CAP,
      capped: true,
    });
    expect(formatSeqDrop(123456)).toEqual({ count: SEQ_DROP_DISPLAY_CAP, capped: true });
  });

  it("非有限 (NaN/Infinity) は null (fail-safe)", () => {
    expect(formatSeqDrop(Number.NaN)).toBeNull();
    expect(formatSeqDrop(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("小数は切り捨てて整数扱い", () => {
    expect(formatSeqDrop(3.9)).toEqual({ count: 3, capped: false });
  });
});
