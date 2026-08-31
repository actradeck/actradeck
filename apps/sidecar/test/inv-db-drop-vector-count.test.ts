/**
 * INV-DB-DROP-VECTOR-COUNT (sweep 019fd74b・QA-DB2 I 群 + task 01a0480f-d29a QA R2):
 * `db-drop` の **rule 行数** と **陽性 vector 数** を両側から結合する。
 *
 * 背景: db-drop の literal は「追加のみ・削除禁止」の規律で育っている一方、行を足したのに
 * ベクタを足さない (逆に、ベクタだけ足して行を足さない) 編集を落とす仕掛けが無かった。
 * 件数はどちらの側でも単独では pin できる (それぞれの exact 値) が、単独の pin は
 * 「両方を同じ方向へ動かす coordinated 編集」しか強制しない。ここでは件数の exact pin に加えて
 * **帰属 (どの行がどのベクタを担っているか)** を両方向で assert し、片側だけの増減を RED にする。
 *
 * vector の出所は safety-bench corpus (`COMMANDS`)。公開ベンチが読む単一出所で import 可能ゆえ、
 * テストのソースを走査する必要がない (「pin の pin」を作らない・実行可能な結合で固定する)。
 * INV-DB-DROP-RISK-VERDICT 側の陽性列 (`inv-policy-categories.test.ts`) は pin 凍結済みなので
 * **読まないし触らない** — あちらは分類器の verdict を、ここは件数の結合を担う。
 *
 * 分類器の走査正規化 (`splitSegments` / `literalRuleMatches`) には手を触れない。segment スコープの
 * 帰属判定はここでは `segmentRe` を**コマンド全体**へ当てる (`[\s\S]{0,512}` ゆえ segment 適用の
 * superset)。これは「どの行の担当か」を決めるためだけの緩い帰属で、gate 判定ではない。
 * 実挙動 (risk / category) は同じテスト内で live 分類器に問い直して確認する。
 */
import { describe, expect, it } from "vitest";

import { COMMANDS } from "../e2e/safety-bench/classifier-corpus.js";
import { classifyCommandCategories, classifyCommandRisk, LITERAL_RULES } from "../src/normalize.js";

/** db-drop の literal 行数 (exact)。行を増減したらここと corpus の両方を更新することになる。 */
const DB_DROP_RULE_ROWS = 9;
/** bench corpus の db-drop 陽性 vector 数 (exact)。公開ベンチの support と同じ数。 */
const DB_DROP_CORPUS_POSITIVES = 11;
/**
 * whole-command スコープでは拾えず segment スコープでのみ db-drop になる陽性 vector の数
 * (task 01a0480f-d29a で「既知の限界 = low」から high へ**反転**した群の corpus 上の担体)。
 */
const SEGMENT_SCOPE_ONLY_POSITIVES = 1;
/** segment スコープを持つ rule 行の数 (現行は mysqladmin 行のみ)。 */
const SEGMENT_SCOPED_ROWS = 1;

const dbDropRows = LITERAL_RULES.filter((r) => r.category === "db-drop");
const corpusPositives = COMMANDS.filter((v) => v.expectCategories.includes("db-drop"));
/** 帰属判定 (gate 判定ではない): whole-command scope ∨ segment scope の superset。 */
const rowCovers = (r: (typeof LITERAL_RULES)[number], command: string): boolean =>
  r.re.test(command) || (r.segmentRe?.test(command) ?? false);

describe("INV-DB-DROP-VECTOR-COUNT: rule 行数と陽性 vector 数の結合", () => {
  it("(7) db-drop の rule 行数と corpus 陽性 vector 数は両方向に結合している", () => {
    expect(dbDropRows.length, "db-drop literal rows").toBe(DB_DROP_RULE_ROWS);
    expect(corpusPositives.length, "db-drop positives in the bench corpus").toBe(
      DB_DROP_CORPUS_POSITIVES,
    );

    // 前向き: 各 rule 行に、その行自身が拾う陽性 vector が最低 1 本ある。
    //   → 行だけ足してベクタを足さない編集で RED。
    for (const r of dbDropRows) {
      const carriers = corpusPositives.filter((v) => rowCovers(r, v.command));
      expect(carriers.length, `row ${String(r.re)} has a corpus carrier`).toBeGreaterThan(0);
    }

    // 逆向き: 全陽性 vector が最低 1 本の db-drop 行に帰属する。
    //   → 行を消す / ベクタだけ足して行を足さない編集で RED。
    for (const v of corpusPositives) {
      expect(
        dbDropRows.some((r) => rowCovers(r, v.command)),
        `vector is attributable to a db-drop row: ${v.command}`,
      ).toBe(true);
    }

    // 帰属が regex の字面だけで完結していないこと (live 分類器でも db-drop)。
    for (const v of corpusPositives) {
      expect(classifyCommandCategories(v.command).has("db-drop"), v.command).toBe(true);
    }

    // 全 label が DB_DROP_LITERAL_FORMS 側と two-way に一致することは
    //   INV-DB-DROP-ENUMERATION (1) が担う。ここでは重複させない。
  });

  it("(8) 反転群 (segment スコープでのみ high になる形) の大きさは rule 側と vector 側の両方で pin される", () => {
    // task 01a0480f-d29a: 引用内 metachar / 行継続 / redirect の向こう側の実サブコマンドは、
    //   手書きの字面境界では区切りに見えて low へ落ちていた。正準 quote-aware splitter の
    //   segment スコープを足したことで high へ**反転**した (削除でなく反転)。
    //   その反転群の大きさを、rule 側 (segmentRe を持つ行数) と vector 側 (whole-command scope
    //   では拾えない corpus 陽性の本数) の**両方**で pin する。片側だけ動かす編集が RED になる。
    const segmentScoped = LITERAL_RULES.filter((r) => r.segmentRe !== undefined);
    expect(segmentScoped.length, "rules carrying a segment scope").toBe(SEGMENT_SCOPED_ROWS);
    for (const r of segmentScoped) {
      expect(r.category, "segment scope is a db-drop mechanism today").toBe("db-drop");
      expect(dbDropRows).toContain(r);
    }

    const wholeCommandCovered = corpusPositives.filter((v) =>
      dbDropRows.some((r) => r.re.test(v.command)),
    );
    const needsSegmentScope = corpusPositives.filter(
      (v) => !dbDropRows.some((r) => r.re.test(v.command)),
    );
    // 分割が漏れなく・重複なく corpus 陽性を覆う (どちらかの数だけ書き換える編集を防ぐ)。
    expect(wholeCommandCovered.length + needsSegmentScope.length).toBe(corpusPositives.length);
    expect(needsSegmentScope.length, "segment-scope-only positives").toBe(
      SEGMENT_SCOPE_ONLY_POSITIVES,
    );
    expect(wholeCommandCovered.length, "whole-command-covered positives").toBe(
      DB_DROP_CORPUS_POSITIVES - SEGMENT_SCOPE_ONLY_POSITIVES,
    );

    // 反転群は例外なく segment スコープを持つ行に帰属し、live でも high / db-drop である
    //   (= segment スコープを外すとここが崩れる)。
    for (const v of needsSegmentScope) {
      expect(
        segmentScoped.some((r) => r.segmentRe!.test(v.command)),
        `inverted vector belongs to a segment-scoped row: ${v.command}`,
      ).toBe(true);
      expect(classifyCommandRisk(v.command), v.command).toBe("high");
      expect(classifyCommandCategories(v.command).has("db-drop"), v.command).toBe(true);
    }
  });
});
