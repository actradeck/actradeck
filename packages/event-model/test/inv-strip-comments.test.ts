/**
 * INV-STRIP-COMMENTS: 走査正規化 (comment-strip) の単一出所を**挙動**で固定する。
 *
 * 本 helper は sidecar / backend / webui / event-model の tripwire・metatest が共有する
 * 走査の view そのもので、緩めると全消費点の歯が同時に鈍る。よって pin は綴りでなく挙動に置く:
 *  (a) 被覆軸 (行頭 / 行末 / block / 文字列保存 / regex skip) を POSITIVE-NEGATIVE 対で固定。
 *  (b) 非被覆 (残余) も**実測値として**固定する — 「閉じた」と書かないための逐語の証拠。
 *  (c) corpus コントロール: strip 後のソースが TypeScript parser を通ること (= 実コードを
 *      落としていないこと) を実ファイルで実走し、その判定器自身に既知陽性 / 既知陰性を流す。
 *  (d) consolidation 不変条件: repo 全体で comment-strip の実装が 1 本しか無いこと。
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { stripComments } from "../src/test-strip-comments.js";

const PKG_ROOT = fileURLToPath(new URL("../", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** 正準の在処 (repo 相対)。consolidation sweep の唯一の除外先。 */
const CANONICAL_REL = "packages/event-model/src/test-strip-comments.ts";
/** 本テスト自身 (fixture として実装形の文字列を持つため sweep の対象外)。 */
const SELF_REL = "packages/event-model/test/inv-strip-comments.test.ts";

// ---------------------------------------------------------------------------
// (a) 被覆軸: POSITIVE-NEGATIVE 対
// ---------------------------------------------------------------------------

describe("INV-STRIP-COMMENTS-AXES: コメントは落ち、コードは落ちない", () => {
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
});

describe("INV-STRIP-COMMENTS-LITERALS: 文字列 / テンプレートの中は落とさない", () => {
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

  it("除算は regex と誤認しない (JSX の自己閉じ `/>` を壊さない対照)", () => {
    expect(stripComments("const q = total / count; const keepDiv = 1;\n")).toContain("keepDiv");
    expect(stripComments("const el = <Foo bar={x} />;\nconst keepJsx = 1;\n")).toContain("keepJsx");
  });
});

// ---------------------------------------------------------------------------
// (b) 非被覆 (残余) の実測 pin — doc の「閉じた」を禁じるための逐語の証拠
// ---------------------------------------------------------------------------

describe("INV-STRIP-COMMENTS-RESIDUALS: 落とさない形を実測で固定する (全称の主張をしない)", () => {
  it("文字列リテラルとして書かれた逐語コピーは落とさない (lexical 走査の構造的天井)", () => {
    const out = stripComments('const s = "export function isTimespecWord(";\n');
    expect(out).toContain("export function isTimespecWord(");
  });

  it("テンプレート補間 `${…}` の中のコメントは落とさない", () => {
    const out = stripComments("const t = `${x /* residualBlock */}`;\n");
    expect(out).toContain("residualBlock");
  });

  it("regex 位置ヒューリスティックが除外側に倒れる位置 (`)` 直後) の regex は skip されない", () => {
    // `)` の直後は除算と衝突するため regex とみなさない。結果として backtick 文字クラスが
    // テンプレートを開き、後続のコメントが**落ち残る** (走査が厳しい側へ縮退・実コードは消えない)。
    const src = "if (x) /[`]/.test(s);\nconst a = 1; // residualAfterParen\n";
    const out = stripComments(src);
    expect(out).toContain("residualAfterParen");
    expect(out).toContain("const a = 1;"); // コードは消えない (弱化ではなく落とし残し)
  });

  it("`'` / `\"` mode は改行で resync するため desync は 1 行に閉じる", () => {
    const src = "if (x) /['\"]/.test(s); // residualSameLine\nconst b = 2; // droppedNextLine\n";
    const out = stripComments(src);
    expect(out).toContain("residualSameLine"); // 同一行は落ち残る (実測)
    expect(out).not.toContain("droppedNextLine"); // 次行は resync 後なので落ちる (POSITIVE 対)
  });
});

