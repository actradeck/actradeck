/**
 * INV-REDACTION-KINDS: redaction kind 語彙の T1 正典契約。
 *
 * 契約 (T1):
 * - `REDACTION_KINDS` は「redaction の種類」の単一権威 (closed-enum vocabulary)。
 * - 全 kind は `[a-z0-9-]+` で、redactor マーカー文字クラスと両立し prototype 名と衝突しない。
 * - `REDACTION_KINDS_SET` / `isKnownRedactionKind` が正しく既知判定する (phantom は false)。
 * - 重複が無い (集合として well-formed)。
 *
 * sidecar `REDACTION_RULES.kind ⊆ REDACTION_KINDS` の部分集合 pin は sidecar 側
 * (apps/sidecar/test) に置く (依存方向: event-model は sidecar を import 不可)。
 */
import { describe, expect, it } from "vitest";

import {
  REDACTION_KINDS,
  REDACTION_KINDS_SET,
  REDACTION_MARKER_KIND_CHARSET,
  REDACTION_MARKER_PREFIX,
  REDACTION_MARKER_SUFFIX,
  REDACTION_MARKER_PATTERN,
  REDACTION_MARKER_KIND_PATTERN,
  redactionMarker,
  gateRedactionCountByKind,
  isKnownRedactionKind,
} from "../src/index.js";

describe("INV-REDACTION-KINDS", () => {
  it("exposes a non-empty canonical vocabulary", () => {
    expect(REDACTION_KINDS.length).toBeGreaterThan(0);
    // 既知の代表 kind を pin (redactor の安定 enum)。
    expect(REDACTION_KINDS).toContain("github-token");
    expect(REDACTION_KINDS).toContain("aws-access-key-id");
    expect(REDACTION_KINDS).toContain("anthropic-key");
    expect(REDACTION_KINDS).toContain("high-entropy-secret");
  });

  it("has no duplicate kinds (well-formed set)", () => {
    expect(REDACTION_KINDS_SET.size).toBe(REDACTION_KINDS.length);
  });

  it("every kind matches [a-z0-9-]+ (marker charset compatible, no prototype collision)", () => {
    for (const k of REDACTION_KINDS) {
      expect(k).toMatch(/^[a-z0-9-]+$/);
      // prototype 名と衝突しない (projection gate / null-proto 二重防御の前提)。
      expect(["constructor", "__proto__", "prototype", "toString"]).not.toContain(k);
    }
  });

  it("marker pattern source は charset から構築され全 kind を完全捕捉する (TDA-2 single-source)", () => {
    // 文字クラス内容は単一定数 REDACTION_MARKER_KIND_CHARSET のみ。両 pattern はそこから構築される
    // (sidecar REDACTION_MARKER_RE / backend ALL_MARKERS_REGEX が再ハードコードせず共有する正典 source)。
    expect(REDACTION_MARKER_PATTERN).toBe(`\\[REDACTED:[${REDACTION_MARKER_KIND_CHARSET}]+\\]`);
    expect(REDACTION_MARKER_KIND_PATTERN).toBe(
      `\\[REDACTED:([${REDACTION_MARKER_KIND_CHARSET}]+)\\]`,
    );
    // 全 kind を redactionMarker() で marker 化すると pattern が完全一致し、kind 捕捉版は kind を
    // group 1 に正しく取る (write builder ↔ read pattern の round-trip を builder 経由で pin)。
    const full = new RegExp(`^${REDACTION_MARKER_PATTERN}$`);
    const kindRe = new RegExp(`^${REDACTION_MARKER_KIND_PATTERN}$`);
    for (const k of REDACTION_KINDS) {
      const marker = redactionMarker(k);
      expect(full.test(marker), `${k}: pattern no full match`).toBe(true);
      expect(kindRe.exec(marker)?.[1], `${k}: kind capture mismatch`).toBe(k);
    }
  });

  it("marker label prefix/suffix は単一 source で write/read が共有する (TDA-5 single-source)", () => {
    // ラベル書式の正典値を pin (write token と read SQL/pattern が再 type しない単一 source)。
    expect(REDACTION_MARKER_PREFIX).toBe("[REDACTED:");
    expect(REDACTION_MARKER_SUFFIX).toBe("]");
    // builder はマスク文字列を産む唯一の経路 (sidecar token() = redactionMarker)。
    expect(redactionMarker("github-token")).toBe("[REDACTED:github-token]");
    expect(redactionMarker("oauth2-token")).toBe("[REDACTED:oauth2-token]");
    // regex pattern は同じ接頭/接尾から構築される (エスケープ後 byte 一致)。接頭/接尾を
    // 片側で変えると builder か pattern のいずれかがこの組で割れて赤化する。
    const full = new RegExp(`^${REDACTION_MARKER_PATTERN}$`);
    expect(full.test(redactionMarker("github-token"))).toBe(true);
    // pattern は接頭/接尾の正規表現エスケープ形で開始/終了する (`[`→`\\[`, `]`→`\\]`)。
    expect(REDACTION_MARKER_PATTERN.startsWith("\\[REDACTED:")).toBe(true);
    expect(REDACTION_MARKER_PATTERN.endsWith("\\]")).toBe(true);
  });

  it("marker charset includes digits (narrowing forward-drift gate)", () => {
    // 現 vocabulary に digit kind は無いため合成マーカーで charset⊇[0-9] を直接 pin する。
    // charset を [a-z-] に狭めると digit-kind が途中で切れて全体不一致 → 赤化。
    const kindRe = new RegExp(`^${REDACTION_MARKER_KIND_PATTERN}$`);
    expect(kindRe.exec("[REDACTED:oauth2-token]")?.[1]).toBe("oauth2-token");
  });

  it("REDACTION_KINDS_SET / isKnownRedactionKind agree and reject phantom kinds", () => {
    for (const k of REDACTION_KINDS) {
      expect(REDACTION_KINDS_SET.has(k)).toBe(true);
      expect(isKnownRedactionKind(k)).toBe(true);
    }
    expect(isKnownRedactionKind("foo-bar")).toBe(false);
    expect(isKnownRedactionKind("constructor")).toBe(false);
    expect(isKnownRedactionKind("ghp_FAKE_NOT_A_KIND")).toBe(false);
  });
});

