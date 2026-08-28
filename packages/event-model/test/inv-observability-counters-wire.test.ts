/**
 * INV-OBSERVABILITY-COUNTERS-WIRE (TDA-V9-7 landing): 縮退カウンタ wire の射影 / 受信検証 / 集約を固定する。
 *
 * 対象は `unstableRequestIdCount` (sidecar ApprovalBridge・hello 相乗り) と
 * `nonRetirableSkipCount` (backend ApprovalReconciler・endpoint で合流) の 2 つ。どちらも
 * 「0 が正常・>0 は要調査」の診断信号で、endpoint (`GET /realtime/readiness`) が唯一の読取り路。
 *
 * 焦点 (falsifiable):
 *  - NO-RAW by construction: parse は既知 counter のみ抽出し **余剰 field を構造的に落とす**
 *    (敵対 daemon がパス / token を追加 field に詰めても parse 境界で消える)。
 *  - 非負安全整数のみ: 負数 / 小数 / NaN / Infinity / string / bigint / null / 安全整数域外は 0 へ縮退
 *    (奇形 wire から件数をでっち上げない)。**負数の透過は endpoint を「負の観測」で汚す** ため
 *    `asCount` の `>= 0` を外すと本テストが RED になる。
 *  - 未報告と 0 報告の区別: 非 object → undefined (集約から除外)・object → 0 (報告された 0)。
 *  - 集約は sum fold (延べ数の意味論)・空集合 0・安全整数域で飽和。
 *  - hello 構築は conditional field (undefined → field 省略 = 後方互換)。
 */
import { describe, expect, it } from "vitest";

import {
  aggregateDaemonCounters,
  buildDaemonCountersHelloFields,
  buildReadinessCounters,
  DAEMON_COUNTERS_FIELD,
  parseDaemonCountersWire,
  parseReadinessCountersWire,
  ZERO_DAEMON_COUNTERS,
} from "../src/index.js";

/** 非負安全整数へ縮退すべき敵対 / 奇形入力 (すべて 0 期待)。 */
const NON_COUNT_VECTORS: readonly unknown[] = [
  -1,
  -0.5,
  Number.MIN_SAFE_INTEGER,
  1.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 1, // 安全整数域外 (精度が失われる)
  "3",
  "/home/victim/.claude/settings.json",
  true,
  null,
  undefined,
  {},
  [],
  // bigint は typeof "bigint" ゆえ number ゲートで落ちる。
  10n,
];

describe("INV-OBSERVABILITY-COUNTERS-WIRE: field 値の非負安全整数ゲート", () => {
  it("正常値 (0 / 正の安全整数) はそのまま透過する", () => {
    expect(parseDaemonCountersWire({ unstableRequestIdCount: 0 })).toEqual({
      unstableRequestIdCount: 0,
    });
    expect(parseDaemonCountersWire({ unstableRequestIdCount: 9 })).toEqual({
      unstableRequestIdCount: 9,
    });
    expect(parseDaemonCountersWire({ unstableRequestIdCount: Number.MAX_SAFE_INTEGER })).toEqual({
      unstableRequestIdCount: Number.MAX_SAFE_INTEGER,
    });
  });

  it("負数 / 小数 / NaN / Infinity / 非 number は 0 へ縮退する (asCount の >= 0 を外すと RED)", () => {
    for (const v of NON_COUNT_VECTORS) {
      expect(
        parseDaemonCountersWire({ unstableRequestIdCount: v }),
        `daemon counters が ${String(v)} を透過した`,
      ).toEqual({ unstableRequestIdCount: 0 });
      expect(
        parseReadinessCountersWire({ unstableRequestIdCount: v, nonRetirableSkipCount: v }),
        `readiness counters が ${String(v)} を透過した`,
      ).toEqual({ unstableRequestIdCount: 0, nonRetirableSkipCount: 0 });
      expect(
        buildReadinessCounters(ZERO_DAEMON_COUNTERS, v),
        `buildReadinessCounters が ${String(v)} を透過した`,
      ).toEqual({ unstableRequestIdCount: 0, nonRetirableSkipCount: 0 });
    }
  });

  it("負数は endpoint 側 (buildReadinessCounters / hello 構築) でも透過しない", () => {
    expect(buildReadinessCounters({ unstableRequestIdCount: -7 }, -7)).toEqual({
      unstableRequestIdCount: 0,
      nonRetirableSkipCount: 0,
    });
    expect(buildDaemonCountersHelloFields({ unstableRequestIdCount: -7 })).toEqual({
      [DAEMON_COUNTERS_FIELD]: { unstableRequestIdCount: 0 },
    });
  });
});

