import { newEventId } from "@actradeck/event-model";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SessionReplayPanel } from "../src/ui/SessionReplay.js";

import type { ReplayEventDTO } from "../src/realtime/contract.js";

function ev(o: Partial<ReplayEventDTO> = {}): ReplayEventDTO {
  return {
    event_id: newEventId(),
    provider: "claude_code",
    source: "hooks",
    session_id: "s1",
    event_type: "heartbeat",
    kind: "liveness",
    timestamp: "2026-06-06T00:00:00.000Z",
    state: undefined,
    cwd: undefined,
    summary: "alive",
    display_text: "alive",
    subject: undefined,
    request_id: undefined,
    tool_name: undefined,
    command: undefined,
    path: undefined,
    risk_level: undefined,
    decision: undefined,
    auto_allowed: undefined,
    exit_code: undefined,
    elapsed_ms: undefined,
    ...o,
  };
}

describe("SessionReplayPanel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders controls, scrubber, timeline, and reconstructed state", () => {
    const html = renderToStaticMarkup(
      <SessionReplayPanel
        sessionId="s1"
        events={[
          ev({ event_type: "session.started", kind: "session", state: "starting" }),
          ev({
            event_type: "command.started",
            kind: "command",
            state: "running.command_executing",
            timestamp: "2026-06-06T00:00:01.000Z",
            display_text: "npm test",
            command: "npm test",
          }),
        ]}
        index={1}
        playing={false}
        speed={1}
        hasMore={false}
        loading={false}
      />,
    );
    expect(html).toContain('data-testid="session-replay"');
    expect(html).toContain('data-testid="replay-play"');
    expect(html).toContain('data-testid="replay-scrubber"');
    // イベントリストはアクション単位ビューへ刷新 (設計裁定 019eb981)。
    expect(html).toContain('data-testid="action-timeline"');
    expect(html).toContain("running.command_executing");
    expect(html).toContain("npm test");
  });

  it("再生対象セッションの識別 (repo@branch / provider / cwd / session) をヘッダーに出す", () => {
    const html = renderToStaticMarkup(
      <SessionReplayPanel
        sessionId="abcdef0123456789"
        identity={{
          repo: "acme/web",
          branch: "main",
          provider: "codex",
          cwd: "/home/alice/acme/web",
        }}
        events={[ev()]}
        index={0}
        playing={false}
        speed={1}
        hasMore={false}
        loading={false}
      />,
    );
    expect(html).toContain('data-testid="replay-identity"');
    expect(html).toContain("acme/web");
    expect(html).toContain("@main");
    // identity.provider が events[0].provider(claude_code) より優先される。
    expect(html).toContain("codex");
    // cwd はホーム配下を ~ に畳み、full path は title 属性で出す。
    expect(html).toContain("~/acme/web");
    expect(html).toContain('title="/home/alice/acme/web"');
    // session 短縮 id (先頭 12 桁)。
    expect(html).toContain("abcdef012345");
  });

  it("identity 未指定でも events[0] から provider/cwd を補完する (detail 未取得 fallback)", () => {
    const html = renderToStaticMarkup(
      <SessionReplayPanel
        sessionId="zzzzzzzzzzzzzzzz"
        events={[ev({ provider: "claude_code", cwd: "/root/proj" })]}
        index={0}
        playing={false}
        speed={1}
        hasMore={false}
        loading={false}
      />,
    );
    expect(html).toContain('data-testid="replay-identity"');
    expect(html).toContain("claude_code");
    expect(html).toContain("~/proj");
  });

  it("renders empty/loading and load-more states", () => {
    const loading = renderToStaticMarkup(
      <SessionReplayPanel
        sessionId="s1"
        events={[]}
        index={-1}
        playing={false}
        speed={1}
        hasMore={false}
        loading
      />,
    );
    expect(loading).toContain('data-testid="replay-loading"');

    const more = renderToStaticMarkup(
      <SessionReplayPanel
        sessionId="s1"
        events={[ev()]}
        index={0}
        playing={false}
        speed={2}
        hasMore
        loading={false}
      />,
    );
    expect(more).toContain('data-testid="replay-load-more"');
    expect(more).toContain("2x");
  });

  it("wires step, speed, play, load-more; 行クリックは seek でなく詳細モーダルを開く", async () => {
    const { JSDOM } = await import("jsdom");
    const dom = new JSDOM('<!doctype html><div id="root"></div>');
    const reactGlobal = globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    };
    const previousActEnv = reactGlobal.IS_REACT_ACT_ENVIRONMENT;
    const previousWindow = globalThis.window;
    const previousDocument = globalThis.document;
    const previousEvent = globalThis.Event;
    const previousElement = globalThis.Element;
    const previousHTMLElement = globalThis.HTMLElement;
    reactGlobal.IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.window = dom.window as unknown as Window & typeof globalThis;
    globalThis.document = dom.window.document;
    globalThis.Event = dom.window.Event as typeof Event;
    globalThis.Element = dom.window.Element as typeof Element;
    globalThis.HTMLElement = dom.window.HTMLElement as typeof HTMLElement;
    const rootEl = dom.window.document.getElementById("root");
    if (!rootEl) throw new Error("missing root");
    const root = createRoot(rootEl);
    const onSeek = vi.fn();
    const onStep = vi.fn();
    const onPlayPause = vi.fn();
    const onSpeed = vi.fn();
    const onLoadMore = vi.fn();

    try {
      await act(async () => {
        root.render(
          <SessionReplayPanel
            sessionId="s1"
            events={[
              ev({
                event_id: "ev-1",
                event_type: "session.started",
                kind: "session",
                state: "starting",
              }),
              ev({
                event_id: "ev-2",
                event_type: "command.started",
                kind: "command",
                state: "running.command_executing",
                timestamp: "2026-06-06T00:00:01.000Z",
                display_text: "npm test",
              }),
            ]}
            index={0}
            playing={false}
            speed={1}
            hasMore
            loading={false}
            onSeek={onSeek}
            onStep={onStep}
            onPlayPause={onPlayPause}
            onSpeed={onSpeed}
            onLoadMore={onLoadMore}
          />,
        );
      });

      await act(async () => {
        rootEl.querySelector<HTMLButtonElement>('[data-testid="replay-step-next"]')?.click();
        rootEl.querySelector<HTMLButtonElement>('[data-testid="replay-step-back"]')?.click();
        rootEl.querySelector<HTMLButtonElement>('[data-testid="replay-play"]')?.click();
        rootEl.querySelector<HTMLButtonElement>('[data-testid="replay-load-more"]')?.click();
        // 設計裁定 019eb981: 行クリックは seek でなく **詳細モーダル** を開く。
        // アクション行をクリックしても onSeek を呼ばないこと (seek はスクラバー専任) を固定する。
        rootEl.querySelector<HTMLButtonElement>(".ad-action-row__btn")?.click();
        const speed = rootEl.querySelector<HTMLSelectElement>('[data-testid="replay-speed"]');
        if (!speed) throw new Error("missing speed");
        speed.value = "4";
        speed.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      });

      expect(onStep.mock.calls).toEqual([[1], [-1]]);
      expect(onPlayPause).toHaveBeenCalledTimes(1);
      expect(onLoadMore).toHaveBeenCalledTimes(1);
      // 行クリックは seek を呼ばない (詳細モーダルを開く挙動へ変更)。
      expect(onSeek).not.toHaveBeenCalled();
      // 行クリックで詳細モーダルが開く (dialog に本文 panel が出る)。
      expect(
        rootEl.querySelector('[data-testid="action-detail-modal"] .ad-modal__panel'),
      ).not.toBeNull();
      expect(onSpeed).toHaveBeenCalledWith(4);

      // QA-1 (decision 019eb9a0): 行クリック=seek の廃止後も、seek 導線=スクラバーが
      // onSeek を駆動することを固定する (静的存在チェックでは RangeSlider→onSeek 配線の
      // 断線を検出できない)。
      // 注: この harness (node env + 手動 JSDOM) では dispatch した input/change を React の
      // ChangeEventPlugin が onChange へ合成しない (onInput は届くが onChange 不発。value
      // tracker の強制差分でも不発を実測)。React のイベント配送は React 自身の保証領域なので
      // 再検証せず、実マウント済みノードに React が付与した **本物の onChange ハンドラ** を
      // props 経由で直接起動し、production の配線 (onChange→onSeek(Number(value))) を pin する。
      const scrubber = rootEl.querySelector<HTMLInputElement>('[data-testid="replay-scrubber"]');
      if (!scrubber) throw new Error("missing scrubber");
      const reactPropsKey = Object.keys(scrubber).find((k) => k.startsWith("__reactProps$"));
      if (!reactPropsKey) throw new Error("missing react props on scrubber");
      const scrubberProps = (scrubber as unknown as Record<string, unknown>)[reactPropsKey] as {
        onChange?: (e: { currentTarget: { value: string } }) => void;
      };
      if (typeof scrubberProps.onChange !== "function") {
        throw new Error("scrubber onChange is not wired");
      }
      await act(async () => {
        scrubberProps.onChange?.({ currentTarget: { value: "1" } });
      });
      expect(onSeek).toHaveBeenCalledWith(1);
    } finally {
      await act(async () => root.unmount());
      globalThis.window = previousWindow;
      globalThis.document = previousDocument;
      globalThis.Event = previousEvent;
      globalThis.Element = previousElement;
      globalThis.HTMLElement = previousHTMLElement;
      reactGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnv;
      dom.window.close();
    }
  });
});