/**
 * INV-REDACTION-COUNT-GATE (SEC-1r / SEC-3 / TDA-1/TDA-2): kind 別件数 jsonb を信頼境界で gate する
 * **単一 helper** の契約。read/carry (ingest parse / realtime DTO / webui) と write/集計/merge
 * (projection / audit) はすべて本 helper へ委譲するため、ここが gate ロジックの唯一の pin。
 * falsifiable: key allowlist / 正整数値域 / null-proto いずれを外しても該当ケースが赤化する。
 */
describe("INV-REDACTION-COUNT-GATE: gateRedactionCountByKind", () => {
  it("keeps known kinds with a positive integer count", () => {
    expect(gateRedactionCountByKind({ "github-token": 2, "aws-access-key-id": 1 })).toEqual({
      "github-token": 2,
      "aws-access-key-id": 1,
    });
  });

  it("drops phantom / 語彙外 kinds even with a valid count (closed-enum key gate)", () => {
    expect(
      gateRedactionCountByKind({ "github-token": 2, "phantom-evil-kind": 9, "not-a-kind": 5 }),
    ).toEqual({ "github-token": 2 });
  });

  it("drops prototype-name keys (constructor / __proto__) — gate と null-proto の二重防御", () => {
    const raw = JSON.parse('{"github-token": 1, "constructor": 7, "__proto__": 3}') as unknown;
    const out = gateRedactionCountByKind(raw, true);
    expect(out).toEqual({ "github-token": 1 });
    expect(Object.getPrototypeOf(out)).toBeNull(); // nullProto=true
    expect(Object.prototype.hasOwnProperty.call(out, "constructor")).toBe(false);
  });

  it("enforces a positive-integer value domain (drops 0 / negative / float / non-number)", () => {
    expect(
      gateRedactionCountByKind({
        "github-token": 0, // 観測なし → 落とす
        "aws-access-key-id": -1, // 負 → 落とす
        "anthropic-key": 1.5, // 非整数 → 落とす
        "openai-key": "3", // 非数値 → 落とす
        "slack-token": 4, // 正整数 → 採用
      }),
    ).toEqual({ "slack-token": 4 });
  });

  it("returns empty for non-object input (null / array / primitive)", () => {
    expect(gateRedactionCountByKind(null)).toEqual({});
    expect(gateRedactionCountByKind(["github-token"])).toEqual({});
    expect(gateRedactionCountByKind(42)).toEqual({});
    expect(gateRedactionCountByKind(undefined)).toEqual({});
  });

  it("nullProto flag controls the output prototype (plain object by default)", () => {
    expect(Object.getPrototypeOf(gateRedactionCountByKind({ "github-token": 1 }))).toBe(
      Object.prototype,
    );
    expect(Object.getPrototypeOf(gateRedactionCountByKind({ "github-token": 1 }, true))).toBeNull();
  });
});
