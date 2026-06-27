/**
 * kit/Modal の a11y/挙動契約 (設計裁定 019eb981).
 *
 * ネイティブ `<dialog>` ベース:
 *  - dialog 要素で描画され aria-labelledby/aria-modal を持つ (jsdom + react-dom/client)。
 *  - showModal() が呼ばれる (open=true)・close() が呼ばれる (open=false)。
 *  - Esc (dialog cancel イベント) で onClose が 1 回呼ばれる。
 *  - backdrop クリック (target===dialog) で onClose、本文クリックでは閉じない。
 *  - 閉じたとき open 直前の activeElement へフォーカスを返す。
 * ソース走査: showModal/close/onCancel が実装に存在すること (jsdom 非対応 API の退行検出)。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Modal } from "../../src/ui/kit/Modal.js";

let dom: import("jsdom").JSDOM | undefined;

interface DomCtx {
  root: Root;
  doc: Document;
  win: Window & typeof globalThis;
  teardown: () => Promise<void>;
}

async function mountDom(): Promise<DomCtx> {
  const { JSDOM } = await import("jsdom");
  dom = new JSDOM(
    '<!doctype html><body><button id="opener">opener</button><div id="root"></div></body>',
  );
  const reactGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const prev = {
    act: reactGlobal.IS_REACT_ACT_ENVIRONMENT,
    window: globalThis.window,
    document: globalThis.document,
    Event: globalThis.Event,
    Element: globalThis.Element,
    HTMLElement: globalThis.HTMLElement,
    HTMLDialogElement: globalThis.HTMLDialogElement,
    MouseEvent: globalThis.MouseEvent,
  };
  reactGlobal.IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.window = dom.window as unknown as Window & typeof globalThis;
  globalThis.document = dom.window.document;
  globalThis.Event = dom.window.Event as typeof Event;
  globalThis.Element = dom.window.Element as typeof Element;
  globalThis.HTMLElement = dom.window.HTMLElement as typeof HTMLElement;
  globalThis.HTMLDialogElement = dom.window.HTMLDialogElement as typeof HTMLDialogElement;
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
    globalThis.HTMLDialogElement = prev.HTMLDialogElement;
    globalThis.MouseEvent = prev.MouseEvent;
    reactGlobal.IS_REACT_ACT_ENVIRONMENT = prev.act;
    dom?.window.close();
    dom = undefined;
  };
  return {
    root,
    doc: dom.window.document,
    win: dom.window as unknown as Window & typeof globalThis,
    teardown,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("kit/Modal — native dialog a11y", () => {
  let ctx: DomCtx;
  beforeEach(async () => {
    ctx = await mountDom();
  });
  afterEach(async () => {
    await ctx.teardown();
  });

  function dialogEl(): HTMLDialogElement | null {
    return ctx.doc.querySelector("dialog");
  }

  it("dialog 要素 + aria-labelledby/aria-modal で描画", async () => {
    await act(async () => {
      ctx.root.render(
        <Modal open onClose={() => {}} titleId="t-1">
          <h2 id="t-1">タイトル</h2>
        </Modal>,
      );
    });
    const d = dialogEl();
    expect(d).not.toBeNull();
    expect(d!.getAttribute("aria-labelledby")).toBe("t-1");
    expect(d!.getAttribute("aria-modal")).toBe("true");
  });

  it("open=true で showModal()、open=false で close() を呼ぶ", async () => {
    // jsdom 27 は HTMLDialogElement.prototype に showModal/close を実装しないため、
    // 実ブラウザ相当の API をプロトタイプへ定義してから spy する (open 属性も同期する)。
    const proto = ctx.win.HTMLDialogElement.prototype as HTMLDialogElement & {
      showModal: () => void;
      close: () => void;
    };
    proto.showModal = function (this: HTMLDialogElement) {
      this.setAttribute("open", "");
    };
    proto.close = function (this: HTMLDialogElement) {
      this.removeAttribute("open");
    };
    const showSpy = vi.spyOn(proto, "showModal");
    const closeSpy = vi.spyOn(proto, "close");

    function Wrapper({ open }: { open: boolean }) {
      return (
        <Modal open={open} onClose={() => {}} titleId="t-2">
          <h2 id="t-2">x</h2>
        </Modal>
      );
    }
    await act(async () => {
      ctx.root.render(<Wrapper open />);
    });
    expect(showSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      ctx.root.render(<Wrapper open={false} />);
    });
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("Esc (cancel イベント) で onClose を呼ぶ", async () => {
    const onClose = vi.fn();
    await act(async () => {
      ctx.root.render(
        <Modal open onClose={onClose} titleId="t-3">
          <h2 id="t-3">x</h2>
        </Modal>,
      );
    });
    const d = dialogEl()!;
    await act(async () => {
      d.dispatchEvent(new ctx.win.Event("cancel", { cancelable: true, bubbles: false }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("backdrop クリック (target===dialog) で閉じ、本文クリックでは閉じない", async () => {
    const onClose = vi.fn();
    await act(async () => {
      ctx.root.render(
        <Modal open onClose={onClose} titleId="t-4">
          <h2 id="t-4">x</h2>
          <button id="inner">inner</button>
        </Modal>,
      );
    });
    const d = dialogEl()!;
    // 本文 (panel 内) クリック → 閉じない。
    const inner = ctx.doc.getElementById("inner")!;
    await act(async () => {
      inner.dispatchEvent(new ctx.win.MouseEvent("click", { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();
    // dialog 自身 (backdrop 相当) クリック → 閉じる。
    await act(async () => {
      d.dispatchEvent(new ctx.win.MouseEvent("click", { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("閉じたとき open 直前の activeElement へフォーカスを返す", async () => {
    const opener = ctx.doc.getElementById("opener") as HTMLButtonElement;
    opener.focus();
    expect(ctx.doc.activeElement).toBe(opener);

    function Wrapper({ open }: { open: boolean }) {
      return (
        <Modal open={open} onClose={() => {}} titleId="t-5">
          <h2 id="t-5">x</h2>
        </Modal>
      );
    }
    await act(async () => {
      ctx.root.render(<Wrapper open />);
    });
    // 閉じる → opener へフォーカスが返る。
    await act(async () => {
      ctx.root.render(<Wrapper open={false} />);
    });
    expect(ctx.doc.activeElement).toBe(opener);
  });
});

describe("kit/Modal — source contract (jsdom 非対応 API 退行検出)", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../../src/ui/kit/Modal.tsx", import.meta.url)),
    "utf8",
  );
  it("showModal / close / onCancel を使い aria-labelledby を結ぶ", () => {
    expect(src).toContain("showModal");
    expect(src).toContain(".close(");
    expect(src).toContain("onCancel");
    expect(src).toContain("aria-labelledby");
  });
});
