/**
 * QA-R2-1 (2026-08-13 監査 R2): useTelemetry フック runtime を直駆動する
 * (use-audit-coverage.test.tsx と同型 — jsdom + createRoot + act・実フック駆動・fetch のみ vi 制御)。
 *
 * R2 の mutation probe (g) で「telemetry-ui.test.ts を削除しても webui coverage gate が緑のまま」
 * が実証された (use-telemetry.ts は 48.97% → 6.12% でも rc=0)。本ファイルがフック本体
 * (reload / loadPreview / enable / disable / resetId / flush と各 catch fail-safe) を実カバーし、
 * vitest.config.ts の per-file floor が erosion を CI で止める。
 *
 * 受信は必ず closed contract (parseTelemetryStatus / parseTelemetryPreview → TelemetryBatch
 * 再射影) を通す実装をそのまま検証する (parser を mock しない)。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useTelemetry, type UseTelemetryResult } from "../src/ui/use-telemetry.js";

let dom: import("jsdom").JSDOM | undefined;

interface DomCtx {
  root: Root;
  teardown: () => Promise<void>;
}

async function mountDom(): Promise<DomCtx> {
  const { JSDOM } = await import("jsdom");
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://localhost/" });
  const reactGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const prev = {
    act: reactGlobal.IS_REACT_ACT_ENVIRONMENT,
    window: globalThis.window,
    document: globalThis.document,
  };
  reactGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  const rootEl = dom.window.document.getElementById("root");
  if (!rootEl) throw new Error("missing root");
  const root = createRoot(rootEl);
  const teardown = async (): Promise<void> => {
    await act(async () => root.unmount());
    globalThis.window = prev.window;
    globalThis.document = prev.document;
    reactGlobal.IS_REACT_ACT_ENVIRONMENT = prev.act;
    dom?.window.close();
    dom = undefined;
  };
  return { root, teardown };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: () => Promise.resolve(body) } as unknown as Response;
}

const UUID = "7b0994ec-91fe-4d1f-a8bb-5a0e2bf69140";
const OFF_STATUS = { schema_version: 1, mode: "off", offered_endpoint: "https://c.example/v1" };
const ANON_STATUS = {
  schema_version: 1,
  mode: "anonymous",
  endpoint: "https://c.example/v1",
  installation_id: UUID,
  enabled_at: "2026-08-11T00:00:00.000Z",
};
const VALID_BATCH = {
  schema_version: 1,
  installation_id: UUID,
  events: [
    {
      event_name: "active_day",
      occurred_on: "2026-08-11",
      app_version: "0.7.0",
      platform: "linux",
      count: 1,
    },
  ],
};
const VALID_PREVIEW = {
  status: ANON_STATUS,
  batch: VALID_BATCH,
  source_range: { from: "2026-07-13", to: "2026-08-11" },
};

describe("useTelemetry runtime (QA-R2-1)", () => {
  let ctx: DomCtx;
  let result: UseTelemetryResult;

  beforeEach(async () => {
    ctx = await mountDom();
  });
  afterEach(async () => {
    await ctx.teardown();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function Probe({ active }: { active: boolean }): null {
    result = useTelemetry(active);
    return null;
  }
  async function render(active: boolean): Promise<void> {
    await act(async () => {
      ctx.root.render(<Probe active={active} />);
      await flushMicrotasks();
    });
  }

  it("active mount reloads status through the closed projection", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(OFF_STATUS)));
    vi.stubGlobal("fetch", fetchMock);
    await render(true);
    expect(fetchMock).toHaveBeenCalledWith("/realtime/telemetry", expect.anything());
    expect(result.status).toMatchObject({ mode: "off", offered_endpoint: "https://c.example/v1" });
    expect(result.error).toBe(false);
    expect(result.loading).toBe(false);
  });

  it("inactive mount does not fetch; deactivating clears the preview", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(VALID_PREVIEW)));
    vi.stubGlobal("fetch", fetchMock);
    await render(false);
    expect(fetchMock).not.toHaveBeenCalled();
    await render(true);
    await act(async () => {
      await result.loadPreview();
    });
    expect(result.preview?.batch?.events).toHaveLength(1);
    await render(false);
    expect(result.preview).toBeNull();
  });

  it("reload folds invalid status and transport failure to the error flag (fail-safe)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse({ schema_version: 2, mode: "off" }))),
    );
    await render(true);
    expect(result.status).toBeNull();
    expect(result.error).toBe(true);

    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse({ error: "boom" }, false, 502))),
    );
    await act(async () => {
      await result.reload();
    });
    expect(result.error).toBe(true);
  });

  it("loadPreview re-projects the batch through the closed contract and syncs status", async () => {
    const fetchMock = vi.fn((path: string) =>
      Promise.resolve(
        path === "/realtime/telemetry/preview"
          ? jsonResponse(VALID_PREVIEW)
          : jsonResponse(ANON_STATUS),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await render(true);
    await act(async () => {
      await result.loadPreview();
    });
    expect(result.preview?.source_range).toEqual({ from: "2026-07-13", to: "2026-08-11" });
    expect(result.status?.mode).toBe("anonymous");
    expect(result.error).toBe(false);
    act(() => {
      result.clearPreview();
    });
    expect(result.preview).toBeNull();
  });

  it("loadPreview rejects a contaminated batch (NO-RAW: out-of-contract field poisons the preview)", async () => {
    const contaminated = {
      ...VALID_PREVIEW,
      batch: {
        ...VALID_BATCH,
        events: [{ ...VALID_BATCH.events[0], cwd: "/home/operator/secret-repo" }],
      },
    };
    const fetchMock = vi.fn((path: string) =>
      Promise.resolve(
        path === "/realtime/telemetry/preview"
          ? jsonResponse(contaminated)
          : jsonResponse(ANON_STATUS),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await render(true);
    await act(async () => {
      await result.loadPreview();
    });
    expect(result.preview).toBeNull();
    expect(result.error).toBe(true);
  });

  it("enable posts the endpoint body, adopts the new status, and drops the stale preview", async () => {
    const fetchMock = vi.fn((path: string, init?: RequestInit) => {
      if (path === "/realtime/telemetry/preview")
        return Promise.resolve(jsonResponse(VALID_PREVIEW));
      if (init?.method === "POST") return Promise.resolve(jsonResponse(ANON_STATUS));
      return Promise.resolve(jsonResponse(OFF_STATUS));
    });
    vi.stubGlobal("fetch", fetchMock);
    await render(true);
    await act(async () => {
      await result.loadPreview();
    });
    expect(result.preview).not.toBeNull();
    await act(async () => {
      await result.enable("https://c.example/v1");
    });
    const post = fetchMock.mock.calls.find(([path]) => path === "/realtime/telemetry/enable");
    expect(post?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ endpoint: "https://c.example/v1" }),
    });
    expect(result.status?.mode).toBe("anonymous");
    expect(result.preview).toBeNull();
  });

  it("disable and resetId post to their mutation routes; a failed mutation sets error", async () => {
    const posted: string[] = [];
    const fetchMock = vi.fn((path: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posted.push(path);
        return Promise.resolve(jsonResponse(OFF_STATUS));
      }
      return Promise.resolve(jsonResponse(OFF_STATUS));
    });
    vi.stubGlobal("fetch", fetchMock);
    await render(true);
    await act(async () => {
      await result.disable();
      await result.resetId();
    });
    expect(posted).toEqual(["/realtime/telemetry/disable", "/realtime/telemetry/reset-id"]);
    expect(result.error).toBe(false);

    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse({ error: "not_enabled" }, false, 409))),
    );
    await act(async () => {
      await result.resetId();
    });
    expect(result.error).toBe(true);
  });

  it("flush posts then reloads status; a failed flush folds to error without breaking state", async () => {
    const calls: Array<{ path: string; method?: string }> = [];
    const fetchMock = vi.fn((path: string, init?: RequestInit) => {
      calls.push({ path, ...(init?.method !== undefined ? { method: init.method } : {}) });
      if (init?.method === "POST") return Promise.resolve(jsonResponse({ sent: true }));
      return Promise.resolve(jsonResponse(ANON_STATUS));
    });
    vi.stubGlobal("fetch", fetchMock);
    await render(true);
    await act(async () => {
      await result.flush();
    });
    expect(calls).toContainEqual({ path: "/realtime/telemetry/flush", method: "POST" });
    // flush 後に status を再読込する (last_success_at 反映)。
    expect(
      calls.filter((c) => c.path === "/realtime/telemetry" && c.method === undefined).length,
    ).toBeGreaterThanOrEqual(2);
    expect(result.error).toBe(false);

    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse({ error: "send_failed" }, false, 502))),
    );
    await act(async () => {
      await result.flush();
    });
    expect(result.error).toBe(true);
    expect(result.status?.mode).toBe("anonymous"); // last-known は破壊しない。
  });
});
