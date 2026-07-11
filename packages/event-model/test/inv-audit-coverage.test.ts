/**
 * INV-AUDIT-COVERAGE (ADR 019f4cdb Phase 1): per-provider 監査カバレッジ導出の **正準単一出所** を
 * 純関数レベルで pin する。backend SQL 射影 / route / webui parse がこの関数群を共有するため、ここが
 * 契約になる。real-PG 側 (apps/backend/test/inv-audit-coverage.test.ts) は同じ述語を実 PG で照合する。
 *
 * 不変条件:
 *  (a) ingested_at 権威: `last_received_at` / `gap_candidate_ms` は **maxIngestedAtMs からのみ**導く。
 *      adapter 申告 timestamp (maxEventTimestampMs) を後ろ倒しにしても gap は隠れない。
 *  (b) 非稼働 ≠ gap: active_session_count===0 の provider は `gap_candidate_ms=null` (誤警報しない)。
 *  (c) NO-RAW: `projectProviderCoverageRow` は既知 field のみ抽出し余剰 field を落とし、非 slug provider を
 *      row ごと drop する (生パス/secret 様文字列を surface させない)。
 */
import { describe, expect, it } from "vitest";

import {
  type AuditProviderCoverage,
  buildCoverageReport,
  computeProviderCoverage,
  parseAuditCoverageReportWire,
  parseProviderCoverageWire,
  projectProviderCoverageRow,
  type ProviderCoverageInput,
} from "../src/index.js";

const GEN_MS = Date.UTC(2026, 3, 2, 12, 0, 0); // generated_at 基準時刻
const MIN = 60_000;

function input(over: Partial<ProviderCoverageInput> = {}): ProviderCoverageInput {
  return {
    provider: "claude_code",
    maxIngestedAtMs: GEN_MS - 30 * MIN,
    maxEventTimestampMs: GEN_MS - 30 * MIN,
    activeSessionCount: 1,
    totalSessionCount: 1,
    ...over,
  };
}

describe("computeProviderCoverage — (a) ingested_at 権威", () => {
  it("gap は ingested_at 基準で算出する (最終受信 30 分前 ⇒ gap≈30 分)", () => {
    const c = computeProviderCoverage(input(), GEN_MS);
    expect(c.gap_candidate_ms).toBe(30 * MIN);
    expect(c.last_received_at).toBe(new Date(GEN_MS - 30 * MIN).toISOString());
  });

  it("adapter timestamp を『今』へ後ろ倒ししても gap は ingested_at 由来で隠れない", () => {
    // 権威 (ingested_at) は 45 分前だが、adapter 申告 timestamp は generated_at と同時刻 (skew/詐称)。
    // gap を timestamp で計るなら 0 に潰れるが、ingested_at 権威ゆえ 45 分のまま出る (falsifiable)。
    const c = computeProviderCoverage(
      input({ maxIngestedAtMs: GEN_MS - 45 * MIN, maxEventTimestampMs: GEN_MS }),
      GEN_MS,
    );
    expect(c.gap_candidate_ms).toBe(45 * MIN);
    // 表示補助として adapter timestamp も出す (但し gap 非権威)。
    expect(c.last_event_timestamp).toBe(new Date(GEN_MS).toISOString());
    expect(c.last_received_at).toBe(new Date(GEN_MS - 45 * MIN).toISOString());
  });

  it("未来 skew (last_received > generated) は gap を 0 へ clamp (負にしない)", () => {
    const c = computeProviderCoverage(input({ maxIngestedAtMs: GEN_MS + 10 * MIN }), GEN_MS);
    expect(c.gap_candidate_ms).toBe(0);
  });
});

describe("computeProviderCoverage — (b) 非稼働 ≠ gap", () => {
  it("非稼働 (active=0) provider は last_received が古くても gap_candidate_ms=null", () => {
    // 稼働 session ゼロ・最終受信は 6 時間前 (巨大な age)。誤警報しない。
    const c = computeProviderCoverage(
      input({ activeSessionCount: 0, totalSessionCount: 3, maxIngestedAtMs: GEN_MS - 360 * MIN }),
      GEN_MS,
    );
    expect(c.active_session_count).toBe(0);
    expect(c.gap_candidate_ms).toBeNull();
    // 最終受信時刻自体は表示のため保持する (gap alarm のみ抑止)。
    expect(c.last_received_at).toBe(new Date(GEN_MS - 360 * MIN).toISOString());
  });

  it("稼働あり (active>0) だが無受信 (last_received なし) も gap_candidate_ms=null", () => {
    const c = computeProviderCoverage(
      input({ activeSessionCount: 2, maxIngestedAtMs: null, maxEventTimestampMs: null }),
      GEN_MS,
    );
    expect(c.gap_candidate_ms).toBeNull();
    // TDA-2: 無受信は null (gap と対称・wire で present-null に統一)。
    expect(c.last_received_at).toBeNull();
  });

  it("稼働あり + 受信あり のときだけ gap を出す", () => {
    const c = computeProviderCoverage(input({ activeSessionCount: 1 }), GEN_MS);
    expect(c.gap_candidate_ms).toBe(30 * MIN);
  });
});

