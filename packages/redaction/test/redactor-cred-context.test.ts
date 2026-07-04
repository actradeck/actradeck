/**
 * TDA-3 (R1・decision 019f2d73): redactObject の credential-context 伝播分岐
 * (redactor.ts:1085-1097) を **sink 非依存の pure package test** で exercise する。
 *
 * これらの分岐 (SECRET_KIND_FIELDS keep / cred=true 文脈伝播) は移設前は sidecar の sink.emit
 * 統合テストから到達していたが、分割後 package 単独では未到達 (1087,1091-1097 uncovered) だった。
 * pure な redactDeep 入力で当該分岐に到達させ、leak-safe 挙動を固定する。
 */
import { describe, expect, it } from "vitest";

import { redactDeep } from "@actradeck/redaction";

const GH = "ghp_1234567890abcdefABCDEF1234567890abcd";

describe("redactObject: cred=true 文脈伝播 (redactor.ts:1090-1097)", () => {
  it("credential キー配下の nested object の全 string を文脈マスク (benign inner key でも)", () => {
    // top-level `api_key` (isCredKey) の値が object → redactValue(v, cred=true) で redactObject(cred=true) 再帰。
    //   配下は benign な inner key でも cred=true ゆえ全 string がマスクされる (SEC-FINAL-2)。
    const out = redactDeep({
      api_key: {
        plain: "hello world plaintext value", // string → token("credential-assignment") [1091-1095]
        num: 42, // 非 string → redactValue(v, cred=true) [1096]
        empty: "", // 空文字は温存 [1093-1094]
        nested: { inner: "another secret-ish value" }, // object → cred=true で再帰
        arr: ["array element string", 7], // array → cred=true で再帰
      },
    }) as { api_key: Record<string, unknown> };

    const cred = out.api_key;
    // benign inner key の string は全て credential-assignment marker へ。
    expect(cred.plain).toBe("[REDACTED:credential-assignment]");
    // 空文字は温存 (マスク対象なし)。
    expect(cred.empty).toBe("");
    // 非 string は保持 (構造の決定性)。
    expect(cred.num).toBe(42);
    // nested object 内の string も文脈伝播でマスク。
    expect((cred.nested as Record<string, unknown>).inner).toBe("[REDACTED:credential-assignment]");
    // array 内の string もマスク・非 string は保持。
    const arr = cred.arr as unknown[];
    expect(arr[0]).toBe("[REDACTED:credential-assignment]");
    expect(arr[1]).toBe(7);
    // 構造は保持 (object/array のまま)。
    expect(typeof cred.nested).toBe("object");
    expect(Array.isArray(cred.arr)).toBe(true);
    // 原文の raw は当然どこにも残らない (benign fixture だが marker 化を確認)。
    expect(JSON.stringify(out)).toContain("[REDACTED:credential-assignment]");
  });
});

describe("redactObject: SECRET_KIND_FIELDS (secret_kinds) 値ゲート (redactor.ts:1085-1087)", () => {
  it("secret_kinds 配列は既知 kind を keep し、未知/secret 形は redactString でマスク", () => {
    // key "secret_kinds" ∈ SECRET_KIND_FIELDS → redactSecretKindsValue へ分岐 (1085-1087)。
    const out = redactDeep({
      secret_kinds: ["github-token", GH, "high-entropy-secret", 123],
    }) as { secret_kinds: unknown[] };

    const kinds = out.secret_kinds;
    // 既知 kind (公開 enum) は verbatim keep。
    expect(kinds[0]).toBe("github-token");
    expect(kinds[2]).toBe("high-entropy-secret");
    // secret 形 (raw github token) は leak-safe に redactString でマスク。
    expect(kinds[1]).toBe("[REDACTED:github-token]");
    // 非 string 要素は保持 (fail-safe 再帰・数値はそのまま)。
    expect(kinds[3]).toBe(123);
    // raw secret は残らない。
    expect(JSON.stringify(out)).not.toContain(GH);
  });

  it("secret_kinds が配列でない場合は credential 文脈で fail-safe マスク", () => {
    // 非配列 → redactValue(value, cred=true) 経路 (redactSecretKindsValue の非 Array 分岐)。
    const out = redactDeep({ secret_kinds: `leak ${GH}` }) as { secret_kinds: unknown };
    // 文字列は credential 文脈でマスク (raw 非残留)。
    expect(String(out.secret_kinds)).not.toContain(GH);
    expect(String(out.secret_kinds)).toBe("[REDACTED:credential-assignment]");
  });
});