// ---------------------------------------------------------------------------
// (c) corpus コントロール (実行可能・判定器自身に既知陽性 / 既知陰性を流す)
// ---------------------------------------------------------------------------

/** strip 後のソースが TypeScript parser で構文エラーにならないか。 */
function parseErrorCount(source: string, fileName: string): number {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, false, kind);
  return (sf as unknown as { parseDiagnostics: readonly unknown[] }).parseDiagnostics.length;
}

function listTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "coverage") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) listTsFiles(p, acc);
    else if ([".ts", ".tsx"].includes(extname(p))) acc.push(p);
  }
  return acc;
}

describe("INV-STRIP-COMMENTS-CORPUS: 実ファイルで実コードを落としていない", () => {
  it("判定器の歯: 壊れた出力は検出し、健全な出力は検出しない (既知陽性 / 既知陰性)", () => {
    // 既知陽性: 文字列の途中で切った出力 (comment-strip が実コードを落とした形の代理)。
    expect(parseErrorCount('const s = "unterminated\n', "positive.ts")).toBeGreaterThan(0);
    // 既知陰性: 健全なソース。
    expect(parseErrorCount('const s = "fine";\n', "negative.ts")).toBe(0);
  });

  it("event-model の src/test 全ファイルは strip 後も構文エラー無く parse される", () => {
    const files = [
      ...listTsFiles(join(PKG_ROOT, "src")),
      ...listTsFiles(join(PKG_ROOT, "test")),
    ].sort();
    // 非空虚: 走査集合が実在すること (glob が空になる変異は RED)。
    expect(files.length, "corpus is non-empty").toBeGreaterThan(20);
    const broken = files.filter(
      (f) => parseErrorCount(stripComments(readFileSync(f, "utf8")), f) > 0,
    );
    expect(broken.map((f) => f.slice(REPO_ROOT.length))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (d) consolidation 不変条件: comment-strip の実装は repo に 1 本だけ
// ---------------------------------------------------------------------------

/** ローカルな comment-strip 実装の定義形 (関数宣言 / 変数束縛の両綴り)。 */
const LOCAL_DEFINITION_RE = /(?:function|const|let|var)\s+stripComments\b/;

describe("INV-STRIP-COMMENTS-SINGLE-SOURCE: 未移行コピーが repo に残っていない", () => {
  const gitFiles = (): string[] =>
    execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" })
      .split("\n")
      .filter((f) => /\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(f));

  it("検出器の歯: 正準の定義形は検出し、import のみのファイルは検出しない", () => {
    // 既知陽性 (正準の実装そのもの・同一検出器へ流す)。
    const canonical = readFileSync(join(REPO_ROOT, CANONICAL_REL), "utf8");
    expect(LOCAL_DEFINITION_RE.test(stripComments(canonical))).toBe(true);
    // 既知陰性 (消費点の形)。
    const consumerShape = 'import { stripComments } from "@actradeck/event-model";\n';
    expect(LOCAL_DEFINITION_RE.test(stripComments(consumerShape))).toBe(false);
  });

  it("正準以外のどのファイルも comment-strip をローカル定義しない", () => {
    const files = gitFiles().filter((f) => f !== CANONICAL_REL && f !== SELF_REL);
    // 非空虚: repo 全体を走査していること (対象集合を絞る変異は RED)。
    expect(files.length, "repo-wide scan set").toBeGreaterThan(300);
    const offenders = files.filter((f) => {
      let src: string;
      try {
        src = readFileSync(join(REPO_ROOT, f), "utf8");
      } catch {
        return false; // symlink / 削除途中は無視 (走査の非空虚性は上で固定済み)
      }
      return LOCAL_DEFINITION_RE.test(stripComments(src));
    });
    expect(offenders, "comment-strip は正準 1 本のみ").toEqual([]);
  });
});
