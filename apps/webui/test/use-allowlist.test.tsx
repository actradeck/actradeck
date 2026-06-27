/**
 * PAL-v2 (ADR 019ee147・QA-3/QA-4): useAllowlist フック + PersistedApprovalsPanel の interaction INV。
 *
 * use-session-body.test.tsx と同型 (jsdom + createRoot + act・実フック駆動・fetch を vi 制御)。
 * 固定する不変条件 (falsifiable):
 *  - QA-4 (hook): load は GET allowlist URL を叩き view を populate / revoke は POST (signature+repo_scope) で
 *    最新一覧へ更新 / 世代ゲートで stale 応答を破棄 / HTTP エラーで error 設定。
 *  - QA-3 (panel): load クリックで一覧描画 (signature短縮/repo/risk/失効ボタン) / revoke クリックで POST 発火 +
 *    最新一覧へ / enabled=false で disabled banner / error 表示。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FixedLocaleProvider } from "../src/ui/LocaleProvider";
import { PersistedApprovalsPanel } from "../src/ui/PersistedApprovalsPanel";
import { useAllowlist, type UseAllowlistResult } from "../src/ui/use-allowlist";

let dom: import("jsdom").JSDOM | undefined;

interface DomCtx {
  root: Root;
  rootEl: HTMLElement;
  teardown: () => Promise<void>;
}

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
    MouseEvent: globalThis.MouseEvent,
  };
  reactGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  globalThis.Event = dom.window.Event as typeof Event;
  globalThis.Element = dom.window.Element as typeof Element;
  globalThis.HTMLElement = dom.window.HTMLElement as typeof HTMLElement;
  globalThis.MouseEvent = dom.window.MouseEvent as typeof MouseEvent;
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
    globalThis.MouseEvent = prev.MouseEvent;
    reactGlobal.IS_REACT_ACT_ENVIRONMENT = prev.act;
    dom?.window.close();
    dom = undefined;
  };
  return { root, rootEl, teardown };
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: () => Promise.resolve(body) } as unknown as Response;
}

const ENTRY = {
  signature: "a".repeat(64),
  repo_scope: "scopeA",
  repo_label: "repoA",
  risk: "medium",
  created_at_ms: 1,
  expires_at_ms: 9_999_999_999_999,
};

afterEach(() => vi.restoreAllMocks());

describe("useAllowlist hook (QA-4)", () => {
  let ctx: DomCtx;
  let latest: UseAllowlistResult;

  beforeEach(async () => {
    ctx = await mountDom();
  });
  afterEach(async () => {
    await ctx.teardown();
  });

  async function render(getSessionId: () => string | null): Promise<void> {
    function Probe(): null {
      latest = useAllowlist(getSessionId());
      return null;
    }
    await act(async () => {
      ctx.root.render(<Probe />);
    });
  }

  it("load は GET allowlist URL を叩き view を populate する", async () => {
    const calls: Array<[string, unknown]> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: unknown) => {
        calls.push([url, init]);
        return Promise.resolve(jsonResponse({ enabled: true, entries: [ENTRY] }));
      }),
    );
    await render(() => "sess/x");
    await act(async () => {
      latest.load();
      await Promise.resolve();
    });
    expect(calls[0]![0]).toBe("/realtime/sessions/sess%2Fx/approvals/allowlist"); // encodeURIComponent
    expect(calls[0]![1]).toBeUndefined(); // list は GET (init なし)
    expect(latest.view?.enabled).toBe(true);
    expect(latest.view?.entries).toHaveLength(1);
    expect(latest.view?.entries[0]!.signature).toBe(ENTRY.signature);
  });

  it("revoke は POST (signature+repo_scope) を送り最新一覧へ更新する", async () => {
    const calls: Array<{ url: string; init: { method?: string; body?: string } }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: { method?: string; body?: string }) => {
        calls.push({ url, init: init ?? {} });
        // revoke 後は空一覧 + removed。
        return Promise.resolve(jsonResponse({ enabled: true, entries: [], removed: 1 }));
      }),
    );
    await render(() => "s1");
    await act(async () => {
      latest.revoke(ENTRY.signature, ENTRY.repo_scope);
      await Promise.resolve();
    });
    expect(calls[0]!.url).toBe("/realtime/sessions/s1/approvals/allowlist/revoke");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({
      signature: ENTRY.signature,
      repo_scope: ENTRY.repo_scope,
    });
    expect(latest.view?.entries).toHaveLength(0); // revoke 応答の最新一覧で更新。
  });

  it("世代ゲート: 古い load 応答が新 load を上書きしない", async () => {
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
      latest.load();
    });
    await act(async () => {
      latest.load();
    });
    await act(async () => {
      resolveSecond({ enabled: true, entries: [ENTRY] });
      await Promise.resolve();
    });
    expect(latest.view?.entries).toHaveLength(1);
    await act(async () => {
      resolveFirst({ enabled: false, entries: [] });
      await Promise.resolve();
    });
    expect(latest.view?.entries).toHaveLength(1); // 旧世代は破棄。
    expect(latest.view?.enabled).toBe(true);
  });

  it("HTTP エラーで error を設定する", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse({}, false, 503))),
    );
    await render(() => "s1");
    await act(async () => {
      latest.load();
      await Promise.resolve();
    });
    expect(latest.error).toContain("503");
  });
});

describe("PersistedApprovalsPanel interaction (QA-3)", () => {
  let ctx: DomCtx;

  beforeEach(async () => {
    ctx = await mountDom();
  });
  afterEach(async () => {
    await ctx.teardown();
  });

  function click(testid: string): void {
    const el = ctx.rootEl.querySelector(`[data-testid="${testid}"]`);
    if (!el) throw new Error(`no element ${testid}`);
    el.dispatchEvent(new dom!.window.MouseEvent("click", { bubbles: true }));
  }

  async function renderPanel(): Promise<void> {
    await act(async () => {
      ctx.root.render(
        <FixedLocaleProvider locale="ja">
          <PersistedApprovalsPanel sessionId="s1" nowMs={1000} />
        </FixedLocaleProvider>,
      );
    });
  }

  it("load クリックで一覧 (署名/repo/失効ボタン) を描画し、revoke クリックで POST する", async () => {
    const calls: Array<{ url: string; init?: { method?: string; body?: string } }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: { method?: string; body?: string }) => {
        calls.push({ url, ...(init ? { init } : {}) });
        const isRevoke = url.endsWith("/revoke");
        return Promise.resolve(
          jsonResponse({
            enabled: true,
            entries: isRevoke ? [] : [ENTRY],
            ...(isRevoke ? { removed: 1 } : {}),
          }),
        );
      }),
    );
    await renderPanel();

    // load クリック → 一覧描画。
    await act(async () => {
      click("allowlist-load");
      await Promise.resolve();
    });
    expect(ctx.rootEl.querySelector('[data-testid="allowlist-list"]')).not.toBeNull();
    expect(ctx.rootEl.querySelector('[data-testid="allowlist-sig"]')!.textContent).toContain(
      ENTRY.signature.slice(0, 12),
    );
    expect(ctx.rootEl.querySelector('[data-testid="allowlist-revoke"]')).not.toBeNull();
    // NO-RAW: 描画 HTML に生コマンド片がない。
    expect(ctx.rootEl.innerHTML).not.toContain("command");

    // revoke クリック → POST 発火 + 最新一覧 (空) で再描画。
    await act(async () => {
      click("allowlist-revoke");
      await Promise.resolve();
    });
    const revCall = calls.find((c) => c.url.endsWith("/revoke"));
    expect(revCall?.init?.method).toBe("POST");
    expect(ctx.rootEl.querySelector('[data-testid="allowlist-empty"]')).not.toBeNull();
  });

  it("enabled=false で disabled banner を出す", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse({ enabled: false, entries: [ENTRY] }))),
    );
    await renderPanel();
    await act(async () => {
      click("allowlist-load");
      await Promise.resolve();
    });
    expect(ctx.rootEl.querySelector('[data-testid="allowlist-disabled"]')).not.toBeNull();
  });
});
