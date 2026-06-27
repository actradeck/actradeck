/**
 * INV-I18N: 国際化の不変条件 (設計裁定 019eb745)。
 *
 * 型でもキー完全性は守るが (en: Record<MessageKey,string>)、実行時にも赤線化する:
 *  - INV-I18N-COMPLETENESS:      ja と en のキー集合が双方向に一致。
 *  - INV-I18N-PLACEHOLDER-PARITY: 各キーの {param} プレースホルダ集合が ja/en で一致。
 *  - INV-I18N-NO-RAW-CJK:        src/ui + app + src/replay のソースから **コメントを除去した後**、
 *                                i18n/messages.ts 以外に CJK リテラルが残らない (ハードコード禁止)。
 *
 * コメント (行コメントとブロックコメント) は日本語のまま残す仕様なので、除去処理が正しくないと偽陽性になる。
 */
import { describe, expect, it } from "vitest";

import { CATALOGS_FOR_TEST, LOCALES, t, type Locale } from "../src/ui/i18n/messages.js";
import { BROWSER_SOURCES } from "./_support/browser-graph.js";

/** メッセージ文字列から `{param}` の名前集合を抽出する。 */
function placeholders(template: string): Set<string> {
  const out = new Set<string>();
  const re = /\{(\w+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) out.add(m[1]!);
  return out;
}

const CJK_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/;

/**
 * ソースから行コメントとブロックコメントを除去する。文字列/テンプレート/
 * 正規表現リテラル内の `//` を誤ってコメント開始扱いしないよう、状態機械で走査する。
 * 除去後のソースに CJK が残れば「ユーザー可視文字列のハードコード」とみなす。
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  type Mode = "code" | "line" | "block" | "sq" | "dq" | "tpl";
  let mode: Mode = "code";
  while (i < n) {
    const c = src[i]!;
    const c2 = i + 1 < n ? src[i + 1]! : "";
    if (mode === "code") {
      if (c === "/" && c2 === "/") {
        mode = "line";
        i += 2;
        continue;
      }
      if (c === "/" && c2 === "*") {
        mode = "block";
        i += 2;
        continue;
      }
      if (c === "'") {
        mode = "sq";
        out += c;
        i++;
        continue;
      }
      if (c === '"') {
        mode = "dq";
        out += c;
        i++;
        continue;
      }
      if (c === "`") {
        mode = "tpl";
        out += c;
        i++;
        continue;
      }
      out += c;
      i++;
      continue;
    }
    if (mode === "line") {
      if (c === "\n") {
        mode = "code";
        out += c;
      }
      i++;
      continue;
    }
    if (mode === "block") {
      if (c === "*" && c2 === "/") {
        mode = "code";
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    // 文字列/テンプレートリテラル内: そのまま残し、エスケープと閉じを追う。
    if (c === "\\") {
      out += c + c2;
      i += 2;
      continue;
    }
    if (
      (mode === "sq" && c === "'") ||
      (mode === "dq" && c === '"') ||
      (mode === "tpl" && c === "`")
    ) {
      mode = "code";
    }
    out += c;
    i++;
  }
  return out;
}

const MESSAGES_REL = "src/ui/i18n/messages.ts";

describe("INV-I18N-COMPLETENESS: ja/en key sets match bidirectionally", () => {
  it("ja and en have identical key sets", () => {
    const jaKeys = Object.keys(CATALOGS_FOR_TEST.ja).sort();
    const enKeys = Object.keys(CATALOGS_FOR_TEST.en).sort();
    const missingInEn = jaKeys.filter((k) => !(k in CATALOGS_FOR_TEST.en));
    const missingInJa = enKeys.filter((k) => !(k in CATALOGS_FOR_TEST.ja));
    expect(missingInEn, `en に欠落: ${missingInEn.join(", ")}`).toEqual([]);
    expect(missingInJa, `ja に欠落: ${missingInJa.join(", ")}`).toEqual([]);
    expect(enKeys).toEqual(jaKeys);
  });

  it("every catalog value is a non-empty string for all locales", () => {
    for (const loc of LOCALES) {
      const cat = CATALOGS_FOR_TEST[loc];
      for (const [k, v] of Object.entries(cat)) {
        expect(typeof v, `${loc}.${k} は string`).toBe("string");
      }
    }
  });
});

describe("INV-I18N-PLACEHOLDER-PARITY: {param} sets match per key across locales", () => {
  it("ja and en placeholders are identical for every key", () => {
    const mismatches: string[] = [];
    for (const key of Object.keys(CATALOGS_FOR_TEST.ja)) {
      const jaSet = placeholders(CATALOGS_FOR_TEST.ja[key]!);
      const enSet = placeholders(CATALOGS_FOR_TEST.en[key]!);
      const a = [...jaSet].sort().join(",");
      const b = [...enSet].sort().join(",");
      if (a !== b) mismatches.push(`${key}: ja={${a}} en={${b}}`);
    }
    expect(mismatches, `placeholder 不一致: ${mismatches.join(" | ")}`).toEqual([]);
  });
});

describe("INV-I18N-NO-RAW-CJK: no CJK literals outside messages.ts (comments stripped)", () => {
  it("strip helper does not mistake // inside strings for comments (self-check)", () => {
    expect(stripComments('const u = "https://x/ア";')).toContain("ア");
    expect(stripComments("// 日本語コメント\nconst x = 1;")).not.toContain("日本語");
    expect(stripComments("/* 日本語ブロック */ const y = 2;")).not.toContain("日本語");
  });

  it("scans a non-empty set of browser-graph sources (sanity)", () => {
    expect(BROWSER_SOURCES.length).toBeGreaterThan(0);
  });

  it("no browser-graph source (except messages.ts) contains raw CJK after comment strip", () => {
    const offenders: Array<{ path: string; sample: string }> = [];
    for (const { path, source } of BROWSER_SOURCES) {
      if (path.replace(/\\/g, "/").endsWith(MESSAGES_REL)) continue;
      const stripped = stripComments(source);
      if (CJK_RE.test(stripped)) {
        const line = stripped
          .split("\n")
          .find((l) => CJK_RE.test(l))
          ?.trim();
        offenders.push({ path, sample: line ?? "" });
      }
    }
    expect(
      offenders,
      `CJK リテラルが残存 (t()/カタログへ移行せよ):\n${offenders
        .map((o) => `  ${o.path}: ${o.sample}`)
        .join("\n")}`,
    ).toEqual([]);
  });
});

describe("t(): placeholder replacement", () => {
  it("substitutes named params and leaves unknowns intact", () => {
    expect(t("ja", "risk.files", { count: 3 })).toBe("変更ファイル: 3");
    expect(t("en", "risk.files", { count: 3 })).toBe("Changed files: 3");
    // params 無しのプレースホルダ付きキーは原文 {x} を残す (空文字にしない)。
    expect(t("ja", "risk.files")).toContain("{count}");
  });

  it("returns plain templates without params unchanged", () => {
    expect(t("ja", "approval.allow")).toBe("許可");
    expect(t("en", "approval.allow")).toBe("Allow");
  });

  it("unknown locale falls back to ja", () => {
    expect(t("de" as Locale, "approval.allow")).toBe("許可");
  });
});