describe("projectProviderCoverageRow — (c) NO-RAW by construction", () => {
  it("既知 field のみ射影し余剰 field (生パス/secret 様) を構造的に落とす", () => {
    const projected = projectProviderCoverageRow({
      provider: "codex",
      maxIngestedAtMs: 1000,
      maxEventTimestampMs: 2000,
      activeSessionCount: 1,
      totalSessionCount: 2,
      cwd: "/home/user/secret-project", // 漏れてはならない
      leaked_secret: "ghp_realtokenxxxxxxxxxxxxxxxxxxxxxxxxxx", // 漏れてはならない
      payload: { command: "rm -rf /" },
    });
    expect(projected).toEqual({
      provider: "codex",
      maxIngestedAtMs: 1000,
      maxEventTimestampMs: 2000,
      activeSessionCount: 1,
      totalSessionCount: 2,
    });
    // 余剰キーが構造的に存在しない。
    expect(Object.keys(projected ?? {}).sort()).toEqual([
      "activeSessionCount",
      "maxEventTimestampMs",
      "maxIngestedAtMs",
      "provider",
      "totalSessionCount",
    ]);
  });

  it("非 slug provider (生パス/大文字/長文字列) は row ごと drop する", () => {
    expect(projectProviderCoverageRow({ provider: "/home/user/leak" })).toBeUndefined();
    expect(projectProviderCoverageRow({ provider: "Claude Code" })).toBeUndefined();
    expect(projectProviderCoverageRow({ provider: "a".repeat(33) })).toBeUndefined();
    expect(projectProviderCoverageRow({ provider: "" })).toBeUndefined();
    expect(projectProviderCoverageRow(null)).toBeUndefined();
    expect(projectProviderCoverageRow("codex")).toBeUndefined();
  });

  it("非数 ms は null / 負・非有限 count は 0 へ縮退 (安全側)", () => {
    const p = projectProviderCoverageRow({
      provider: "gemini",
      maxIngestedAtMs: "not-a-number",
      maxEventTimestampMs: undefined,
      activeSessionCount: -5,
      totalSessionCount: Number.NaN,
    });
    expect(p).toEqual({
      provider: "gemini",
      maxIngestedAtMs: null,
      maxEventTimestampMs: null,
      activeSessionCount: 0,
      totalSessionCount: 0,
    });
  });

  it("pg numeric の文字列 ms も finite number として受ける", () => {
    const p = projectProviderCoverageRow({
      provider: "codex",
      maxIngestedAtMs: "1712059200000",
      maxEventTimestampMs: "1712059200000",
      activeSessionCount: "2",
      totalSessionCount: "2",
    });
    expect(p?.maxIngestedAtMs).toBe(1712059200000);
    expect(p?.activeSessionCount).toBe(2);
  });
});

