/**
 * ADR 019f1582: useDaemons の parseDaemons 単体 INV (寛容検証・id 抽出・use-wall-feed と同方針)。
 * 応答 `{ daemons: [{id}] }` から relay-target になりうる id 文字列だけを取り出し、奇形は静かに落とす。
 */
import { describe, expect, it } from "vitest";

import { parseDaemons } from "../src/ui/use-daemons.js";

describe("parseDaemons", () => {
  it("daemons 配列から id 文字列のみ抽出する", () => {
    expect(parseDaemons({ daemons: [{ id: "a" }, { id: "b" }] })).toEqual(["a", "b"]);
  });

  it("非オブジェクト / daemons 欠落・非配列 は [] (寛容・LIVE-FOUND-3 教訓)", () => {
    expect(parseDaemons(null)).toEqual([]);
    expect(parseDaemons("x")).toEqual([]);
    expect(parseDaemons({})).toEqual([]);
    expect(parseDaemons({ daemons: "x" })).toEqual([]);
  });

  it("非オブジェクト要素 / 非 string id / 空 id を落とす", () => {
    expect(parseDaemons({ daemons: [null, 1, { id: 5 }, { id: "" }, { id: "ok" }] })).toEqual([
      "ok",
    ]);
  });

  // sweep 019f15a9 (QA-2): useDaemons は `[...parseDaemons(data)].sort()` で決定的順序にし、
  // CockpitBoard は daemonIds[0] を relay-target に選ぶ。順不同/poll 間の並べ替えでも「先頭」が
  // 安定することを timer 非依存の純合成で固定する (flaky 回避・hook 描画不要)。
  it("parseDaemons + sort: 順不同入力でも決定的順序 (先頭安定選択の基礎)", () => {
    const sortIds = (raw: unknown): string[] => [...parseDaemons(raw)].sort();
    const a = sortIds({ daemons: [{ id: "dba56777" }, { id: "474f2b45" }] });
    const b = sortIds({ daemons: [{ id: "474f2b45" }, { id: "dba56777" }] }); // 入力順を反転。
    expect(a).toEqual(["474f2b45", "dba56777"]);
    expect(b).toEqual(["474f2b45", "dba56777"]); // 入力順に依存しない。
    expect(a[0]).toBe(b[0]); // daemonIds[0] が決定的 = relay-target 一貫性。
  });
});
