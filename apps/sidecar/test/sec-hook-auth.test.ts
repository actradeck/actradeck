/**
 * SEC-3: hook receiver の per-launch トークン認証 + loopback (DNS-rebinding) ガード。
 *
 * 不変条件:
 * - トークン無し / 誤トークン → 403 かつ event を一切 emit しない (sink 未呼び出し)。
 * - 正トークン → 既存挙動 (200 + emit)。
 * - 偽 Origin / 偽 Host (非 loopback) → 403 & no emit。
 * - settings 注入: buildHookSettings(token) が全 hook entry に HOOK_TOKEN_HEADER を付与。
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ApprovalBridge } from "../src/approval-bridge.js";
import { HookReceiver, tokenEquals } from "../src/hook-receiver.js";
import {
  HOOK_TOKEN_HEADER,
  buildHookSettings,
  generateHookToken,
  writeHookSettings,
} from "../src/settings-injection.js";
import type { EventSink } from "../src/sink.js";

const TOKEN = "test-token-abc123";

function makeReceiver(authToken: string | undefined): {
  receiver: HookReceiver;
  emit: ReturnType<typeof vi.fn>;
} {
  const emit = vi.fn(() => undefined);
  const sink = { emit } as unknown as EventSink;
  const receiver = new HookReceiver({
    sink,
    approvalBridge: new ApprovalBridge({ timeoutMs: 50 }),
    ...(authToken !== undefined ? { authToken } : {}),
  });
  return { receiver, emit };
}

const BODY = JSON.stringify({
  session_id: "s1",
  hook_event_name: "SessionStart",
  source: "startup",
});

async function post(port: number, headers: Record<string, string>): Promise<{ status: number }> {
  const res = await fetch(`http://127.0.0.1:${port}/hook`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: BODY,
  });
  await res.text();
  return { status: res.status };
}

/**
 * 生 http.request で任意の Host ヘッダを送る (fetch は Host を forbidden header として
 * 上書きできないため、DNS-rebinding の検証には raw client が必要)。
 */
function rawPost(port: number, headers: Record<string, string>): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/hook",
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
      },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on("error", reject);
    req.end(BODY);
  });
}

describe("SEC-3: hook receiver token auth", () => {
  it("rejects requests with NO token (403 + no emit)", async () => {
    const { receiver, emit } = makeReceiver(TOKEN);
    const port = await receiver.listen();
    const { status } = await post(port, {});
    await receiver.close();
    expect(status).toBe(403);
    expect(emit).not.toHaveBeenCalled();
  });

  it("rejects requests with WRONG token (403 + no emit)", async () => {
    const { receiver, emit } = makeReceiver(TOKEN);
    const port = await receiver.listen();
    const { status } = await post(port, { [HOOK_TOKEN_HEADER]: "wrong" });
    await receiver.close();
    expect(status).toBe(403);
    expect(emit).not.toHaveBeenCalled();
  });

  it("accepts requests with CORRECT token (200 + emit preserved)", async () => {
    const { receiver, emit } = makeReceiver(TOKEN);
    const port = await receiver.listen();
    const { status } = await post(port, { [HOOK_TOKEN_HEADER]: TOKEN });
    await receiver.close();
    expect(status).toBe(200);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("rejects forged non-loopback Origin (403 + no emit), even with correct token", async () => {
    const { receiver, emit } = makeReceiver(TOKEN);
    const port = await receiver.listen();
    const { status } = await post(port, {
      [HOOK_TOKEN_HEADER]: TOKEN,
      Origin: "http://evil.example.com",
    });
    await receiver.close();
    expect(status).toBe(403);
    expect(emit).not.toHaveBeenCalled();
  });

  it("rejects forged non-loopback Host header (DNS-rebinding) (403 + no emit)", async () => {
    const { receiver, emit } = makeReceiver(TOKEN);
    const port = await receiver.listen();
    const { status } = await rawPost(port, {
      [HOOK_TOKEN_HEADER]: TOKEN,
      Host: "attacker.internal",
    });
    await receiver.close();
    expect(status).toBe(403);
    expect(emit).not.toHaveBeenCalled();
  });

  it("accepts localhost Origin with correct token", async () => {
    const { receiver, emit } = makeReceiver(TOKEN);
    const port = await receiver.listen();
    const { status } = await post(port, {
      [HOOK_TOKEN_HEADER]: TOKEN,
      Origin: `http://localhost:${port}`,
    });
    await receiver.close();
    expect(status).toBe(200);
    expect(emit).toHaveBeenCalledTimes(1);
  });
});

// --- SEC-2: 定数時間トークン照合 (timingSafeEqual) -----------------------------
// 素の `value !== authToken` をタイミング攻撃耐性のある定数時間比較へ統一する。
// 挙動は非破壊 (一致=true / 不一致・長さ不一致・undefined=false) であることを固定する。
describe("SEC-2: hook receiver uses constant-time token comparison", () => {
  it("returns true only for the exact matching token", () => {
    expect(tokenEquals(TOKEN, TOKEN)).toBe(true);
  });

  it("returns false for a same-length but different token (content mismatch)", () => {
    const wrong = "x".repeat(TOKEN.length); // 同長 → timingSafeEqual 経路を通る
    expect(wrong.length).toBe(TOKEN.length);
    expect(tokenEquals(TOKEN, wrong)).toBe(false);
  });

  it("returns false for a length-mismatched token (short-circuits before timingSafeEqual)", () => {
    expect(tokenEquals(TOKEN, TOKEN.slice(0, -1))).toBe(false); // 短い
    expect(tokenEquals(TOKEN, TOKEN + "extra")).toBe(false); // 長い
  });

  it("returns false for an undefined/absent provided token", () => {
    expect(tokenEquals(TOKEN, undefined)).toBe(false);
  });

  it("returns false for empty provided against non-empty expected (length mismatch)", () => {
    expect(tokenEquals(TOKEN, "")).toBe(false);
  });
});

describe("SEC-3: settings injection carries token header", () => {
  it("generateHookToken returns a high-entropy URL-safe token", () => {
    const a = generateHookToken();
    const b = generateHookToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  });

  it("buildHookSettings injects HOOK_TOKEN_HEADER into every hook entry", () => {
    const settings = buildHookSettings("http://127.0.0.1:9/hook", TOKEN);
    const entries = Object.values(settings.hooks).flatMap((g) => g.flatMap((x) => x.hooks));
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.headers?.[HOOK_TOKEN_HEADER]).toBe(TOKEN);
    }
  });

  it("buildHookSettings without token omits headers (backward compatible)", () => {
    const settings = buildHookSettings("http://127.0.0.1:9/hook");
    const entries = Object.values(settings.hooks).flatMap((g) => g.flatMap((x) => x.hooks));
    for (const e of entries) {
      expect(e.headers).toBeUndefined();
    }
  });

  // TDA-2: token を含む settings.json は 0600 で書く (親 dir 0700 単層依存を避ける defense-in-depth)。
  it("writeHookSettings writes the token-bearing settings.json with 0600 mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "actradeck-sec-hook-auth-"));
    try {
      const p = join(dir, "settings.json");
      writeHookSettings(p, "http://127.0.0.1:9/hook", TOKEN);
      // file mode は所有者 rw のみ (group/other 読取不可)。
      expect(statSync(p).mode & 0o777).toBe(0o600);
      // token はリテラルで含まれる (受理側の照合用) が、上記 0600 で owner-only。
      expect(readFileSync(p, "utf8")).toContain(TOKEN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