describe("buildCoverageReport — 単一エントリポイント", () => {
  it("行群を射影+導出し、非 slug row を除外して provider 昇順で並べる", () => {
    const gen = new Date(GEN_MS);
    const report = buildCoverageReport(
      [
        {
          provider: "codex",
          maxIngestedAtMs: GEN_MS - 10 * MIN,
          maxEventTimestampMs: GEN_MS - 10 * MIN,
          activeSessionCount: 1,
          totalSessionCount: 1,
        },
        // 非 slug → drop される
        { provider: "/etc/passwd", maxIngestedAtMs: GEN_MS, activeSessionCount: 1 },
        {
          provider: "claude_code",
          maxIngestedAtMs: GEN_MS - 20 * MIN,
          maxEventTimestampMs: GEN_MS - 20 * MIN,
          activeSessionCount: 0,
          totalSessionCount: 2,
        },
      ],
      gen,
    );
    expect(report.generated_at).toBe(gen.toISOString());
    expect(report.providers.map((p) => p.provider)).toEqual(["claude_code", "codex"]);
    // claude_code は非稼働 → null、codex は稼働 → gap あり。
    expect(report.providers[0].gap_candidate_ms).toBeNull();
    expect(report.providers[1].gap_candidate_ms).toBe(10 * MIN);
  });

  it("応答に生パス/secret が一切現れない (NO-RAW・全体シリアライズ検査)", () => {
    const report = buildCoverageReport(
      [
        {
          provider: "codex",
          maxIngestedAtMs: GEN_MS,
          maxEventTimestampMs: GEN_MS,
          activeSessionCount: 1,
          totalSessionCount: 1,
          cwd: "/home/user/secret",
          token: "ghp_leakmexxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
        },
      ],
      new Date(GEN_MS),
    );
    const blob = JSON.stringify(report);
    expect(blob).not.toContain("/home/user/secret");
    expect(blob).not.toContain("ghp_leakme");
  });

  it("Date 有効域外の epoch ms を throw せず null へ縮退させる (SEC-1・fail-safe)", () => {
    // year ~290000 相当 = 9.089e15 ms > JS Date 上限 8.64e15。`new Date(ms).toISOString()` は
    // RangeError を投げるため endpoint 全体が 500 縮退しうる。ingest は year 4桁 cap で到達不能だが、
    // at-rest 破損/直接書込に対し層の dirty-row robustness と同水準で timestamp も守る。
    const OUT_OF_RANGE = 9.089e15;
    // (1) computeProviderCoverage 直呼び: throw せず時刻=null・gap=null で一貫。
    const cov = computeProviderCoverage(
      input({
        maxIngestedAtMs: OUT_OF_RANGE,
        maxEventTimestampMs: OUT_OF_RANGE,
        activeSessionCount: 1,
      }),
      GEN_MS,
    );
    expect(cov.last_received_at).toBeNull();
    expect(cov.last_event_timestamp).toBeNull();
    expect(cov.gap_candidate_ms).toBeNull();
    // 負方向の域外 (-9e15) も同様に null (throw しない)。
    const neg = computeProviderCoverage(
      input({ maxIngestedAtMs: -9e15, activeSessionCount: 1 }),
      GEN_MS,
    );
    expect(neg.last_received_at).toBeNull();
    expect(neg.gap_candidate_ms).toBeNull();
    // (2) buildCoverageReport (生行射影) 経由: 例外を投げずレポートを返し、時刻は null。
    let report!: ReturnType<typeof buildCoverageReport>;
    expect(() => {
      report = buildCoverageReport(
        [
          {
            provider: "codex",
            maxIngestedAtMs: OUT_OF_RANGE,
            maxEventTimestampMs: OUT_OF_RANGE,
            activeSessionCount: 1,
            totalSessionCount: 1,
          },
        ],
        new Date(GEN_MS),
      );
    }).not.toThrow();
    expect(report.providers[0].last_received_at).toBeNull();
    expect(report.providers[0].gap_candidate_ms).toBeNull();
  });
});

/**
 * (d) wire 受信検証 (webui parse 単一出所): `parseProviderCoverageWire` /
 * `parseAuditCoverageReportWire` は endpoint 応答 (untrusted 扱い) を検証射影する。
 * `parseAgentVisibilityWire` (INV-AGENT-VIS-WIRE) と同流儀の敵対 vector を pin する:
 *  - 余剰 field を構造的に落とす (NO-RAW)。
 *  - 非 slug provider を row ごと drop (生パス/secret 様を surface させない)。
 *  - 非 ISO 時刻文字列を落とす・数値汚染を非負整数 / null へ縮退。
 *  - generated_at 不正は report 全体 undefined (gap 基準を欠く → 未取得扱いへ fail-safe)。
 */
const GEN_ISO = new Date(GEN_MS).toISOString();
const WIRE_ROW: AuditProviderCoverage = {
  provider: "codex",
  last_received_at: new Date(GEN_MS - 30 * MIN).toISOString(),
  last_event_timestamp: new Date(GEN_MS - 30 * MIN).toISOString(),
  active_session_count: 1,
  total_session_count: 2,
  gap_candidate_ms: 30 * MIN,
};

