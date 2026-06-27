/**
 * @vitest-environment jsdom
 *
 * 通知 permission の gesture 不変条件 + 設定永続 (jsdom + fake notifier).
 *
 * INV-NOTIFY-PERMISSION-ON-GESTURE: requestPermission は requestEnable (ユーザー操作ハンドラ) からのみ
 *   呼ばれ、mount(フック初期化) では呼ばれない。
 *
 * テスト用の最小 renderHook (react-dom/client + act)。@testing-library に依存しない。
 */
import { act } from "react";
import { createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LocaleProvider } from "../src/ui/LocaleProvider.js";
import { useNotifications } from "../src/ui/use-notifications.js";
import type { Notifier } from "../src/ui/notifications.js";
import type { SessionListItem } from "../src/realtime/contract.js";

// React 19 act() の環境フラグ。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface HookHandle<T> {
  current: T;
  rerender: () => void;
  unmount: () => void;
}

function renderHook<T>(useHook: () => T): HookHandle<T> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const handle: HookHandle<T> = {
    current: undefined as unknown as T,
    rerender: () => {},
    unmount: () => {},
  };
  function Probe({ children }: { children: ReactNode }) {
    return createElement(LocaleProvider, null, children);
  }
  function Capture() {
    handle.current = useHook();
    return null;
  }
  const render = () =>
    act(() => {
      root.render(createElement(Probe, null, createElement(Capture, null)));
    });
  render();
  handle.rerender = render;
  handle.unmount = () =>
    act(() => {
      root.unmount();
    });
  return handle;
}

function fakeNotifier(
  initial: NotificationPermission,
  granted: NotificationPermission = initial,
): {
  notifier: Notifier;
  requestSpy: ReturnType<typeof vi.fn>;
  shown: { count: number };
} {
  const shown = { count: 0 };
  // requestPermission を呼ぶと permission が `granted` 引数の値へ遷移する（実ブラウザ挙動の模倣）。
  let current = initial;
  const requestSpy = vi.fn(async () => {
    current = granted;
    return current;
  });
  const notifier: Notifier = {
    get permission() {
      return current;
    },
    show() {
      shown.count += 1;
    },
    requestPermission: requestSpy,
  };
  return { notifier, requestSpy, shown };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useNotifications — permission on gesture", () => {
  it("INV-NOTIFY-PERMISSION-ON-GESTURE: mount では requestPermission を呼ばない", () => {
    const { notifier, requestSpy } = fakeNotifier("default");
    const h = renderHook(() => useNotifications({ notifier }));
    expect(requestSpy).not.toHaveBeenCalled();
    // mount 後の設定は既定 (全 false)。
    expect(h.current.settings.enabled).toBe(false);
    h.unmount();
  });

  it("requestEnable(ユーザー操作) で requestPermission を呼び、granted なら enabled=true", async () => {
    const { notifier, requestSpy } = fakeNotifier("default", "granted");
    const h = renderHook(() => useNotifications({ notifier }));
    await act(async () => {
      await h.current.requestEnable();
    });
    expect(requestSpy).toHaveBeenCalledTimes(1);
    expect(h.current.settings.enabled).toBe(true);
    // 既定で全カテゴリ on。
    expect(h.current.settings.categories).toEqual({
      approval: true,
      stalled: true,
      failed: true,
    });
    h.unmount();
  });

  it("denied のままなら enabled=false に留める (安全側)", async () => {
    const { notifier, requestSpy } = fakeNotifier("denied");
    const h = renderHook(() => useNotifications({ notifier }));
    await act(async () => {
      await h.current.requestEnable();
    });
    // permission が既に denied なら requestPermission は呼ばない (prompt 再要求しない)。
    expect(requestSpy).not.toHaveBeenCalled();
    expect(h.current.settings.enabled).toBe(false);
    h.unmount();
  });

  it("permission=granted を localStorage 永続して再 mount で復元する", async () => {
    const a = fakeNotifier("granted");
    const h1 = renderHook(() => useNotifications({ notifier: a.notifier }));
    await act(async () => {
      await h1.current.requestEnable();
    });
    expect(h1.current.settings.enabled).toBe(true);
    h1.unmount();

    // 再 mount: localStorage から復元 (granted なので requestPermission は不要)。
    const b = fakeNotifier("granted");
    const h2 = renderHook(() => useNotifications({ notifier: b.notifier }));
    expect(h2.current.settings.enabled).toBe(true);
    expect(b.requestSpy).not.toHaveBeenCalled();
    h2.unmount();
  });

  it("notify は granted+enabled+hidden で show を呼び、visible では呼ばない", async () => {
    const { notifier, shown } = fakeNotifier("granted");
    const hiddenSpy = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const h = renderHook(() => useNotifications({ notifier }));
    await act(async () => {
      await h.current.requestEnable(); // granted → enabled=true, 全カテゴリ on。
    });
    act(() => {
      h.current.notify(baseItem({ needs_attention: false }), baseItem({ needs_attention: true }));
    });
    expect(shown.count).toBe(1);

    // タブ前面 (hidden=false) では発火しない (INV-NOTIFY-SUPPRESS-VISIBLE の hook 経路)。
    hiddenSpy.mockReturnValue(false);
    act(() => {
      h.current.notify(
        baseItem({ session_id: "s-1111111111", needs_attention: false }),
        baseItem({ session_id: "s-1111111111", needs_attention: true }),
      );
    });
    expect(shown.count).toBe(1);

    hiddenSpy.mockRestore();
    h.unmount();
  });
});

// notify 用の最小 item。
function baseItem(over: Partial<SessionListItem> = {}): SessionListItem {
  return {
    session_id: "s-0000000000",
    provider: "claude_code",
    source: "hook",
    agent_id: undefined,
    repo: "acme/app",
    branch: "main",
    cwd: "/w",
    state: "running.command_executing",
    current_action: undefined,
    last_event_at: "2026-06-15T00:00:00.000Z",
    needs_attention: false,
    liveness_state: "live",
    stalled_suspected: false,
    connected: true,
    ...over,
  };
}
