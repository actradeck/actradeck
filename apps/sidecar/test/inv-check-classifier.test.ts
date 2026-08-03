/**
 * INV-CHECK-CLASSIFIER (ADR 0015 §D6・B1・受入 11)。
 *
 * check 分類器 (`classifyCheck`) が:
 *  - `pnpm test` → (test, script) / `vitest run` → (test, program) を正しく分類する。
 *  - mutating 変種 (`eslint --fix` / `prettier --write`) を **非認定**する。
 *  - **正準トークナイザチェーン** (normalize.ts の tokenize/stripRunnerWrappers/commandName/
 *    normalizeCommandName/skipLeadingAssignments) を消費する — 第二パーサでないことを behavioral に固定する。
 *
 * ## meta-test の原理 (第二パーサ禁止の falsifiable な担保)
 * path 剥がし (`/usr/local/bin/vitest`)・quote 処理 (`"vitest"`)・runner 剥がし (`sudo pnpm test`)・
 * 先頭代入 skip (`TZ=utc vitest`)・version 接尾辞 (`python3.11` 相当は interpreter 側) は、**素朴な
 * `command.split(/\s+/)[0]` パーサでは実現できず、正準チェーンを通したときだけ**同一 basename に正規化される。
 * 各変種が plain 形と同一分類になることを assert することで、分類器が正準チェーンを消費している事実を固定する
 * (naive パーサなら少なくとも 1 変種で分類が崩れる)。
 */
import { describe, expect, it } from "vitest";

import { classifyCheck } from "../src/check-classifier.js";
import {
  commandName,
  normalizeCommandName,
  skipLeadingAssignments,
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
    const deassigned = raw.slice(skipLeadingAssignments(raw));
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
