/**
 * INV-CHECK-CLASSIFIER (ADR 0015 §D6・B1・受入 11)。
 *
 * check 分類器 (`classifyCheck`) が:
 *  - `pnpm test` → (test, script) / `vitest run` → (test, program) を正しく分類する。
 *  - mutating 変種 (`eslint --fix` / `prettier --write`) を **非認定**する。
 *  - **正準トークナイザチェーン** (normalize.ts の tokenize/stripRunnerWrappers/commandName/
 *    normalizeCommandName/skipCommandPrefixWords) を消費する — 第二パーサでないことを behavioral に固定する。
 *
 * ## meta-test の原理 (第二パーサ禁止の falsifiable な担保)
 * path 剥がし (`/usr/local/bin/vitest`)・quote 処理 (`"vitest"`)・runner 剥がし (`sudo pnpm test`)・
 * 先頭代入 skip (`TZ=utc vitest`)・version 接尾辞 (`python3.11` 相当は interpreter 側) は、**素朴な
 * `command.split(/\s+/)[0]` パーサでは実現できず、正準チェーンを通したときだけ**同一 basename に正規化される。
 * 各変種が plain 形と同一分類になることを assert することで、分類器が正準チェーンを消費している事実を固定する
 * (naive パーサなら少なくとも 1 変種で分類が崩れる)。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { classifyCheck } from "../src/check-classifier.js";
import {
  commandName,
  normalizeCommandName,
  skipCommandPrefixWords,
  stripRunnerWrappers,
  tokenize,
} from "../src/normalize.js";

describe("受入 11: 基本分類", () => {
  it("pnpm test → (test, script)", () => {
    expect(classifyCheck("pnpm test")).toEqual({ check_kind: "test", check_match: "script" });
  });
  it("vitest run → (test, program)", () => {
    expect(classifyCheck("vitest run")).toEqual({ check_kind: "test", check_match: "program" });
  });
  it("npm run lint → (lint, script)", () => {
    expect(classifyCheck("npm run lint")).toEqual({ check_kind: "lint", check_match: "script" });
  });
  it("make typecheck → (typecheck, script)", () => {
    expect(classifyCheck("make typecheck")).toEqual({
      check_kind: "typecheck",
      check_match: "script",
    });
  });
  it("tsc --noEmit → (typecheck, program)", () => {
    expect(classifyCheck("tsc --noEmit")).toEqual({
      check_kind: "typecheck",
      check_match: "program",
    });
  });
  it("prettier --check → (format, program); 素の prettier は非認定", () => {
    expect(classifyCheck("prettier --check .")).toEqual({
      check_kind: "format",
      check_match: "program",
    });
    expect(classifyCheck("prettier .")).toBeUndefined();
  });
});

describe("受入 11: mutating 変種は非認定 (§D6・fingerprint を無効化する)", () => {
  it("eslint --fix → undefined", () => {
    expect(classifyCheck("eslint --fix")).toBeUndefined();
  });
  it("prettier --write → undefined", () => {
    expect(classifyCheck("prettier --write .")).toBeUndefined();
  });
  it("eslint . (非 fix) → (lint, program)", () => {
    expect(classifyCheck("eslint .")).toEqual({ check_kind: "lint", check_match: "program" });
  });
  it("npm run lint:fix → undefined (script 名の fix)", () => {
    expect(classifyCheck("npm run lint:fix")).toBeUndefined();
  });
  it("prettier -w → undefined (formatter 文脈の -w = --write)", () => {
    expect(classifyCheck("prettier -w .")).toBeUndefined();
    // --check と併記でも -w があれば書き換えるので非認定 (矛盾指定の安全側)。
    expect(classifyCheck("prettier --check -w .")).toBeUndefined();
  });
});

describe("QA-B1-3: `-w` は workspace フラグ文脈では mutating でない", () => {
  it("pnpm -w test → (test, script)", () => {
    expect(classifyCheck("pnpm -w test")).toEqual({ check_kind: "test", check_match: "script" });
  });
  it("npm test -w pkg → (test, script)", () => {
    expect(classifyCheck("npm test -w pkg")).toEqual({ check_kind: "test", check_match: "script" });
  });
  it("pnpm -w run lint → (lint, script)", () => {
    expect(classifyCheck("pnpm -w run lint")).toEqual({
      check_kind: "lint",
      check_match: "script",
    });
  });
});

describe("QA-B1-2: exec-runner (npx/pnpx/pnpm exec) を貫通して内側 program を分類する", () => {
  it("npx vitest run → (test, program)", () => {
    expect(classifyCheck("npx vitest run")).toEqual({ check_kind: "test", check_match: "program" });
  });
  it("npx eslint . → (lint, program)", () => {
    expect(classifyCheck("npx eslint .")).toEqual({ check_kind: "lint", check_match: "program" });
  });
  it("npx -y tsc --noEmit → (typecheck, program) [runner フラグ -y を剥がす]", () => {
    expect(classifyCheck("npx -y tsc --noEmit")).toEqual({
      check_kind: "typecheck",
      check_match: "program",
    });
  });
  it("npx -p typescript tsc --noEmit → (typecheck, program) [値付き -p pkg を剥がす]", () => {
    expect(classifyCheck("npx -p typescript tsc --noEmit")).toEqual({
      check_kind: "typecheck",
      check_match: "program",
    });
  });
  it("pnpm exec eslint . → (lint, program)", () => {
    expect(classifyCheck("pnpm exec eslint .")).toEqual({
      check_kind: "lint",
      check_match: "program",
    });
  });
  it("pnpm dlx prettier --check . → (format, program)", () => {
    expect(classifyCheck("pnpm dlx prettier --check .")).toEqual({
      check_kind: "format",
      check_match: "program",
    });
  });
  it("yarn exec vitest → (test, program)", () => {
    expect(classifyCheck("yarn exec vitest")).toEqual({
      check_kind: "test",
      check_match: "program",
    });
  });
  it("pnpx eslint . → (lint, program)", () => {
    expect(classifyCheck("pnpx eslint .")).toEqual({ check_kind: "lint", check_match: "program" });
  });
  it("npx eslint --fix → undefined (内側 mutating を貫通後に検出)", () => {
    expect(classifyCheck("npx eslint --fix")).toBeUndefined();
  });
  it("npx tsx script.ts → undefined (内側が非チェック program)", () => {
    expect(classifyCheck("npx tsx script.ts")).toBeUndefined();
  });

  // QA-B1R2-4: unwrap の depth cap (MAX_EXEC_UNWRAP=3) を pin する。cap を超える多重 wrap で貫通を止める。
  //   開示: `npx npx ... vitest` の多重 exec-runner wrap は実 corpus に **0 件** (synthetic な forward-compat
  //   カバレッジ)。cap は無界再帰 (悪意ある/退化した多重 wrap) を有界化するための防御であり、実データ由来でない。
  it("QA-B1R2-4: exec-runner unwrap は MAX_EXEC_UNWRAP(3) で停止する (cap 超過は非分類)", () => {
    // cap 境界内 (≤3 wrap) は内側 program まで貫通して分類する。
    expect(classifyCheck("npx vitest run")).toEqual({ check_kind: "test", check_match: "program" }); // 1 wrap
    expect(classifyCheck("npx npx npx vitest run")).toEqual({
      check_kind: "test",
      check_match: "program",
    }); // 3 wrap = cap ちょうど
    // cap 超過 (4 wrap) は貫通を止め、外側の npx (非チェック program) のまま undefined。
    expect(classifyCheck("npx npx npx npx vitest run")).toBeUndefined(); // 4 wrap > cap → 停止
  });
});

describe("受入 11: subcommand program", () => {
  it("go test ./... → (test, program)", () => {
    expect(classifyCheck("go test ./...")).toEqual({ check_kind: "test", check_match: "program" });
  });
  it("cargo clippy → (lint, program)", () => {
    expect(classifyCheck("cargo clippy")).toEqual({ check_kind: "lint", check_match: "program" });
  });
  it("ruff check scripts → (lint, program) [実 rollout 形]", () => {
    expect(classifyCheck(".venv/bin/ruff check scripts")).toEqual({
      check_kind: "lint",
      check_match: "program",
    });
  });
  it("go build → (build, program); go run は非認定", () => {
    expect(classifyCheck("go build ./...")).toEqual({
      check_kind: "build",
      check_match: "program",
    });
    expect(classifyCheck("go run main.go")).toBeUndefined();
  });
});

describe("非チェックは undefined (証拠なし = honest・other_check backstop 無し)", () => {
  it.each(["ls -la", "git status", "cat foo.txt", "echo hi", "rm -rf /tmp/x", "", "   "])(
    "%s → undefined",
    (cmd) => {
      expect(classifyCheck(cmd)).toBeUndefined();
    },
  );
});

describe("複数セグメント: 最初のチェックを拾う", () => {
  it("`cd app && pnpm test` → (test, script)", () => {
    expect(classifyCheck("cd app && pnpm test")).toEqual({
      check_kind: "test",
      check_match: "script",
    });
  });
  it("`ruff check . && pytest -q` → (lint, program) [先頭優先・実 rollout 形]", () => {
    expect(classifyCheck(".venv/bin/ruff check . && .venv/bin/pytest -q")).toEqual({
      check_kind: "lint",
      check_match: "program",
    });
  });
});

describe("meta-test (受入 11): 正準トークナイザチェーンを消費している (第二パーサでない)", () => {
  // 各行: [変種, plain 形]。変種は canonical chain を通したときだけ plain と同一 basename に正規化される。
  const variants: Array<[string, string, string]> = [
    ["path 剥がし", "/usr/local/bin/vitest run", "vitest run"],
    ["quote 処理", '"vitest" run', "vitest run"],
    ["runner 剥がし (sudo)", "sudo pnpm test", "pnpm test"],
    ["runner 剥がし (env+代入)", "env CI=1 pnpm test", "pnpm test"],
    ["runner 剥がし (timeout+duration)", "timeout 60 pytest -q", "pytest -q"],
    ["先頭代入 skip", "TZ=utc vitest run", "vitest run"],
    ["path+quote 複合", "'/usr/bin/eslint' .", "eslint ."],
  ];

  it.each(variants)(
    "%s: 変種と plain が同一分類 (canonical 正規化の証)",
    (_label, variant, plain) => {
      const a = classifyCheck(variant);
      const b = classifyCheck(plain);
      expect(a).toEqual(b);
      expect(a).toBeDefined();
    },
  );

  it("分類の basename が canonical チェーン (tokenize→skipAssign→stripWrappers→commandName→normalize) と一致する", () => {
    // classifyCheck が返す program 分類は、正準チェーンで導いた basename の語彙照合に一致するはず。
    const cmd = "env FOO=1 /opt/bin/vitest run";
    // 正準チェーンを test 側でも同じ手順で回して basename を導く。
    const raw = tokenize(cmd);
    const deassigned = raw.slice(skipCommandPrefixWords(raw));
    const { tokens } = stripRunnerWrappers(deassigned);
    const base = normalizeCommandName(commandName(tokens));
    expect(base).toBe("vitest"); // canonical chain の帰結。
    // 分類器も同じ basename 解釈で test/program を返す。
    expect(classifyCheck(cmd)).toEqual({ check_kind: "test", check_match: "program" });
  });

  it("naive `split[0]` パーサなら少なくとも 1 変種で分類が崩れる (第二パーサ回帰の tripwire)", () => {
    const naive = (cmd: string): string => cmd.trim().split(/\s+/)[0] ?? "";
    // 素朴パーサは path/quote/wrapper/代入を正規化しないため basename が語彙に一致しない。
    expect(naive("/usr/local/bin/vitest run")).toBe("/usr/local/bin/vitest"); // ≠ "vitest"
    expect(naive("sudo pnpm test")).toBe("sudo"); // ≠ "pnpm"
    expect(naive("TZ=utc vitest run")).toBe("TZ=utc"); // ≠ "vitest"
    // だが classifyCheck は全て正しく分類する (= naive でない証)。
    expect(classifyCheck("/usr/local/bin/vitest run")?.check_kind).toBe("test");
    expect(classifyCheck("sudo pnpm test")?.check_kind).toBe("test");
    expect(classifyCheck("TZ=utc vitest run")?.check_kind).toBe("test");
  });
});

// TDA-CQ-1 (2026-08-14): check-classifier は分類器と同じ splitSegments を消費するため、
// quote-aware 化 (fix/classifier-quoted-operators) の走査範囲変更がここにも波及する。
// 両方向を pin する: 引用内演算子は crediting を壊さず、引用内の偽 check 語は credit しない。
describe("quoted operators in check commands (splitSegments coupling)", () => {
  it("quoted args with pipes do not break check crediting", () => {
    expect(classifyCheck("vitest run -t 'a|b'")).toEqual({
      check_kind: "test",
      check_match: "program",
    });
    expect(classifyCheck("pnpm test # rerun after fix")).toEqual({
      check_kind: "test",
      check_match: "script",
    });
  });

  it("a check word inside a quoted string is data, not a credited check (false-credit removal)", () => {
    // 旧分割は "foo | pytest" の引用内 | で裂けて pytest を segment として誤 credit した。
    expect(classifyCheck('echo "foo | pytest"')).toBeUndefined();
  });
});

describe("R11 H2 (QA-CQ11-2 ≡ SEC-CQ11-2): compound statements never credit a check (fake-green)", () => {
  // 実 bash: `if false; then touch M; fi` は M を作らず rc=0。`! pytest` は exit を反転する。
  //   予約語を読み飛ばして内側を認定すると、失敗したテストが passed バッジになる (ADR 0015 の禁止方向)。
  it("reserved words are not skipped by the check classifier", () => {
    let checked = 0;
    for (const cmd of [
      "if false; then pytest; fi",
      "! pytest",
      "if ! npm test; then echo failed; fi",
      "while pytest; do :; done",
      "until pytest -q; do sleep 1; done",
      "! eslint .",
      "! tsc --noEmit",
    ]) {
      expect(classifyCheck(cmd), cmd).toBeUndefined();
      checked += 1;
    }
    expect(checked).toBe(7);
    // `time` は予約語であると同時に runner ラッパで、exit は配下のものが素通しされる → 正当な credit。
    expect(classifyCheck("time pytest")).toEqual({ check_kind: "test", check_match: "program" });
  });

  it("env assignments are still skipped, and the pre-existing && form is unchanged", () => {
    expect(classifyCheck("CI=1 pytest")).toEqual({ check_kind: "test", check_match: "program" });
    expect(classifyCheck("FOO=1 BAR=2 npm test")).toEqual({
      check_kind: "test",
      check_match: "script",
    });
    // `false && pytest` は exit 1 で自己限定する既知の形 (base から同じ・R11 で変えていない)。
    expect(classifyCheck("false && pytest")).toEqual({
      check_kind: "test",
      check_match: "program",
    });
  });

  it("R12 H1 (QA-CQ12-1): multi-line compound statements are not credited either", () => {
    // `\n` はセグメント区切りなので予約語が自分のセグメントに落ち、セグメント単位のフェンスは届かない。
    //   実 bash: `if false; then\n  touch M\nfi` は M を作らず rc=0 = passed バッジになる形。
    let checked = 0;
    for (const cmd of [
      "if false; then\n  pytest\nfi",
      "while false; do\n  npm test\ndone",
      "until true; do\n  eslint .\ndone",
      "if false\nthen\n  tsc --noEmit\nfi",
      "case y in\n  x) pytest;;\nesac",
      "for f in; do\n  pytest\ndone",
    ]) {
      expect(classifyCheck(cmd), cmd).toBeUndefined();
      checked += 1;
    }
    expect(checked).toBe(6);
    // 複合文を含まない複数行は普通に credit される (ガードが過剰でないこと)。
    expect(classifyCheck("cd app\npytest")).toEqual({ check_kind: "test", check_match: "program" });
  });

  it("R13 H1 (SEC-CQ13-1 ≡ QA-CQ13-1): shell function definitions are not credited", () => {
    // QA-CQ12-1 の recommendation が名指しした「関数定義ヘッダ (`name() {`)」は、上の R12 H1 が
    //   件数 6 を合わせる裏で 1 形だけ落としていた (SEC-CQ13-2: 件数一致は landing でない)。ここでは
    //   所見の evidence を逐語で pin する。実 bash (marker 方式・裁定者が再現):
    //     `run() {\n  touch M\n}`       → M を作らず rc=0  (定義だけ・本体は走らない)
    //     `function run {\n  touch M\n}` → M を作らず rc=0
    //     `{\n  touch M\n}`             → M を作る        (グループは本体を実行する・対照)
    //   `function` / `name()` は COMMAND_POSITION_RESERVED_WORDS に無い (risk 側の前置語 skip と
    //   共有しない) ので、check 局所のカーブアウトで拾う。
    const FUNCTION_DEFINITIONS = [
      "run() {\n  pytest\n}",
      "function run {\n  pytest\n}",
      "function run() {\n  pytest\n}",
      "run()\n{\n  pytest\n}",
      "check () {\n  npm test\n}",
      "test_all() { pytest; }",
      "_ci() {\n  eslint .\n}",
      "t() {\n  tsc --noEmit\n}",
      "pytest; run() { :; }", // 定義が後ろでも全体の exit は定義の 0 になる
    ];
    for (const cmd of FUNCTION_DEFINITIONS) expect(classifyCheck(cmd), cmd).toBeUndefined();
    // 対照: 本体を実行する grouping / subshell は credit される (ガードが過剰でないこと)。
    expect(classifyCheck("{\n  pytest\n}")).toEqual({ check_kind: "test", check_match: "program" });
    expect(classifyCheck("(\n  pytest\n)")).toEqual({ check_kind: "test", check_match: "program" });
    // 単一行の `{ pytest; }` は base から undefined (grouping 語がセグメント先頭に残る under-credit・
    //   安全方向・本ラウンドで変えない)。
    expect(classifyCheck("{ pytest; }")).toBeUndefined();
  });

  it("QA-CQ13-2: the compound-statement guard scans every segment, not only the first", () => {
    // `segments[0]` だけを見る変異は R12 の vector (すべて予約語が先頭セグメント) では生き残った。
    for (const cmd of [
      "echo a\nif false; then\n  pytest\nfi",
      "cd app && true\nwhile false; do\n  npm test\ndone",
      "pytest\nfunction run {\n  :\n}",
      "npm test\nif false; then :; fi",
    ]) {
      expect(classifyCheck(cmd), cmd).toBeUndefined();
    }
    expect(classifyCheck("cd app\npytest")).toEqual({ check_kind: "test", check_match: "program" });
  });

  it("R12 M1 (SEC-CQ12-1): oversized commands yield no evidence, and fast", () => {
    // `checkFields` は `splitSegments` の唯一のガード無し消費者で、4 MiB の入力で同期 hook パスが
    //   3 分停止した。解析可能長を超えたら証拠なし (undefined) で即帰る。
    const huge = `pytest ${">o ".repeat(12_000)}`; // 36 KiB > 16 KiB
    expect(huge.length).toBeGreaterThan(16 * 1024);
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 3; i += 1) {
      const started = performance.now();
      expect(classifyCheck(huge)).toBeUndefined();
      best = Math.min(best, performance.now() - started);
    }
    expect(best, "oversized input must short-circuit").toBeLessThan(50);
  });

  it("known pre-existing gap (v0.9 task 01a03bb6): sequencing after the check still credits it", () => {
    // exit がコマンド全体のものになる形 (SEC-CQ12-2・base 同値・32 combos)。R12 では意図的に触らない。
    expect(classifyCheck("pytest ; echo done")).toEqual({
      check_kind: "test",
      check_match: "program",
    });
    expect(classifyCheck("npm test || true")).toEqual({
      check_kind: "test",
      check_match: "script",
    });
  });

  it("source coupling: the check classifier derives the program through the canonical chain with reserved words off", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/check-classifier.ts", import.meta.url)),
      "utf8",
    );
    expect(src).toContain("programTokens(rawTokens, { reservedWords: false })");
    expect(src).not.toMatch(/skipCommandPrefixWords\(/);
    // R12: 複合文ガードと長さガードは classifyCheck の入口にあること。
    expect(src).toContain("if (hasCompoundStatement(segments)) return undefined;");
    // R13: 関数定義ヘッダの腕は check 局所 (risk 側と共有する予約語集合へ `function` を足さない)。
    expect(src).toContain('head === "function" || head.endsWith("()") || second === "()"');
    expect(src).not.toMatch(/COMMAND_POSITION_RESERVED_WORDS\.add\(/);
    expect(src).toContain("if (command.length > MAX_ANALYZABLE_COMMAND_LEN) return undefined;");
  });
});
