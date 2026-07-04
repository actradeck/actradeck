/**
 * INV-POLICY-PRESETS (ADR 019f23e1・P3): 承認ポリシー preset (Strict/Balanced/Demo) の契約を pin する。
 *
 * preset は「既存 PolicyCategory 集合への名前付き展開テンプレート」(pure-expand)。enforcement/wire/disk は
 * 変えず、UI は presetCategories を既存 set 経路へ流し matchPreset で逆引き表示する。ここが正準契約になる。
 *
 * 不変条件:
 *  (a) strict = 全 PolicyCategory / balanced ≡ DEFAULT_GATED_CATEGORIES (集合等価) /
 *      demo = {recursive-rm, disk-destroy, fork-bomb}。
 *  (b) demo ⊊ balanced ⊊ strict (真部分集合)。
 *  (c) demo は非空 (default scope の empty→DEFAULT fail-safe に触れない不変条件)。
 *  (d) matchPreset: 各 presetCategories(n)→n / balanced に 1 個増減で undefined / 空集合→undefined /
 *      未知文字列混入は projectPolicyCategories(orderPolicyCategories) で落として評価。
 *  (e) falsifiability: preset メンバーを改変する mutant で該当 assert が赤化する。
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_GATED_CATEGORIES,
  matchPreset,
  POLICY_PRESETS,
  PolicyCategory,
  PRESET_ORDER,
  presetCategories,
  type PolicyPresetName,
} from "../src/index.js";

/** 集合等価 (順序非依存)。 */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sb = new Set(b);
  return a.every((x) => sb.has(x));
}

/** a ⊊ b (真部分集合)。 */
function isProperSubset(a: readonly string[], b: readonly string[]): boolean {
  const sb = new Set(b);
  return a.length < b.length && a.every((x) => sb.has(x));
}

describe("POLICY_PRESETS: 各 preset の exact set (a)", () => {
  it("strict = 全 PolicyCategory", () => {
    expect(sameSet(POLICY_PRESETS.strict, PolicyCategory.options)).toBe(true);
    expect(POLICY_PRESETS.strict).toHaveLength(PolicyCategory.options.length);
  });

  it("balanced ≡ DEFAULT_GATED_CATEGORIES (集合等価・二重定義しない導出)", () => {
    expect(sameSet(POLICY_PRESETS.balanced, DEFAULT_GATED_CATEGORIES)).toBe(true);
  });

  it("demo = {recursive-rm, disk-destroy, fork-bomb}", () => {
    expect(sameSet(POLICY_PRESETS.demo, ["recursive-rm", "disk-destroy", "fork-bomb"])).toBe(true);
  });

  it("各 preset は PolicyCategory.options の安定順 (手書き順序非依存・diff 安定)", () => {
    for (const name of PRESET_ORDER) {
      const cats = POLICY_PRESETS[name];
      const ordered = PolicyCategory.options.filter((c) => cats.includes(c));
      expect([...cats]).toEqual(ordered);
    }
  });
});

describe("preset 包含関係 (b)(c)", () => {
  it("demo ⊊ balanced ⊊ strict (真部分集合)", () => {
    expect(isProperSubset(POLICY_PRESETS.demo, POLICY_PRESETS.balanced)).toBe(true);
    expect(isProperSubset(POLICY_PRESETS.balanced, POLICY_PRESETS.strict)).toBe(true);
  });

  it("demo は非空 (empty→DEFAULT fail-safe に触れない)", () => {
    expect(POLICY_PRESETS.demo.length).toBeGreaterThan(0);
    // 全 preset が非空 (どの preset も silent 全 OFF にならない)。
    for (const name of PRESET_ORDER) {
      expect(presetCategories(name).length).toBeGreaterThan(0);
    }
  });
});

describe("presetCategories: 共有 const を汚さない", () => {
  it("返り値の変更が POLICY_PRESETS を破壊しない (新配列コピー)", () => {
    const cats = presetCategories("demo");
    cats.push("db-drop");
    expect(POLICY_PRESETS.demo).not.toContain("db-drop");
    expect(sameSet(presetCategories("demo"), ["recursive-rm", "disk-destroy", "fork-bomb"])).toBe(
      true,
    );
  });
});

describe("matchPreset: 逆引き (d)", () => {
  it("presetCategories(n) を渡すと n を返す (round-trip・全 preset)", () => {
    for (const name of PRESET_ORDER) {
      expect(matchPreset(new Set(presetCategories(name)))).toBe(name);
    }
  });

  it("balanced に 1 個足すと undefined (custom)", () => {
    const looser = new Set<string>([...POLICY_PRESETS.balanced, "perm-change"]);
    expect(matchPreset(looser)).toBeUndefined();
  });

  it("balanced から 1 個引くと undefined (custom)", () => {
    const stricter = new Set<string>(POLICY_PRESETS.balanced.filter((c) => c !== "db-drop"));
    expect(matchPreset(stricter)).toBeUndefined();
  });

  it("空集合は undefined (どの preset も非空ゆえ一致しない)", () => {
    expect(matchPreset(new Set<string>())).toBeUndefined();
  });

  it("未知文字列は projection で落として評価する (NO-RAW)", () => {
    // demo + 未知値 → 未知値は落ちて demo と一致。
    expect(matchPreset(new Set<string>([...POLICY_PRESETS.demo, "bogus", "rm -rf /"]))).toBe(
      "demo",
    );
    // 全て未知値のみ → 空へ落ち undefined。
    expect(matchPreset(new Set<string>(["bogus", "AKIAIOSFODNN7EXAMPLE"]))).toBeUndefined();
  });

  it("順序非依存で逆引きする (入力順に依らない)", () => {
    const reversed = new Set<string>([...POLICY_PRESETS.strict].reverse());
    expect(matchPreset(reversed)).toBe("strict");
  });
});

describe("PRESET_ORDER", () => {
  it("表示順は strict → balanced → demo", () => {
    expect(PRESET_ORDER).toEqual<PolicyPresetName[]>(["strict", "balanced", "demo"]);
  });
});
