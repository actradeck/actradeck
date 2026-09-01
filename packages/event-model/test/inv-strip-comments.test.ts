/**
 * INV-STRIP-COMMENTS: 走査正規化 (comment-strip) の単一出所を**挙動**で固定する。
 *
 * 本 helper は sidecar / backend / webui / event-model の tripwire・metatest が共有する
 * 走査の view そのもので、緩めると全消費点の歯が同時に鈍る。よって pin は綴りでなく挙動に置く:
 *  (a) 被覆軸 (行頭 / 行末 / block / 文字列保存 / regex skip) を POSITIVE-NEGATIVE 対で固定。
 *  (b) 非被覆 (残余) も**実測値として**固定する — 「閉じた」と書かないための逐語の証拠。
 *  (c) corpus コントロール: git 管理下の全 TS ソースについて、TS パーサの leaf token 列が
 *      strip 前後で一致すること (落とし過ぎ = 実コード喪失 / 落とし残し = コメント混入 の
 *      **双方向**) を実走し、その判定器自身に既知陽性 3 方向と既知陰性を流す。
 *  (d) consolidation 不変条件: repo 全体で comment-strip の実装が 1 本しか無いこと。
 *  (e) 実行証跡: 各 describe の実走本数を afterEach で数え、トップレベル afterAll で照合する
 *      (describe 単体の skip を in-process で RED にする)。CI 側は assert-inv-ran が受ける。
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { stripComments } from "../src/test-strip-comments.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** 正準の在処 (repo 相対)。consolidation sweep の唯一の除外先。 */
const CANONICAL_REL = "packages/event-model/src/test-strip-comments.ts";
/** 本テスト自身 (fixture として実装形の文字列を持つため sweep の対象外)。 */
const SELF_REL = "packages/event-model/test/inv-strip-comments.test.ts";

/** テスト vector 中の backtick (テンプレートリテラルの綴りを文字列で組むため)。 */
const BACKTICK = "\u0060";

/**
 * describe ごとの **実走** 本数 (registration 時点でなく実行時に加算)。
 * `describe.skip` はその group の hook を登録しないため 0 のまま残り、末尾の afterAll が RED になる。
 */
const RAN = { axes: 0, literals: 0, regex: 0, residuals: 0, corpus: 0, singleSource: 0 };

/** 実走本数の literal pin。it を消す / skip する / 早期 return させるとここで RED。 */
const EXPECTED_RUNS = {
  axes: 11, // axes の it 本数
  literals: 4, // literals の it 本数
  regex: 14, // regex の it 本数
  residuals: 3, // residuals の it 本数
  corpus: 2, // corpus の it 本数
  singleSource: 2, // single_source の it 本数
} as const;

// ---------------------------------------------------------------------------
// (a) 被覆軸: POSITIVE-NEGATIVE 対
// ---------------------------------------------------------------------------

