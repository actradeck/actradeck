/**
 * QA-1 ≡ TDA-4: useAuditCoverage フックの runtime を直駆動する INV (safety-demo-hook.test.tsx と同型 —
 * jsdom + createRoot + act・実フック駆動・fetch を vi 制御・fake timers)。fail-safe 分岐を falsifiable に固定:
 *
 *  (a) unmount で interval cleanup (以後 fetch しない) + in-flight resolve で setState されない (cancelled guard)。
 *  (b) `!res.ok` (5xx 等) は last-known を保持する (flicker 回避・誤って null 化しない)。
 *  (c) parse が undefined (奇形応答: generated_at 不正) でも last-known を保持する。
 *  (d) `enabled=false` → coverage を null リセットし fetch しない (非表示時メモリ衛生)。
 *  (e) enabled トグル (false→true) で再取得する。
 *
 * 受信は必ず event-model 正準 `parseAuditCoverageReportWire` を通す (NO-RAW・単一出所)。実 parser を
 * mock しない (契約検証)。fetch のみ vi 制御。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { COVERAGE_POLL_MS, useAuditCoverage } from "../src/ui/use-audit-coverage.js";
import type { AuditCoverageReport } from "@actradeck/event-model";

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

/** マイクロタスクを数回フラッシュ (fetch().then(async res => await res.json()).then(...) の 3 段 hop 用)。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

/** ok/status 制御可能な最小 Response (json は body を返す)。 */
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: () => Promise.resolve(body) } as unknown as Response;
}

const GEN = "2026-04-02T12:00:00.000Z";
/** 妥当な wire report (parse を通ると 1 provider の coverage になる)。 */
const VALID_BODY = {
  generated_at: GEN,
  providers: [
    {
      provider: "codex",
      last_received_at: "2026-04-02T11:59:48.000Z",
      last_event_timestamp: "2026-04-02T11:59:48.000Z",
      active_session_count: 1,
      total_session_count: 1,
      gap_candidate_ms: 12_000,
    },
  ],
};

describe("useAuditCoverage runtime (QA-1 / TDA-4)", () => {
  let ctx: DomCtx;
  let tornDown: boolean;
  let latest: AuditCoverageReport | null;

  beforeEach(async () => {
    vi.useFakeTimers();
    ctx = await mountDom();
    tornDown = false;
    latest = null;
  });
  afterEach(async () => {
    if (!tornDown) await ctx.teardown();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // 安定 component 識別 (再 render で hook state を保つ・render 内定義は毎回別 type で再マウントされる)。
  function Probe({ enabled }: { enabled: boolean }): null {
    ({ coverage: latest } = useAuditCoverage({ enabled }));
    return null;
  }
  async function render(enabled: boolean): Promise<void> {
    await act(async () => {
      ctx.root.render(<Probe enabled={enabled} />);
    });
  }

  it("enabled: same-origin GET (accept json) で妥当応答を parse し coverage を確立する", async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(jsonResponse(VALID_BODY)),
    );
    vi.stubGlobal("fetch", fetchMock);
    await render(true);
    await act(async () => {
      await flush();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/realtime/audit/coverage");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ accept: "application/json" });
    // GET 契約 (mutating method を送らない)。
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBeUndefined();
    expect(latest?.generated_at).toBe(GEN);
    expect(latest?.providers).toHaveLength(1);
    expect(latest?.providers[0]!.provider).toBe("codex");
  });

  it("(d) enabled=false は fetch せず coverage を null に保つ", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(VALID_BODY)));
    vi.stubGlobal("fetch", fetchMock);
    await render(false);
    await act(async () => {
      await flush();
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(latest).toBeNull();
  });

  it("(d)+(e) enabled トグル: true で取得 → false で null リセット → true で再取得", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(VALID_BODY)));
    vi.stubGlobal("fetch", fetchMock);
    await render(true);
    await act(async () => {
      await flush();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(latest?.providers).toHaveLength(1);
    // false へ: 破棄 (null リセット)・新規 fetch なし。
    await render(false);
    await act(async () => {
      await flush();
    });
    expect(latest).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // true へ戻す: 再取得。
    await render(true);
    await act(async () => {
      await flush();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(latest?.providers).toHaveLength(1);
  });

  it("(b) !res.ok (503) は last-known を保持する (誤って null 化しない)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(VALID_BODY)) // 初回: 確立
      .mockResolvedValueOnce(jsonResponse({ error: "internal error" }, false, 503)); // 2 回目: 5xx
    vi.stubGlobal("fetch", fetchMock);
    await render(true);
    await act(async () => {
      await flush();
    });
    expect(latest?.providers).toHaveLength(1);
    // interval で 2 回目 pull → 503。last-known を保持。
    await act(async () => {
      vi.advanceTimersByTime(COVERAGE_POLL_MS);
      await flush();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(latest?.providers).toHaveLength(1); // 変わらず (null 化しない)
    expect(latest?.generated_at).toBe(GEN);
  });

  it("(c) parse undefined (奇形応答: generated_at 不正) は last-known を保持する", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(VALID_BODY)) // 初回: 確立
      .mockResolvedValueOnce(jsonResponse({ generated_at: "yesterday", providers: [] })); // 奇形
    vi.stubGlobal("fetch", fetchMock);
    await render(true);
    await act(async () => {
      await flush();
    });
    expect(latest?.providers).toHaveLength(1);
    await act(async () => {
      vi.advanceTimersByTime(COVERAGE_POLL_MS);
      await flush();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 奇形 (parse=undefined) は反映せず last-known を保持。
    expect(latest?.providers).toHaveLength(1);
    expect(latest?.generated_at).toBe(GEN);
  });

  it("(a) unmount: interval cleanup で以後 fetch しない + in-flight resolve で setState されない", async () => {
    // 制御可能な deferred fetch (unmount 中に in-flight のまま resolve させる)。
    let resolveFetch!: (r: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((res) => {
          resolveFetch = res;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await render(true);
    expect(fetchMock).toHaveBeenCalledTimes(1); // マウント時 pull (未 resolve = in-flight)
    // unmount (cancelled=true + clearInterval)。
    await ctx.teardown();
    tornDown = true;
    // in-flight fetch を unmount 後に resolve → cancelled guard で setState されない (throw/warn なし)。
    await expect(
      act(async () => {
        resolveFetch(jsonResponse(VALID_BODY));
        await flush();
      }),
    ).resolves.toBeUndefined();
    // interval が cleanup 済 = タイマを進めても再 pull しない。
    await act(async () => {
      vi.advanceTimersByTime(COVERAGE_POLL_MS * 3);
      await flush();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
