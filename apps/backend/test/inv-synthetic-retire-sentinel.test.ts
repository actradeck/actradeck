/**
 * INV-SYNTHETIC-RETIRE-SENTINEL (TDA-R4-5・R5 強化 SEC-R5-3/TDA-R5-3・DB 不要):
 * `relay_lost` sentinel の単一出所を固定する。この値の比較は synthetic_retired vs by_decision
 * (→hard_gate) の分類・liveness/coverage の活動除外を決める境界判定であり、リテラル再打鍵は
 * rename / 第二 synthetic origin 追加で「合成 retire が operator 決定へ silent 再分類」される
 * drift 源だった。
 *
 *  - TS 消費点は event-model の正準 `isSyntheticRetireOrigin` / `SYNTHETIC_RETIRE_ORIGIN` を使う
 *    (型システム外の行値 string|null / unknown にも安全)。
 *  - SQL リテラル (型検査が届かない) は本 metatest がソース結合で正準定数と一致することを pin する
 *    (ADR 0015 slice-B1 の「literal を 2 度書かない + coupling metatest」と同型)。
 *  - R5 強化 (SEC-R5-3/TDA-R5-3): 走査を allow-list でなく **backend src 全 .ts の sweep** にし、
 *    走査前に**コメントを除去** (コメント文面が非空虚ガードを偽充足する穴を閉塞)。比較形は
 *    `===` に加え `!==` / `case` / 単引用も対象。producer (approval-reconciler) と出荷ラベル
 *    (audit-report) の定数消費も pin する。
 *
 * 走査範囲の注意 (finding-registry): この metatest の走査範囲 (scope) を狭める変更は
 * 境界ゲート契約の走査範囲変更 = full 監査既定。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SYNTHETIC_RETIRE_ORIGIN } from "@actradeck/event-model";

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

/** backend src の全 .ts (再帰・テストファイル除外)。allow-list にしない (SEC-R5-3)。 */
function listSrcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listSrcFiles(p));
    else if (ent.name.endsWith(".ts") && !/\.(test|spec)\.ts$/.test(ent.name)) out.push(p);
  }
  return out;
}

/**
 * コメントを除去する (SEC-R5-3・SEC-R6-2・SEC-R8-2)。コメント文面が SQL 抽出の非空虚ガードを
 * 偽充足したり比較形スキャンを誤 trip したりしないための正規化。
 *  - 行頭コメント行 (`//` / `/*` / docstring 継続 `*`) は行ごと除去。`/* ... *\/ code` 形は
 *    `*\/` 以降のコードを保持 (行ごと落とすと禁止形を隠しうる)。
 *  - SEC-R8-2: **インライン block comment** (`code /* was: ... *\/`) と **トレイリング行コメント**
 *    (空白 + `//` 以降) も除去 — 「実 SQL を同一行のコメントへ退避して presence 検査を偽充足」
 *    する形を閉塞する。トレイリング `//` は空白先行のみ対象 (文字列内 URL `://` は `:` 先行ゆえ
 *    非該当)。限界の正直な開示: 文字列リテラル内に ` // ` や `/*` を含むコードは以降が
 *    落ちうる (現 backend src に該当なし・禁止形スキャンには「隠す」方向の理論穴だが、
 *    そのようなコードを書く時点で本 metatest の走査対象追随が必要)。
 *
 * SEC-R9-3 (残渣の正直な開示): (a) `code;//comment` (空白なし `//`) は除去されないが、
 * prettier (CI blocking) が `; //` へ正規化するため非永続。(b) コメントでない素の文字列定数が
 * pattern を含む形は lexical ガードの構造的天井 — 本 metatest はリテラル値の defense-in-depth
 * であり、実 SQL 除外句の削除は real-PG の意味論テスト (inv-liveness-parity の
 * aggregateObservationSql parity / inv-audit-coverage の providerCoverage / inv-audit の
 * fold・いずれも positive control 付き) が直接殺す。それら DB テストは describe.skipIf ゆえ
 * CI (DATABASE_URL 供給) 条件付き backstop である点も含めて開示する。
 */
