/**
 * INV-ATTACH-HOOK-AUTH (ADR 019ea476 D3)。
 *
 * Attach daemon の HookReceiver は authToken **必須**。
 * - requireAuthToken=true かつ authToken 未設定 → construct 時に throw (起動不能)。
 *   mutation: requireAuthToken の assert を消すと「起動できてしまう」→ ここが赤化。
 * - token 無し / 誤 token の POST → 403 + no emit (既存 SEC-3 の Attach 適用)。
 * - 正 token → 200 + emit。
 */
import { describe, expect, it, vi } from "vitest";

import { ApprovalBridge } from "../src/approval-bridge.js";
import { HookReceiver } from "../src/hook-receiver.js";
import { HOOK_TOKEN_HEADER } from "../src/settings-injection.js";
import type { EventSink } from "../src/sink.js";

const TOKEN = "attach-nonce-123";
const BODY = JSON.stringify({
  session_id: "s1",
  hook_event_name: "SessionStart",
  source: "startup",
});

function makeSink(): { sink: EventSink; emit: ReturnType<typeof vi.fn> } {
  const emit = vi.fn(() => undefined);
  return { sink: { emit } as unknown as EventSink, emit };
}

async function post(port: number, headers: Record<string, string>): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/hook`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: BODY,
  });
  await res.text();
  return res.status;
}

describe("INV-ATTACH-HOOK-AUTH: Attach は authToken 必須", () => {
  it("throws at construction when requireAuthToken=true but authToken is missing", () => {
    const { sink } = makeSink();
    expect(
      () =>
        new HookReceiver({
          sink,
          approvalBridge: new ApprovalBridge({ timeoutMs: 50 }),
          requireAuthToken: true,
          // authToken 未設定 — Attach では到達不能であるべき。
        }),
    ).toThrow(/authToken is required/i);
  });

  it("throws when requireAuthToken=true and authToken is empty string", () => {
    const { sink } = makeSink();
    expect(
      () =>
        new HookReceiver({
          sink,
          approvalBridge: new ApprovalBridge({ timeoutMs: 50 }),
          requireAuthToken: true,
          authToken: "",
        }),
    ).toThrow(/authToken is required/i);
  });

  it("constructs when requireAuthToken=true and authToken is present", async () => {
    const { sink, emit } = makeSink();
    const receiver = new HookReceiver({
      sink,
      approvalBridge: new ApprovalBridge({ timeoutMs: 50 }),
      requireAuthToken: true,
      authToken: TOKEN,
      captureMode: "attach",
    });
    const port = await receiver.listen();
    // no token → 403, no emit.
    expect(await post(port, {})).toBe(403);
    expect(emit).not.toHaveBeenCalled();
    // correct token → 200 + emit.
    expect(await post(port, { [HOOK_TOKEN_HEADER]: TOKEN })).toBe(200);
    await receiver.close();
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("attach emit carries capture_mode=attach", async () => {
    const { sink, emit } = makeSink();
    const receiver = new HookReceiver({
      sink,
      approvalBridge: new ApprovalBridge({ timeoutMs: 50 }),
      requireAuthToken: true,
      authToken: TOKEN,
      captureMode: "attach",
    });
    const port = await receiver.listen();
    await post(port, { [HOOK_TOKEN_HEADER]: TOKEN });
    await receiver.close();
    expect(emit).toHaveBeenCalledTimes(1);
    const ev = emit.mock.calls[0]?.[0] as { capture_mode?: string };
    expect(ev.capture_mode).toBe("attach");
  });
});
