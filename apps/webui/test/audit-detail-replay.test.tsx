/**
 * 監査詳細モーダルの「このセッションを再生」導線 (調査 → Replay 直結)。
 * ユーザー指摘: Replay が構造的に遠い (調査面=監査からセッションへ飛べない)。
 * AuditDetailModal は onReplay を渡されたときだけ Replay ボタンを出し、押下で当該 session_id を
 * 渡してモーダルを閉じる。CockpitBoard 側がそれを board+Replay へ deep-link する。
 */
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuditDetailModal } from "../src/ui/AuditDetailModal.js";

describe("AuditDetailModal の Replay 導線 (静的)", () => {
  it("onReplay 指定 + sessionId ありで Replay ボタンを出す", () => {
    const html = renderToStaticMarkup(
      <AuditDetailModal sessionId="s-123" onClose={() => {}} onReplay={() => {}} />,
    );
    expect(html).toContain('data-testid="audit-detail-replay"');
    expect(html).toContain("このセッションを再生");
  });

  it("onReplay 未指定なら Replay ボタンを出さない (既存の監査専用利用を壊さない)", () => {
    const html = renderToStaticMarkup(<AuditDetailModal sessionId="s-123" onClose={() => {}} />);
    expect(html).not.toContain('data-testid="audit-detail-replay"');
    // 閉じる導線は常にある。
    expect(html).toContain('data-testid="audit-detail-close"');
  });

  it("sessionId が null (閉) のときはボタンを描かない", () => {
    const html = renderToStaticMarkup(
      <AuditDetailModal sessionId={null} onClose={() => {}} onReplay={() => {}} />,
    );
    expect(html).not.toContain('data-testid="audit-detail-replay"');
  });
});

describe("AuditDetailModal の Replay 導線 (クリック配線)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // jsdom は heavy module (実測 import ~290ms・CI 負荷下では倍化しうる)。テスト本体で
  // `await import("jsdom")` すると testTimeout(5s) 枠内に module compile を抱え、CI runner の
  // CPU 競合で 5s を超えて flake する (private CI 29160552819 で実観測: local 5/5 green・
  // 非接触 diff で 5060ms timeout = 環境 timing)。① heavy import を file の import 相へ静的化し
  // testTimeout 枠外へ出す (本体は render+click+assert ~20ms のみ) + ② 明示 testTimeout を保険に張る。
  // assert (onReplay(sessionId)/onClose 呼出し検証) は不変 — 配線を壊せば依然 RED。
  it("Replay 押下で onReplay(sessionId) と onClose を呼ぶ", async () => {
    const dom = new JSDOM('<!doctype html><div id="root"></div>');
    const reactGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const prev = {
      act: reactGlobal.IS_REACT_ACT_ENVIRONMENT,
      window: globalThis.window,
      document: globalThis.document,
      Event: globalThis.Event,
      Element: globalThis.Element,
      HTMLElement: globalThis.HTMLElement,
      fetch: globalThis.fetch,
    };
    reactGlobal.IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.window = dom.window as unknown as Window & typeof globalThis;
    globalThis.document = dom.window.document;
    globalThis.Event = dom.window.Event as typeof Event;
    globalThis.Element = dom.window.Element as typeof Element;
    globalThis.HTMLElement = dom.window.HTMLElement as typeof HTMLElement;
    // 詳細 fetch は本テストの対象外。ヘッダー Replay ボタンは summary 非依存で出るため、
    // ネットワークへ出ないよう reject で握り潰す (component は catch して setError するだけ)。
    globalThis.fetch = vi.fn(() => Promise.reject(new Error("no network in test"))) as never;

    const rootEl = dom.window.document.getElementById("root");
    if (!rootEl) throw new Error("missing root");
    const root = createRoot(rootEl);
    const onReplay = vi.fn();
    const onClose = vi.fn();

    try {
      await act(async () => {
        root.render(
          <AuditDetailModal sessionId="sess-xyz" onClose={onClose} onReplay={onReplay} />,
        );
      });
      const btn = dom.window.document.querySelector<HTMLButtonElement>(
        '[data-testid="audit-detail-replay"]',
      );
      if (!btn) throw new Error("replay button not rendered");
      await act(async () => {
        btn.click();
      });
      expect(onReplay).toHaveBeenCalledWith("sess-xyz");
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
      globalThis.window = prev.window;
      globalThis.document = prev.document;
      globalThis.Event = prev.Event;
      globalThis.Element = prev.Element;
      globalThis.HTMLElement = prev.HTMLElement;
      globalThis.fetch = prev.fetch;
      reactGlobal.IS_REACT_ACT_ENVIRONMENT = prev.act;
      dom.window.close();
    }
  }, 15_000);
});
