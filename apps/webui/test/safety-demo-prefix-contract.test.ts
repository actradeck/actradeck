/**
 * INV-DEMO-PREFIX-CONTRACT (TDA-4) — webui のローカル `SAFETY_DEMO_SESSION_PREFIX` と backend 正典
 * (safety-demo-script 経由 @actradeck/backend) の **等価性**を pin する契約テスト。
 *
 * webui は browser bundle を汚さないため prefix をローカル定数で持つ (parseDemoLaunch が demo-safety- を
 * 抽出する NO-RAW ゲート)。値が backend 正典から drift すると、起動応答の session_id を webui が誤って
 * 弾く/受ける。ここでは **両方を import して値比較のみ**行う (node test・browser bundle 非依存)。
 */
import { describe, expect, it } from "vitest";

import { SAFETY_DEMO_SESSION_PREFIX as BACKEND_PREFIX } from "@actradeck/backend";

import { SAFETY_DEMO_SESSION_PREFIX as WEBUI_PREFIX } from "../src/ui/use-safety-demo.js";

describe("INV-DEMO-PREFIX-CONTRACT: webui prefix ≡ backend 正典", () => {
  it("webui のローカル prefix は backend safety-demo-script の正典と一致する (drift ガード)", () => {
    expect(WEBUI_PREFIX).toBe(BACKEND_PREFIX);
    expect(WEBUI_PREFIX).toBe("demo-safety-");
  });
});