function stripComments(src: string): string {
  return src
    .split("\n")
    .map((line) => {
      let out = line;
      if (/^\s*\/\*/.test(out)) {
        const close = out.indexOf("*/");
        out = close >= 0 ? out.slice(close + 2) : "";
      }
      if (/^\s*(\/\/|\*)/.test(out)) return "";
      out = out.replace(/\/\*[^*]*(?:\*(?!\/)[^*]*)*\*\//g, ""); // インライン /* ... */
      out = out.replace(/\s\/\/.*$/, ""); // トレイリング // (空白先行のみ)
      return out;
    })
    .join("\n");
}

const FILES = listSrcFiles(SRC_DIR);
const SOURCES = new Map(
  FILES.map((p) => [path.relative(SRC_DIR, p), stripComments(fs.readFileSync(p, "utf8"))]),
);

function read(rel: string): string {
  const src = SOURCES.get(rel);
  expect(src, `${rel} が backend src に存在しない (走査対象 rot)`).toBeDefined();
  return src!;
}

describe("INV-SYNTHETIC-RETIRE-SENTINEL: relay_lost sentinel の単一出所", () => {
  it("SQL リテラル (payload->>'resolution_origin' = '<x>') は正準定数と一致する (backend src 全体 sweep・非空虚)", () => {
    // SQL 比較は型検査の外 — ソース結合で pin する。正準定数を rename したらここが赤くなり、
    // SQL の追随を強制する。走査は backend src 全体 (allow-list 外の新規 SQL 面も自動で網に入る)。
    const values: string[] = [];
    for (const src of SOURCES.values()) {
      for (const m of src.matchAll(/resolution_origin'\s*=\s*'([^']+)'/g)) values.push(m[1]!);
    }
    // SEC-R6-2: 非空虚ガードは総件数でなく既知 SQL 面のファイル単位で固定する (実 SQL が消えて
    // トレイリングコメントだけが件数を偽充足する穴を閉塞。既知面が消えたら明示的にここを更新)。
    for (const file of ["ingest-store.ts", "audit-store.ts"]) {
      expect(
        /resolution_origin'\s*=\s*'/.test(read(file)),
        `${file} の既知 SQL 除外面が消えた (意図的なら本ガードを更新)`,
      ).toBe(true);
    }
    expect(values.length).toBeGreaterThanOrEqual(2);
    for (const v of values) expect(v).toBe(SYNTHETIC_RETIRE_ORIGIN);
  });

  it("生リテラル比較/分岐 (===/!==/case 'relay_lost') が backend src 全体に残存しない (SEC-R5-3/R6-5)", () => {
    // SEC-R6-5: 走査範囲は backend src のみ (sidecar/webui の sentinel は ResolutionOrigin 上の
    // 型付き switch = compile ガード済み・backend だけが型不可視な SQL リテラルを持つ)。
    // 被演算子順序は左辺値形 (`x === "relay_lost"`) のみ対象 — 右辺値形は sweep 追跡 (TDA-R6-3)。
    const forbidden = [/[!=]==\s*["']relay_lost["']/, /case\s+["']relay_lost["']/];
    for (const [rel, src] of SOURCES) {
      for (const re of forbidden) {
        expect(re.test(src), `${rel} に sentinel の生リテラル比較/分岐が残存 (${re})`).toBe(false);
      }
    }
  });

  it("TS 消費点は正準 predicate / 定数を使う (リテラル再打鍵の再発防止・非空虚)", () => {
    // 分類 fold (audit-store) / 活動除外 TS ミラー (liveness) / packet reason (audit-packet) は
    // predicate を、producer (approval-reconciler) と出荷ラベル (audit-report) は定数を消費する
    // ことをソース結合で pin (最も緩い残存コピーが実効強度)。
    for (const file of ["audit-store.ts", "liveness.ts", "audit-packet.ts"]) {
      expect(
        read(file).includes("isSyntheticRetireOrigin("),
        `${file} が正準 predicate を消費していない`,
      ).toBe(true);
    }
    for (const file of ["approval-reconciler.ts", "audit-report.ts"]) {
      expect(
        read(file).includes("SYNTHETIC_RETIRE_ORIGIN"),
        `${file} が正準定数を消費していない`,
      ).toBe(true);
    }
  });
});