describe("parseProviderCoverageWire — (d) wire row 受信検証", () => {
  it("正しい DTO row をそのまま射影する", () => {
    expect(parseProviderCoverageWire({ ...WIRE_ROW })).toEqual(WIRE_ROW);
  });

  it("余剰 field (生パス/secret 様) を構造的に落とす (NO-RAW)", () => {
    const parsed = parseProviderCoverageWire({
      ...WIRE_ROW,
      cwd: "/home/user/secret-project", // 漏れてはならない
      token: "ghp_realtokenxxxxxxxxxxxxxxxxxxxxxxxxxx", // 漏れてはならない
      payload: { command: "rm -rf /" },
    });
    expect(parsed).toEqual(WIRE_ROW);
    expect(Object.keys(parsed ?? {}).sort()).toEqual([
      "active_session_count",
      "gap_candidate_ms",
      "last_event_timestamp",
      "last_received_at",
      "provider",
      "total_session_count",
    ]);
    const blob = JSON.stringify(parsed);
    expect(blob).not.toContain("/home/user");
    expect(blob).not.toContain("ghp_");
    expect(blob).not.toContain("rm -rf");
  });

  it("非 slug provider は row ごと undefined (生パス/大文字/長文字列/空)", () => {
    expect(
      parseProviderCoverageWire({ ...WIRE_ROW, provider: "/home/user/leak" }),
    ).toBeUndefined();
    expect(parseProviderCoverageWire({ ...WIRE_ROW, provider: "Claude Code" })).toBeUndefined();
    expect(parseProviderCoverageWire({ ...WIRE_ROW, provider: "a".repeat(33) })).toBeUndefined();
    expect(parseProviderCoverageWire({ ...WIRE_ROW, provider: "" })).toBeUndefined();
    expect(parseProviderCoverageWire(null)).toBeUndefined();
    expect(parseProviderCoverageWire("codex")).toBeUndefined();
    expect(parseProviderCoverageWire([WIRE_ROW])).toBeUndefined();
  });

  it("非 ISO 時刻文字列を null へ落とす (NO-RAW・自由文字列/生パスを surface させない)", () => {
    const parsed = parseProviderCoverageWire({
      ...WIRE_ROW,
      last_received_at: "not-a-timestamp",
      last_event_timestamp: "/var/log/leak.txt", // ISO でない → 落ちる
    });
    expect(parsed?.last_received_at).toBeNull();
    expect(parsed?.last_event_timestamp).toBeNull();
    // 実在しない日時 (ISO 形だが 13 月) も落ちる。
    expect(
      parseProviderCoverageWire({ ...WIRE_ROW, last_received_at: "2026-13-40T99:99:99Z" })
        ?.last_received_at,
    ).toBeNull();
  });

  it("数値汚染: count は非負整数へ、gap は非負整数 / null へ縮退 (誤警報しない安全側)", () => {
    const parsed = parseProviderCoverageWire({
      ...WIRE_ROW,
      active_session_count: -5,
      total_session_count: Number.NaN,
      gap_candidate_ms: "not-a-number",
    });
    expect(parsed?.active_session_count).toBe(0);
    expect(parsed?.total_session_count).toBe(0);
    expect(parsed?.gap_candidate_ms).toBeNull(); // 非数 gap → idle 扱い (false positive を作らない)
    // 負 gap は 0 へ clamp (未来 skew 対称)。null は null のまま。
    expect(
      parseProviderCoverageWire({ ...WIRE_ROW, gap_candidate_ms: -10 })?.gap_candidate_ms,
    ).toBe(0);
    expect(
      parseProviderCoverageWire({ ...WIRE_ROW, gap_candidate_ms: null })?.gap_candidate_ms,
    ).toBeNull();
    // pg numeric 文字列 count も受ける。
    expect(
      parseProviderCoverageWire({ ...WIRE_ROW, active_session_count: "3" })?.active_session_count,
    ).toBe(3);
  });
});

