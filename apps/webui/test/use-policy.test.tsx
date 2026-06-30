/**
 * ADR 019f0c3e Phase 2: usePolicy フック + PolicySettingsPanel の interaction INV。
 *
 * use-allowlist.test.tsx と同型 (jsdom + createRoot + act・実フック駆動・fetch を vi 制御)。
 * 固定する不変条件 (falsifiable):
 *  - hook: load は GET policy URL を叩き view を populate / save は POST (.../set) で最新へ更新 /
 *    世代ゲートで stale 応答を破棄 / HTTP エラーで error 設定 / parsePolicy が未知 category を落とす。
 *  - panel: load クリックでカテゴリ描画 (checkbox + default タグ) / toggle+save で POST (closed enum) /
 *    envGateEnabled=false で警告 banner / 描画 HTML に生コマンドが無い (NO-RAW)。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FixedLocaleProvider } from "../src/ui/LocaleProvider";
import { PolicySettingsPanel } from "../src/ui/PolicySettingsPanel";
import { parsePolicy, usePolicy, type UsePolicyResult } from "../src/ui/use-policy";

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

const GET_BODY = {
  enabled: true,
  categories: ["recursive-rm", "secret-egress"],
  env_gate_enabled: true,
};

afterEach(() => vi.restoreAllMocks());

describe("parsePolicy (closed-enum 投影)", () => {
  it("未知/非 string category を落とし enum 安定順に投影する", () => {
    const v = parsePolicy({
      enabled: true,
      categories: ["secret-egress", "rm -rf /", 42, "recursive-rm", "bogus"],
      env_gate_enabled: true,
    });
    expect(v?.categories).toEqual(["recursive-rm", "secret-egress"]); // 未知/raw 除外 + 安定順。
  });

  it("env_gate_enabled は明示 false のみ false (省略は true)", () => {
    expect(parsePolicy({ enabled: true, categories: [] })?.envGateEnabled).toBe(true);
    expect(
      parsePolicy({ enabled: true, categories: [], env_gate_enabled: false })?.envGateEnabled,
    ).toBe(false);
  });

  it("categories が配列でなければ undefined (壊れ応答を弾く)", () => {
    expect(parsePolicy({ enabled: true, categories: "nope" })).toBeUndefined();
  });
});

describe("usePolicy hook", () => {
  let ctx: DomCtx;
  let latest: UsePolicyResult;

  beforeEach(async () => {
    ctx = await mountDom();
  });
  afterEach(async () => {
    await ctx.teardown();
  });

  async function render(getSessionId: () => string | null): Promise<void> {
    function Probe(): null {
      latest = usePolicy(getSessionId());
      return null;
    }
    await act(async () => {
      ctx.root.render(<Probe />);
    });
  }

  it("load は GET policy URL を叩き view を populate する", async () => {
    const calls: Array<[string, unknown]> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: unknown) => {
        calls.push([url, init]);
        return Promise.resolve(jsonResponse(GET_BODY));
      }),
    );
    await render(() => "sess/x");
    await act(async () => {
      latest.load();
      await Promise.resolve();
    });
    expect(calls[0]![0]).toBe("/realtime/sessions/sess%2Fx/approvals/policy"); // encodeURIComponent
    expect(calls[0]![1]).toBeUndefined(); // get は GET (init なし)
    expect(latest.view?.enabled).toBe(true);
    expect(latest.view?.categories).toEqual(["recursive-rm", "secret-egress"]);
    expect(latest.view?.envGateEnabled).toBe(true);
  });

  it("save は POST (.../set, enabled+categories) を送り最新へ更新する", async () => {
    const calls: Array<{ url: string; init: { method?: string; body?: string } }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: { method?: string; body?: string }) => {
        calls.push({ url, init: init ?? {} });
        return Promise.resolve(
          jsonResponse({ enabled: false, categories: ["disk-destroy"], env_gate_enabled: true }),
        );
      }),
    );
    await render(() => "s1");
    await act(async () => {
      latest.save({ enabled: false, categories: ["disk-destroy"] });
      await Promise.resolve();
    });
    expect(calls[0]!.url).toBe("/realtime/sessions/s1/approvals/policy/set");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({
      enabled: false,
      categories: ["disk-destroy"],
    });
    expect(latest.view?.enabled).toBe(false);
    expect(latest.view?.categories).toEqual(["disk-destroy"]);
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
      resolveSecond({ enabled: true, categories: ["disk-destroy"], env_gate_enabled: true });
      await Promise.resolve();
    });
    expect(latest.view?.categories).toEqual(["disk-destroy"]);
    await act(async () => {
      resolveFirst({ enabled: false, categories: ["recursive-rm"], env_gate_enabled: true });
      await Promise.resolve();
    });
    expect(latest.view?.categories).toEqual(["disk-destroy"]); // 旧世代は破棄。
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
    expect(latest.error).toContain("503"); // 空 body → fallback (HTTP ステータス)
  });

  it("QA-R3-1: HTTP エラー時は本文 error を優先して表示する (HTTP ステータスだけにしない)", async () => {
    // SEC-R2-2 の本体: persist 失敗等の実理由を operator に見せる body.error 抽出パスを pin。
    const detail = "policy applied in memory but failed to persist to disk";
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse({ error: detail }, false, 500))),
    );
    await render(() => "s1");
    await act(async () => {
      latest.load();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(latest.error).toBe(detail); // "HTTP 500" でなく本文 error
  });
});

describe("PolicySettingsPanel interaction", () => {
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
          <PolicySettingsPanel sessionId="s1" />
        </FixedLocaleProvider>,
      );
    });
  }

  it("load クリックでカテゴリ (checkbox + default タグ) を描画する", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(GET_BODY))),
    );
    await renderPanel();
    await act(async () => {
      click("policy-load");
      await Promise.resolve();
    });
    expect(ctx.rootEl.querySelector('[data-testid="policy-categories"]')).not.toBeNull();
    // 全 12 カテゴリの checkbox。
    expect(ctx.rootEl.querySelectorAll('[data-testid^="policy-cat-input-"]')).toHaveLength(12);
    // recursive-rm は default タグ + checked。
    expect(
      ctx.rootEl.querySelector('[data-testid="policy-cat-default-recursive-rm"]'),
    ).not.toBeNull();
    const rm = ctx.rootEl.querySelector(
      '[data-testid="policy-cat-input-recursive-rm"]',
    ) as HTMLInputElement;
    expect(rm.checked).toBe(true);
    // perm-change は既定 OFF (default タグ無し・unchecked)。
    expect(ctx.rootEl.querySelector('[data-testid="policy-cat-default-perm-change"]')).toBeNull();
    const perm = ctx.rootEl.querySelector(
      '[data-testid="policy-cat-input-perm-change"]',
    ) as HTMLInputElement;
    expect(perm.checked).toBe(false);
    // 構造的 NO-RAW: パネルは静的ラベル + closed-enum key のみ描画し、動的 command/secret 経路を持たない
    // (relay 層の resolvePolicy/buildPolicyResponse/parsePolicy で投影済)。secret 様の値が混ざらないことを確認。
    expect(ctx.rootEl.innerHTML).not.toContain("AKIA");
  });

  it("カテゴリ toggle + save で POST (closed enum・更新後 categories) を送る", async () => {
    const calls: Array<{ url: string; init?: { method?: string; body?: string } }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: { method?: string; body?: string }) => {
        calls.push({ url, ...(init ? { init } : {}) });
        const isSet = url.endsWith("/set");
        return Promise.resolve(
          jsonResponse(
            isSet
              ? {
                  enabled: true,
                  categories: ["recursive-rm", "secret-egress", "disk-destroy"],
                  env_gate_enabled: true,
                }
              : GET_BODY,
          ),
        );
      }),
    );
    await renderPanel();
    await act(async () => {
      click("policy-load");
      await Promise.resolve();
    });
    // disk-destroy を追加で ON にする (初期は未選択)。
    await act(async () => {
      click("policy-cat-input-disk-destroy");
      await Promise.resolve();
    });
    // save クリック → POST /set。
    await act(async () => {
      click("policy-save");
      await Promise.resolve();
    });
    const setCall = calls.find((c) => c.url.endsWith("/set"));
    expect(setCall?.init?.method).toBe("POST");
    const body = JSON.parse(setCall!.init!.body!) as { enabled: boolean; categories: string[] };
    expect(body.enabled).toBe(true);
    expect(body.categories).toContain("disk-destroy");
    expect(body.categories).toContain("recursive-rm");
  });

  it("envGateEnabled=false で警告 banner を出す", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({ enabled: true, categories: ["recursive-rm"], env_gate_enabled: false }),
        ),
      ),
    );
    await renderPanel();
    await act(async () => {
      click("policy-load");
      await Promise.resolve();
    });
    expect(ctx.rootEl.querySelector('[data-testid="policy-env-disabled"]')).not.toBeNull();
  });
});
