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

/**
 * QA-FF-2: 表示名が散文の中に **語として** 現れるか。
 *
 * 部分文字列一致だと `DROP TABLESPACE` が `DROP TABLE` の言及として通る — 注記は
 * `DROP TABLESPACE` を「認識しない形」として実際に名指ししているので、`DROP TABLE` の言及を
 * 丸ごと削っても検査が空虚に充足していた。境界は form の**端が単語文字のときだけ**課す
 * (`dropDatabase(` / `drop_database(` は `(` で終わるので後端を課すと必ず落ちる)。
 * `mysqladmin … drop` のように内部に空白や非 ASCII を含む form も、端の 2 文字だけを見るので
 * そのまま扱える。
 */
const formMentionRe = (form: string): RegExp => {
  const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lead = /^\w/.test(form) ? "(?<!\\w)" : "";
  const trail = /\w$/.test(form) ? "(?!\\w)" : "";
  return new RegExp(`${lead}${escaped}${trail}`);
};

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

  it("(3) docs/approval-policy.md の db-drop 注記は全形を**語として**含む (片方向・注記は非認識形も語る)", () => {
    const doc = read("../../../docs/approval-policy.md");
    const start = doc.indexOf("> **`db-drop` is a literal list");
    expect(start, "db-drop note paragraph").toBeGreaterThanOrEqual(0);
    const end = doc.indexOf("\n\n", start);
    const note = doc.slice(start, end).replace(/`/g, "");
    for (const f of DB_DROP_LITERAL_FORMS) {
      // POSITIVE (旧判定・維持): 部分文字列として現れる。
      expect(note.includes(f), `note mentions ${f}`).toBe(true);
      // POSITIVE (QA-FF-2・厳格化): 語として現れる。旧判定だけだと注記が非認識形として名指ししている
      //   `DROP TABLESPACE` が `DROP TABLE` の言及に化け、`DROP TABLE` の言及を丸ごと消しても緑だった。
      expect(formMentionRe(f).test(note), `note mentions ${f} as a word`).toBe(true);
    }
  });

  it("(3') 語境界判定は部分文字列一致の**厳格化**であって緩和でない (QA-FF-2)", () => {
    // 新判定にマッチする位置は必ず部分文字列一致の位置でもある (境界は前後を制約するだけ)。
    //   注記本文で両方向を実測し、旧一致集合 ⊇ 新一致集合 を pin する。
    const doc = read("../../../docs/approval-policy.md");
    const start = doc.indexOf("> **`db-drop` is a literal list");
    const note = doc.slice(start, doc.indexOf("\n\n", start)).replace(/`/g, "");
    for (const f of DB_DROP_LITERAL_FORMS) {
      if (formMentionRe(f).test(note)) expect(note.includes(f), f).toBe(true);
    }
    // 同一リテラルの POSITIVE / NEGATIVE 対。旧判定が空虚充足していた実例をそのまま使う。
    const tableRe = formMentionRe("DROP TABLE");
    expect(tableRe.test("recognises the SQL forms DROP TABLE / DROP DATABASE")).toBe(true);
    expect(tableRe.test("(DROP TABLE)")).toBe(true);
    const tablespaceOnly = "Still not recognised: DROP TABLESPACE / DROP USER";
    expect(tablespaceOnly.includes("DROP TABLE"), "substring match was vacuously true").toBe(true);
    expect(tableRe.test(tablespaceOnly), "word-boundary match rejects it").toBe(false);
    // 末尾が単語文字でない form には後端境界を課さない (課すと `dropDatabase(` が落ちる)。
    expect(formMentionRe("dropDatabase(").test("the Mongo shell db.dropDatabase()")).toBe(true);
    expect(formMentionRe("dropDatabase(").test("grep -rn dropDatabase docs/")).toBe(false);
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

  // INV-DB-DROP-BOUND-DOC (task 01a0480f-d29a): mysqladmin 行の**束縛値**を語る散文はコード定数と非結合で、
  //   境界を動かすと docs が黙って嘘になる (旧: 「512 characters」を 3 箇所が手書き)。regex source から
  //   `{0,N}` を抽出し、両スコープの一致と docs の逐語一致を two-way に pin する。束縛値を変える変更は
  //   ここで RED になり、docs を同時に更新させる (境界ゲートの走査範囲変更ゆえ full 監査も要る)。
  it("(6) mysqladmin ルールの束縛値は両スコープで一致し docs の散文と two-way に一致", () => {
    const row = LITERAL_RULES.find((r) => r.re.source.includes("mysqladmin"));
    expect(row, "mysqladmin row").toBeDefined();
    const boundOf = (re: RegExp): string => {
      const m = /\{0,(\d+)\}/.exec(re.source);
      expect(m, `bound in ${String(re)}`).not.toBeNull();
      return m![1]!;
    };
    const bound = boundOf(row!.re);
    expect(row!.segmentRe, "mysqladmin row は segment スコープを持つ").toBeDefined();
    expect(boundOf(row!.segmentRe!), "両スコープの束縛値は同一").toBe(bound);
    // docs の散文 (approval-policy 注記 / bench doc 2 箇所) が同じ数値を語っている。
    //   docs は prettier が折り返すので、空白を畳んだ view で照合する (改行位置に依存させない)。
    const flat = (rel: string): string => read(rel).replace(/\s+/g, " ");
    const policyDoc = flat("../../../docs/approval-policy.md");
    const benchDoc = flat("../../../docs/benchmarks/redaction-and-risk-classifier.md");
    expect(policyDoc).toContain(`within ${bound} characters of \`mysqladmin\``);
    expect(benchDoc).toContain(`within ${bound} characters of \`mysqladmin\``);
    expect(benchDoc).toContain(`the ${bound} bound's two-sided boundary`);
    // 「片方のスコープだけ数値を変える」編集も RED にする (source 逐語の相互 pin)。
    expect(row!.re.source).toContain(`{0,${bound}}`);
    expect(row!.segmentRe!.source).toContain(`{0,${bound}}`);
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
