/**
 * INV-SEMANTIC-FIRST / Carbon 除去ガード（設計裁定 019ea263 D1/D4）。
 *
 * Adaptive Clarity の「Semantic First」（直値色/単位でなくトークン経由）と Carbon 全面置換を
 * 退行から守る:
 *  - globals.scss の宣言値に生 hex 色を持たない（var(--ad-*) のみ）。
 *  - `--cds-*`（Carbon 供給トークン）を参照しない。
 *  - webui の src/app から `@carbon/*` を import しない。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const webuiRoot = fileURLToPath(new URL("..", import.meta.url));
const globals = readFileSync(`${webuiRoot}/app/globals.scss`, "utf8");

/** ディレクトリ配下の .ts/.tsx を再帰収集。 */
function collect(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = `${dir}/${name}`;
    if (statSync(p).isDirectory()) collect(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe("INV-SEMANTIC-FIRST: globals は直値色でなくトークンを使う", () => {
  it("宣言値に生 hex 色を持たない（コメント除く）", () => {
    const offenders = globals
      .split("\n")
      .map((line, i) => ({ line: line.replace(/\/\/.*$/, ""), no: i + 1 }))
      .filter((l) => /#[0-9a-fA-F]{3,6}\b/.test(l.line));
    expect(
      offenders.map((o) => `globals.scss:${o.no}: ${o.line.trim()}`),
      "raw hex は禁止。var(--ad-*) を使う",
    ).toEqual([]);
  });

  it("Carbon の --cds-* を参照しない", () => {
    expect(globals).not.toMatch(/--cds-/);
  });

  it("Carbon の @use を残さない", () => {
    expect(globals).not.toMatch(/@use\s+["']@carbon/);
  });
});

describe("Carbon 全面置換: src/app から @carbon を import しない", () => {
  it("@carbon/react・@carbon/icons-react の import がない（コメント言及は許容）", () => {
    const files = [...collect(`${webuiRoot}/src`), ...collect(`${webuiRoot}/app`)];
    const offenders = files.filter((f) =>
      /(^|\n)\s*import[^\n]*@carbon\//.test(readFileSync(f, "utf8")),
    );
    expect(offenders, "@carbon import は kit へ置換済みのはず").toEqual([]);
  });
});
