/**
 * INV-AGENT-VIS-WIRE (ADR 019f1972 §2b・decision 019f1a29): agent-visibility の wire 射影 + 受信検証 +
 * 集約の **単一出所** を直接 pin する。3 トラスト境界 (sidecar 射影 / backend handleHello 検証 /
 * webui endpoint parse) がこの純関数を共有するため、ここが正準契約になる。
 *
 * 不変条件:
 *  - `parseAgentVisibilityWire` は既知 4 boolean のみ抽出し**余剰 field を落とす** (NO-RAW・パス/secret を
 *    追加 field に詰めても parse 境界で消える)。
 *  - 非 boolean field は **false へ縮退** (安全側・false positive で「配線済み」と誤主張しない)。
 *  - shape 不正 (非 object / claude・codex 欠落) は **undefined** (集約から除外・**非 throw**)。
 *  - `aggregateAgentReadiness` は field ごと OR fold。空配列は全 false (未観測・安全側)。
 */
import { describe, expect, it } from "vitest";

import {
  aggregateAgentReadiness,
  parseAgentVisibilityWire,
  type AgentVisibilityWire,
} from "../src/index.js";

const WIRED: AgentVisibilityWire = {
  claude: { binaryOnPath: true, anyHook: true },
  codex: { binaryOnPath: true, rolloutDirResolved: true },
};

describe("parseAgentVisibilityWire (wire 受信検証の単一出所)", () => {
  it("正しい shape を boolean のまま射影する", () => {
    expect(
      parseAgentVisibilityWire({
        claude: { binaryOnPath: true, anyHook: false },
        codex: { binaryOnPath: false, rolloutDirResolved: true },
      }),
    ).toEqual({
      claude: { binaryOnPath: true, anyHook: false },
      codex: { binaryOnPath: false, rolloutDirResolved: true },
    });
  });

  it("余剰 field (パス/settings 内容/token 様文字列) を構造的に落とす (NO-RAW)", () => {
    const parsed = parseAgentVisibilityWire({
      claude: {
        binaryOnPath: true,
        anyHook: true,
        hookPath: "/home/user/.claude/settings.json", // 漏れてはならない
        settingsDump: { hooks: { PreToolUse: [{ command: "node forwarder.js" }] } },
      },
      codex: {
        binaryOnPath: true,
        rolloutDirResolved: true,
        codexHome: "/home/user/.codex", // 漏れてはならない
        token: "glpat-XXXXXXXXXXXXXXXXXXXX",
      },
      extra: "/absolute/path/leak",
    });
    expect(parsed).toEqual(WIRED);
    // 射影結果に余剰 key が存在しないことを構造的に確認 (NO-RAW)。
    expect(Object.keys(parsed?.claude ?? {}).sort()).toEqual(["anyHook", "binaryOnPath"]);
    expect(Object.keys(parsed?.codex ?? {}).sort()).toEqual(["binaryOnPath", "rolloutDirResolved"]);
    // 生文字列が射影のどこにも残らない (JSON 全体走査)。
    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toContain("/home/user");
    expect(serialized).not.toContain("glpat-");
    expect(serialized).not.toContain("settings.json");
  });

  it("非 boolean field を false へ縮退する (安全側・false positive を作らない)", () => {
    expect(
      parseAgentVisibilityWire({
        claude: { binaryOnPath: "true", anyHook: 1 }, // truthy だが非 boolean
        codex: { binaryOnPath: {}, rolloutDirResolved: null },
      }),
    ).toEqual({
      claude: { binaryOnPath: false, anyHook: false },
      codex: { binaryOnPath: false, rolloutDirResolved: false },
    });
  });

  it("欠落 field は false 扱い (部分 shape でも非 throw)", () => {
    expect(parseAgentVisibilityWire({ claude: {}, codex: {} })).toEqual({
      claude: { binaryOnPath: false, anyHook: false },
      codex: { binaryOnPath: false, rolloutDirResolved: false },
    });
  });

  it("shape 不正 (非 object / claude・codex 欠落 / 配列) は undefined (集約除外・非 throw)", () => {
    expect(parseAgentVisibilityWire(undefined)).toBeUndefined();
    expect(parseAgentVisibilityWire(null)).toBeUndefined();
    expect(parseAgentVisibilityWire("nope")).toBeUndefined();
    expect(parseAgentVisibilityWire(42)).toBeUndefined();
    expect(parseAgentVisibilityWire([])).toBeUndefined();
    expect(
      parseAgentVisibilityWire({ claude: { binaryOnPath: true, anyHook: true } }),
    ).toBeUndefined(); // codex 欠落
    expect(parseAgentVisibilityWire({ codex: WIRED.codex })).toBeUndefined(); // claude 欠落
    expect(parseAgentVisibilityWire({ claude: null, codex: null })).toBeUndefined();
    expect(parseAgentVisibilityWire({ claude: [], codex: [] })).toBeUndefined(); // 配列 sub-object
  });
});

describe("aggregateAgentReadiness (machine 全体 OR fold の単一出所)", () => {
  it("field ごとに OR fold する (いずれかの daemon が見えていれば true)", () => {
    const a: AgentVisibilityWire = {
      claude: { binaryOnPath: true, anyHook: false },
      codex: { binaryOnPath: false, rolloutDirResolved: false },
    };
    const b: AgentVisibilityWire = {
      claude: { binaryOnPath: true, anyHook: true },
      codex: { binaryOnPath: true, rolloutDirResolved: false },
    };
    expect(aggregateAgentReadiness([a, b])).toEqual({
      claude: { binaryOnPath: true, anyHook: true },
      codex: { binaryOnPath: true, rolloutDirResolved: false },
    });
  });

  it("空配列は全 false (誰も報告せず＝未観測・安全側)", () => {
    expect(aggregateAgentReadiness([])).toEqual({
      claude: { binaryOnPath: false, anyHook: false },
      codex: { binaryOnPath: false, rolloutDirResolved: false },
    });
  });

  it("単一 report はそのまま透過する", () => {
    expect(aggregateAgentReadiness([WIRED])).toEqual(WIRED);
  });
});
