/**
 * ADR 019f1972 §2b: useReadiness の parseReadiness 単体 INV (寛容検証・NO-RAW・use-daemons と同方針)。
 * `/realtime/readiness` 応答 `{ daemonCount, claude:{...}, codex:{...} }` を event-model の正準パーサで射影し、
 * boolean のみ抽出・daemonCount を非負 number へ安全抽出・奇形は null/0/false へ fail-safe に縮退する。
 */
import { describe, expect, it } from "vitest";

import { parseReadiness } from "../src/ui/use-readiness.js";

describe("parseReadiness", () => {
  it("正常応答から daemonCount + per-agent boolean を抽出する", () => {
    const r = parseReadiness({
      daemonCount: 2,
      claude: { binaryOnPath: true, anyHook: true },
      codex: { binaryOnPath: true, rolloutDirResolved: false },
    });
    expect(r).toEqual({
      daemonCount: 2,
      claude: { binaryOnPath: true, anyHook: true },
      codex: { binaryOnPath: true, rolloutDirResolved: false },
    });
  });

  it("非オブジェクトは null (未取得扱い)", () => {
    expect(parseReadiness(null)).toBeNull();
    expect(parseReadiness("x")).toBeNull();
    expect(parseReadiness(123)).toBeNull();
  });

  it("claude/codex 欠落 (object だが visibility 不正) → 全 false へ縮退 (安全側・未配線)", () => {
    const r = parseReadiness({ daemonCount: 1 });
    expect(r).toEqual({
      daemonCount: 1,
      claude: { binaryOnPath: false, anyHook: false },
      codex: { binaryOnPath: false, rolloutDirResolved: false },
    });
  });

  it("非 boolean field は false へ縮退・余剰 field は落ちる (NO-RAW)", () => {
    const r = parseReadiness({
      daemonCount: 3,
      claude: { binaryOnPath: "yes", anyHook: 1, leaked: "/home/me/.env" },
      codex: { binaryOnPath: true, rolloutDirResolved: "true" },
    });
    expect(r).toEqual({
      daemonCount: 3,
      claude: { binaryOnPath: false, anyHook: false },
      codex: { binaryOnPath: true, rolloutDirResolved: false },
    });
    expect(JSON.stringify(r)).not.toContain("leaked");
    expect(JSON.stringify(r)).not.toContain(".env");
  });

  it("daemonCount が非 number / 負 / 非有限 → 0 へ縮退", () => {
    expect(parseReadiness({ daemonCount: "5" })?.daemonCount).toBe(0);
    expect(parseReadiness({ daemonCount: -1 })?.daemonCount).toBe(0);
    expect(parseReadiness({ daemonCount: Number.NaN })?.daemonCount).toBe(0);
    expect(parseReadiness({ daemonCount: Number.POSITIVE_INFINITY })?.daemonCount).toBe(0);
    expect(parseReadiness({})?.daemonCount).toBe(0);
  });

  it("daemonCount は floor で整数化する (端数は切り捨て)", () => {
    expect(parseReadiness({ daemonCount: 2.9 })?.daemonCount).toBe(2);
  });
});
