import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveManagedSession } from "../src/cli.js";

/**
 * managed mode の session 構成 (live-found 修正 / task 019e948f) の回帰固定。
 *
 * 実欠陥(ライブ probe_003): ACTRADECK_SESSION を明示すると SessionIdentity が即確定モードになり、
 * learn-once が claude の hook canonical を無視 → 監視イベント(ACTRADECK_SESSION)と
 * hook イベント(claude session_id)が別 session に分裂した。
 * 修正: managed mode は **常に learn-wait** (explicitSession=false)、ACTRADECK_SESSION は fallback id。
 * 本テストは「managed mode は ACTRADECK_SESSION の有無に関わらず explicit 即確定にしない」を固定する。
 */
describe("resolveManagedSession (managed mode は常に learn-wait)", () => {
  const saved = process.env.ACTRADECK_SESSION;
  beforeEach(() => delete process.env.ACTRADECK_SESSION);
  afterEach(() => {
    if (saved === undefined) delete process.env.ACTRADECK_SESSION;
    else process.env.ACTRADECK_SESSION = saved;
  });

  it("ACTRADECK_SESSION 設定時も explicitSession は false (= hook canonical を待つ・分裂しない)", () => {
    process.env.ACTRADECK_SESSION = "sess_operator_label";
    const r = resolveManagedSession(() => "AUTO");
    // 即確定にしない (これが分裂を防ぐ核心): explicit は必ず false。
    expect(r.explicitSession).toBe(false);
    // ACTRADECK_SESSION は fallback id として保持される (canonical 確定前/hook 皆無の last-resort)。
    expect(r.sessionId).toBe("sess_operator_label");
  });

  it("ACTRADECK_SESSION 未設定なら自動採番 (fallback) + explicitSession false", () => {
    const r = resolveManagedSession(() => "GENERATED");
    expect(r.explicitSession).toBe(false);
    expect(r.sessionId).toBe("sess_GENERATED");
  });

  it("空文字の ACTRADECK_SESSION は未設定扱い (自動採番)", () => {
    process.env.ACTRADECK_SESSION = "";
    const r = resolveManagedSession(() => "GEN2");
    expect(r.sessionId).toBe("sess_GEN2");
    expect(r.explicitSession).toBe(false);
  });
});