describe("INV-STRIP-COMMENTS-AXES: コメントは落ち、コードは落ちない", () => {
  afterEach(() => {
    RAN.axes++;
  });

  it("行頭の行コメントを落とし、改行は保存する (行番号が保たれる)", () => {
    const out = stripComments("const a = 1;\n  // note\nconst b = 2;\n");
    expect(out).not.toContain("note"); // NEGATIVE
    expect(out).toContain("const a = 1;"); // POSITIVE 対
    expect(out).toContain("const b = 2;"); // POSITIVE 対
    expect(out.split("\n").length).toBe(4); // 行数保存
  });

  it("行末の行コメントを落とす (新軸) — 直前の空白も落とし、コード側は逐語で残る", () => {
    const out = stripComments("const a = 1;   // verbatimPin\n");
    expect(out).not.toContain("verbatimPin"); // NEGATIVE
    expect(out).toBe("const a = 1;\n"); // POSITIVE 対 (末尾空白も除去)
  });

  it("空白を挟まない `code;//note` も落とす (旧 backend 実装の残余 SEC-R9-3(a) の解消)", () => {
    const out = stripComments("select();//hiddenPin\n");
    expect(out).not.toContain("hiddenPin"); // NEGATIVE
    expect(out).toBe("select();\n"); // POSITIVE 対
  });

  it("行末コメントだけを落とし、同じ行の逐語 pin は残る (自己充足と非自己充足の対)", () => {
    const selfSatisfying = stripComments("const x = 1; // export function isTimespecWord(\n");
    const real = stripComments("export function isTimespecWord(word: string) {} // note\n");
    expect(selfSatisfying).not.toContain("export function isTimespecWord("); // NEGATIVE
    expect(real).toContain("export function isTimespecWord("); // POSITIVE 対
  });

  it("インライン block コメントを落とし、前後のコードを残す", () => {
    const out = stripComments("const a = /* was: bad */ good;\n");
    expect(out).not.toContain("was: bad"); // NEGATIVE
    expect(out).toContain("const a =");
    expect(out).toContain("good;"); // POSITIVE 対
  });

  it("複数行 block コメントを落とす (改行も落ちるため行番号は保存しない — 実測)", () => {
    const out = stripComments("const a = 1;\n/**\n * doc pin\n */\nconst b = 2;\n");
    expect(out).not.toContain("doc pin"); // NEGATIVE
    expect(out).toContain("const a = 1;");
    expect(out).toContain("const b = 2;"); // POSITIVE 対
    expect(out.split("\n").length).toBeLessThan(6); // 行数は保存されない (実測 bound)
  });

  it("docstring 継続行 `*` はブロックの内側として落ちる", () => {
    expect(stripComments("/**\n * alpha\n * beta\n */\nconst c = 3;\n")).not.toContain("beta");
    expect(stripComments("/**\n * alpha\n * beta\n */\nconst c = 3;\n")).toContain("const c = 3;");
  });

  // SEC-CSX-1(a): テンプレート補間 `${…}` の中は **コード**なので code mode で走査する。
  //   追跡しないと補間内の行末コメントが view に残り、presence pin (toContain) がコメント 1 本で
  //   自己充足する (backend inv-synthetic-retire-sentinel で base 対照つきに実証された H)。
  it("テンプレート補間 `${…}` 内の行末コメントを落とす", () => {
    const src = "const t = `head ${\n  value // dropInInterp\n} tail`;\n";
    const out = stripComments(src);
    expect(out).not.toContain("dropInInterp"); // NEGATIVE
    expect(out).toContain("head ${"); // POSITIVE 対 (テンプレート本文は残る)
    expect(out).toContain("value"); // POSITIVE 対 (補間内の実コードは残る)
  });

  it("テンプレート補間内のブロックコメントを落とす", () => {
    const out = stripComments("const t = `${x /* dropBlockInInterp */}`;\n");
    expect(out).not.toContain("dropBlockInInterp"); // NEGATIVE
    expect(out).toContain("`${x"); // POSITIVE 対
  });

  it("入れ子テンプレートで backtick の parity が反転しない (以降のコメントが落ち続ける)", () => {
    const src = "const t = `a${ `inner` }b`;\nconst c = 1; // dropAfterNested\n";
    const out = stripComments(src);
    expect(out).not.toContain("dropAfterNested"); // NEGATIVE
    expect(out).toContain("`inner`"); // POSITIVE 対
  });

  it("補間の外のテンプレート本文の `//` は落とさない (補間追跡が本文まで code 化しない対)", () => {
    expect(stripComments("const t = `see https://keepInTplBody`;\n")).toContain(
      "https://keepInTplBody",
    );
  });
});

describe("INV-STRIP-COMMENTS-LITERALS: 文字列 / テンプレートの中は落とさない", () => {
  afterEach(() => {
    RAN.literals++;
  });

  it("文字列内の URL の `//` を落とさない", () => {
    const out = stripComments('const u = "https://example.test/keepMe";\n');
    expect(out).toContain("https://example.test/keepMe"); // POSITIVE
    expect(out).toContain('const u = "'); // POSITIVE 対 (行ごと消えていない)
  });

  it("文字列内の ` // ` (空白先行) を落とさない — 旧 backend / webui 実装が誤って落としていた形", () => {
    expect(stripComments("const s = 'a // b keepInner';\n")).toContain("a // b keepInner");
    expect(stripComments('const s = "x /* y */ keepBlock";\n')).toContain("x /* y */ keepBlock");
  });

  it("テンプレートリテラル内の `//` を落とさない", () => {
    expect(stripComments("const t = `proto://keepTpl`;\n")).toContain("proto://keepTpl");
  });

  it("文字列を挟んだ後の**本物の**行末コメントは落ちる (落とし残しでないことの対)", () => {
    const out = stripComments('const u = "https://example.test/keepMe"; // dropMe\n');
    expect(out).toContain("https://example.test/keepMe"); // POSITIVE
    expect(out).not.toContain("dropMe"); // NEGATIVE 対
  });
});

