/**
 * INV-CONTRACT-GOLDEN: docs/ingestion-contract.md の golden example が
 * NormalizedEvent schema に対して valid であり続ける (ADR 019f2d2c D5)。
 *
 * anti-drift by construction: 読者がコピーする **doc 内の実バイト列**を抽出して parseEvent に通す。
 * schema が変わって doc の example が無効化すると、このテストが RED になる (doc↔schema の非 drift 固定)。
 * さらに example が D1 (provider = 未知 slug) / D2 (source = external) を実際に行使することを確認する。
 *
 * 対になる実 /ingest 経路の検証は apps/backend/test/inv-contract-golden.test.ts (real PG POST)。
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ALL_EVENT_TYPES,
  isKnownProvider,
  PROVIDER_SLUG_RE,
  safeParseEvent,
} from "../src/index.js";
import { extractDocEventTypes, extractGoldenEvent, GOLDEN_DOC_PATH } from "./golden-contract.js";

describe("INV-CONTRACT-GOLDEN: docs/ingestion-contract.md の golden example", () => {
  const raw = readFileSync(GOLDEN_DOC_PATH, "utf8");

  it("doc から golden example を抽出できる (marker が存在する)", () => {
    const golden = extractGoldenEvent(raw);
    expect(golden).toBeTypeOf("object");
    expect(golden).not.toBeNull();
  });

  it("golden example が NormalizedEvent schema を満たす (schema drift → RED)", () => {
    const golden = extractGoldenEvent(raw);
    const res = safeParseEvent(golden);
    if (!res.success) {
      // 失敗理由を可視化 (raw secret は golden に無い)。
      throw new Error(`golden example failed parseEvent: ${res.error.message}`);
    }
    expect(res.success).toBe(true);
  });

  it("golden example が D1 (provider = 未知 slug) を行使する", () => {
    const golden = extractGoldenEvent(raw) as Record<string, unknown>;
    const provider = String(golden.provider);
    expect(PROVIDER_SLUG_RE.test(provider)).toBe(true);
    expect(isKnownProvider(provider)).toBe(false); // 既知 2 値ではない = 開放を実証
  });

  it("golden example が D2 (source = external) を行使する", () => {
    const golden = extractGoldenEvent(raw) as Record<string, unknown>;
    expect(golden.source).toBe("external");
  });

  // TDA-3: doc §4.3 の event_type 列挙 (EVENT-TYPES marker) が ALL_EVENT_TYPES と集合一致する。
  //   doc で type を増減/typo すると RED になる (fail-loud・列挙ドリフト検出)。
  describe("TDA-3: docs §4.3 event_type 列挙 ≡ ALL_EVENT_TYPES (集合一致 pin)", () => {
    it("doc marker から event_type を抽出できる", () => {
      const docTypes = extractDocEventTypes(raw);
      expect(docTypes.length).toBeGreaterThanOrEqual(18);
    });

    it("doc の列挙集合と ALL_EVENT_TYPES 集合が完全一致する", () => {
      const docSet = new Set(extractDocEventTypes(raw));
      const canonSet = new Set<string>(ALL_EVENT_TYPES);
      // 差分を両方向で可視化 (どちらに typo/増減があるか特定できる)。
      const missingInDoc = [...canonSet].filter((t) => !docSet.has(t));
      const extraInDoc = [...docSet].filter((t) => !canonSet.has(t));
      expect(missingInDoc, `doc に欠けている event_type: ${missingInDoc.join(", ")}`).toEqual([]);
      expect(extraInDoc, `doc に余分な event_type: ${extraInDoc.join(", ")}`).toEqual([]);
      // サイズも一致 (重複記載も検出)。
      expect(docSet.size).toBe(canonSet.size);
      expect(extractDocEventTypes(raw).length).toBe(canonSet.size);
    });
  });
});
