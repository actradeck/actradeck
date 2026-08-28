/**
 * INV-DB-DROP-ENUMERATION (task 01a0480f-ffca・TDA-DB2-3 ≡ QA-DB2-7 ≡ TDA-DB-4): `db-drop` の literal 列挙は
 * **表示コピーが 4 つ**あり (docs/approval-policy.md の表行 + 注記 / event-model payload.ts docstring / webui i18n
 * ja・en)、機械 pin が無かったため完全性が 3 段階に分裂した (base の i18n が `dropdb` を落とす・head のラベルが
 * 代表形のみ)。本テストは event-model `DB_DROP_LITERAL_FORMS` を単一出所として、
 *   (1) sidecar `LITERAL_RULES` の db-drop 行の `labels` 和集合 == DB_DROP_LITERAL_FORMS (two-way・欠落も過剰も RED)、
 *   (2) docs/approval-policy.md の `db-drop` 表行の backtick 列挙 == 同集合 (two-way)、
 *   (3) docs/approval-policy.md の注記段落が全形を含む (注記は「認識しない形」も語るため片方向)、
 *   (4) payload.ts docstring の `db-drop:` 行の列挙 == 同集合 (two-way)、
 *   (5) webui i18n の `policy.cat.db-drop` は ja/en とも `{forms}` placeholder で**生成**し、列挙コピーを持たない
 * を pin する。分類器の挙動は一切見ない (INV-DB-DROP-RISK-VERDICT が担う)。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DB_DROP_LITERAL_FORMS } from "@actradeck/event-model";

import { LITERAL_RULES } from "../src/normalize.js";

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const FORMS: ReadonlySet<string> = new Set(DB_DROP_LITERAL_FORMS);
const sorted = (xs: Iterable<string>): string[] => [...xs].sort();

describe("INV-DB-DROP-ENUMERATION: db-drop の列挙コピーは DB_DROP_LITERAL_FORMS と two-way に一致", () => {
  it("DB_DROP_LITERAL_FORMS は重複なし・空文字なし・secret 様でない表示名", () => {
    expect(DB_DROP_LITERAL_FORMS.length).toBe(FORMS.size);
    for (const f of DB_DROP_LITERAL_FORMS) {
      expect(f.trim().length, f).toBeGreaterThan(0);
      expect(f.length, f).toBeLessThanOrEqual(32);
    }
  });

  it("(1) LITERAL_RULES の db-drop 行の labels 和集合 == DB_DROP_LITERAL_FORMS (欠落・過剰で RED)", () => {
    const rows = LITERAL_RULES.filter((r) => r.category === "db-drop");
    expect(rows.length).toBeGreaterThan(0);
    const union = new Set<string>();
    for (const r of rows) {
      expect(r.labels.length, `${String(r.re)} has a label`).toBeGreaterThan(0);
      for (const l of r.labels) {
        expect(union.has(l), `label ${l} appears on two rows`).toBe(false);
        union.add(l);
      }
    }
    expect(sorted(union)).toEqual(sorted(FORMS));
  });

  it("(1') 全 LITERAL_RULES 行が非空の labels を持つ (テーブル契約)", () => {
    for (const r of LITERAL_RULES) {
      expect(r.labels.length, String(r.re)).toBeGreaterThan(0);
    }
  });

  it("(2) docs/approval-policy.md の db-drop 表行の列挙 == DB_DROP_LITERAL_FORMS", () => {
    const doc = read("../../../docs/approval-policy.md");
    const row = doc.split("\n").find((l) => l.startsWith("| `db-drop`"));
    expect(row, "db-drop table row").toBeDefined();
    const cell = row!.split("|")[2]!;
    // QA-FF-3: indexOf が -1 だと slice(0, -1) が非空になり length guard が自己充足するので、marker の存在を先に pin する。
    expect(cell, "row cell carries the '(literal list' marker").toContain("(literal list");
    const list = cell.slice(0, cell.indexOf("(literal list"));
    expect(list.length, "row cell lists forms before the marker").toBeGreaterThan(0);
    const tokens = [...list.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
    expect(sorted(tokens)).toEqual(sorted(FORMS));
    // 表示順もテーブル順 (読者が LITERAL_RULES と突き合わせられる)。
    expect(tokens).toEqual([...DB_DROP_LITERAL_FORMS]);
  });

  it("(3) docs/approval-policy.md の db-drop 注記は全形を含む (片方向・注記は非認識形も語る)", () => {
    const doc = read("../../../docs/approval-policy.md");
    const start = doc.indexOf("> **`db-drop` is a literal list");
    expect(start, "db-drop note paragraph").toBeGreaterThanOrEqual(0);
    const end = doc.indexOf("\n\n", start);
    const note = doc.slice(start, end).replace(/`/g, "");
    for (const f of DB_DROP_LITERAL_FORMS) {
      expect(note.includes(f), `note mentions ${f}`).toBe(true);
    }
  });

  it("(4) event-model payload.ts docstring の db-drop 行の列挙 == DB_DROP_LITERAL_FORMS", () => {
    const src = read("../../../packages/event-model/src/payload.ts");
    const lines = src.split("\n");
    const i = lines.findIndex((l) => /^\s*\*\s*- db-drop:/.test(l));
    expect(i, "db-drop docstring line").toBeGreaterThanOrEqual(0);
    // 継続行 (次の `- <category>:` 行まで) を連結し、`(literal list` の手前を列挙として読む。
    let text = lines[i]!.replace(/^\s*\*\s*- db-drop:/, "");
    for (let j = i + 1; j < lines.length && !/^\s*\*\s*- [a-z-]+:/.test(lines[j]!); j++) {
      text += " " + lines[j]!.replace(/^\s*\*\s?/, "");
    }
    expect(text, "docstring carries the '(literal list' marker").toContain("(literal list");
    const list = text.slice(0, text.indexOf("(literal list"));
    expect(list.length, "docstring lists forms before the marker").toBeGreaterThan(0);
    const tokens = list
      .split("/")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    expect(sorted(tokens)).toEqual(sorted(FORMS));
    expect(tokens).toEqual([...DB_DROP_LITERAL_FORMS]);
  });

  it("(5) webui i18n の policy.cat.db-drop は ja/en とも {forms} で生成し、列挙コピーを持たない", () => {
    const src = read("../../webui/src/ui/i18n/messages.ts");
    const values = [...src.matchAll(/"policy\.cat\.db-drop":\s*"([^"]*)"/g)].map((m) => m[1]!);
    expect(values.length, "ja + en").toBe(2);
    for (const v of values) {
      expect(v.includes("{forms}"), v).toBe(true);
      for (const f of DB_DROP_LITERAL_FORMS) {
        expect(v.includes(f), `no hard-coded copy of ${f} in ${v}`).toBe(false);
      }
    }
  });
});
