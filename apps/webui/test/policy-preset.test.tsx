/**
 * ADR 019f23e1 (P3): PolicyPresetSelector + 2 パネルへの preset 配線 INV。
 *
 * pure-expand を UI 層で固定する (falsifiable):
 *  - matchPreset 逆引きバッジ: draftCats が strict/balanced/demo に厳密一致でその preset 名・不一致で custom。
 *  - preset ボタン click → onApply(presetCategories(name)) (既存 set 経路へ closed-enum を渡す)。
 *  - PolicySettingsPanel: load 後に Demo ボタン click → save POST body categories == demo 集合。
 *  - looser 警告: demo (Balanced より緩い) 適用で警告・balanced では出ない。
 *  - enforcement scope 注記が常時描画される (honest support-matrix・overclaim しない)。
 *  - NO-RAW: 生コマンド/preset 名リテラルの secret 様値が描画に混ざらない (closed-enum ラベルのみ)。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POLICY_PRESETS, presetCategories, type PolicyCategory } from "@actradeck/event-model";

import { ApprovalPolicyView } from "../src/ui/ApprovalPolicyView";
import { FixedLocaleProvider } from "../src/ui/LocaleProvider";
import { PolicyPresetSelector } from "../src/ui/PolicyPresetSelector";
import { PolicySettingsPanel } from "../src/ui/PolicySettingsPanel";

function renderStatic(node: React.ReactNode, locale: "ja" | "en" = "ja"): string {
  return renderToStaticMarkup(<FixedLocaleProvider locale={locale}>{node}</FixedLocaleProvider>);
}

describe("PolicyPresetSelector 静的描画 (matchPreset バッジ / looser / enforcement)", () => {
  function selector(
    cats: readonly PolicyCategory[],
    enabled = true,
    prefix: "policy" | "approvalPolicy" = "policy",
  ) {
    return (
      <PolicyPresetSelector
        prefix={prefix}
        draftCats={new Set(cats)}
        draftEnabled={enabled}
        onApply={() => {}}
      />
    );
  }

  it("3 preset ボタン (strict/balanced/demo) と enforcement 注記を描く", () => {
    const html = renderStatic(selector(POLICY_PRESETS.balanced));
    expect(html).toContain('data-testid="policy-preset-strict"');
    expect(html).toContain('data-testid="policy-preset-balanced"');
    expect(html).toContain('data-testid="policy-preset-demo"');
    // enforcement scope は常時開示 (Managed のみ予防・Attach 観測のみ・Codex rollout 検知のみ)。
    expect(html).toContain('data-testid="policy-enforcement-scope"');
    expect(html).toContain("Managed");
  });

  it("strict 一致 → バッジ Strict・looser 警告なし", () => {
    const html = renderStatic(selector(POLICY_PRESETS.strict));
    expect(html).toContain('data-testid="policy-preset-badge"');
    expect(html).toContain("Strict");
    expect(html).not.toContain('data-testid="policy-preset-looser"');
  });

  it("balanced 一致 → バッジ Balanced・looser 警告なし", () => {
    const html = renderStatic(selector(POLICY_PRESETS.balanced));
    expect(html).toContain("Balanced");
    expect(html).not.toContain('data-testid="policy-preset-looser"');
  });

  it("demo 一致 → バッジ Demo・looser 警告あり (Balanced より緩い)", () => {
    const html = renderStatic(selector(POLICY_PRESETS.demo));
    expect(html).toContain("Demo");
    expect(html).toContain('data-testid="policy-preset-looser"');
  });

  it("どの preset とも不一致 → custom バッジ", () => {
    // balanced + perm-change = どの preset とも不一致。
    const html = renderStatic(selector([...POLICY_PRESETS.balanced, "perm-change"]));
    expect(html).toContain("カスタム"); // ja custom
  });

  it("無効化 (draftEnabled=false) は looser 警告を出す (素通し方向)", () => {
    const html = renderStatic(selector(POLICY_PRESETS.strict, false));
    expect(html).toContain('data-testid="policy-preset-looser"');
  });

  it("en: 英語ラベルが出てハードコード日本語が漏れない", () => {
    const html = renderStatic(selector(POLICY_PRESETS.demo, true, "approvalPolicy"), "en");
    expect(html).toContain("Demo");
    expect(html).toContain("Managed");
    expect(html).not.toMatch(/[ぁ-んァ-ン一-龥]/);
  });

  it("NO-RAW: 描画は静的 i18n ラベル + closed-enum のみで secret 様値を持たない", () => {
    // 注: demo サマリは「rm -rf / ディスク破壊」等を **説明文** として含む (静的 i18n・意図的)。
    // NO-RAW が禁じるのは wire/event 由来の生 command/secret の混入であり、それを sentinel で確認する。
    const html = renderStatic(selector(POLICY_PRESETS.strict));
    expect(html).not.toContain("AKIA");
    expect(html).not.toContain("ghp_");
    // preset 名 (strict/balanced/demo リテラル) は data-testid/enum 由来のみ。生 categories 値は描画しない。
    expect(html).not.toContain("policy.preset."); // i18n キーが未解決で漏れていない。
  });
});

// ── jsdom interaction: preset click が既存 set 経路へ presetCategories を渡すこと ──

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

describe("PolicyPresetSelector onApply → presetCategories", () => {
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

  it("Demo ボタン click で onApply(presetCategories('demo')) が呼ばれる", async () => {
    const applied: PolicyCategory[][] = [];
    await act(async () => {
      ctx.root.render(
        <FixedLocaleProvider locale="ja">
          <PolicyPresetSelector
            prefix="policy"
            draftCats={new Set(POLICY_PRESETS.balanced)}
            draftEnabled
            onApply={(c) => applied.push(c)}
          />
        </FixedLocaleProvider>,
      );
    });
    await act(async () => {
      click("policy-preset-demo");
      await Promise.resolve();
    });
    expect(applied).toHaveLength(1);
    expect([...applied[0]!].sort()).toEqual([...presetCategories("demo")].sort());
  });
});

describe("PolicySettingsPanel: preset 適用 → 既存 save POST が presetCategories を送る", () => {
  let ctx: DomCtx;
  beforeEach(async () => {
    ctx = await mountDom();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await ctx.teardown();
  });

  function click(testid: string): void {
    const el = ctx.rootEl.querySelector(`[data-testid="${testid}"]`);
    if (!el) throw new Error(`no element ${testid}`);
    el.dispatchEvent(new dom!.window.MouseEvent("click", { bubbles: true }));
  }

  it("load → Strict ボタン → save で POST body categories == strict 集合", async () => {
    const calls: Array<{ url: string; init?: { method?: string; body?: string } }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: { method?: string; body?: string }) => {
        calls.push({ url, ...(init ? { init } : {}) });
        return Promise.resolve(
          jsonResponse({
            enabled: true,
            categories: url.endsWith("/set") ? [...POLICY_PRESETS.strict] : ["recursive-rm"],
            env_gate_enabled: true,
          }),
        );
      }),
    );
    await act(async () => {
      ctx.root.render(
        <FixedLocaleProvider locale="ja">
          <PolicySettingsPanel sessionId="s1" />
        </FixedLocaleProvider>,
      );
    });
    await act(async () => {
      click("policy-load");
      await Promise.resolve();
    });
    // preset セレクタが描画されている (加法)。checkbox 群も残る。
    expect(ctx.rootEl.querySelector('[data-testid="policy-preset"]')).not.toBeNull();
    expect(ctx.rootEl.querySelector('[data-testid="policy-categories"]')).not.toBeNull();
    await act(async () => {
      click("policy-preset-strict");
      await Promise.resolve();
    });
    await act(async () => {
      click("policy-save");
      await Promise.resolve();
    });
    const setCall = calls.find((c) => c.url.endsWith("/set"));
    expect(setCall?.init?.method).toBe("POST");
    const body = JSON.parse(setCall!.init!.body!) as { categories: string[] };
    expect([...body.categories].sort()).toEqual([...presetCategories("strict")].sort());
  });
});

describe("ApprovalPolicyView (per-repo): Default に preset 適用 → 既存 save が presetCategories を送る", () => {
  let ctx: DomCtx;
  beforeEach(async () => {
    ctx = await mountDom();
    globalThis.localStorage?.clear?.();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await ctx.teardown();
  });

  function click(testid: string): void {
    const el = ctx.rootEl.querySelector(`[data-testid="${testid}"]`);
    if (!el) throw new Error(`no element ${testid}`);
    el.dispatchEvent(new dom!.window.MouseEvent("click", { bubbles: true }));
  }

  it("session relay で list 取得 → Demo ボタン → save POST body categories == demo・looser 警告表示", async () => {
    const LIST_BODY = {
      enabled: true,
      categories: [...POLICY_PRESETS.balanced],
      env_gate_enabled: true,
      repos: [],
    };
    const calls: Array<{ url: string; init?: { method?: string; body?: string } }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: { method?: string; body?: string }) => {
        calls.push({ url, ...(init ? { init } : {}) });
        // set 応答は list 形状を返す (reload と両立)。
        return Promise.resolve(jsonResponse(LIST_BODY));
      }),
    );
    await act(async () => {
      ctx.root.render(
        <FixedLocaleProvider locale="ja">
          <ApprovalPolicyView active relayTarget={{ kind: "session", id: "s1" }} nowMs={1000} />
        </FixedLocaleProvider>,
      );
      // auto-reload (mount useEffect) を解決。
      await Promise.resolve();
      await Promise.resolve();
    });
    // Default 選択で preset セレクタが detail に描画される。
    expect(ctx.rootEl.querySelector('[data-testid="policy-preset"]')).not.toBeNull();
    await act(async () => {
      click("policy-preset-demo");
      await Promise.resolve();
    });
    // demo は Balanced より緩い → looser 警告。
    expect(ctx.rootEl.querySelector('[data-testid="policy-preset-looser"]')).not.toBeNull();
    await act(async () => {
      click("policyview-save");
      await Promise.resolve();
    });
    const setCall = calls.find((c) => c.url.endsWith("/set"));
    expect(setCall?.init?.method).toBe("POST");
    const body = JSON.parse(setCall!.init!.body!) as { categories: string[]; repo_scope?: string };
    expect([...body.categories].sort()).toEqual([...presetCategories("demo")].sort());
    // Default scope ゆえ repo_scope は載らない (machine baseline)。
    expect(body.repo_scope).toBeUndefined();
  });
});
