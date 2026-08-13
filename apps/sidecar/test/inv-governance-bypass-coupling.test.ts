import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  BYPASS_PERMISSION_MODE,
  governanceModeFor,
  isBypassPermissionMode,
} from "../src/permission-mode.js";

/**
 * INV-GOVERNANCE-BYPASS-COUPLING (SEC-R2-2 → SEC-R3-1 で排他性を強化・2026-08-14)
 *
 * governance_mode 宣言 (normalize.ts) と bypass 承認ゲート (approval-bridge.ts) は
 * permission-mode.ts の単一出所を共有しなければならない。R3 監査 (SEC-R3-1) で、旧版が
 * 「単一出所 + 両サイト消費」しか固定せず、**ゲート側に `|| mode === "別値"` を足す**
 * (= docstring が謳う故障クラスそのもの) が素通りすることが実証された。本版は排他性を固定する:
 *  (1) 引用リテラル (どの quote 形でも・SEC-R3-3) は permission-mode.ts のみ。
 *  (2) permission_mode の**値比較**は permission-mode.ts の外に存在しない (typeof 判定は除外)。
 *  (3) bridge のゲート条件は boolean 演算子を伴わない `isBypassPermissionMode(...)` 単独形。
 *  (4) 宣言側は governanceModeFor() を消費する (独自の三項分岐を持たない)。
 *
 * ⚠️ 走査範囲 (scope) 契約: この metatest の走査正規化 (src 再帰・.ts/.tsx・quote 形・比較
 * regex) を変える修正は finding-registry の full 再監査既定に該当する。
 */
const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const SINGLE_SOURCE_FILE = "permission-mode.ts";
// SEC-R3-3: single/double/backtick どの quote 形でも捕捉する。
const QUOTED_LITERAL_RE = /["'`]bypassPermissions["'`]/;
// SEC-R3-1: 値比較の排他 — `typeof x === "string"` (型判定) と `!== undefined` (presence 判定)
// は許容し、それ以外 (リテラル・定数を問わず bypass 集合を広げうる値比較) を禁じる。
// (lookahead は `\s*` の backtracking で迂回されないよう空白込みで否定し、lookbehind は
//  optional な `input.` を挟んだ typeof 形 — `typeof input.permission_mode === "string"` の
//  途中から `permission_mode ===` だけを拾う迂回 — も両形で除外する)
const VALUE_COMPARISON_RE =
  /(?<!typeof )(?<!typeof input\.)permission_mode\s*[!=]==(?!\s*undefined\b)/;

async function sourceFiles(): Promise<string[]> {
  const entries = await readdir(SRC_DIR, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => relative(SRC_DIR, join(entry.parentPath, entry.name)))
    .sort();
}

describe("INV-GOVERNANCE-BYPASS-COUPLING", () => {
  it("the bypassPermissions literal (any quote form) lives only in the single-source module", async () => {
    const files = await sourceFiles();
    // 走査自体の vacuity guard: 対象集合に両消費サイトと単一出所が実在する。
    expect(files).toContain("normalize.ts");
    expect(files).toContain("approval-bridge.ts");
    expect(files).toContain(SINGLE_SOURCE_FILE);

    const offenders: string[] = [];
    for (const file of files) {
      const content = await readFile(join(SRC_DIR, file), "utf8");
      if (file === SINGLE_SOURCE_FILE) {
        expect(content).toMatch(QUOTED_LITERAL_RE); // POSITIVE: 単一出所は実際に定義を持つ。
        continue;
      }
      if (QUOTED_LITERAL_RE.test(content)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("SEC-R3-1: no permission_mode value comparison exists outside the single source (exclusivity)", async () => {
    // ゲート側に `|| input.permission_mode === "someFutureSkipMode"` を足す変更は、リテラルが
    // 何であれこの assert が RED にする (旧版はリテラル走査のみで新値の追加が素通りだった)。
    for (const file of await sourceFiles()) {
      if (file === SINGLE_SOURCE_FILE) continue;
      const content = await readFile(join(SRC_DIR, file), "utf8");
      const hit = VALUE_COMPARISON_RE.exec(content);
      expect(hit, `${file} must not compare permission_mode values directly: ${hit?.[0]}`).toBe(
        null,
      );
    }
  });

  it("SEC-R3-1: the bridge gate condition is the bare shared predicate (no boolean widening)", async () => {
    const bridge = await readFile(join(SRC_DIR, "approval-bridge.ts"), "utf8");
    // 条件行そのものを pin する: predicate 単独・`||`/`&&` での拡張なし。
    expect(bridge).toMatch(/^\s*if \(isBypassPermissionMode\(input\.permission_mode\)\) \{$/m);
    // predicate 呼び出しが boolean 演算子と同一行で合成されていない。
    const widened = bridge
      .split("\n")
      .filter((line) => line.includes("isBypassPermissionMode(") && /\|\||&&/.test(line));
    expect(widened).toEqual([]);
  });

  it("SEC-R3-1: the declaration side consumes governanceModeFor (no local re-derivation)", async () => {
    const normalize = await readFile(join(SRC_DIR, "normalize.ts"), "utf8");
    expect(normalize).toContain('import { governanceModeFor } from "./permission-mode.js";');
    expect(normalize).toContain("governance_mode: governanceModeFor(input.permission_mode)");
    // 宣言側が predicate を直接使って独自分岐を再導入しない (導出は単一関数に限る)。
    expect(normalize).not.toContain("isBypassPermissionMode(");
  });

  it("the predicate and derivation match exactly the bypass mode and nothing else", () => {
    expect(BYPASS_PERMISSION_MODE).toBe("bypassPermissions");
    expect(isBypassPermissionMode("bypassPermissions")).toBe(true);
    expect(governanceModeFor("bypassPermissions")).toBe("unavailable");
    for (const mode of [undefined, "", "default", "acceptEdits", "plan", "someFutureSkipMode"]) {
      expect(isBypassPermissionMode(mode), `mode=${String(mode)}`).toBe(false);
      expect(governanceModeFor(mode), `mode=${String(mode)}`).toBe("enforcement");
    }
  });
});