describe("INV-STRIP-COMMENTS-REGEX: regex リテラルで走査が desync しない", () => {
  afterEach(() => {
    RAN.regex++;
  });

  it("文字クラスに backtick を含む regex の後でも行コメントが落ちる (実測: normalize.ts の形)", () => {
    const src = "const RE = /[|&;$`(){}<>\\n]/;\nconst a = 1; // dropAfterBacktick\n";
    const out = stripComments(src);
    expect(out).not.toContain("dropAfterBacktick"); // NEGATIVE
    expect(out).toContain("const RE = /[|&;$`(){}<>\\n]/;"); // POSITIVE 対 (regex は逐語で残る)
  });

  it("文字クラスに quote を含む regex の後でも行コメントが落ちる", () => {
    const src = "const R = /^[({\\s'\"]+/;\nconst b = 2; // dropAfterQuoteClass\n";
    const out = stripComments(src);
    expect(out).not.toContain("dropAfterQuoteClass"); // NEGATIVE
    expect(out).toContain("/^[({\\s'\"]+/"); // POSITIVE 対
  });

  it("escape された `/` を含む regex を行コメント開始と誤認しない", () => {
    const src = 'code.replace(/\\/\\*[\\s\\S]*?\\*\\//g, "") + keepTail;\n';
    expect(stripComments(src)).toContain("keepTail"); // POSITIVE (行の残りが消えていない)
  });

  it("文字クラス内の未 escape の `/` を含む regex でも行の残りが消えない", () => {
    expect(stripComments("const S = /[/]/; const keepAfterSlashClass = 1;\n")).toContain(
      "keepAfterSlashClass",
    );
  });

  it("declined 位置 (識別子直後) でも escape された `/` は行コメントにならない", () => {
    // `)` の直後は regex とみなさない (除算と衝突する) ので、この regex は skip されない。
    // code mode の escape 素通しが無いと `\/` の `/` が次の `/` と組んで行の残りを落とす。
    // `)` は regex 位置として受けるので、ここは **識別子直後** の declined 位置を使う
    // (有効な JS では識別子の直後の `/` は除算)。escape 素通しが無いと `\\/` の `/` が
    // 次の `/` と組んで行コメント扱いになり、行の残り (実コード) が落ちる。
    const src = "const v = x /a\\//.test(s) && keepDeclinedTail;\n";
    expect(stripComments(src)).toContain("keepDeclinedTail");
  });

  it("regex の文字クラス内の quote は string mode を開かない (クラス追跡の歯)", () => {
    // クラス追跡が無いと regex が `[` の中の `/` で閉じたことにされ、続く `"` が dq mode を開き、
    // 後段の文字列内 `//` が行コメント扱いになって実コードが落ちる。
    const src = 'const S = /[/"]/; const t = "a // b keepInClass";\n';
    expect(stripComments(src)).toContain("keepInClass");
  });

  it("行を跨ぐ regex は認めない (閉じない `/` が後続行を飲み込まない)", () => {
    // 不正形入力のガード: regex 位置に閉じない `/` があっても、次行以降の走査を壊さない。
    const src = "const a = [ / ];\nconst b = 1; // dropMe\nconst keepAfterBogusSlash = 2;\n";
    const out = stripComments(src);
    expect(out).not.toContain("dropMe"); // NEGATIVE (次行のコメントは通常どおり落ちる)
    expect(out).toContain("keepAfterBogusSlash"); // POSITIVE 対
  });

  it("ファイル先頭の regex も skip される (直前の意味のある文字が無い位置)", () => {
    const src = '/["]/.test(x); const k = "a // b keepStart";\n';
    expect(stripComments(src)).toContain("keepStart");
  });

  it("除算は regex と誤認しない (JSX の自己閉じ `/>` を壊さない対照)", () => {
    expect(stripComments("const q = total / count; const keepDiv = 1;\n")).toContain("keepDiv");
    expect(stripComments("const el = <Foo bar={x} />;\nconst keepJsx = 1;\n")).toContain("keepJsx");
  });

  // SEC-CSX-1(b): 終端候補の直後が `/` の形 (= 直後が行コメント) を regex と認めない。
  //   実形は sidecar normalize.ts の `(t) => /^alias\.[^=\s]+=!/i.test(t)` — 終端直前の `!` が
  //   regex 開始位置に見えるため終端 `/` が新しい regex の開始と誤認され、直後の `//` の片方を
  //   飲んで行末コメントが view に残っていた。
  it("regex の終端候補直後が `/` の形は regex と認めない (行末コメントを飲まない)", () => {
    // arrow 位置は skip 側なので、ここは **識別子直後** の declined 位置で組む。終端直前の `!` が
    // regex 開始位置に見えるため、guard が無いと終端 `/` が新しい regex の開始と誤認され、
    // 直後の `//` の片方を飲んで行末コメントが view に残る。
    const src = "const v = x /^a\\.[^=\\s]+=!/i.test(t); // dropAfterBangRegex\n";
    const out = stripComments(src);
    expect(out).not.toContain("dropAfterBangRegex"); // NEGATIVE
    expect(out).toContain("const v = x /^a"); // POSITIVE 対
  });

  it("`)` 直後の regex を skip する (行末コメントが落ちる)", () => {
    const out = stripComments("if (x) /[a-z]/.test(s); // dropAfterParenRegex\n");
    expect(out).not.toContain("dropAfterParenRegex"); // NEGATIVE
    expect(out).toContain("if (x) /[a-z]/.test(s);"); // POSITIVE 対 (regex は逐語で残る)
  });

  it("`=>` 直後の regex を skip する (行末コメントが落ちる)", () => {
    const out = stripComments("const f = (x) => /[a-z]/.test(x); // dropAfterArrowRegex\n");
    expect(out).not.toContain("dropAfterArrowRegex"); // NEGATIVE
    expect(out).toContain("const f = (x) =>"); // POSITIVE 対
  });

  it("`)` / `=>` 直後の regex 内 backtick が後続テンプレートの parity を壊さない", () => {
    // QA-CSX-1 R1/R2 の形: backtick を含む文字クラスが tpl mode を開くと、以降の実テンプレート
    //   本文が code 扱いになって中身が落ちる (実コード喪失)。
    const a = "if (x) /[" + BACKTICK + "]/.test(s);\nconst t = `see https://keepParenTpl\nmore`;\n";
    const b =
      "const f = (x) => /[" + BACKTICK + "]/.test(x);\nconst t = `a https://keepArrowTpl\nb`;\n";
    expect(stripComments(a)).toContain("keepParenTpl");
    expect(stripComments(b)).toContain("keepArrowTpl");
  });

  it("閉じないブロックコメントはファイル残りを飲まない (fail-closed・SEC-CSX-2)", () => {
    // declined 位置 (識別子直後) の regex 文字クラス内 `/*` が block mode を開き `*/` が無いまま
    //   EOF まで飲むと、当該ファイルが全 tripwire の view から空になる (DROP)。閉じないブロックは
    //   コメントとみなさず逐語で残す (MISS = 安全側) へ縮退させる。
    const src = "const v = x /[^/*]/.test(s);\nfunction keepEverythingAfter() {}\n";
    expect(stripComments(src)).toContain("keepEverythingAfter");
  });
});

