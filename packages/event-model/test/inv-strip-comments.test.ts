/**
 * INV-STRIP-COMMENTS: 走査正規化 (comment-strip) の単一出所を**挙動**で固定する。
 *
 * 本 helper は sidecar / backend / webui / event-model の tripwire・metatest が共有する
 * 走査の view そのもので、緩めると全消費点の歯が同時に鈍る。よって pin は綴りでなく挙動に置く:
 *  (a) 被覆軸 (行頭 / 行末 / block / 文字列保存 / regex skip) を POSITIVE-NEGATIVE 対で固定。
 *  (b) 非被覆 (残余) も**実測値として**固定する — 「閉じた」と書かないための逐語の証拠。
 *  (c) corpus コントロール: git 管理下の走査集合 (`SCAN_SOURCE_EXTENSIONS` の 7 拡張子・
 *      2026-09-01 実測 620 file) について、TS パーサの leaf token 列が
 *      strip 前後で一致すること (落とし過ぎ = 実コード喪失 / 落とし残し = コメント混入 の
 *      **双方向**) を実走し、その判定器自身に既知陽性 **4 方向** (落とし残し / 実コード脱落 /
 *      parse 破壊 / token 混入) と既知陰性を流す。走査集合は正準の `SCAN_SOURCE_EXTENSIONS`
 *      (7 拡張子・2026-09-01 実測 620 file) を共有する。
 *  (d) consolidation 不変条件: repo 全体で comment-strip の実装が 1 本しか無いこと。
 *  (e) 実行証跡: 各 it の**最後の文**で実走本数を加算し、トップレベル afterAll で照合する
 *      (describe 単体の skip も、it 先頭の早期 return も in-process で RED になる。
 *      `afterEach` 方式は早期 return でも発火するので使わない)。CI 側は assert-inv-ran が受ける。
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";

import { isScannedSourcePath, stripComments } from "../src/test-strip-comments.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** 正準の在処 (repo 相対)。consolidation sweep の唯一の除外先。 */
const CANONICAL_REL = "packages/event-model/src/test-strip-comments.ts";
/** 本テスト自身 (fixture として実装形の文字列を持つため sweep の対象外)。 */
const SELF_REL = "packages/event-model/test/inv-strip-comments.test.ts";

/** テスト vector 中の backtick (テンプレートリテラルの綴りを文字列で組むため)。 */
const BACKTICK = "\u0060";

/**
 * negative assert の POSITIVE 対 (TDA-CSX-R4-3): marker が **入力 vector に実在する**ことを
 * 同一リテラルで固定してから strip する。marker を vector から消す 1 行編集は
 * `not.toContain(marker)` を恒真化するが、この対があると先に RED になる。
 */
function strippedWithout(src: string, ...markers: readonly string[]): string {
  for (const marker of markers) {
    expect(src, `vector に marker ${marker} が実在しない (negative assert が恒真)`).toContain(
      marker,
    );
  }
  return stripComments(src);
}

/**
 * describe ごとの **実走** 本数 (registration 時点でなく実行時に加算)。
 * `describe.skip` はその group の hook を登録しないため 0 のまま残り、末尾の afterAll が RED になる。
 */
const RAN = { axes: 0, literals: 0, regex: 0, residuals: 0, corpus: 0, singleSource: 0 };

/** 実走本数の literal pin。it を消す / skip する / 早期 return させるとここで RED。 */
const EXPECTED_RUNS = {
  axes: 11, // axes describe の it 本数
  literals: 9, // literals describe の it 本数
  regex: 28, // regex describe の it 本数
  residuals: 11, // residuals describe の it 本数
  corpus: 2, // corpus describe の it 本数
  singleSource: 2, // singleSource describe の it 本数
} as const;

// ---------------------------------------------------------------------------
// (a) 被覆軸: POSITIVE-NEGATIVE 対
// ---------------------------------------------------------------------------

