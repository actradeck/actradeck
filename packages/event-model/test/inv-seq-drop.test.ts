/**
 * INV-SEQ-DROP (ADR 019f4cdb Phase2・eval R2 項目5後半・decision 019f502c):
 *  client 申告 `seq` による中間 silent-drop **下限検知**の正準導出 `computeSeqMissingLowerBound` と、
 *  NormalizedEvent の optional `seq` スキーマ受理/拒否を pin する。backend SQL 集約はこの式を鏡写しにし
 *  real-PG parity テスト (apps/backend/test/inv-audit-coverage.test.ts) で照合する。
 *
 * 不変条件:
 *  (a) 空/単一/連続 → 0 (欠落なし)。
 *  (b) 区間内の穴のみを数える (下限)。重複 seq は distinct で collapse (retry 冪等)。
 *  (c) 結果は常に非負。順不同でも同値 (集合演算)。
 *  (d) schema: seq は非負整数のみ受理・負値/非整数/巨大非整数を reject・省略可 (後方互換)。
 */
import { describe, expect, it } from "vitest";

import { parseEvent, safeParseEvent } from "../src/index.js";
// N-TDA-1: computeSeqMissingLowerBound は public barrel 非公開 (raw 下限を集約に誤用する footgun 回避)。
//   raw の境界テストのみ seq-drop.js 相対 import で参照する。集約公開 API は evaluateSeqMissing (barrel)。
import { computeSeqMissingLowerBound, evaluateSeqMissing } from "../src/seq-drop.js";

describe("computeSeqMissingLowerBound — (a) 欠落なしの境界", () => {
  it("空配列 → 0 (seq-bearing でない)", () => {
    expect(computeSeqMissingLowerBound([])).toBe(0);
  });
  it("単一 seq → 0", () => {
    expect(computeSeqMissingLowerBound([0])).toBe(0);
    expect(computeSeqMissingLowerBound([42])).toBe(0);
  });
  it("連続 seq (0..n) → 0", () => {
    expect(computeSeqMissingLowerBound([0, 1, 2, 3, 4])).toBe(0);
  });
  it("min が 0 でなくても連続なら 0 (区間ベース)", () => {
    expect(computeSeqMissingLowerBound([5, 6, 7])).toBe(0);
  });
});

describe("computeSeqMissingLowerBound — (b) 区間内の穴のみを下限で数える", () => {
  it("1 個の穴 [0,2] → 1", () => {
    expect(computeSeqMissingLowerBound([0, 2])).toBe(1);
  });
  it("複数の穴 [0,1,4,5] → 2 (2,3 が欠落)", () => {
    expect(computeSeqMissingLowerBound([0, 1, 4, 5])).toBe(2);
  });
  it("順不同でも同値 (集合演算)", () => {
    expect(computeSeqMissingLowerBound([5, 0, 4, 1])).toBe(2);
  });
  it("大きな穴 [0,10] → 9", () => {
    expect(computeSeqMissingLowerBound([0, 10])).toBe(9);
  });
});

describe("computeSeqMissingLowerBound — (b') 重複 seq は collapse (retry 冪等)", () => {
  it("完全連続 + 重複 [0,1,1,2,2,2] → 0", () => {
    expect(computeSeqMissingLowerBound([0, 1, 1, 2, 2, 2])).toBe(0);
  });
  it("穴あり + 重複 [0,0,2,2] → 1 (重複は欠落を捏造しない)", () => {
    expect(computeSeqMissingLowerBound([0, 0, 2, 2])).toBe(1);
  });
  it("全部同一 seq [7,7,7] → 0 (span=1, distinct=1)", () => {
    expect(computeSeqMissingLowerBound([7, 7, 7])).toBe(0);
  });
});

describe("computeSeqMissingLowerBound — (c) 非負・dirty 値の防御", () => {
  it("結果は常に非負 (整数区間で distinct <= span)", () => {
    for (const arr of [
      [0, 5],
      [3, 3, 9],
      [0, 1, 2, 100],
    ]) {
      expect(computeSeqMissingLowerBound(arr)).toBeGreaterThanOrEqual(0);
    }
  });
  it("負・非整数・非有限・非数な seq は無視して数える (at-rest 破損防御・throw しない)", () => {
    // 有効なのは [0,2] のみ → 下限 1。dirty 値 (-1, 1.5, NaN, Infinity) は除外。
    const dirty = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2] as number[];
    expect(computeSeqMissingLowerBound(dirty)).toBe(1);
  });
  it("有効 seq が皆無 (全 dirty) → 0", () => {
    expect(computeSeqMissingLowerBound([-1, -2, 3.14] as number[])).toBe(0);
  });
});