// ---------------------------------------------------------------------------
// (b) 非被覆 (残余) の実測 pin — doc の「閉じた」を禁じるための逐語の証拠
// ---------------------------------------------------------------------------

describe("INV-STRIP-COMMENTS-RESIDUALS: 落とさない形を実測で固定する (全称の主張をしない)", () => {
  afterEach(() => {
    RAN.residuals++;
  });

  it("文字列リテラルとして書かれた逐語コピーは落とさない (lexical 走査の構造的天井)", () => {
    const out = stripComments('const s = "export function isTimespecWord(";\n');
    expect(out).toContain("export function isTimespecWord(");
  });

  it("残る declined 位置 (識別子 / `}` / 非 arrow の `>` 直後) の regex は skip されない", () => {
    // 有効な JS では識別子 / `}` / `>` の直後の `/` は除算であり、JSX の `{...p} />` とも
    // 衝突するため regex 位置に入れていない。ここに quote / backtick を含む regex を書くと
    // string / template mode を誤って開く。単引用 / 二重引用は改行で resync するので影響は
    // その行に閉じるが、backtick は resync しない。**方向は consumer 依存**: negative assert
    // (not.toContain) には厳しい側、presence pin (toContain) には**緩い側**に倒れる。
    const src =
      "const v = x /['\"]/.test(s); // residualSameLine\nconst b = 2; // droppedNextLine\n";
    const out = stripComments(src);
    expect(out).toContain("residualSameLine"); // 同一行は落ち残る (実測)
    expect(out).not.toContain("droppedNextLine"); // 次行は resync 後なので落ちる (POSITIVE 対)
  });

  it("残る declined 位置 + backtick は次の backtick まで落ち残る (改行 resync しない)", () => {
    const src = "const v = x /[" + BACKTICK + "]/.test(s);\\nconst a = 1; // residualAfterIdent\\n";
    const out = stripComments(src);
    expect(out).toContain("residualAfterIdent"); // 落ち残り (実測)
    expect(out).toContain("const a = 1;"); // 実コードは消えない (DROP でなく MISS 方向)
  });
});

