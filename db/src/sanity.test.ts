import { describe, expect, it } from "vitest";

// Phase 0 sanity test for db workspace. スキーマ整合テスト (enum/型/制約) は Phase 1/3。
describe("db package skeleton", () => {
  it("is green", () => {
    expect(true).toBe(true);
  });
});
