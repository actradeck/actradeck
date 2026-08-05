// GFI #21: pin the real fetchOk's HTTP-status mapping without any network. The fake-Deps
// tests inject fetchJson directly and never exercise deps.ts's fetchOk, so the "non-OK
// response throws naming the status and host" contract lived only in a comment. Here we stub
// the GLOBAL fetch (deterministic, no sockets, no real timers fire — the AbortSignal.timeout
// timer is unref'd and the stub resolves immediately) and drive the real makeRealDeps().
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeRealDeps } from "./deps.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("real Deps fetchOk — HTTP status mapping (GFI #21)", () => {
  it("a resolved non-OK response throws naming the HTTP status and the host", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 500 }) as unknown as Response);
    const deps = await makeRealDeps();
    await expect(
      deps.fetchJson("https://api.github.com/repos/actradeck/actradeck/releases/latest"),
    ).rejects.toThrow(/HTTP 500 for api\.github\.com/);
  });

  it("fetchBytes shares the same mapping (single fetchOk source)", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 403 }) as unknown as Response);
    const deps = await makeRealDeps();
    await expect(deps.fetchBytes("https://objects.example.com/x.tar.gz")).rejects.toThrow(
      /HTTP 403 for objects\.example\.com/,
    );
  });

  it("an OK response flows through to json()", async () => {
    vi.stubGlobal("fetch", async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({ tag_name: "v9.9.9" }),
      } as unknown as Response;
    });
    const deps = await makeRealDeps();
    await expect(deps.fetchJson("https://api.github.com/x")).resolves.toEqual({
      tag_name: "v9.9.9",
    });
  });
});
