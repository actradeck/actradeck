import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BYPASS_PERMISSION_MODE, isBypassPermissionMode } from "../src/permission-mode.js";

/**
 * INV-GOVERNANCE-BYPASS-COUPLING (SEC-R2-2・2026-08-13 監査 R2)
 *
 * governance_mode 宣言 (normalize.ts) と bypass 承認ゲート (approval-bridge.ts) は
 * "bypassPermissions" 判定を permission-mode.ts の単一出所 predicate で共有しなければ
 * ならない。独立リテラルの二重記述だと、ゲート側だけに bypass モードを追加したとき
 * 宣言側が「enforcement (Protected)」を虚偽宣言する (SEC-5 と同じ gate↔宣言 decoupling)。
 *
 * ⚠️ 走査範囲 (scope) 契約: この metatest の走査正規化 (対象 = src/*.ts 直下・引用リテラル形
 * `"bypassPermissions"` のみ) を変える修正は finding-registry の full 再監査既定に該当する。
 */
const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
const SINGLE_SOURCE_FILE = "permission-mode.ts";
const QUOTED_LITERAL = '"bypassPermissions"';

async function sourceFiles(): Promise<string[]> {
  const entries = await readdir(SRC_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => entry.name)
    .sort();
}

describe("INV-GOVERNANCE-BYPASS-COUPLING", () => {
  it("the quoted bypassPermissions literal lives only in the single-source module", async () => {
    const files = await sourceFiles();
    // 走査自体の vacuity guard: 対象集合に両消費サイトと単一出所が実在する。
    expect(files).toContain("normalize.ts");
    expect(files).toContain("approval-bridge.ts");
    expect(files).toContain(SINGLE_SOURCE_FILE);

    const offenders: string[] = [];
    for (const file of files) {
      const content = await readFile(join(SRC_DIR, file), "utf8");
      if (file === SINGLE_SOURCE_FILE) {
        expect(content).toContain(QUOTED_LITERAL); // POSITIVE assert: 単一出所は実際に定義を持つ。
        continue;
      }
      if (content.includes(QUOTED_LITERAL)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it("both consumers import the shared predicate (positive coupling)", async () => {
    for (const file of ["normalize.ts", "approval-bridge.ts"]) {
      const content = await readFile(join(SRC_DIR, file), "utf8");
      expect(content, `${file} must consume isBypassPermissionMode`).toMatch(
        /import \{ isBypassPermissionMode \} from "\.\/permission-mode\.js";/,
      );
      expect(content, `${file} must call isBypassPermissionMode`).toContain(
        "isBypassPermissionMode(input.permission_mode)",
      );
    }
  });

  it("the predicate matches exactly the bypass mode and nothing else", () => {
    expect(BYPASS_PERMISSION_MODE).toBe("bypassPermissions");
    expect(isBypassPermissionMode("bypassPermissions")).toBe(true);
    for (const mode of [undefined, "", "default", "acceptEdits", "plan", "someFutureSkipMode"]) {
      expect(isBypassPermissionMode(mode), `mode=${String(mode)}`).toBe(false);
    }
  });
});