describe("INV-OBSERVABILITY-COUNTERS-WIRE: NO-RAW by construction (余剰 field を落とす)", () => {
  it("敵対 daemon の余剰 field (パス / secret 様) は parse 境界で消える (pass-through 化すると RED)", () => {
    const hostile = {
      unstableRequestIdCount: 2,
      leakedPath: "/home/victim/.claude/settings.json",
      token: "glpat-XXXXXXXXXXXXXXXXXXXX",
      request_id: "s0123456789ab:apr-00112233445566778899aabbccddeeff",
      session_id: "sess_0199f0a1-2b3c-7d4e-8f01-23456789abcd",
    };
    const parsed = parseDaemonCountersWire(hostile);
    expect(parsed).toEqual({ unstableRequestIdCount: 2 });
    expect(Object.keys(parsed ?? {})).toEqual(["unstableRequestIdCount"]);
    expect(JSON.stringify(parsed)).not.toContain("victim");
    expect(JSON.stringify(parsed)).not.toContain("glpat-");
    expect(JSON.stringify(parsed)).not.toContain("apr-");
    expect(JSON.stringify(parsed)).not.toContain("sess_");
  });

  it("readiness 応答 parse も既知 2 counter のみ抽出する (read 境界の対称性)", () => {
    const parsed = parseReadinessCountersWire({
      unstableRequestIdCount: 1,
      nonRetirableSkipCount: 3,
      cwd: "/home/victim/work",
      extra: { nested: "x" },
    });
    expect(parsed).toEqual({ unstableRequestIdCount: 1, nonRetirableSkipCount: 3 });
    expect(Object.keys(parsed).sort()).toEqual(["nonRetirableSkipCount", "unstableRequestIdCount"]);
  });

  it("hello 構築も射影を通す (provider が余剰 field を持っていても wire へ出ない)", () => {
    const fields = buildDaemonCountersHelloFields({
      unstableRequestIdCount: 4,
      leakedPath: "/home/victim/.env",
    } as never);
    expect(fields).toEqual({ [DAEMON_COUNTERS_FIELD]: { unstableRequestIdCount: 4 } });
    expect(JSON.stringify(fields)).not.toContain("victim");
  });
});

describe("INV-OBSERVABILITY-COUNTERS-WIRE: 未報告 / 報告 0 の区別と fail-safe", () => {
  it("非 object (未報告) は undefined = 集約から除外 (例外を投げない)", () => {
    for (const raw of [undefined, null, 3, "x", true, [], [{ unstableRequestIdCount: 1 }]]) {
      expect(parseDaemonCountersWire(raw), `${String(raw)} が未報告扱いにならない`).toBeUndefined();
    }
  });

  it("field 欠落の object は「報告された 0」(undefined ではない)", () => {
    expect(parseDaemonCountersWire({})).toEqual({ unstableRequestIdCount: 0 });
  });

  it("readiness 応答 parse は非 object でも throw せず全 0 の安全形を返す", () => {
    for (const raw of [undefined, null, "x", 7, []]) {
      expect(parseReadinessCountersWire(raw)).toEqual({
        unstableRequestIdCount: 0,
        nonRetirableSkipCount: 0,
      });
    }
  });

  it("hello 構築は undefined で field 自体を省略する (旧 daemon / observe-only の後方互換)", () => {
    expect(buildDaemonCountersHelloFields(undefined)).toEqual({});
    expect(DAEMON_COUNTERS_FIELD in buildDaemonCountersHelloFields(undefined)).toBe(false);
    // 0 報告は field を載せる ("縮退なし" の積極的な宣言)。
    expect(buildDaemonCountersHelloFields(ZERO_DAEMON_COUNTERS)).toEqual({
      [DAEMON_COUNTERS_FIELD]: { unstableRequestIdCount: 0 },
    });
  });
});

describe("INV-OBSERVABILITY-COUNTERS-WIRE: 集約 (sum fold)", () => {
  it("延べ数ゆえ OR でなく加算する (複数 daemon の縮退が合算される)", () => {
    expect(
      aggregateDaemonCounters([
        { unstableRequestIdCount: 2 },
        { unstableRequestIdCount: 0 },
        { unstableRequestIdCount: 9 },
      ]),
    ).toEqual({ unstableRequestIdCount: 11 });
  });

  it("空集合は 0 (誰も報告していない = 未観測・安全側)", () => {
    expect(aggregateDaemonCounters([])).toEqual({ unstableRequestIdCount: 0 });
  });

  it("集約も入力を射影する (奇形の report が合計を汚さない)", () => {
    expect(
      aggregateDaemonCounters([
        { unstableRequestIdCount: 5 },
        { unstableRequestIdCount: -100 } as never,
        { unstableRequestIdCount: Number.NaN } as never,
      ]),
    ).toEqual({ unstableRequestIdCount: 5 });
  });

  it("安全整数域で飽和する (加算が精度を失う域へ出ない)", () => {
    const r = aggregateDaemonCounters([
      { unstableRequestIdCount: Number.MAX_SAFE_INTEGER },
      { unstableRequestIdCount: Number.MAX_SAFE_INTEGER },
    ]);
    expect(r.unstableRequestIdCount).toBe(Number.MAX_SAFE_INTEGER);
    expect(Number.isSafeInteger(r.unstableRequestIdCount)).toBe(true);
  });

  it("buildReadinessCounters は daemon 集約と backend ローカル値を closed shape へ合流させる", () => {
    const merged = buildReadinessCounters({ unstableRequestIdCount: 3 }, 4);
    expect(merged).toEqual({ unstableRequestIdCount: 3, nonRetirableSkipCount: 4 });
    expect(Object.keys(merged).sort()).toEqual(["nonRetirableSkipCount", "unstableRequestIdCount"]);
  });
});
