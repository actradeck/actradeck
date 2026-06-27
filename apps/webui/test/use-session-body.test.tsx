/**
 * QA-1 (段階2 裁定 019ea50a carryover): useSessionBody のメモリ衛生・世代ゲート直接単体テスト。
 *
 * 縛る不変条件 (跨セッション secret 残留に隣接・falsifiable・mutation で RED):
 *  (a) generation gate: 古い世代の遅延 fetch 応答が新世代の結果を上書きしない (stale 応答破棄)。
 *  (b) clear(): 保持していた diff/stdout body (テスト内ダミー `ghp_…` 相当) がメモリから消える。
 *  (c) CockpitBoard→SessionDetail の clearBody 配線 (session 切替で clear 発火) を1本 pin。
 *
 * 実 React フック (use-session-body) を createRoot + act で直接駆動し、fetch を vi で制御する。
 * SessionDetail 経由でなくコントローラを直接ドライブする (props mock でなく実フックの挙動を固定)。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useSessionBody, type UseSessionBodyResult } from "../src/ui/use-session-body";

// --- jsdom + act 環境の組み立て (session-replay.test.tsx と同型) ----------------
interface DomCtx {
  root: Root;
  rootEl: HTMLElement;
  teardown: () => Promise<void>;
}

let dom: import("jsdom").JSDOM | undefined;

async function mountDom(): Promise<DomCtx> {
  const { JSDOM } = await import("jsdom");
  dom = new JSDOM('<!doctype html><div id="root"></div>');
  const reactGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const prev = {
    act: reactGlobal.IS_REACT_ACT_ENVIRONMENT,
    window: globalThis.window,
    document: globalThis.document,
    Event: globalThis.Event,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
  };
  reactGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  globalThis.Event = dom.window.Event as typeof Event;
  globalThis.Element = dom.window.Element as typeof Element;
  globalThis.HTMLElement = dom.window.HTMLElement as typeof HTMLElement;
  const rootEl = dom.window.document.getElementById("root");
  if (!rootEl) throw new Error("missing root");
  const root = createRoot(rootEl);
  const teardown = async (): Promise<void> => {
    await act(async () => root.unmount());
    globalThis.window = prev.window;
    globalThis.document = prev.document;
    globalThis.Event = prev.Event;
    globalThis.Element = prev.Element;
    globalThis.HTMLElement = prev.HTMLElement;
    reactGlobal.IS_REACT_ACT_ENVIRONMENT = prev.act;
    dom?.window.close();
    dom = undefined;
  };
  return { root, rootEl, teardown };
}

/** 実フックを駆動し、最新の controller を外へ渡す probe コンポーネント。 */
function makeProbe(getSessionId: () => string | null, sink: (c: UseSessionBodyResult) => void) {
  return function Probe(): null {
    const sessionId = getSessionId();
    const controller = useSessionBody(sessionId);
    sink(controller);
    return null;
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useSessionBody: generation gate + memory hygiene (QA-1)", () => {
  let ctx: DomCtx;
  let latest: UseSessionBodyResult;

  beforeEach(async () => {
    ctx = await mountDom();
  });
  afterEach(async () => {
    await ctx.teardown();
  });

  /** controller を捕捉して render する。 */
  async function render(getSessionId: () => string | null): Promise<void> {
    const Probe = makeProbe(getSessionId, (c) => {
      latest = c;
    });
    await act(async () => {
      ctx.root.render(<Probe />);
    });
  }

  it("(a) generation gate: 古い世代の遅延 output 応答が新世代を上書きしない", async () => {
    // 2 回の fetch を別 deferred で制御する。1 回目 (旧世代) を後から resolve しても
    // 2 回目 (新世代) の結果を上書きしてはならない。
    let resolveFirst!: (v: unknown) => void;
    let resolveSecond!: (v: unknown) => void;
    const firstP = new Promise((r) => (resolveFirst = r));
    const secondP = new Promise((r) => (resolveSecond = r));
    const calls: string[] = [];
    const fetchMock = vi.fn((url: string) => {
      calls.push(url);
      const body = calls.length === 1 ? firstP : secondP;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => body,
      } as unknown as Response);
    });
    vi.stubGlobal("fetch", fetchMock);

    await render(() => "s1");

    // 1 回目 loadOutput (旧世代) を発火。
    await act(async () => {
      latest.loadOutput("cmd-old");
    });
    // 2 回目 loadOutput (新世代) を発火 (1 回目未解決のまま)。
    await act(async () => {
      latest.loadOutput("cmd-new");
    });

    // 新世代を先に解決する。
    await act(async () => {
      resolveSecond({
        session_id: "s1",
        anchor_event_id: "cmd-new",
        output_excerpt: "NEW-OUTPUT\n",
        tail: 16384,
        truncated: false,
        not_found: false,
      });
      await Promise.resolve();
    });
    expect(latest.output?.output_excerpt).toBe("NEW-OUTPUT\n");

    // 旧世代を **後から** 解決する → 世代ゲートで破棄され、NEW を上書きしない。
    await act(async () => {
      resolveFirst({
        session_id: "s1",
        anchor_event_id: "cmd-old",
        output_excerpt: "STALE-OLD-OUTPUT\n",
        tail: 16384,
        truncated: false,
        not_found: false,
      });
      await Promise.resolve();
    });
    expect(latest.output?.output_excerpt).toBe("NEW-OUTPUT\n");
    expect(latest.output?.output_excerpt).not.toContain("STALE-OLD-OUTPUT");
  });

  it("(a') generation gate: 古い世代の遅延 diff 応答が新世代を上書きしない", async () => {
    let resolveFirst!: (v: unknown) => void;
    let resolveSecond!: (v: unknown) => void;
    const firstP = new Promise((r) => (resolveFirst = r));
    const secondP = new Promise((r) => (resolveSecond = r));
    let n = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        n++;
        const body = n === 1 ? firstP : secondP;
        return Promise.resolve({ ok: true, status: 200, json: () => body } as unknown as Response);
      }),
    );
    await render(() => "s1");
    await act(async () => {
      latest.loadDiff();
    });
    await act(async () => {
      latest.loadDiff();
    });
    await act(async () => {
      resolveSecond({
        body: "NEW-DIFF\n",
        truncated: false,
        secret_detected: false,
        redaction_count: 0,
      });
      await Promise.resolve();
    });
    expect(latest.diff?.body).toBe("NEW-DIFF\n");
    await act(async () => {
      resolveFirst({
        body: "STALE-DIFF\n",
        truncated: false,
        secret_detected: false,
        redaction_count: 0,
      });
      await Promise.resolve();
    });
    expect(latest.diff?.body).toBe("NEW-DIFF\n");
    expect(latest.diff?.body).not.toContain("STALE-DIFF");
  });

  it("(b) clear(): 保持していた diff/stdout body (ghp_ 相当ダミー) がメモリから消える", async () => {
    // diff と output を両方ロードしてから clear() し、保持本文が undefined になることを固定。
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        const json = url.includes("/diff")
          ? {
              // テスト内ダミー (実経路は redaction 済みだが、ここでは「保持本文が消える」ことだけ固定)。
              body: "diff --git a/x b/x\n+TOKEN=ghp_DUMMYDUMMYDUMMYDUMMYDUMMYDUMMY01\n",
              truncated: false,
              secret_detected: true,
              redaction_count: 1,
            }
          : {
              session_id: "s1",
              anchor_event_id: "cmd1",
              output_excerpt: "out ghp_DUMMYDUMMYDUMMYDUMMYDUMMYDUMMY02\n",
              tail: 16384,
              truncated: false,
              not_found: false,
            };
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(json),
        } as unknown as Response);
      }),
    );
    await render(() => "s1");

    await act(async () => {
      latest.loadDiff();
      await Promise.resolve();
    });
    await act(async () => {
      latest.loadOutput("cmd1");
      await Promise.resolve();
    });
    // ロードできていること (前提) を確認。
    expect(latest.diff?.body).toContain("ghp_DUMMY");
    expect(latest.output?.output_excerpt).toContain("ghp_DUMMY");

    // clear() で保持本文が消える (跨セッションでメモリに残さない)。
    await act(async () => {
      latest.clear();
    });
    expect(latest.diff).toBeUndefined();
    expect(latest.output).toBeUndefined();
    expect(latest.diffError).toBeUndefined();
    expect(latest.outputError).toBeUndefined();
  });

  it("(b') clear() 後に到着した in-flight 応答は保持されない (世代を進めて破棄)", async () => {
    let resolveDiff!: (v: unknown) => void;
    const p = new Promise((r) => (resolveDiff = r));
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => p } as unknown as Response)),
    );
    await render(() => "s1");
    await act(async () => {
      latest.loadDiff();
    });
    // 応答到着前に clear()。
    await act(async () => {
      latest.clear();
    });
    // 後から in-flight 応答が解決しても、clear が進めた世代で破棄される。
    await act(async () => {
      resolveDiff({
        body: "LATE-DIFF\n",
        truncated: false,
        secret_detected: false,
        redaction_count: 0,
      });
      await Promise.resolve();
    });
    expect(latest.diff).toBeUndefined();
  });
});