// ---------------------------------------------------------------------------
// (c) corpus コントロール — TS パーサの leaf token 列で **双方向**に照合する (QA-CSX-1 / SEC-CSX-3)
// ---------------------------------------------------------------------------

/**
 * strip の正しさを **TypeScript パーサ 2 面**で判定する。実装側の主張 (「parse が通る」) より強い:
 *
 *  1. **コメント範囲の等価** — パーサが列挙したコメント範囲だけを原文から除いたテキストと、
 *     strip 出力を空白無視で照合する。落とし過ぎ (`code_dropped`) と落とし残し
 *     (`comment_retained`) の **双方向**を直接見る。
 *  2. **leaf token 列の等価** — コメントは trivia ゆえ leaf token に現れない。実コードが落ちれば
 *     token が減る。**正直な限界**: 落とし残した行コメントは strip 出力を再 parse したときも
 *     コメントとして読まれるので token 列は変わらない — MISS 方向を担うのは (1) であって (2)
 *     ではない。(2) は (1) が空白正規化で見落とす形 (トークン境界の変化) を受ける第 2 軸。
 *
 * JSDoc ノードは setParentNodes 有効時に子として現れるが**コメント**なので token に数えない。
 */
function analyze(
  original: string,
  fileName: string,
  strip: (src: string) => string,
): readonly string[] {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sfBefore = ts.createSourceFile(fileName, original, ts.ScriptTarget.ESNext, true, kind);
  const errsBefore = (sfBefore as unknown as { parseDiagnostics: readonly unknown[] })
    .parseDiagnostics.length;

  const stripped = strip(original);
  const sfAfter = ts.createSourceFile(fileName, stripped, ts.ScriptTarget.ESNext, true, kind);
  const errsAfter = (sfAfter as unknown as { parseDiagnostics: readonly unknown[] })
    .parseDiagnostics.length;

  const findings: string[] = [];
  if (errsAfter > errsBefore) findings.push("parse_broken");

  const truth = squeeze(withoutComments(original, sfBefore));
  const actual = squeeze(stripped);
  if (truth !== actual) {
    if (actual.length < truth.length && isSubsequence(actual, truth)) findings.push("code_dropped");
    else if (actual.length > truth.length && isSubsequence(truth, actual))
      findings.push("comment_retained");
    else findings.push("comment_range_mismatch");
  }

  const before = leafTokens(sfBefore);
  const after = leafTokens(sfAfter);
  if (before.length !== after.length || before.some((t, i) => t !== after[i])) {
    if (after.length < before.length && isSubsequence(after, before))
      findings.push("token_dropped");
    else if (after.length > before.length && isSubsequence(before, after))
      findings.push("token_leaked");
    else findings.push("token_mismatch");
  }
  return findings;
}

