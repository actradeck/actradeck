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
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ALL_EVENT_TYPES,
  extractDocEventTypes,
  extractGoldenEvent,
  GOLDEN_DOC_RELPATH,
  isKnownProvider,
  PROVIDER_SLUG_RE,
  safeParseEvent,
} from "../src/index.js";

// doc パスは共有 relpath を自 dir に resolve する (node 依存は test 側・src は node-free を維持)。
const GOLDEN_DOC_PATH = resolve(dirname(fileURLToPath(import.meta.url)), GOLDEN_DOC_RELPATH);

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

  /**
   * INV-CONTRACT-REDOS: contract-doc の抽出正規表現 (GOLDEN_RE / EVENT_TYPES_RE) は
   * js/polynomial-redos を持たない。以前は `\s*([\s\S]*?)\s*` で `\s` が外側 `\s*` と内側
   * `[\s\S]` の両方に一致し、空白多数入力で polynomial backtracking した。捕捉群に隣接する
   * `\s*` を除去し固定リテラルで挟むことで overlap を構造的に消した。
   *
   * ここでは (a) 抽出結果が現行と byte 等価であること (whitespace 変動に不変)、(b) 病的な
   * 大量空白入力で catastrophic backtracking しない (時間上限) こと、を pin する。
   * falsifiable: regex を旧 `\s*([\s\S]*?)\s*` へ戻すと (b) の時間上限を超え RED になる。
   */
  describe("INV-CONTRACT-REDOS: 抽出 regex が polynomial-redos を持たない (js/polynomial-redos)", () => {
    it("golden 抽出はフェンス内前後空白に不変 (capture byte 等価)", () => {
      // フェンス内に余分な先頭/末尾空白を挿入しても、trim 後の JSON.parse 結果は不変。
      const synthetic =
        "冒頭\n<!-- GOLDEN-EVENT:START -->\n\n```json\n\n   " +
        '{"event_id":"x","n":1}' +
        "\n\n```\n<!-- GOLDEN-EVENT:END -->\n末尾";
      expect(extractGoldenEvent(synthetic)).toEqual({ event_id: "x", n: 1 });
      // 実 doc の抽出結果も従来どおり (schema drift テストと重複するが capture 不変を明示 pin)。
      const golden = extractGoldenEvent(raw) as Record<string, unknown>;
      expect(golden.event_id).toBeTypeOf("string");
    });

    it("event_type 抽出は marker 内前後空白に不変 (backtick token 集合等価)", () => {
      const synthetic =
        "<!-- EVENT-TYPES:START -->\n\n   `a.b` `c.d`   \n\n<!-- EVENT-TYPES:END -->";
      expect(extractDocEventTypes(synthetic)).toEqual(["a.b", "c.d"]);
    });

    it("病的な大量空白入力で GOLDEN_RE が catastrophic backtracking しない (時間上限)", () => {
      // START + ```json の後に大量空白 + 閉じフェンス無し → 旧 regex は O(N^2) で backtrack。
      const pathological =
        "<!-- GOLDEN-EVENT:START -->\n```json\n" + " ".repeat(100_000) + "no-close";
      const start = performance.now();
      expect(() => extractGoldenEvent(pathological)).toThrow(/GOLDEN-EVENT marker/);
      const elapsed = performance.now() - start;
      // 線形なら数 ms。旧 polynomial regex では 1s 超。300ms を分離閾値に置く。
      expect(elapsed, `GOLDEN_RE backtracking suspected (${elapsed.toFixed(1)}ms)`).toBeLessThan(
        300,
      );
    });

    it("病的な大量空白入力で EVENT_TYPES_RE が catastrophic backtracking しない (時間上限)", () => {
      const pathological = "<!-- EVENT-TYPES:START -->\n" + " ".repeat(100_000) + "no-end-marker";
      const start = performance.now();
      expect(() => extractDocEventTypes(pathological)).toThrow(/EVENT-TYPES marker/);
      const elapsed = performance.now() - start;
      expect(
        elapsed,
        `EVENT_TYPES_RE backtracking suspected (${elapsed.toFixed(1)}ms)`,
      ).toBeLessThan(300);
    });
  });

  // contract-doc の fail-loud 契約 (marker 欠落 → throw)。「docs を黙って壊す」を CI で赤化させる。
  // 単一出所化 (PR-2 QA-3/TDA-1) で public API 化した抽出器の throw 分岐を pin する。
  describe("fail-loud: marker が欠けたら throw (docs 破壊を黙って通さない)", () => {
    it("GOLDEN-EVENT marker が無い markdown で extractGoldenEvent が throw する", () => {
      expect(() => extractGoldenEvent("# ドキュメント\n本文に golden なし")).toThrow(
        /GOLDEN-EVENT marker/,
      );
    });

    it("EVENT-TYPES marker が無い markdown で extractDocEventTypes が throw する", () => {
      expect(() => extractDocEventTypes("# ドキュメント\nevent_type 列挙なし")).toThrow(
        /EVENT-TYPES marker/,
      );
    });
  });
});