describe("INV-STRIP-COMMENTS-AXES: コメントは落ち、コードは落ちない", () => {
  it("行頭の行コメントを落とし、改行は保存する (行番号が保たれる)", () => {
    const out = strippedWithout("const a = 1;\n  // note\nconst b = 2;\n", "note");
    expect(out).not.toContain("note"); // NEGATIVE
    expect(out).toContain("const a = 1;"); // POSITIVE 対
    expect(out).toContain("const b = 2;"); // POSITIVE 対
    expect(out.split("\n").length).toBe(4); // 行数保存
    RAN.axes++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  it("行末の行コメントを落とす (新軸) — 直前の空白も落とし、コード側は逐語で残る", () => {
    const out = strippedWithout("const a = 1;   // verbatimPin\n", "verbatimPin");
    expect(out).not.toContain("verbatimPin"); // NEGATIVE
    expect(out).toBe("const a = 1;\n"); // POSITIVE 対 (末尾空白も除去)
    RAN.axes++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  it("空白を挟まない `code;//note` も落とす (旧 backend 実装の残余 SEC-R9-3(a) の解消)", () => {
    const out = strippedWithout("select();//hiddenPin\n", "hiddenPin");
    expect(out).not.toContain("hiddenPin"); // NEGATIVE
    expect(out).toBe("select();\n"); // POSITIVE 対
    RAN.axes++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  it("行末コメントだけを落とし、同じ行の逐語 pin は残る (自己充足と非自己充足の対)", () => {
    const selfSatisfying = stripComments("const x = 1; // export function isTimespecWord(\n");
    const real = stripComments("export function isTimespecWord(word: string) {} // note\n");
    expect(selfSatisfying).not.toContain("export function isTimespecWord("); // NEGATIVE
    expect(real).toContain("export function isTimespecWord("); // POSITIVE 対
    RAN.axes++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  it("インライン block コメントを落とし、前後のコードを残す", () => {
    const out = strippedWithout("const a = /* was: bad */ good;\n", "was: bad");
    expect(out).not.toContain("was: bad"); // NEGATIVE
    expect(out).toContain("const a =");
    expect(out).toContain("good;"); // POSITIVE 対
    RAN.axes++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  it("複数行 block コメントを落とす (改行も落ちるため行番号は保存しない — 実測)", () => {
    const out = strippedWithout("const a = 1;\n/**\n * doc pin\n */\nconst b = 2;\n", "doc pin");
    expect(out).not.toContain("doc pin"); // NEGATIVE
    expect(out).toContain("const a = 1;");
    expect(out).toContain("const b = 2;"); // POSITIVE 対
    expect(out.split("\n").length).toBeLessThan(6); // 行数は保存されない (実測 bound)
    RAN.axes++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  it("docstring 継続行 `*` はブロックの内側として落ちる", () => {
    const out = strippedWithout("/**\n * alpha\n * beta\n */\nconst c = 3;\n", "beta");
    expect(out).not.toContain("beta"); // NEGATIVE
    expect(out).toContain("const c = 3;"); // POSITIVE 対
    RAN.axes++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  // SEC-CSX-1(a): テンプレート補間 `${…}` の中は **コード**なので code mode で走査する。
  //   追跡しないと補間内の行末コメントが view に残り、presence pin (toContain) がコメント 1 本で
  //   自己充足する (backend inv-synthetic-retire-sentinel で base 対照つきに実証された H)。
  it("テンプレート補間 `${…}` 内の行末コメントを落とす", () => {
    const src = "const t = `head ${\n  value // dropInInterp\n} tail`;\n";
    const out = strippedWithout(src, "dropInInterp");
    expect(out).not.toContain("dropInInterp"); // NEGATIVE
    expect(out).toContain("head ${"); // POSITIVE 対 (テンプレート本文は残る)
    expect(out).toContain("value"); // POSITIVE 対 (補間内の実コードは残る)
    RAN.axes++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  it("テンプレート補間内のブロックコメントを落とす", () => {
    const out = strippedWithout("const t = `${x /* dropBlockInInterp */}`;\n", "dropBlockInInterp");
    expect(out).not.toContain("dropBlockInInterp"); // NEGATIVE
    expect(out).toContain("`${x"); // POSITIVE 対
    RAN.axes++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  it("入れ子テンプレートで backtick の parity が反転しない (以降のコメントが落ち続ける)", () => {
    const src = "const t = `a${ `inner` }b`;\nconst c = 1; // dropAfterNested\n";
    const out = strippedWithout(src, "dropAfterNested");
    expect(out).not.toContain("dropAfterNested"); // NEGATIVE
    expect(out).toContain("`inner`"); // POSITIVE 対
    RAN.axes++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  it("補間の外のテンプレート本文の `//` は落とさない (補間追跡が本文まで code 化しない対)", () => {
    expect(stripComments("const t = `see https://keepInTplBody`;\n")).toContain(
      "https://keepInTplBody",
    );
    RAN.axes++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });
});

describe("INV-STRIP-COMMENTS-LITERALS: 文字列 / テンプレートの中は落とさない", () => {
  it("文字列内の URL の `//` を落とさない", () => {
    const out = stripComments('const u = "https://example.test/keepMe";\n');
    expect(out).toContain("https://example.test/keepMe"); // POSITIVE
    expect(out).toContain('const u = "'); // POSITIVE 対 (行ごと消えていない)
    RAN.literals++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  it("文字列内の ` // ` (空白先行) を落とさない — 旧 backend / webui 実装が誤って落としていた形", () => {
    expect(stripComments("const s = 'a // b keepInner';\n")).toContain("a // b keepInner");
    expect(stripComments('const s = "x /* y */ keepBlock";\n')).toContain("x /* y */ keepBlock");
    RAN.literals++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  it("テンプレートリテラル内の `//` を落とさない", () => {
    expect(stripComments("const t = `proto://keepTpl`;\n")).toContain("proto://keepTpl");
    RAN.literals++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  it("文字列を挟んだ後の**本物の**行末コメントは落ちる (落とし残しでないことの対)", () => {
    const out = strippedWithout('const u = "https://example.test/keepMe"; // dropMe\n', "dropMe");
    expect(out).toContain("https://example.test/keepMe"); // POSITIVE
    expect(out).not.toContain("dropMe"); // NEGATIVE 対
    RAN.literals++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  // TDA-CSX-R3-1 ≡ QA-CSX-R3-1 ≡ SEC-CSX-R3-2: ES2019 (proposal "JSON superset") 以降、
  //   U+2028 / U+2029 は**文字列リテラル内に生で書ける**。行コメント終端と regex の行境界では
  //   LineTerminator として扱いつつ、単引用 / 二重引用の resync だけは LF / CR に限定しないと、
  //   文字列の途中で code mode へ戻り、閉じ引用符が新しい文字列を開いて後続の行コメントを飲む。
  it("単引用文字列内の生 U+2028 で resync しない (後続の行コメントは落ちる)", () => {
    const out = strippedWithout("const s = 'a\u2028b'; // dropAfterSqLs\n", "dropAfterSqLs");
    expect(out).not.toContain("dropAfterSqLs"); // NEGATIVE
    expect(out).toContain("'a\u2028b'"); // POSITIVE 対 (文字列は逐語で残る)
    RAN.literals++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  it("二重引用文字列内の生 U+2028 で resync しない", () => {
    const out = strippedWithout('const s = "a\u2028b"; // dropAfterDqLs\n', "dropAfterDqLs");
    expect(out).not.toContain("dropAfterDqLs"); // NEGATIVE
    expect(out).toContain('"a\u2028b"'); // POSITIVE 対
    RAN.literals++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  it("単引用文字列内の生 U+2029 で resync しない", () => {
    const out = strippedWithout("const s = 'a\u2029b'; // dropAfterSqPs\n", "dropAfterSqPs");
    expect(out).not.toContain("dropAfterSqPs"); // NEGATIVE
    expect(out).toContain("'a\u2029b'"); // POSITIVE 対
    RAN.literals++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  it("二重引用文字列内の生 U+2029 で resync しない", () => {
    const out = strippedWithout('const s = "a\u2029b"; // dropAfterDqPs\n', "dropAfterDqPs");
    expect(out).not.toContain("dropAfterDqPs"); // NEGATIVE
    expect(out).toContain('"a\u2029b"'); // POSITIVE 対
    RAN.literals++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  it("生の LF / CR は依然 resync する (分離が過剰でないことの対照)", () => {
    // 単引用 / 二重引用は生の LF / CR を含めない (構文エラー) ので、そこに達したら
    //   「skip されなかった regex 内の quote 等で誤って開いた」と判定してよい。
    const lf = strippedWithout(
      "const v = x /['\"]/.test(s);\nconst b = 2; // droppedAfterLfResync\n",
      "droppedAfterLfResync",
    );
    expect(lf).not.toContain("droppedAfterLfResync"); // NEGATIVE
    const cr = strippedWithout(
      "const v = x /['\"]/.test(s);\rconst b = 2; // droppedAfterCrResync\n",
      "droppedAfterCrResync",
    );
    expect(cr).not.toContain("droppedAfterCrResync"); // NEGATIVE 対
    RAN.literals++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });
});

describe("INV-STRIP-COMMENTS-REGEX: regex リテラルで走査が desync しない", () => {
  it("文字クラスに backtick を含む regex の後でも行コメントが落ちる (実測: normalize.ts の形)", () => {
    const src = "const RE = /[|&;$`(){}<>\\n]/;\nconst a = 1; // dropAfterBacktick\n";
    const out = strippedWithout(src, "dropAfterBacktick");
    expect(out).not.toContain("dropAfterBacktick"); // NEGATIVE
    expect(out).toContain("const RE = /[|&;$`(){}<>\\n]/;"); // POSITIVE 対 (regex は逐語で残る)
    RAN.regex++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  it("文字クラスに quote を含む regex の後でも行コメントが落ちる", () => {
    const src = "const R = /^[({\\s'\"]+/;\nconst b = 2; // dropAfterQuoteClass\n";
    const out = strippedWithout(src, "dropAfterQuoteClass");
    expect(out).not.toContain("dropAfterQuoteClass"); // NEGATIVE
    expect(out).toContain("/^[({\\s'\"]+/"); // POSITIVE 対
    RAN.regex++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  it("escape された `/` を含む regex を行コメント開始と誤認しない", () => {
    const src = 'code.replace(/\\/\\*[\\s\\S]*?\\*\\//g, "") + keepTail;\n';
    expect(stripComments(src)).toContain("keepTail"); // POSITIVE (行の残りが消えていない)
    RAN.regex++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  it("文字クラス内の未 escape の `/` を含む regex でも行の残りが消えない", () => {
    expect(stripComments("const S = /[/]/; const keepAfterSlashClass = 1;\n")).toContain(
      "keepAfterSlashClass",
    );
    RAN.regex++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  it("declined 位置 (識別子直後) でも escape された `/` は行コメントにならない", () => {
    // (QA-CSX-R4-3: 旧記述「`)` の直後は regex とみなさない」は R2 で `)` を受けて以降**偽**。
    // code mode の escape 素通しが無いと `\/` の `/` が次の `/` と組んで行の残りを落とす。
    // `)` は regex 位置として受けるので、ここは **識別子直後** の declined 位置を使う
    // (有効な JS では識別子の直後の `/` は除算)。escape 素通しが無いと `\\/` の `/` が
    // 次の `/` と組んで行コメント扱いになり、行の残り (実コード) が落ちる。
    const src = "const v = x /a\\//.test(s) && keepDeclinedTail;\n";
    expect(stripComments(src)).toContain("keepDeclinedTail");
    RAN.regex++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  it("regex の文字クラス内の quote は string mode を開かない (クラス追跡の歯)", () => {
    // クラス追跡が無いと regex が `[` の中の `/` で閉じたことにされ、続く `"` が dq mode を開き、
    // 後段の文字列内 `//` が行コメント扱いになって実コードが落ちる。
    const src = 'const S = /[/"]/; const t = "a // b keepInClass";\n';
    expect(stripComments(src)).toContain("keepInClass");
    RAN.regex++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  it("行を跨ぐ regex は認めない (閉じない `/` が後続行を飲み込まない)", () => {
    // 不正形入力のガード: regex 位置に閉じない `/` があっても、次行以降の走査を壊さない。
    const src = "const a = [ / ];\nconst b = 1; // dropMe\nconst keepAfterBogusSlash = 2;\n";
    const out = strippedWithout(src, "dropMe");
    expect(out).not.toContain("dropMe"); // NEGATIVE (次行のコメントは通常どおり落ちる)
    expect(out).toContain("keepAfterBogusSlash"); // POSITIVE 対
    RAN.regex++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  it("ファイル先頭の regex も skip される (直前の意味のある文字が無い位置)", () => {
    const src = '/["]/.test(x); const k = "a // b keepStart";\n';
    expect(stripComments(src)).toContain("keepStart");
    RAN.regex++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  it("除算は regex と誤認しない (JSX の自己閉じ `/>` を壊さない対照)", () => {
    expect(stripComments("const q = total / count; const keepDiv = 1;\n")).toContain("keepDiv");
    expect(stripComments("const el = <Foo bar={x} />;\nconst keepJsx = 1;\n")).toContain("keepJsx");
    RAN.regex++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
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
    const out = strippedWithout(src, "dropAfterBangRegex");
    expect(out).not.toContain("dropAfterBangRegex"); // NEGATIVE
    expect(out).toContain("const v = x /^a"); // POSITIVE 対
    RAN.regex++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  // 注: この vector と直下の `=>` 版は quote を含まない regex なので、当該位置を
  //   REGEX_PRECEDERS から外しても出力は変わらない (軸としては非 load-bearing)。
  //   軸そのものの load-bearing 性は下の「軸は load-bearing」群が担う (QA-CSX-R3-4)。
  it("`)` 直後の regex を skip する (行末コメントが落ちる)", () => {
    const out = strippedWithout(
      "if (x) /[a-z]/.test(s); // dropAfterParenRegex\n",
      "dropAfterParenRegex",
    );
    expect(out).not.toContain("dropAfterParenRegex"); // NEGATIVE
    expect(out).toContain("if (x) /[a-z]/.test(s);"); // POSITIVE 対 (regex は逐語で残る)
    RAN.regex++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  it("`=>` 直後の regex を skip する (行末コメントが落ちる)", () => {
    const out = strippedWithout(
      "const f = (x) => /[a-z]/.test(x); // dropAfterArrowRegex\n",
      "dropAfterArrowRegex",
    );
    expect(out).not.toContain("dropAfterArrowRegex"); // NEGATIVE
    expect(out).toContain("const f = (x) =>"); // POSITIVE 対
    RAN.regex++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  it("`)` / `=>` 直後の regex 内 backtick が後続テンプレートの parity を壊さない", () => {
    // QA-CSX-1 R1/R2 の形: backtick を含む文字クラスが tpl mode を開くと、以降の実テンプレート
    //   本文が code 扱いになって中身が落ちる (実コード喪失)。
    const a = "if (x) /[" + BACKTICK + "]/.test(s);\nconst t = `see https://keepParenTpl\nmore`;\n";
    const b =
      "const f = (x) => /[" + BACKTICK + "]/.test(x);\nconst t = `a https://keepArrowTpl\nb`;\n";
    expect(stripComments(a)).toContain("keepParenTpl");
    expect(stripComments(b)).toContain("keepArrowTpl");
    RAN.regex++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  it("閉じないブロックコメントはファイル残りを飲まない (fail-closed・SEC-CSX-2)", () => {
    // declined 位置 (識別子直後) の regex 文字クラス内 `/*` が block mode を開き `*/` が無いまま
    //   EOF まで飲むと、当該ファイルが全 tripwire の view から空になる (DROP)。閉じないブロックは
    //   コメントとみなさず逐語で残す (MISS = 安全側) へ縮退させる。
    const src = "const v = x /[^/*]/.test(s);\nfunction keepEverythingAfter() {}\n";
    expect(stripComments(src)).toContain("keepEverythingAfter");
    RAN.regex++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  // SEC-CSX-R2-1: 終端候補の直後が `*` の形 (= 直後がブロックコメント) も regex と認めない。
  //   `/` だけを拒否していたとき、除算 + 同一行ブロックコメントで、除算の `/` から `/*` の `/` までが
  //   regex と誤認され、`*` 以降のコメント本文が code として view に残っていた (repo 全体で 15 site)。
  it("`)` 直後の除算 + 同一行ブロックコメントを飲まない", () => {
    const out = strippedWithout(
      "const ms = (a ?? 0) / 1000; /* dropParenBlockPin */\n",
      "dropParenBlockPin",
    );
    expect(out).not.toContain("dropParenBlockPin"); // NEGATIVE
    expect(out).toContain("const ms = (a ?? 0) / 1000;"); // POSITIVE 対 (コードは逐語で残る)
    RAN.regex++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  it("`]` 直後の除算 + 同一行ブロックコメントを飲まない", () => {
    const out = strippedWithout(
      "const n = xs[0] / 2; /* dropBracketBlockPin */\n",
      "dropBracketBlockPin",
    );
    expect(out).not.toContain("dropBracketBlockPin"); // NEGATIVE
    expect(out).toContain("const n = xs[0] / 2;"); // POSITIVE 対
    RAN.regex++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  it("`=>` 直後の regex は同一行ブロックコメントがあっても skip され、コメントは落ちる", () => {
    const out = strippedWithout(
      "const f = (x) => /[a-z]/.test(x); /* dropArrowBlockPin */\n",
      "dropArrowBlockPin",
    );
    expect(out).not.toContain("dropArrowBlockPin"); // NEGATIVE
    expect(out).toContain("/[a-z]/.test(x);"); // POSITIVE 対 (regex は逐語で残る)
    RAN.regex++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  it("本物の regex の直後にブロックコメントが続く形は regex を保つ (過剰拒否でない対照)", () => {
    const out = strippedWithout(
      "const re = /a[b/c]d/gi; /* dropAfterRealRegex */\n",
      "dropAfterRealRegex",
    );
    expect(out).toContain("/a[b/c]d/gi"); // POSITIVE (regex 逐語)
    expect(out).not.toContain("dropAfterRealRegex"); // NEGATIVE 対
    RAN.regex++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  // SEC-CSX-R2-2: U+2028 / U+2029 は ECMAScript の LineTerminator。行コメントを終わらせ、
  //   regex リテラルを跨げない。`\n` と同格に扱わないと、以降が code として view に残る。
  it("U+2028 は行コメントを終わらせる (行コメント以降が view に残らない)", () => {
    const src = "const a = 1; // note\u2028const keepAfterLs = 2;\n";
    const out = strippedWithout(src, "note");
    expect(out).not.toContain("note"); // NEGATIVE
    expect(out).toContain("const keepAfterLs = 2;"); // POSITIVE 対 (実コードは残る)
    RAN.regex++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  it("U+2029 も行コメントを終わらせる", () => {
    const src = "const a = 1; // note\u2029const keepAfterPs = 2;\n";
    const out = strippedWithout(src, "note");
    expect(out).not.toContain("note"); // NEGATIVE
    expect(out).toContain("const keepAfterPs = 2;"); // POSITIVE 対
    RAN.regex++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  it("regex リテラルは U+2028 を跨がない (跨ぐと後続行を飲む)", () => {
    const src = "const v = x = /a\u2028const keepAfterLsRegex = 1; // dropMe\n";
    const out = strippedWithout(src, "dropMe");
    expect(out).toContain("keepAfterLsRegex"); // POSITIVE (行を跨いで飲んでいない)
    expect(out).not.toContain("dropMe"); // NEGATIVE 対 (次の行コメントは落ちる)
    RAN.regex++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  // QA-CSX-R3-3 (S1・:135): preceder 追跡は LineTerminator を「意味のある文字」に数えない。
  //   数えてしまうと、次の行頭に置かれた regex が declined になり (直前が改行)、その中の
  //   backtick がテンプレートを開いて後続のコメントを飲む。
  it("行を跨いだ preceder の直後の regex も skip される (改行は意味のある文字に数えない)", () => {
    const src = "const re =\n  /[" + BACKTICK + "]/;\nconst keep = 1; // dropAfterWrappedRegex\n";
    const out = strippedWithout(src, "dropAfterWrappedRegex");
    expect(out).not.toContain("dropAfterWrappedRegex"); // NEGATIVE
    expect(out).toContain("/[" + BACKTICK + "]/;"); // POSITIVE 対 (regex は逐語で残る)
    RAN.regex++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  // QA-CSX-R3-3 (S4・:381): regex 走査の行境界。既存の it (`const a = [ / ];` 形) は
  //   fail-closed guard (終端候補の直後が `//` / `*`) に吸収されて空虚だったので、**guard が
  //   発火しない**形 — 終端が普通の除算スラッシュ — を追加する。既存 it は削除していない。
  //   ここで pin するのは現挙動 (stray backtick がテンプレートを開いて落ち残る) であり、
  //   走査が行を跨ぐと **span に飲まれてコメントが落ちる = この pin が RED になる**。
  it("regex 走査は LF を跨がない (跨ぐと stray backtick が span へ飲まれ挙動が変わる)", () => {
    const src = "const v = x = /a" + BACKTICK + "b;\nconst c = 1 / 2; // keptByStrayTplLf\n";
    const out = stripComments(src);
    expect(out).toContain("keptByStrayTplLf"); // 現挙動の pin (落ち残り = 既知残余)
    expect(out).toContain("const c = 1 / 2;"); // POSITIVE 対 (実コードは消えない)
    RAN.regex++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  it("regex 走査は U+2028 も跨がない (LineTerminator 全体で境界を取る)", () => {
    const src = "const v = x = /a" + BACKTICK + "b;\u2028const c = 1 / 2; // keptByStrayTplLs\n";
    const out = stripComments(src);
    expect(out).toContain("keptByStrayTplLs"); // 現挙動の pin
    expect(out).toContain("const c = 1 / 2;"); // POSITIVE 対
    RAN.regex++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  // QA-CSX-R3-4 ≡ SEC-CSX-R2-5 + TDA-CSX-R3-2: R2/R3 で足した軸 vector は quote を含まない
  //   regex だったため、その位置を `REGEX_PRECEDERS` から外しても出力が変わらなかった
  //   (非 load-bearing)。**quote を含む regex** にすると、skip されない場合に単引用が開いて
  //   同一行のコメントが落ち残るので、軸そのものが出力に効く。既存 vector は削除していない。
  it("`]` 軸は load-bearing (外すと同一行のコメントが落ち残る形)", () => {
    const out = strippedWithout(
      "const ok = arr[i] /['\"]/.test(s); // dropAfterBracketRegexQuote\n",
      "dropAfterBracketRegexQuote",
    );
    expect(out).not.toContain("dropAfterBracketRegexQuote"); // NEGATIVE
    expect(out).toContain("arr[i] /['\"]/.test(s);"); // POSITIVE 対
    RAN.regex++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  it("`)` 軸は load-bearing (同上)", () => {
    const out = strippedWithout(
      "if (x) /['\"]/.test(s); // dropAfterParenRegexQuote\n",
      "dropAfterParenRegexQuote",
    );
    expect(out).not.toContain("dropAfterParenRegexQuote"); // NEGATIVE
    expect(out).toContain("if (x) /['\"]/.test(s);"); // POSITIVE 対
    RAN.regex++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  it("`=>` 軸は load-bearing (同上)", () => {
    const out = strippedWithout(
      "const f2 = (x) => /['\"]/.test(x); // dropAfterArrowRegexQuote\n",
      "dropAfterArrowRegexQuote",
    );
    expect(out).not.toContain("dropAfterArrowRegexQuote"); // NEGATIVE
    expect(out).toContain("=> /['\"]/.test(x);"); // POSITIVE 対
    RAN.regex++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  it("過剰拒否でない対照も load-bearing (regex skip を止めると出力が変わる形)", () => {
    // R3 の対照 vector は quote を含まない regex だったので skip の有無で出力が変わらなかった。
    const out = strippedWithout(
      "const re2 = /a['\"]b/; /* dropAfterRealRegexQuote */\nconst keepRR = 1;\n",
      "dropAfterRealRegexQuote",
    );
    expect(out).not.toContain("dropAfterRealRegexQuote"); // NEGATIVE
    expect(out).toContain("/a['\"]b/;"); // POSITIVE 対 (regex は逐語で残る)
    RAN.regex++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });
});

// ---------------------------------------------------------------------------
// (b) 非被覆 (残余) の実測 pin — doc の「閉じた」を禁じるための逐語の証拠
// ---------------------------------------------------------------------------

describe("INV-STRIP-COMMENTS-RESIDUALS: 落とさない形を実測で固定する (全称の主張をしない)", () => {
  it("文字列リテラルとして書かれた逐語コピーは落とさない (lexical 走査の構造的天井)", () => {
    const out = stripComments('const s = "export function isTimespecWord(";\n');
    expect(out).toContain("export function isTimespecWord(");
    RAN.residuals++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  it("残る declined 位置 (識別子 / `}` / 非 arrow の `>` 直後) の regex は skip されない", () => {
    // 有効な JS では識別子 / `}` / `>` の直後の `/` は除算であり、JSX の `{...p} />` とも
    // 衝突するため regex 位置に入れていない。ここに quote / backtick を含む regex を書くと
    // string / template mode を誤って開く。単引用 / 二重引用は **LF / CR** で resync するので
    // 影響はその行に閉じる (U+2028 / U+2029 では resync しない — ES2019 以降文字列内に生で
    // 書けるため)。backtick は resync しない。**方向は consumer 依存**: negative assert
    // (not.toContain) には厳しい側、presence pin (toContain) には**緩い側**に倒れる。
    const src =
      "const v = x /['\"]/.test(s); // residualSameLine\nconst b = 2; // droppedNextLine\n";
    const out = strippedWithout(src, "droppedNextLine");
    expect(out).toContain("residualSameLine"); // 同一行は落ち残る (実測)
    expect(out).not.toContain("droppedNextLine"); // 次行は resync 後なので落ちる (POSITIVE 対)
    RAN.residuals++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  it("残る declined 位置 + backtick は次の backtick まで落ち残る (改行 resync しない)", () => {
    const src = "const v = x /[" + BACKTICK + "]/.test(s);\\nconst a = 1; // residualAfterIdent\\n";
    const out = stripComments(src);
    expect(out).toContain("residualAfterIdent"); // 落ち残り (実測)
    expect(out).toContain("const a = 1;"); // 実コードは消えない (DROP でなく MISS 方向)
    RAN.residuals++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  // QA-CSX-R2-4 / TDA-CSX-R2-2: 直上の vector は改行を escape 済みの 2 文字として渡しており
  //   **物理的に 1 行**で、「backtick は改行で resync しない」という主張を検証していなかった。
  //   実改行を含む版を追加する (既存は削除しない — 追加のみ)。
  it("残る declined 位置 + backtick は **実改行**を跨いでも落ち残る (tpl は resync しない)", () => {
    const src =
      "const v = x /[" + BACKTICK + "]/.test(s);\nconst a = 1; // residualAfterIdentReal\n";
    expect(src).toContain("\n"); // 非空虚: 入力が実改行を含む (escape 済み文字列でない)
    const out = stripComments(src);
    expect(out).toContain("residualAfterIdentReal"); // 落ち残り (実測・改行を跨ぐ)
    expect(out).toContain("const a = 1;"); // 実コードは消えない (DROP でなく MISS 方向)
    RAN.residuals++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  it("同じ形でも単引用 / 二重引用は **実改行**で resync する (backtick との対照)", () => {
    const src = "const v = x /['\"]/.test(s);\nconst b = 2; // droppedNextLineReal\n";
    const out = strippedWithout(src, "droppedNextLineReal");
    expect(out).not.toContain("droppedNextLineReal"); // POSITIVE 対 (resync 後なので落ちる)
    RAN.residuals++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  // SEC-CSX-R3-1 (quote carrier): accepted 位置の除算と同一行に開き引用符があると、
  //   走査が終端を探して引用符を跨ぎ、その行のコメントが落ち残る。是正は追跡 task
  //   (01a05d34-e82b・v0.10)。ここでは**現挙動を既知残余として固定**する — 変わったら気付く。
  it("accepted 位置の除算 + 同一行の開き引用符はその行のコメントを落とし残す", () => {
    const src =
      "const n = (a) / 2; const s = 'x; // quoteCarrierNote\nconst after = 1; // afterQuoteCarrier\n";
    const out = strippedWithout(src, "afterQuoteCarrier");
    expect(out).toContain("quoteCarrierNote"); // 現挙動の pin (同一行は落ち残る)
    expect(out).not.toContain("afterQuoteCarrier"); // POSITIVE 対 (次行は resync 後なので落ちる)
    RAN.residuals++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  // QA-CSX-R3-2: 終端候補の直後が `*` の形を fail-closed で拒否した結果、**本物の**
  //   `/a/*2` (regex 乗算) も regex として skip されなくなり、その後の行のコメントが落ち残る。
  //   guard を外すと R2 の H が戻るので、これは意図した交換であり既知残余として固定する。
  it("`/re/*` (regex 乗算) は skip されず、後続行のコメントが落ち残る", () => {
    const out = stripComments("const y = /a/*2;\nconst keepRS = 1; // regexStarNote\n");
    expect(out).toContain("regexStarNote"); // 現挙動の pin
    expect(out).toContain("const keepRS = 1;"); // POSITIVE 対 (実コードは消えない)
    RAN.residuals++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  // QA-CSX-R2-5: flag 無し regex の直後に空白なしで行コメントが続く `/abc/// note` は、
  //   guard が regex を拒否した結果 regex の閉じ `/` まで行コメントに飲まれる (実コード脱落)。
  //   corpus コントロールがこの形の**導入**を RED にするので、既知残余として固定する。
  it("`/abc/// note` は regex の閉じスラッシュまで行コメントに飲まれる (実コード脱落)", () => {
    const out = strippedWithout(
      "const r = /abc/// slashSlashNote\nconst keepSL = 1;\n",
      "slashSlashNote",
      "/abc/",
    );
    expect(out).not.toContain("slashSlashNote"); // コメントは落ちる
    expect(out).toContain("const r = /abc"); // 現挙動の pin: 閉じ `/` が失われる
    expect(out).not.toContain("/abc/"); // NEGATIVE 対 (脱落を逐語で固定)
    RAN.residuals++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  // TDA-CSX-R4-2 ≡ QA-CSX-R4-1: **valid-TS の**最小再現。declined 位置 (`}` 直後) の regex が
  //   quote を含み、その行が U+2028 で終わると、単引用 mode が resync せず行コメントが view に残る。
  //   R3 の U+2028 修正 (resync を LF/CR 限定へ分離) が**意図的に**残した残余の逐語 pin。
  it("valid-TS の declined `}` 位置 + U+2028 は行コメントを落とし残す (MISS 方向)", () => {
    const src =
      "function qaW1() {} /['\"]/.test(String(1));\u2028const qaW1b = 1; // qaMarkMiss\nconst qaW1c = 2;\n";
    const out = strippedWithout(src, "qaMarkMiss");
    expect(out).toContain("qaMarkMiss"); // 現挙動の pin (MISS)
    expect(out).toContain("const qaW1c = 2;"); // POSITIVE 対 (実コードは消えない)
    RAN.residuals++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  it("同形の LF 版はコメントが落ちる (U+2028 との対照・resync が効く side)", () => {
    const src =
      "function qaW1() {} /['\"]/.test(String(1));\nconst qaW1b = 1; // qaMarkLf\nconst qaW1c = 2;\n";
    const out = strippedWithout(src, "qaMarkLf");
    expect(out).not.toContain("qaMarkLf"); // NEGATIVE (POSITIVE 対は strippedWithout)
    expect(out).toContain("const qaW1c = 2;"); // POSITIVE 対
    RAN.residuals++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  // TDA-CSX-R4-2 の DROP 側: `/re/*` の後方に `*\/` があるとブロックが閉じ、間の**実コード**が落ちる。
  //   MISS 側 (後続行のコメントが落ち残る) は上の `/re/*` pin が担う。両方向を別々に固定する。
  it("`/re/*` の後方に `*/` があると間の実コードが落ちる (DROP 方向)", () => {
    const src =
      "const y = /a/*2;\nfunction qaKeepDrop() {}\n/** doc */\nconst qaAfterDrop = 1; // qaMarkDrop\n";
    const out = strippedWithout(src, "qaKeepDrop");
    expect(out).not.toContain("qaKeepDrop"); // 現挙動の pin (DROP・実コード脱落)
    expect(out).toContain("const qaAfterDrop = 1;"); // POSITIVE 対 (後方は残る)
    RAN.residuals++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
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
  // TDA-CSX-R4-1 (fail-closed): strip 前から parse できないファイルは、truth (パーサが列挙した
  //   コメント範囲) 自体が信用できず、以下の比較が「strip が何をしても一致する」盲目スライスに
  //   なる。判定を保留せず offender として報告する (既存条件は不変・単調強化)。
  if (errsBefore > 0) findings.push("unparseable_before_strip");
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
  // SEC-CSX-R2-3: JavaScript 経路の代表。これが無いと、拡張子集合を `.ts` 系へ狭める編集が
  //   両方の走査 (corpus / sweep) から js/mjs/cjs を落としても緑のまま通る。
  "scripts/ci/assert-inv-ran.mjs",
  // TDA-CSX-R3-3 + QA-CSX-R2-7: 拡張子ごと / ルートごとの実在 member。`.mjs` だけだと
  //   `.js` / `.cjs` を落とす縮小や、`db/` ・リポジトリ直下を走査集合から外す縮小が
  //   緑のまま通る (member はすべて apps/ packages/ scripts/ 配下だった)。
  "docs/examples/opencode-adapter/adapter.js",
  ".pnpmfile.cjs",
  "db/migrations/1717459200000_init-event-store.ts",
  "vitest.config.ts",
] as const;

// SEC-CSX-R2-3: 走査集合の拡張子は正準 (`SCAN_SOURCE_EXTENSIONS` / `isScannedSourcePath`) を
// 共有する。以前はここに `.ts/.tsx/.mts/.cts` を手書きしていたため、`.js` / `.mjs` / `.cjs` の
// 経路が corpus コントロールからも単一出所 sweep からも**丸ごと外**にあった。

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
    .filter((f) => isScannedSourcePath(f));

function assertScanSetIsWhole(files: readonly string[]): void {
  // 件数だけを見ると `git ls-files packages apps/webui` へ縮めても緑のままになる (TDA-CSX-2)。
  for (const member of REQUIRED_SCAN_MEMBERS) {
    expect(files, `走査集合に ${member} が居ない (走査範囲の縮小)`).toContain(member);
  }
  expect(files.length, "repo-wide scan set").toBeGreaterThan(300);
}

describe("INV-STRIP-COMMENTS-CORPUS: repo 全体で実コードもコメントも取り違えていない", () => {
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
    // QA-CSX-R2-3: 実 corpus のファイルは 400 文字を軽く超える。小さい fixture だけだと
    //   「大きい入力は素通し」型の恒真化 (`if (original.length > 400) return findings;`) が
    //   corpus ループごと無音になる。同じ判定器へ **実 corpus 規模**の既知陽性 / 既知陰性を流す。
    const large = "foo(1); // pad\n".repeat(40) + 'const s2 = "y"; /* big */\n';
    expect(large.length, "fixture は実 corpus 規模").toBeGreaterThan(400);
    expect(analyze(large, "p5.ts", (src) => src)).toContain("comment_retained");
    expect(analyze(large, "p6.ts", stripComments)).toEqual([]);
    // 既知陽性 5 (TDA-CSX-R4-1): strip 前から parse できない入力。旧判定器はここで比較が
    //   恒真になり findings 空 = 盲目だった。
    expect(analyze("const s = 'unterminated\n", "p7.ts", stripComments)).toContain(
      "unparseable_before_strip",
    );
    // 既知陰性 (対): parse できる入力では立たない。
    expect(analyze(sample, "p8.ts", stripComments)).not.toContain("unparseable_before_strip");
    // TDA の再現形: JSX を含む `.mjs` は ScriptKind.TS で parse できず、strip は行コメントを
    //   view に残すのに、旧判定器の findings は空だった (現行 620 file には該当なし)。
    const parserBlind = "const probeEl = <div/>;\nconst probeQ = x /['\"]/.test(s); // MARKBLIND\n";
    expect(stripComments(parserBlind), "盲目スライスの実体").toContain("MARKBLIND"); // POSITIVE
    expect(analyze(parserBlind, "scripts/probe.mjs", stripComments)).toContain(
      "unparseable_before_strip",
    ); // NEGATIVE 対 (fail-closed で offender になる)
    RAN.corpus++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
  });

  it(
    "git 管理下の走査集合 (7 拡張子・620 file) で strip がコメント範囲と一致する",
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
      // 開示: JSX text 中の `//` 以降を落とす残余 (SEC-CSX-7) は base 同値の pre-existing だが、
      //   その形を**新たにソースへ導入すると**この assertion が RED になる (現行 620 file には無い)。
      expect(offenders, "strip はコメントだけを過不足なく落とす").toEqual([]);
      RAN.corpus++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
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
  it("検出器の歯: 正準の定義形は検出し、import のみのファイルは検出しない", () => {
    // 既知陽性 (正準の実装そのもの・同一検出器へ流す)。
    const canonical = readFileSync(join(REPO_ROOT, CANONICAL_REL), "utf8");
    expect(LOCAL_DEFINITION_RE.test(stripComments(canonical))).toBe(true);
    // 既知陰性 (消費点の形)。
    const consumerShape = 'import { stripComments } from "@actradeck/event-model";\n';
    expect(LOCAL_DEFINITION_RE.test(stripComments(consumerShape))).toBe(false);
    RAN.singleSource++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
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
      RAN.singleSource++; // 実行証跡は **計測 callback 末尾**で加算する (早期 return を RED にする)
    },
    CORPUS_IT_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// (e) 実行証跡 (QA-CSX-2 / TDA-CSX-4): describe 単体 skip を in-process で RED にする
// ---------------------------------------------------------------------------
// registration-time の件数 pin は `describe.skip` / 早期 return で緑のまま通る。各 it の
// **最後の文**で実行本数を加算し、**トップレベルの** afterAll で literal と照合する
// (skip された describe の it は加算に到達せず、it 先頭の早期 return も同様に到達しない。
//  `afterEach` は早期 return でも発火するため、QA-CSX-R2-2 ≡ TDA-CSX-R2-3 で置き換えた)。
// ファイル丸ごとの skip はこの afterAll も走らないため、CI 側 `assert-inv-ran --suite strip-comments`
// が第 2 層として受ける (PR #55 の sidecar-linear と同形の二段)。
afterAll(() => {
  expect(RAN, "INV-STRIP-COMMENTS の各 describe が実走した本数").toEqual(EXPECTED_RUNS);
});
