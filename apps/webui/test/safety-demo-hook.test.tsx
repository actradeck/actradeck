/**
 * QA-1 + TDA-2: useSafetyDemo フックの runtime を直駆動する INV (use-policy-admin.test.tsx と同型 —
 * jsdom + createRoot + act・実フック駆動・fetch を vi 制御)。falsifiable に固定する不変条件:
 *
 *  - 二度押し抑止: launching/running 中の再 launch() で fetch は 1 回のみ (多重 POST しない)。
 *  - 成功: res.ok かつ demo-safety- prefix parse 成功 → phase=running + session_id 取得
 *    (already_running でも同様に収束)。NO-RAW parse は実 parseDemoLaunch を通す (mock しない)。
 *  - 失敗: fetch reject / res.ok===false / parse=null(prefix 不一致) → phase="error"、生値を掴まない。
 *  - TDA-2 出現 watchdog: running 後 live 一覧に出現しなければ WATCHDOG_MS で error へ縮退し CTA 再活性
 *    (busy=false)。出現したら watchdog 解除 (error にしない)・出現後に live から落ちても再監視しない (latch)。
 *  - リーク無し: unmount 後にタイマが発火しない (clearTimeout)。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SAFETY_DEMO_APPEARANCE_WATCHDOG_MS,
  useSafetyDemo,
  type SafetyDemoState,
} from "../src/ui/use-safety-demo.js";

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

describe("useSafetyDemo runtime (QA-1 / TDA-2)", () => {
  let ctx: DomCtx;
  let tornDown: boolean;
  let latest: SafetyDemoState;

  beforeEach(async () => {
    ctx = await mountDom();
    tornDown = false;
  });
  afterEach(async () => {
    if (!tornDown) await ctx.teardown();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // 安定した component 識別 (再 render で hook state を保つ)。render 内定義だと毎回別 type 扱いになり
  // React が再マウントし state が idle にリセットされてしまう。
  function Probe({ liveSessionIds }: { liveSessionIds: readonly string[] }): null {
    latest = useSafetyDemo({ liveSessionIds });
    return null;
  }

  async function render(liveSessionIds: readonly string[]): Promise<void> {
    await act(async () => {
      ctx.root.render(<Probe liveSessionIds={liveSessionIds} />);
    });
  }

  /** launch を起こし fetch mock を返す (呼び出しごとに deferred を差し替え)。 */
  function stubDeferredFetch(): {
    fetchMock: ReturnType<typeof vi.fn>;
    resolve: (r: Response) => void;
    reject: (e: unknown) => void;
  } {
    let resolve!: (r: Response) => void;
    let reject!: (e: unknown) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((res, rej) => {
          resolve = res;
          reject = rej;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    // resolve/reject は launch() が fetch を呼んだ時点で executor 内で代入される。値スナップショットでなく
    // 変数を後読みする wrapper を返す (呼び出し時点の最新 executor へ委譲)。
    return {
      fetchMock,
      resolve: (r: Response) => resolve(r),
      reject: (e: unknown) => reject(e),
    };
  }

  it("成功: res.ok + demo-safety- prefix → phase=running + session_id (実 parseDemoLaunch 経由)", async () => {
    const f = stubDeferredFetch();
    await render([]);
    expect(latest.phase).toBe("idle");
    await act(async () => {
      latest.launch();
    });
    expect(latest.phase).toBe("launching");
    // BFF への same-origin POST 契約 (token はブラウザに載せない)。
    expect(f.fetchMock).toHaveBeenCalledTimes(1);
    expect(f.fetchMock.mock.calls[0]![0]).toBe("/realtime/demo/safety");
    expect((f.fetchMock.mock.calls[0]![1] as { method?: string }).method).toBe("POST");
    await act(async () => {
      f.resolve(jsonResponse({ session_id: "demo-safety-abcd1234" }));
      await flush();
    });
    expect(latest.phase).toBe("running");
    expect(latest.sessionId).toBe("demo-safety-abcd1234");
  });

  it("already_running でも session_id を掴み running へ収束する", async () => {
    const f = stubDeferredFetch();
    await render([]);
    await act(async () => {
      latest.launch();
    });
    await act(async () => {
      f.resolve(jsonResponse({ session_id: "demo-safety-ff00", already_running: true }));
      await flush();
    });
    expect(latest.phase).toBe("running");
    expect(latest.sessionId).toBe("demo-safety-ff00");
  });

  it("二度押し抑止: launching/running 中の再 launch() で fetch は 1 回のみ", async () => {
    const f = stubDeferredFetch();
    await render([]);
    await act(async () => {
      latest.launch();
    });
    expect(f.fetchMock).toHaveBeenCalledTimes(1);
    // launching 中の再押下 → guard で no-op (fetch 増えない)。
    await act(async () => {
      latest.launch();
    });
    expect(f.fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      f.resolve(jsonResponse({ session_id: "demo-safety-abcd1234" }));
      await flush();
    });
    expect(latest.phase).toBe("running");
    // running 中の再押下 → guard で no-op。
    await act(async () => {
      latest.launch();
    });
    expect(f.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("失敗(fetch reject): phase=error・session_id は掴まない", async () => {
    const f = stubDeferredFetch();
    await render([]);
    await act(async () => {
      latest.launch();
    });
    await act(async () => {
      f.reject(new Error("network down"));
      await flush();
    });
    expect(latest.phase).toBe("error");
    expect(latest.sessionId).toBeNull();
  });

  it("失敗(res.ok===false): phase=error", async () => {
    const f = stubDeferredFetch();
    await render([]);
    await act(async () => {
      latest.launch();
    });
    await act(async () => {
      f.resolve(jsonResponse({ session_id: "demo-safety-abcd1234" }, false, 503));
      await flush();
    });
    expect(latest.phase).toBe("error");
    expect(latest.sessionId).toBeNull();
  });

  it("失敗(parse=null: prefix 不一致): phase=error・生 id を掴まない (NO-RAW)", async () => {
    const f = stubDeferredFetch();
    await render([]);
    await act(async () => {
      latest.launch();
    });
    await act(async () => {
      f.resolve(jsonResponse({ session_id: "sess-evil-1234" }));
      await flush();
    });
    expect(latest.phase).toBe("error");
    expect(latest.sessionId).toBeNull();
  });

  it("error からの再 launch() は許可される (CTA 再活性・guard は launching/running のみ)", async () => {
    const f = stubDeferredFetch();
    await render([]);
    await act(async () => {
      latest.launch();
    });
    await act(async () => {
      f.reject(new Error("x"));
      await flush();
    });
    expect(latest.phase).toBe("error");
    await act(async () => {
      latest.launch();
    });
    expect(latest.phase).toBe("launching");
    expect(f.fetchMock).toHaveBeenCalledTimes(2);
  });

  it("TDA-2 watchdog: 出現しなければ WATCHDOG_MS で error へ縮退する", async () => {
    vi.useFakeTimers();
    const f = stubDeferredFetch();
    await render([]); // live 一覧は空 = デモは出現しない
    await act(async () => {
      latest.launch();
    });
    await act(async () => {
      f.resolve(jsonResponse({ session_id: "demo-safety-stuck" }));
      await flush();
    });
    expect(latest.phase).toBe("running");
    // 直前 (WATCHDOG_MS - 1) では running のまま。
    await act(async () => {
      vi.advanceTimersByTime(SAFETY_DEMO_APPEARANCE_WATCHDOG_MS - 1);
      await flush();
    });
    expect(latest.phase).toBe("running");
    // WATCHDOG_MS 到達で error (CTA 再活性)。
    await act(async () => {
      vi.advanceTimersByTime(1);
      await flush();
    });
    expect(latest.phase).toBe("error");
  });

  it("TDA-2 watchdog: 出現したら解除 (error にしない)・出現後 live から落ちても再監視しない (latch)", async () => {
    vi.useFakeTimers();
    const f = stubDeferredFetch();
    await render([]);
    await act(async () => {
      latest.launch();
    });
    await act(async () => {
      f.resolve(jsonResponse({ session_id: "demo-safety-live" }));
      await flush();
    });
    expect(latest.phase).toBe("running");
    // live 一覧に出現 → watchdog 解除。
    await render(["demo-safety-live"]);
    await act(async () => {
      vi.advanceTimersByTime(SAFETY_DEMO_APPEARANCE_WATCHDOG_MS * 2);
      await flush();
    });
    expect(latest.phase).toBe("running"); // error にならない
    // 完了で live から落ちても (latch) 再監視せず error にしない。
    await render([]);
    await act(async () => {
      vi.advanceTimersByTime(SAFETY_DEMO_APPEARANCE_WATCHDOG_MS * 2);
      await flush();
    });
    expect(latest.phase).toBe("running");
  });

  it("リーク無し: unmount 後に watchdog タイマは発火しない (clearTimeout)", async () => {
    vi.useFakeTimers();
    const f = stubDeferredFetch();
    await render([]);
    await act(async () => {
      latest.launch();
    });
    await act(async () => {
      f.resolve(jsonResponse({ session_id: "demo-safety-unmount" }));
      await flush();
    });
    expect(latest.phase).toBe("running");
    await ctx.teardown();
    tornDown = true;
    // unmount 後にタイマを進めても phase 更新 (running→error) は起きない — 発火は clearTimeout 済み。
    expect(() => vi.advanceTimersByTime(SAFETY_DEMO_APPEARANCE_WATCHDOG_MS * 2)).not.toThrow();
    expect(latest.phase).toBe("running");
  });
});
