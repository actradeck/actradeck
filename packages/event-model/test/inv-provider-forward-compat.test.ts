/**
 * INV-PROVIDER-FORWARD-COMPAT: provider は slug 開放 (ADR 019f2d2c D1)、
 * source は closed enum + "external" (D2)。
 *
 * 契約 (T1・#6a 公開取込コントラクト):
 * - 既知 provider (claude_code / codex) の意味論は不変 (KNOWN_PROVIDERS 定数保持)。
 * - 未知だが valid な slug (例 my_tool / gemini / a) は受理され pipeline を貫通する。
 * - **非 slug は fail-safe reject** (6 クラス: 大文字・空白・記号・33字+・空文字・非文字列)。
 *   regex 自体が parse 境界の NO-RAW sanitizer ゆえ secret/生パス/生コマンドを運べない。
 * - source は closed。"external" は additive で受理・その他未知は reject。
 * - **falsifiability**: regex を無界化 (z.string()) すると reject クラスが GREEN=RED になる。
 */
import { describe, expect, it } from "vitest";

import {
  Provider,
  Source,
  KNOWN_PROVIDERS,
  PROVIDER_SLUG_RE,
  isKnownProvider,
  safeParseEvent,
} from "../src/index.js";
import { validEvent } from "./helpers.js";

describe("INV-PROVIDER-FORWARD-COMPAT", () => {
  // --- 既知 provider は不変 ---
  it("keeps KNOWN_PROVIDERS = [claude_code, codex] (意味論分岐の基準)", () => {
    expect([...KNOWN_PROVIDERS]).toEqual(["claude_code", "codex"]);
  });

  it.each(["claude_code", "codex"])("accepts known provider %s and marks it known", (p) => {
    expect(Provider.safeParse(p).success).toBe(true);
    expect(isKnownProvider(p)).toBe(true);
    expect(safeParseEvent(validEvent({ provider: p })).success).toBe(true);
  });

  // --- 未知 slug は受理 (開放) ・ただし KNOWN ではない ---
  it.each(["my_tool", "gemini", "aider", "cursor-agent", "a", "x9", "z".repeat(32)])(
    "accepts unknown-but-valid slug %s and it flows through parseEvent",
    (slug) => {
      expect(Provider.safeParse(slug).success).toBe(true);
      expect(isKnownProvider(slug)).toBe(false);
      const res = safeParseEvent(validEvent({ provider: slug }));
      expect(res.success).toBe(true);
      if (res.success) expect(res.data.provider).toBe(slug);
    },
  );

  // --- 非 slug 6 クラス: fail-safe reject (NO-RAW by construction) ---
  const rejectClasses: ReadonlyArray<readonly [string, unknown]> = [
    ["uppercase", "Gemini"],
    ["whitespace", "my tool"],
    ["symbol/path/quote", "../etc"],
    ["over-32-chars", "a".repeat(33)],
    ["empty string", ""],
    ["non-string", 123],
  ];
  it.each(rejectClasses)("rejects non-slug provider class: %s", (_label, value) => {
    expect(Provider.safeParse(value).success).toBe(false);
    expect(safeParseEvent(validEvent({ provider: value as never })).success).toBe(false);
  });

  // 追加 reject: 数字始まり / 大文字混在 / 制御文字 / スラッシュ / 先頭記号
  it.each(["9lives", "Claude_Code", "tok\nen", "a/b", "-lead", "_lead", "dot.ted", "spa ce"])(
    "rejects additional non-slug shapes: %s",
    (value) => {
      expect(Provider.safeParse(value).success).toBe(false);
    },
  );

  // QA-2 (R2): named non-ASCII / emoji / marker 形の負ケース。PROVIDER_SLUG_RE は
  //   `[a-z0-9_-]` のみ許可ゆえ、多言語文字・fullwidth・emoji・redaction marker 形は
  //   すべて非 slug として reject される (NO-RAW の charset 有界化を代表入力で固定)。
  const nonAsciiRejectClasses: ReadonlyArray<readonly [string, string]> = [
    ["japanese", "ツール"],
    ["japanese-mixed", "my_ツール"],
    ["accented-latin (café)", "café"],
    ["fullwidth-ascii", "ｃｌａｕｄｅ"],
    ["cyrillic-homoglyph", "сlaude"],
    ["emoji", "🚀tool"],
    ["emoji-only", "🚀"],
    ["redaction-marker-form", "[REDACTED:github-token]"],
    ["marker-bare", "[REDACTED:x]"],
  ];
  it.each(nonAsciiRejectClasses)(
    "rejects non-ASCII / emoji / marker provider: %s",
    (_label, value) => {
      expect(Provider.safeParse(value).success).toBe(false);
      expect(safeParseEvent(validEvent({ provider: value as never })).success).toBe(false);
    },
  );

  // 正直な限界の開示: 32 字以内の小文字英数+_- なら secret 様文字列も slug として通る。
  // regex は charset/長さで有界化するが「秘匿値か」の意味判定はしない (NO-RAW ≠ 秘匿検出)。
  // 実 secret (token/key) は長さ・大文字混在・記号で大半が reject される。
  it("bounds charset/length, not secrecy: a short lowercase token-shaped slug is a valid slug", () => {
    expect(Provider.safeParse("sk_live_abcdef").success).toBe(true);
  });

  it("PROVIDER_SLUG_RE anchors both ends (no substring leakage)", () => {
    // 埋め込まれた valid slug でも full-match でなければ reject。
    expect(PROVIDER_SLUG_RE.test("claude_code")).toBe(true);
    expect(PROVIDER_SLUG_RE.test("x claude_code x")).toBe(false);
    expect(PROVIDER_SLUG_RE.test("claude_code\ninjected")).toBe(false);
  });

  it("upper bound is exactly 32 chars (32 ok, 33 reject)", () => {
    expect(Provider.safeParse("a".repeat(32)).success).toBe(true);
    expect(Provider.safeParse("a".repeat(33)).success).toBe(false);
  });

  // --- source (HOW) closed enum ---
  it("accepts source external (D2 additive) via schema and parseEvent", () => {
    expect(Source.safeParse("external").success).toBe(true);
    expect(safeParseEvent(validEvent({ source: "external" })).success).toBe(true);
  });

  it.each(["hooks", "app_server", "rollout", "sdk", "external"])(
    "accepts known source %s (closed enum membership)",
    (s) => {
      expect(Source.safeParse(s).success).toBe(true);
    },
  );

  it.each(["telnet", "External", "http", "", "sidecar"])(
    "rejects unknown source %s (source stays closed・D2)",
    (s) => {
      expect(Source.safeParse(s).success).toBe(false);
    },
  );
});
