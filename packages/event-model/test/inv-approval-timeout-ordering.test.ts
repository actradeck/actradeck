/**
 * INV-APPROVAL-TIMEOUT-ORDERING — 承認待ちは agent 側フック timeout より**厳密に先に**切れる。
 *
 * ## なぜ P0 か
 * ActraDeck の承認ゲートは CC の PreToolUse / PermissionRequest フック応答を握り続けることで
 * 成立する。CC の契約 (公式 docs `hooks`) はこうである:
 *
 * > A timed-out `command`, `http`, or `mcp_tool` hook doesn't block the tool call.
 * > The call continues through the normal permission flow, so don't count on a stalled hook
 * > to act as a gate.
 *
 * したがって **フック timeout が先に切れると、承認は「安全側 deny」ではなく「素通り」になる**。
 * 承認待ちとフック timeout はかつて別ファイルの別リテラル (30s と 35s) で、片方だけ編集すれば
 * 無言で fail-open へ反転した。ここではその順序と、導出が単一出所から来ていることを固定する。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  APPROVAL_HOOK_MARGIN_MS,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  MAX_APPROVAL_TIMEOUT_MS,
  MIN_APPROVAL_TIMEOUT_MS,
  clampApprovalTimeoutMs,
  hookTimeoutSecondsFor,
} from "../src/index.js";

/** CC の `http` フック既定 timeout (秒)。docs に上限記載は無く、既定は安全に使えると分かっている値。 */
const CC_HTTP_HOOK_DEFAULT_TIMEOUT_SECONDS = 600;

describe("INV-APPROVAL-TIMEOUT-ORDERING", () => {
  it("導出フック timeout は承認待ちより厳密に長い (これが逆転すると deny でなく素通りになる)", () => {
    // 既定・境界・不正値・上限超過を含めて全数で順序を確認する。
    const candidates = [
      MIN_APPROVAL_TIMEOUT_MS,
      1_000,
      30_000,
      DEFAULT_APPROVAL_TIMEOUT_MS,
      MAX_APPROVAL_TIMEOUT_MS,
      MAX_APPROVAL_TIMEOUT_MS + 60_000, // 上限超過 → clamp されるはず
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ];
    for (const raw of candidates) {
      const effective = clampApprovalTimeoutMs(raw);
      const hookMs = hookTimeoutSecondsFor(raw) * 1000;
      expect(
        hookMs,
        `hook timeout must exceed approval wait for input ${String(raw)}`,
      ).toBeGreaterThan(effective);
      // 余裕が margin 未満へ痩せていないこと (切り上げは常に安全方向)。
      expect(hookMs - effective, `margin for input ${String(raw)}`).toBeGreaterThanOrEqual(
        APPROVAL_HOOK_MARGIN_MS,
      );
    }
  });

  it("導出フック timeout は CC の http フック既定 600s を超えない (未検証域へ出さない)", () => {
    expect(hookTimeoutSecondsFor(MAX_APPROVAL_TIMEOUT_MS)).toBeLessThanOrEqual(
      CC_HTTP_HOOK_DEFAULT_TIMEOUT_SECONDS,
    );
    // 上限超過入力も clamp されるので同じ天井に収まる。
    expect(hookTimeoutSecondsFor(MAX_APPROVAL_TIMEOUT_MS * 10)).toBeLessThanOrEqual(
      CC_HTTP_HOOK_DEFAULT_TIMEOUT_SECONDS,
    );
  });

  it("clamp は安全側へ倒す (不正値は既定へ・上限超過は上限へ・無界化しない)", () => {
    expect(clampApprovalTimeoutMs(Number.NaN)).toBe(DEFAULT_APPROVAL_TIMEOUT_MS);
    expect(clampApprovalTimeoutMs(0)).toBe(DEFAULT_APPROVAL_TIMEOUT_MS);
    expect(clampApprovalTimeoutMs(-5)).toBe(DEFAULT_APPROVAL_TIMEOUT_MS);
    // Infinity は「無界待ち」の要求であり有限値の切詰めではない → 上限でなく**既定**へ倒す
    // (garbage 入力から上限近くの待ちを黙って与えない)。
    expect(clampApprovalTimeoutMs(Number.POSITIVE_INFINITY)).toBe(DEFAULT_APPROVAL_TIMEOUT_MS);
    expect(clampApprovalTimeoutMs(MAX_APPROVAL_TIMEOUT_MS + 1)).toBe(MAX_APPROVAL_TIMEOUT_MS);
    expect(clampApprovalTimeoutMs(120_000)).toBe(120_000);
  });

  it("既定値の厳密 pin (変更は意図的にこのテストを更新することを強制する)", () => {
    expect(DEFAULT_APPROVAL_TIMEOUT_MS).toBe(300_000);
    expect(APPROVAL_HOOK_MARGIN_MS).toBe(30_000);
    expect(hookTimeoutSecondsFor(DEFAULT_APPROVAL_TIMEOUT_MS)).toBe(330);
  });

  /**
   * source-coupling: 消費側が正準出所を**実際に**引いていることを固定する。
   * 値の pin だけでは、消費側がリテラルへ戻る drift を検出できない (両方が偶然一致しうる)。
   */
  it("消費側は正準出所を import しており、手書きリテラルへ戻っていない", () => {
    const read = (rel: string): string =>
      readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

    // attach (永続 settings.json merge) と managed (temp settings 注入) の **両方**を走査する。
    //   片方だけ導出に直すと、そのモードだけ順序が逆転して fail-open になる
    //   (実際 R1 の初回実装では managed 側の 2 本目リテラルが取り残されていた)。
    for (const rel of [
      "../../../apps/sidecar/src/settings-merge.ts",
      "../../../apps/sidecar/src/settings-injection.ts",
    ]) {
      const src = read(rel);
      // POSITIVE: 導出関数を通している。
      expect(src, rel).toContain("hookTimeoutSecondsFor(DEFAULT_APPROVAL_TIMEOUT_MS)");
      // NEGATIVE: 旧リテラル (35 秒) の三項へ戻っていない。
      expect(src, rel).not.toMatch(/\?\s*35\s*:/);
    }

    const bridge = read("../../../apps/sidecar/src/approval-bridge.ts");
    expect(bridge).toContain("opts.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS");
    expect(bridge).not.toContain("opts.timeoutMs ?? 30_000");

    const display = read("../../../apps/webui/src/ui/approval-display.ts");
    expect(display).toContain("timeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS");
    expect(display).not.toContain("timeoutMs = 30_000");
  });
});