const squeeze = (s: string): string => s.replace(/\s+/g, "");

function isSubsequence(
  small: readonly unknown[] | string,
  big: readonly unknown[] | string,
): boolean {
  let i = 0;
  for (const t of big) if (i < small.length && small[i] === t) i++;
  return i === small.length;
}

/** パーサが列挙したコメント範囲だけを取り除いたテキスト (= 正しい strip 出力の真値)。 */
function withoutComments(text: string, sf: ts.SourceFile): string {
  const ranges: Array<[number, number]> = [];
  const seen = new Set<string>();
  const addAt = (pos: number): void => {
    for (const fn of [ts.getLeadingCommentRanges, ts.getTrailingCommentRanges]) {
      for (const r of fn(text, pos) ?? []) {
        const key = `${r.pos}:${r.end}`;
        if (seen.has(key)) continue;
        seen.add(key);
        ranges.push([r.pos, r.end]);
      }
    }
  };
  const walk = (node: ts.Node): void => {
    addAt(node.pos);
    for (const kid of node.getChildren(sf)) walk(kid);
  };
  walk(sf);
  ranges.sort((x, y) => x[0] - y[0]);
  let out = "";
  let cur = 0;
  for (const [start, end] of ranges) {
    if (start < cur) {
      cur = Math.max(cur, end);
      continue;
    }
    out += text.slice(cur, start);
    cur = end;
  }
  return out + text.slice(cur);
}

function leafTokens(sf: ts.SourceFile): string[] {
  const tokens: string[] = [];
  const walk = (node: ts.Node): void => {
    if (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode)
      return;
    const kids = node.getChildren(sf);
    if (kids.length === 0) {
      const text = node.getText(sf);
      if (text.length > 0) tokens.push(text);
      return;
    }
    for (const kid of kids) walk(kid);
  };
  walk(sf);
  return tokens;
}

/** 走査集合の非空虚性は「件数」でなく「4 workspace の既知ファイルが居ること」で固定する (TDA-CSX-2)。 */
const REQUIRED_SCAN_MEMBERS = [
  "apps/sidecar/src/normalize.ts",
  "apps/sidecar/test/inv-approval.test.ts",
  "apps/backend/src/sidecar-registry.ts",
  "apps/webui/test/inv-i18n.test.ts",
  "packages/event-model/src/index.ts",
] as const;

const SCAN_EXTENSION_RE = /\.(?:ts|tsx|mts|cts)$/;

/**
 * repo 全体 (約 600 ファイル) を 2 回 parse するため、既定の 5s では coverage 計測下で足りない
 * (実測: 素の run で 3.8s / `--coverage` で 12.5s)。LINEAR の `LINEAR_IT_TIMEOUT_MS` と同じ規範で
 * 明示する。timeout はそれ自体が失敗なので、RED の歯は失われない (失うのは診断だけ)。
 */
const CORPUS_IT_TIMEOUT_MS = 120_000;