describe("parseAuditCoverageReportWire — (d) wire report 受信検証", () => {
  it("正しい report を射影し provider 昇順へ整列、非 slug row を除外する", () => {
    const parsed = parseAuditCoverageReportWire({
      generated_at: GEN_ISO,
      providers: [
        { ...WIRE_ROW, provider: "codex" },
        { ...WIRE_ROW, provider: "/etc/passwd" }, // drop
        { ...WIRE_ROW, provider: "claude_code" },
      ],
    });
    expect(parsed?.generated_at).toBe(GEN_ISO);
    expect(parsed?.providers.map((p) => p.provider)).toEqual(["claude_code", "codex"]);
  });

  it("generated_at 不正 (欠落/非 ISO/非文字列) は report 全体 undefined (未取得扱いへ fail-safe)", () => {
    expect(parseAuditCoverageReportWire({ providers: [] })).toBeUndefined();
    expect(
      parseAuditCoverageReportWire({ generated_at: "yesterday", providers: [] }),
    ).toBeUndefined();
    expect(parseAuditCoverageReportWire({ generated_at: 12345, providers: [] })).toBeUndefined();
    expect(parseAuditCoverageReportWire(null)).toBeUndefined();
    expect(parseAuditCoverageReportWire("nope")).toBeUndefined();
    expect(parseAuditCoverageReportWire([])).toBeUndefined();
  });

  it("providers 欠落/非配列は空配列扱い (report は返すが 0 行)", () => {
    expect(parseAuditCoverageReportWire({ generated_at: GEN_ISO })).toEqual({
      generated_at: GEN_ISO,
      providers: [],
    });
    expect(
      parseAuditCoverageReportWire({ generated_at: GEN_ISO, providers: "not-array" })?.providers,
    ).toEqual([]);
  });

  it("report 全体に生パス/secret が現れない (NO-RAW・シリアライズ検査)", () => {
    const blob = JSON.stringify(
      parseAuditCoverageReportWire({
        generated_at: GEN_ISO,
        providers: [{ ...WIRE_ROW, cwd: "/home/user/secret", token: "ghp_leakmexxxxxxxxxx" }],
        leaked_top: "/absolute/path/leak", // 余剰 top-level も落ちる
      }),
    );
    expect(blob).not.toContain("/home/user/secret");
    expect(blob).not.toContain("ghp_leakme");
    expect(blob).not.toContain("leaked_top");
    expect(blob).not.toContain("/absolute/path/leak");
  });

  it("SEC-1: __proto__ 汚染ペイロードで prototype を汚さず許可 6 field のみ出力する", () => {
    // 生 JSON からの parse (spread でなく実 wire 経路)。__proto__ を持つ row + report。
    const raw = JSON.parse(
      '{"generated_at":"2026-04-02T12:00:00.000Z","__proto__":{"polluted":"top"},' +
        '"providers":[{"provider":"claude_code","last_received_at":"2026-04-02T11:59:48.000Z",' +
        '"last_event_timestamp":"2026-04-02T11:59:48.000Z","active_session_count":1,' +
        '"total_session_count":1,"gap_candidate_ms":12000,"__proto__":{"x":1}}]}',
    );
    const parsed = parseAuditCoverageReportWire(raw);
    // (a) Object.prototype は汚染されていない。
    expect((Object.prototype as Record<string, unknown>).x).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    // (b) 出力 row は許可 6 field のみ (汚染 key を surface させない)。
    expect(parsed?.providers).toHaveLength(1);
    expect(Object.keys(parsed?.providers[0] ?? {}).sort()).toEqual([
      "active_session_count",
      "gap_candidate_ms",
      "last_event_timestamp",
      "last_received_at",
      "provider",
      "total_session_count",
    ]);
    // (c) report top-level も generated_at / providers のみ。
    expect(Object.keys(parsed ?? {}).sort()).toEqual(["generated_at", "providers"]);
    const blob = JSON.stringify(parsed);
    expect(blob).not.toContain("polluted");
  });

  it("TDA-3: producer(buildCoverageReport) ↔ parser round-trip 恒等 (silent drift を pin)", () => {
    const gen = new Date(GEN_MS);
    const rows = [
      {
        provider: "codex",
        maxIngestedAtMs: GEN_MS - 10 * MIN,
        maxEventTimestampMs: GEN_MS - 8 * MIN,
        activeSessionCount: 2,
        totalSessionCount: 3,
      },
      {
        provider: "claude_code",
        maxIngestedAtMs: GEN_MS - 20 * MIN,
        maxEventTimestampMs: GEN_MS - 20 * MIN,
        activeSessionCount: 0, // 非稼働 → gap null
        totalSessionCount: 2,
      },
      {
        provider: "gemini",
        maxIngestedAtMs: null, // 無受信 → last_received null / gap null
        maxEventTimestampMs: null,
        activeSessionCount: 1,
        totalSessionCount: 1,
      },
    ];
    const produced = buildCoverageReport(rows, gen);
    // 実 wire を模す JSON round-trip (undefined→欠落 等の JSON 意味論を通す)。
    const roundTripped = parseAuditCoverageReportWire(JSON.parse(JSON.stringify(produced)));
    expect(roundTripped).toEqual(produced);
  });
});