describe("CockpitBoard→SessionDetail clearBody 配線 (QA-1 c)", () => {
  let ctx: DomCtx;
  let latest: UseSessionBodyResult;

  beforeEach(async () => {
    ctx = await mountDom();
  });
  afterEach(async () => {
    await ctx.teardown();
  });

  it("(c) session 切替で clear() が発火し、前 session の保持本文が消える", async () => {
    // CockpitBoard は実際には useSessionBody(selectedId) + useEffect([selectedId..]) で clearBody する。
    //   ここではその「session 切替→clear 発火」配線を、selectedId を切替える probe で直接 pin する
    //   (実フック + 実 useEffect 経路。SessionDetail props mock ではない)。
    let sessionId: string | null = "s1";
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              body: "diff --git a/x b/x\n+held-body\n",
              truncated: false,
              secret_detected: false,
              redaction_count: 0,
            }),
        } as unknown as Response),
      ),
    );

    // CockpitBoard の配線を最小再現する probe (selectedId 変化で clearBody)。
    //   実 CockpitBoard:72-74 と同じ deps [selectedId, clearBody] で clear を発火する
    //   (session 切替で前 session の保持本文を破棄)。
    const { useEffect } = await import("react");
    function Board(): null {
      const controller = useSessionBody(sessionId);
      latest = controller;
      const { clear } = controller;
      useEffect(() => {
        clear();
      }, [sessionId, clear]);
      return null;
    }

    await act(async () => {
      ctx.root.render(<Board />);
    });
    // s1 の本文をロード。
    await act(async () => {
      latest.loadDiff();
      await Promise.resolve();
    });
    expect(latest.diff?.body).toContain("held-body");

    // session を切替えて再 render → useEffect の clear が発火し前 session 本文が消える。
    sessionId = "s2";
    await act(async () => {
      ctx.root.render(<Board />);
    });
    expect(latest.diff).toBeUndefined();
  });
});