const trackedSources = (): string[] =>
  execFileSync("git", ["ls-files"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\n")
    .filter((f) => SCAN_EXTENSION_RE.test(f));

function assertScanSetIsWhole(files: readonly string[]): void {
  // 件数だけを見ると `git ls-files packages apps/webui` へ縮めても緑のままになる (TDA-CSX-2)。
  for (const member of REQUIRED_SCAN_MEMBERS) {
    expect(files, `走査集合に ${member} が居ない (走査範囲の縮小)`).toContain(member);
  }
  expect(files.length, "repo-wide scan set").toBeGreaterThan(300);
}

describe("INV-STRIP-COMMENTS-CORPUS: repo 全体で実コードもコメントも取り違えていない", () => {
  afterEach(() => {
    RAN.corpus++;
  });

  it("判定器の歯: 落とし過ぎ / 落とし残し / parse 破壊を検出し、健全な strip は検出しない", () => {
    const sample = 'const a = 1; // note\nconst s = "x"; /* block */\n';
    // 既知陰性 (正準そのもの) — 同じ判定器へ流す。
    expect(analyze(sample, "negative.ts", stripComments)).toEqual([]);
    // 既知陽性 1: 何も落とさない strip (= コメントが view に残る)。
    expect(analyze(sample, "p1.ts", (src) => src)).toContain("comment_retained");
    // 既知陽性 2: 実コードを落とす strip (行末の式ごと落とす形)。
    expect(
      analyze(sample, "p2.ts", (src) => stripComments(src).replace('const s = "x";', "")),
    ).toContain("code_dropped");
    // 既知陽性 3: parse を壊す strip (文字列途中で切る)。
    expect(analyze(sample, "p3.ts", (src) => src.slice(0, src.indexOf('"') + 2))).toContain(
      "parse_broken",
    );
    // 既知陽性 4: token 軸 — コメントの綴りだけ消してテキストをコードとして残す形。
    expect(
      analyze(sample, "p4.ts", (src) => src.replace(/\/\//g, "").replace(/\/\*|\*\//g, "")),
    ).toContain("token_leaked");
  });

  it(
    "git 管理下の全 TS ソースで strip がコメント範囲と一致する",
    () => {
      const files = trackedSources();
      assertScanSetIsWhole(files);
      const offenders: string[] = [];
      for (const rel of files) {
        let src: string;
        try {
          src = readFileSync(join(REPO_ROOT, rel), "utf8");
        } catch {
          continue; // symlink / 削除途中は無視 (非空虚性は上で固定済み)
        }
        const findings = analyze(src, rel, stripComments);
        if (findings.length > 0) offenders.push(`${rel}: ${findings.join(",")}`);
      }
      expect(offenders, "strip はコメントだけを過不足なく落とす").toEqual([]);
    },
    CORPUS_IT_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// (d) consolidation 不変条件: comment-strip の実装は repo に 1 本だけ
// ---------------------------------------------------------------------------

/** ローカルな comment-strip 実装の定義形 (関数宣言 / 変数束縛の両綴り)。 */
const LOCAL_DEFINITION_RE = /(?:function|const|let|var)\s+stripComments\b/;

describe("INV-STRIP-COMMENTS-SINGLE-SOURCE: 未移行コピーが repo に残っていない", () => {
  afterEach(() => {
    RAN.singleSource++;
  });

  it("検出器の歯: 正準の定義形は検出し、import のみのファイルは検出しない", () => {
    // 既知陽性 (正準の実装そのもの・同一検出器へ流す)。
    const canonical = readFileSync(join(REPO_ROOT, CANONICAL_REL), "utf8");
    expect(LOCAL_DEFINITION_RE.test(stripComments(canonical))).toBe(true);
    // 既知陰性 (消費点の形)。
    const consumerShape = 'import { stripComments } from "@actradeck/event-model";\n';
    expect(LOCAL_DEFINITION_RE.test(stripComments(consumerShape))).toBe(false);
  });

  it(
    "正準以外のどのファイルも comment-strip をローカル定義しない",
    () => {
      const files = trackedSources().filter((f) => f !== CANONICAL_REL && f !== SELF_REL);
      assertScanSetIsWhole(files);
      const offenders = files.filter((f) => {
        let src: string;
        try {
          src = readFileSync(join(REPO_ROOT, f), "utf8");
        } catch {
          return false;
        }
        return LOCAL_DEFINITION_RE.test(stripComments(src));
      });
      expect(offenders, "comment-strip は正準 1 本のみ").toEqual([]);
    },
    CORPUS_IT_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// (e) 実行証跡 (QA-CSX-2 / TDA-CSX-4): describe 単体 skip を in-process で RED にする
// ---------------------------------------------------------------------------
// registration-time の件数 pin は `describe.skip` / 早期 return で緑のまま通る。各 describe の
// `afterEach` で実行本数を数え、**トップレベルの** afterAll で literal と照合する
// (skip された describe の hook は登録されないので、その group の数が 0 のまま残り RED になる)。
// ファイル丸ごとの skip はこの afterAll も走らないため、CI 側 `assert-inv-ran --suite strip-comments`
// が第 2 層として受ける (PR #55 の sidecar-linear と同形の二段)。
afterAll(() => {
  expect(RAN, "INV-STRIP-COMMENTS の各 describe が実走した本数").toEqual(EXPECTED_RUNS);
});
