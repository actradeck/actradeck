/**
 * INV-APPROVAL-TIMEOUT-EMIT (QA-V9-1 ≡ TDA-V9-2 landing・PR #41 再監査):
 * event-model 側の INV-APPROVAL-TIMEOUT-ORDERING は導出関数と source-coupling を pin するが、
 * **settings に実際に書き出される timeout 値**と **bridge が実際に待つ値**は見ていなかった —
 * 正準呼び出しを残したまま `Math.min(hookTimeoutSecondsFor(...), 60)` で上書きする変種が
 * 全 suite 緑で通った (QA 反証)。ここでは emit された値そのものを、承認待ちとの順序込みで pin する。
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_APPROVAL_TIMEOUT_MS, hookTimeoutSecondsFor } from "@actradeck/event-model";

import { ApprovalBridge } from "../src/approval-bridge.js";
import {
  buildHookSettings,
  MANAGED_HOOK_EVENTS,
  OBSERVE_ONLY_HOOK_TIMEOUT_SECONDS,
} from "../src/settings-injection.js";
import { computeMergedSettings } from "../src/settings-merge.js";

const GATED = new Set(["PreToolUse", "PermissionRequest"]);
const EXPECTED_GATED_SECONDS = hookTimeoutSecondsFor(DEFAULT_APPROVAL_TIMEOUT_MS);

function timeoutsOf(hooks: Record<string, Array<{ hooks?: unknown[] }>> | undefined) {
  const out: Record<string, number[]> = {};
  for (const [ev, groups] of Object.entries(hooks ?? {})) {
    out[ev] = groups.flatMap((g) =>
      (g.hooks ?? []).map((h) => (h as { timeout?: number }).timeout ?? -1),
    );
  }
  return out;
}

describe("INV-APPROVAL-TIMEOUT-EMIT: settings に書かれる hook timeout と bridge 実効値の順序", () => {
  it("managed 注入: 承認待ちを持つ event は導出値 (=330s) で、承認待ち (300s) より厳密に長い", () => {
    const settings = buildHookSettings("http://127.0.0.1:9/hook", "tok");
    const emitted = timeoutsOf(settings.hooks);
    expect(Object.keys(emitted).sort()).toEqual([...MANAGED_HOOK_EVENTS].sort());
    for (const ev of MANAGED_HOOK_EVENTS) {
      for (const t of emitted[ev]!) {
        if (GATED.has(ev)) {
          expect(t, ev).toBe(EXPECTED_GATED_SECONDS);
          expect(t * 1000, `${ev}: hook must outlive the approval wait`).toBeGreaterThan(
            DEFAULT_APPROVAL_TIMEOUT_MS,
          );
        } else {
          expect(t, ev).toBe(OBSERVE_ONLY_HOOK_TIMEOUT_SECONDS);
        }
      }
    }
    expect(EXPECTED_GATED_SECONDS).toBe(330); // 既定の厳密 pin (変更は意図的に更新する)
  });

  it("attach merge: 書き出される ActraDeck entry も同じ導出値 (managed と attach の非対称を許さない)", () => {
    const { settings } = computeMergedSettings(
      {},
      { endpoint: "http://127.0.0.1:9/hook", settingsPath: "/dev/null", tokenMode: "env" },
    );
    const emitted = timeoutsOf(settings.hooks ?? {});
    expect(emitted.PreToolUse).toEqual([EXPECTED_GATED_SECONDS]);
    expect(emitted.PermissionRequest).toEqual([EXPECTED_GATED_SECONDS]);
    for (const [ev, ts] of Object.entries(emitted)) {
      if (!GATED.has(ev)) expect(ts, ev).toEqual([OBSERVE_ONLY_HOOK_TIMEOUT_SECONDS]);
    }
  });

  it("bridge 実効値: 省略=既定 / 短縮はそのまま / 既定超過は既定へ丸め、常に静的フック timeout より短い (SEC-V9-1)", () => {
    const staticHookMs = EXPECTED_GATED_SECONDS * 1000;
    const cases: Array<[number | undefined, number]> = [
      [undefined, DEFAULT_APPROVAL_TIMEOUT_MS],
      [50, 50],
      [DEFAULT_APPROVAL_TIMEOUT_MS, DEFAULT_APPROVAL_TIMEOUT_MS],
      [330_000, DEFAULT_APPROVAL_TIMEOUT_MS], // base で反転していた最小域
      [10 * DEFAULT_APPROVAL_TIMEOUT_MS, DEFAULT_APPROVAL_TIMEOUT_MS],
      [Number.NaN, DEFAULT_APPROVAL_TIMEOUT_MS],
    ];
    for (const [requested, expected] of cases) {
      const bridge = new ApprovalBridge(requested === undefined ? {} : { timeoutMs: requested });
      expect(bridge.approvalTimeoutMs, `requested=${String(requested)}`).toBe(expected);
      expect(bridge.approvalTimeoutMs, `requested=${String(requested)}`).toBeLessThan(staticHookMs);
    }
  });
});