describe("evaluateSeqMissing — (e) 密性抑制 (SEC-1≡QA-4)", () => {
  it("dense session (穴少数・raw_missing <= distinct) は抑制せず missing を出す", () => {
    // [0,1,3,4] raw_missing=1・distinct=4 → 1 <= 4 → 非抑制。
    expect(evaluateSeqMissing([0, 1, 3, 4])).toEqual({
      missing: 1,
      distinctCount: 4,
      suppressed: false,
    });
  });

  it("境界: raw_missing === distinct は非抑制 (> のみ抑制)", () => {
    // [0,2,4] span=5 distinct=3 raw_missing=2 → 2 > 3? No → 非抑制・missing=2。
    expect(evaluateSeqMissing([0, 2, 4])).toEqual({
      missing: 2,
      distinctCount: 3,
      suppressed: false,
    });
    // [0,3] span=4 distinct=2 raw_missing=2 → 2 > 2? No → 非抑制・missing=2 (ちょうど半分)。
    expect(evaluateSeqMissing([0, 3])).toEqual({ missing: 2, distinctCount: 2, suppressed: false });
  });

  it("密性違反 (raw_missing > distinct) は suppressed=true・missing=0", () => {
    // [0,4] span=5 distinct=2 raw_missing=3 → 3 > 2 → 抑制。
    expect(evaluateSeqMissing([0, 4])).toEqual({ missing: 0, distinctCount: 2, suppressed: true });
    // every-3rd (global カウンタ 3-way split 模擬) [0,3,6,9] span=10 distinct=4 raw_missing=6 → 抑制。
    expect(evaluateSeqMissing([0, 3, 6, 9])).toEqual({
      missing: 0,
      distinctCount: 4,
      suppressed: true,
    });
  });

  it("SEC-1 回帰: [0, 9e15] (非密・巨大区間) は抑制され偽の巨大値を出さない", () => {
    const huge = 9e15; // computeSeqMissingLowerBound は raw で ~9e15 を返す (抑制前)。
    expect(computeSeqMissingLowerBound([0, huge])).toBeGreaterThan(1e15); // raw は巨大
    const ev = evaluateSeqMissing([0, huge]);
    expect(ev.suppressed).toBe(true);
    expect(ev.missing).toBe(0); // 抑制で 0 (偽の巨大警報を出さない)
  });

  it("seq-bearing でない (空/全 dirty) は suppressed=false・missing=0", () => {
    expect(evaluateSeqMissing([])).toEqual({ missing: 0, distinctCount: 0, suppressed: false });
    expect(evaluateSeqMissing([-1, 2.5] as number[])).toEqual({
      missing: 0,
      distinctCount: 0,
      suppressed: false,
    });
  });

  it("抑制後 missing は必ず distinct 以下に有界 (集約 overflow の芽を摘む)", () => {
    for (const arr of [
      [0, 1, 2],
      [0, 5],
      [0, 4],
      [0, 100],
      [0, 3, 6, 9, 12],
    ]) {
      const ev = evaluateSeqMissing(arr);
      expect(ev.missing).toBeLessThanOrEqual(ev.distinctCount);
      expect(ev.missing).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("NormalizedEvent.seq — (d) スキーマ受理/拒否", () => {
  function ev(over: Record<string, unknown> = {}) {
    return {
      event_id: "0192f8a0-1234-7abc-89de-f01234567890",
      provider: "opencode",
      source: "external",
      session_id: "sess_seq_test",
      event_type: "heartbeat",
      timestamp: "2026-07-04T12:34:56.789Z",
      payload: { kind: "heartbeat", process_alive: true },
      ...over,
    };
  }

  it("seq 省略は受理 (後方互換・既存 adapter 不変)", () => {
    const parsed = safeParseEvent(ev());
    expect(parsed.success).toBe(true);
    // 欠落は undefined (キーを勝手に生やさない)。
    if (parsed.success) expect(parsed.data.seq).toBeUndefined();
  });

  it("seq=0 (起点) を受理", () => {
    const parsed = parseEvent(ev({ seq: 0 }));
    expect(parsed.seq).toBe(0);
  });

  it("正の整数 seq を受理", () => {
    expect(parseEvent(ev({ seq: 12345 })).seq).toBe(12345);
  });

  it("負値 seq を reject", () => {
    expect(safeParseEvent(ev({ seq: -1 })).success).toBe(false);
  });

  it("非整数 seq (小数) を reject", () => {
    expect(safeParseEvent(ev({ seq: 1.5 })).success).toBe(false);
  });

  it("非有限 (Infinity/NaN) を reject", () => {
    expect(safeParseEvent(ev({ seq: Number.POSITIVE_INFINITY })).success).toBe(false);
    expect(safeParseEvent(ev({ seq: Number.NaN })).success).toBe(false);
  });

  it("safe-integer 上限内は受理・巨大値 (>2^53-1 = 非 safe integer) は reject", () => {
    // zod v4 の .int() は safe-integer 域 (|x| <= 2^53-1) を強制する。現実の adapter は 0 起点連番ゆえ
    // 到達しないが、巨大値は schema 境界で reject され unbounded な seq が at-rest へ入らない。
    expect(safeParseEvent(ev({ seq: Number.MAX_SAFE_INTEGER })).success).toBe(true); // 2^53-1
    expect(safeParseEvent(ev({ seq: 2 ** 53 })).success).toBe(false); // 2^53 = 非 safe integer
  });

  it("文字列 seq を reject (数値のみ)", () => {
    expect(safeParseEvent(ev({ seq: "3" })).success).toBe(false);
  });
});
