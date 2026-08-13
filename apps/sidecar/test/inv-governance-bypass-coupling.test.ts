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
 * (= docstring が謳う故障クラスそのもの) が素通りすることが実証された。R4 監査
 * (SEC-R4-1 ≡ QA-R4-1 ≡ TDA-R4-9) で、R3 の比較形 regex (`permission_mode ===`) が
 * **形式依存** — 中間 const alias / `Set.has()` / switch / 分割代入など 8 形が素通り — と
 * 実証されたため、本版は**トークン出現 allowlist** (file → 出現数の完全一致 pin) へ置換した。
 * 第二の独立ゲートは形がどうあれ `permission_mode` をどこかで読む必要があり、トークン出現が
 * 増えた時点で RED になる (形式非依存)。固定する排他性:
 *  (1) 引用リテラル (どの quote 形でも・SEC-R3-3) は permission-mode.ts のみ。
 *  (2) `permission_mode` トークンの出現は下記 allowlist の file×件数に完全一致する
 *      (コメント内の言及も数える = 保守的。正当なリファクタ時はこの map を実測で更新し、
 *      増えた出現が単一出所の predicate/導出を経由することをレビューで確認する)。
 *  (3) bridge のゲート条件は boolean 演算子を伴わない `isBypassPermissionMode(...)` 単独形で、
 *      bridge 内の permission_mode 出現は丁度 1 (= その predicate 呼び出しのみ)。
 *  (4) 宣言側は governanceModeFor() を消費する (独自の三項分岐を持たない)。
 * 既知の限界 (正直開示): トークン走査ゆえ `input["permission" + "_mode"]` のような動的
 * プロパティ構成は検知しない (敵対的難読化は single-operator 境界の脅威モデル外・レビュー対象)。
 *
 * ⚠️ 走査範囲 (scope) 契約: この metatest の走査正規化 (src 再帰・.ts/.tsx・quote 形・
 * 出現 allowlist) を変える修正は finding-registry の full 再監査既定に該当する。
 */
const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const SINGLE_SOURCE_FILE = "permission-mode.ts";
// SEC-R3-3: single/double/backtick どの quote 形でも捕捉する。
const QUOTED_LITERAL_RE = /["'`]bypassPermissions["'`]/;
// SEC-R4-1: permission_mode トークンの出現 allowlist (file → 件数の完全一致)。
// 2026-08-14 実測。件数を変える正当な変更はこの map を更新する (増分は単一出所経由をレビュー)。
const PERMISSION_MODE_OCCURRENCES: Readonly<Record<string, number>> = {
  "approval-bridge.ts": 1, // ゲート条件の isBypassPermissionMode(input.permission_mode) のみ。
  "event-factory.ts": 5, // 型 field 宣言 + 投影 (値比較なし)。
  "normalize.ts": 9, // hook 入力型 + 投影 + governanceModeFor 消費 (値比較なし)。
  [SINGLE_SOURCE_FILE]: 3, // 単一出所自身 (predicate + 導出 + docstring)。
};

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

  it("SEC-R4-1: permission_mode token occurrences match the allowlist exactly (form-independent exclusivity)", async () => {
    // 第二の独立ゲート (`const pm = input.permission_mode; if (S.has(pm)) …` / switch /
    // 分割代入など、R3 の比較形 regex が素通りした 8 形すべて) は permission_mode トークンを
    // どこかで読む必要があり、出現数の完全一致 pin が形式非依存に RED にする。
    const counts: Record<string, number> = {};
    for (const file of await sourceFiles()) {
      const content = await readFile(join(SRC_DIR, file), "utf8");
      const n = (content.match(/permission_mode/g) ?? []).length;
      if (n > 0) counts[file] = n;
    }
    expect(counts).toEqual(PERMISSION_MODE_OCCURRENCES);
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
