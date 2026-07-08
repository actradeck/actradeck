/**
 * INV-TOKEN-EQUALS: 定数時間トークン比較の正典 (repo 単一出所・TDA-5 sweep)。
 *
 * 5 箇所に手書きコピーされていた比較 helper を寄せた canonical の意味論を固定する:
 * fail-safe deny (非文字列 / 空 provided / 空 expected / 長さ・内容不一致 → false)、一致のみ true。
 * timingSafeEqual の同長前提 (長さ不一致は先行 false) も pin する。
 */
import { describe, expect, it } from "vitest";

import { tokenEquals } from "../src/token-equals.js";

const TOKEN = "tok_0123456789abcdef0123456789abcdef";

describe("INV-TOKEN-EQUALS: canonical 定数時間トークン比較", () => {
  it("一致は true", () => {
    expect(tokenEquals(TOKEN, TOKEN)).toBe(true);
  });

  it("内容不一致 (同長) は false", () => {
    const sameLenDiff = TOKEN.slice(0, -1) + (TOKEN.endsWith("f") ? "0" : "f");
    expect(sameLenDiff.length).toBe(TOKEN.length);
    expect(tokenEquals(TOKEN, sameLenDiff)).toBe(false);
  });

  it("長さ不一致は false (timingSafeEqual の同長前提を先行ガード)", () => {
    expect(tokenEquals(TOKEN, TOKEN + "x")).toBe(false);
    expect(tokenEquals(TOKEN, TOKEN.slice(0, -1))).toBe(false);
  });

  it("provided が非文字列 / undefined / null / 数値 は false (unknown 受理・fail-safe)", () => {
    expect(tokenEquals(TOKEN, undefined)).toBe(false);
    expect(tokenEquals(TOKEN, null)).toBe(false);
    expect(tokenEquals(TOKEN, 42)).toBe(false);
    expect(tokenEquals(TOKEN, { token: TOKEN })).toBe(false);
  });

  it("空 provided は false", () => {
    expect(tokenEquals(TOKEN, "")).toBe(false);
  });

  it("空 expected は false (未設定 token で照合しない — 空==空も拒否)", () => {
    // QA-1 註記 (裁定 019f3ed6): この意味論は expected-guard 単独では falsify できない
    // (provided 側 guard + 長さ不一致でも同じ false に落ちる = defense-in-depth の重なり)。
    // 本テストは「空 expected を許可し始めたら赤」という意味論の外形 pin として維持する。
    expect(tokenEquals("", "")).toBe(false);
    expect(tokenEquals("", TOKEN)).toBe(false);
    // SEC-1: 型を欠いた caller の undefined/null expected も throw せず clean deny。
    expect(tokenEquals(undefined as unknown as string, TOKEN)).toBe(false);
    expect(tokenEquals(null as unknown as string, TOKEN)).toBe(false);
  });

  it("マルチバイト (utf8) でも一致/不一致が正しい", () => {
    expect(tokenEquals("秘密トークン", "秘密トークン")).toBe(true);
    expect(tokenEquals("秘密トークン", "秘密トーケン")).toBe(false);
  });
});
