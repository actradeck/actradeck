/**
 * INV-SYNTHETIC-RETIRE-SENTINEL (TDA-R4-5・Phase 4 R4 監査・DB 不要):
 * `relay_lost` sentinel の単一出所を固定する。この値の比較は synthetic_retired vs by_decision
 * (→hard_gate) の分類・liveness/coverage の活動除外を決める境界判定であり、5 箇所のリテラル
 * 再打鍵は rename / 第二 synthetic origin 追加で「合成 retire が operator 決定へ silent 再分類」
 * される drift 源だった。
 *
 *  - TS 消費点は event-model の正準 `isSyntheticRetireOrigin` / `SYNTHETIC_RETIRE_ORIGIN` を使う
 *    (型システム外の行値 string|null / unknown にも安全)。
 *  - SQL リテラル (型検査が届かない) は本 metatest がソース結合で正準定数と一致することを pin する
 *    (ADR 0015 slice-B1 の「literal を 2 度書かない + coupling metatest」と同型)。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { SYNTHETIC_RETIRE_ORIGIN } from "@actradeck/event-model";

const SRC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

function read(file: string): string {
  return fs.readFileSync(path.join(SRC_DIR, file), "utf8");
}

describe("INV-SYNTHETIC-RETIRE-SENTINEL: relay_lost sentinel の単一出所", () => {
  it("SQL リテラル (payload->>'resolution_origin' = '<x>') は正準定数と一致する (非空虚)", () => {
    // SQL 比較は型検査の外 — ソース結合で pin する。対象は活動除外の 2 面 (liveness 集約 /
    // audit-coverage)。正準定数を rename したらここが赤くなり、SQL の追随を強制する。
    const sqlSources = ["ingest-store.ts", "audit-store.ts"].map(read).join("\n");
    const matches = [...sqlSources.matchAll(/resolution_origin'\s*=\s*'([^']+)'/g)].map(
      (m) => m[1]!,
    );
    expect(matches.length).toBeGreaterThanOrEqual(2); // 非空虚ガード (抽出 regex rot 検知)。
    for (const v of matches) expect(v).toBe(SYNTHETIC_RETIRE_ORIGIN);
  });

  it("TS 消費点は正準 predicate を使う (リテラル再打鍵の再発防止・非空虚)", () => {
    // 分類 fold (audit-store) / 活動除外 TS ミラー (liveness) / packet reason (audit-packet) の
    // 3 面が predicate を消費していることをソース結合で pin (最も緩い残存コピーが実効強度)。
    for (const file of ["audit-store.ts", "liveness.ts", "audit-packet.ts"]) {
      expect(
        read(file).includes("isSyntheticRetireOrigin("),
        `${file} が正準 predicate を消費していない`,
      ).toBe(true);
    }
    // 生リテラル比較 (=== "relay_lost") が src に残存しないこと (コメント内の言及は許容するため
    // 比較形のみを走査する)。
    for (const file of ["audit-store.ts", "liveness.ts", "audit-packet.ts", "ingest-store.ts"]) {
      const src = read(file);
      expect(/===\s*"relay_lost"/.test(src), `${file} に sentinel の生リテラル比較が残存`).toBe(
        false,
      );
    }
  });
});
