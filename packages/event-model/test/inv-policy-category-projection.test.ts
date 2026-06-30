/**
 * INV-POLICY-CATEGORY-PROJECTION (TDA-1・decision 019f0e2d): closed-enum 投影の **単一出所**
 * `projectPolicyCategories` を直接 pin する。3 トラスト境界 (sidecar sanitizeCategories /
 * backend resolvePolicy / webui parsePolicy) がこの純関数を共有するため、ここが正準契約になる。
 *
 * 不変条件:
 *  - 出力は常に `PolicyCategory.options` の安定順 (入力順非依存・diff 安定)。
 *  - 未知文字列・非 string・raw コマンド/secret は構造的に落とす (NO-RAW)。
 *  - 非配列 → [] (例外を投げない)。重複は dedupe。
 */
import { describe, expect, it } from "vitest";

import { orderPolicyCategories, PolicyCategory, projectPolicyCategories } from "../src/index.js";

describe("projectPolicyCategories (closed-enum 投影の単一出所)", () => {
  it("有効な category のみを options 安定順で返す (入力順非依存)", () => {
    // 入力は逆順 + 重複だが、出力は options 順・dedupe。
    expect(projectPolicyCategories(["secret-egress", "recursive-rm", "secret-egress"])).toEqual([
      "recursive-rm",
      "secret-egress",
    ]);
  });

  it("未知文字列・raw コマンド・secret 片を構造的に落とす (NO-RAW)", () => {
    expect(
      projectPolicyCategories([
        "recursive-rm",
        "bogus",
        "rm -rf / --secret=AKIAIOSFODNN7EXAMPLE",
        "db-drop",
      ]),
    ).toEqual(["recursive-rm", "db-drop"]);
  });

  it("非 string 要素 (number/object/null/undefined) を落とす", () => {
    expect(
      projectPolicyCategories([
        "disk-destroy",
        42,
        { evil: true },
        null,
        undefined,
        "fork-bomb",
      ] as unknown),
    ).toEqual(["disk-destroy", "fork-bomb"]);
  });

  it("非配列・空配列は [] (例外を投げない)", () => {
    expect(projectPolicyCategories(undefined)).toEqual([]);
    expect(projectPolicyCategories(null)).toEqual([]);
    expect(projectPolicyCategories("recursive-rm")).toEqual([]); // 文字列単体は配列でない
    expect(projectPolicyCategories({ categories: ["recursive-rm"] })).toEqual([]);
    expect(projectPolicyCategories([])).toEqual([]);
  });

  it("全 enum 値を渡すと options と完全一致する (投影は enum を歪めない)", () => {
    const shuffled = [...PolicyCategory.options].reverse();
    expect(projectPolicyCategories(shuffled)).toEqual([...PolicyCategory.options]);
  });
});

/**
 * orderPolicyCategories (TDA-S1-3・decision 019f0e5d): 既に typed な categories 集合を
 * `PolicyCategory.options` の安定順へ整列する単一出所。saveApprovalPolicy / buildPolicyResponse /
 * projectPolicyCategories の整列がこの 1 関数を共有する (順序規則の 3 箇所重複を排除)。
 */
describe("orderPolicyCategories (順序規則の単一出所)", () => {
  it("typed Set を options 安定順へ整列する (挿入順非依存)", () => {
    const set = new Set<PolicyCategory>(["secret-egress", "db-drop", "recursive-rm"]);
    expect(orderPolicyCategories(set)).toEqual(["recursive-rm", "db-drop", "secret-egress"]);
  });

  it("options に無い値は構造的に落とす (closed enum・NO-RAW)", () => {
    const set = new Set<string>(["recursive-rm", "bogus", "rm -rf /"]);
    expect(orderPolicyCategories(set)).toEqual(["recursive-rm"]);
  });

  it("空集合は [] (例外を投げない)", () => {
    expect(orderPolicyCategories(new Set<string>())).toEqual([]);
  });

  it("projectPolicyCategories は orderPolicyCategories と同じ整列規則に従う (委譲の一貫性)", () => {
    const raw = ["secret-egress", "recursive-rm", "db-drop"];
    expect(projectPolicyCategories(raw)).toEqual(orderPolicyCategories(new Set<string>(raw)));
  });
});
