/**
 * INV-TOKEN-ISOLATION (SEC-1): server 専用 bff.ts (REALTIME_TOKEN 保持) と backend value import が
 * ブラウザグラフ (UI / client / app) へ混入しないことを **静的に** 固定する。
 *
 * eslint の no-restricted-imports 境界 (eslint.config.mjs) と二重のゲート。lint 設定が緩んでも
 * 本テストが CI を赤化する。型のみ import (contract.ts の `export type` 再エクスポート) は許可。
 * 違反例: ブラウザ側ファイルに `import { resolveUpstreamConfig } from ".../bff"` を書くと FAIL。
 *
 * TDA-1 (audit ad14a947): browser graph の収集 + ソース読み取りは module load 時に一度だけ凍結する
 * (test/_support/browser-graph.ts)。runtime の再 readFileSync を無くし、並行 next build との
 * 非原子読み取り由来の flaky を解消する。TDA-5: walk/BROWSER_GLOBS は共有モジュールへ dedup。
 */
import { describe, expect, it } from "vitest";

import { BROWSER_SOURCES } from "./_support/browser-graph.js";

/**
 * value import (= `import type` でない) の specifier を抽出する。
 * SEC-5/QA-2 (再監査 019e92f8/ab6a4064): 静的 `import…from` / 副作用 `import "x"` に加え、
 * `dynamic import("x")` と `require("x")` も拾う。code-splitting の `await import("./bff")` が
 * 将来ブラウザグラフへ混入してもゲートが赤化するようにする (eslint の no-restricted-imports は
 * dynamic import を見ないため、この静的テストが二次ゲートとして補完する)。
 */
function valueImportSpecifiers(source: string): string[] {
  const specs: string[] = [];
  // `import ... from "x"` / `import "x"` を走査し、`import type` 始まりは除外する。
  const re = /(^|\n)\s*import\s+(type\s+)?[^;]*?from\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (m[2]) continue; // `import type ... from` は型のみ (消去される) ので許可。
    specs.push(m[3]!);
  }
  // 副作用 import `import "x"` も拾う (bff を副作用 import しても混入する)。
  const sideRe = /(^|\n)\s*import\s*["']([^"']+)["']/g;
  while ((m = sideRe.exec(source)) !== null) specs.push(m[2]!);
  // dynamic import("x") / require("x") も value 経路として拾う (`import type` 相当の除外不要)。
  const dynRe = /(?:\bimport|\brequire)\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = dynRe.exec(source)) !== null) specs.push(m[1]!);
  return specs;
}

describe("INV-TOKEN-ISOLATION: browser graph must not value-import server-only modules", () => {
  it("collects browser-graph files to scan (sanity)", () => {
    // 走査対象がゼロなら検査が空振りになる (偽緑防止)。
    expect(BROWSER_SOURCES.length).toBeGreaterThan(0);
  });

  it("no browser-graph file value-imports bff.ts (holds REALTIME_TOKEN)", () => {
    const offenders: string[] = [];
    for (const { path, source } of BROWSER_SOURCES) {
      const specs = valueImportSpecifiers(source);
      if (specs.some((s) => /(^|\/)bff(\.js)?$/.test(s) || s.endsWith("/realtime/bff"))) {
        offenders.push(path);
      }
    }
    expect(offenders, `bff.ts は server 専用。value import 禁止: ${offenders.join(", ")}`).toEqual(
      [],
    );
  });

  it("no browser-graph file value-imports @actradeck/backend (server-side; type-only re-export のみ可)", () => {
    const offenders: string[] = [];
    for (const { path, source } of BROWSER_SOURCES) {
      const specs = valueImportSpecifiers(source);
      if (specs.includes("@actradeck/backend")) offenders.push(path);
    }
    expect(
      offenders,
      `backend の value import 禁止 (contract.ts の type-only 経由のみ): ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
