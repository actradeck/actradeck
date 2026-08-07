/**
 * SEC-R3-2 / TDA-R4-2 / SEC-R4-4 (Phase 4 R4): 採番時 re-roll と unstableRequestIdCount の意味論 pin。
 *
 * redactString を「常に mangle する」モックへ差し替え、固定部衝突クラス (re-roll が無力な最悪ケース)
 * の実挙動を固定する: ①re-roll は有界 8 回で必ず停止し id を返す (deny へ落とさない・無限ループしない)
 * ②カウンタは「不安定観測の延べ数」= 試行 8 + 使い切り 1 = 9 (良性 re-roll と恒久衝突を値では区別
 * しない、という docstring の意味論をそのまま pin)。通常経路でカウンタが 0 のままであることは
 * inv-approval-request-id-stable (c) 側で pin する (このファイルは module mock ゆえ分離)。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@actradeck/redaction", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@actradeck/redaction")>();
  return {
    ...actual,
    // 固定部衝突ルールの模擬: どの採番も不変性検査に失敗する。
    redactString: (s: string): string => `${s}#mangled`,
  };
});

import { APPROVAL_REQUEST_ID_RE } from "@actradeck/event-model";

import { ApprovalBridge } from "../src/approval-bridge.js";
import type { HookCommonInput } from "../src/normalize.js";

describe("approval-bridge re-roll exhaustion (redactor 全滅クラスの縮退挙動)", () => {
  it("有界 8 回で停止し正準形 id を返す・カウンタは延べ 9 加算 (SEC-R4-4 の意味論 pin)", async () => {
    const bridge = new ApprovalBridge({ timeoutMs: 20 });
    expect(bridge.unstableRequestIdCount).toBe(0);
    const input: HookCommonInput = {
      session_id: "sess-reroll",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "rm -rf /tmp/x" },
    };
    const done = bridge.requestApproval(input, () => {});
    const declared = bridge.pendingRequestIds();
    expect(declared).toHaveLength(1);
    // 使い切っても不安定 id をそのまま返す (承認機能を止めない)・形式自体は正準のまま。
    expect(declared[0]).toMatch(APPROVAL_REQUEST_ID_RE);
    // 初回 mint → 8 回 re-roll (各+1) → 使い切り確認 (+1) = 9。
    expect(bridge.unstableRequestIdCount).toBe(9);
    await done; // timeout deny で回収。
  });
});
