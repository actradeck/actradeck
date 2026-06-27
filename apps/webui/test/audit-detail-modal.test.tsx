/**
 * INV-AUDIT-DETAIL-MODAL (QA-3): AuditDetailModal の描画 / lifecycle 不変条件。
 *
 * use-allowlist.test.tsx と同型 (jsdom + createRoot + act・fetch を vi 制御)。固定する性質 (falsifiable):
 *  - per-session detail を pull し、承認タイムラインに **redaction 済み command** と tool_name を描画する。
 *  - command も path も無い承認は command 行 (.ad-audit-detail__cmd) を描かない。
 *  - sessionId=null (閉) で pull 済み summary を破棄する (command が DOM から消える = メモリ衛生)。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuditDetailModal } from "../src/ui/AuditDetailModal";
import { FixedLocaleProvider } from "../src/ui/LocaleProvider";

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

/** command(e1) / path のみ(e2) / どちらも無し(e3) の 3 エントリを持つ per-session 詳細。 */
const SUMMARY = {
  session_id: "0b7df3b5-f56b-465e-a335-0b50fe769a8f",
  provider: "claude_code",
  source: "hooks",
  cwd: "/home/user/Files/Memorymcp",
  last_event_at: "2026-06-20T02:41:06.462Z",
  secret_detected: true,
  secret_redaction_count: 3,
  secret_redaction_count_by_kind: { "github-token": 2, "aws-access-key-id": 1 },
  approvals: { total: 3, by_decision: { allow_for_session: 3 }, pending: 0 },
  high_risk_op_count: 0,
  entries: [
    {
      event_id: "e1",
      timestamp: "2026-06-20T02:00:00.000Z",
      tool_name: "Bash",
      risk_level: "medium",
      command: "cd ~/Files/Memorymcp && git stash pop",
      decision: "allow_for_session",
    },
    {
      event_id: "e2",
      timestamp: "2026-06-20T02:01:00.000Z",
      tool_name: "Edit",
      risk_level: "low",
      path: "src/app.ts",
      decision: "allow_for_session",
    },
    {
      event_id: "e3",
      timestamp: "2026-06-20T02:02:00.000Z",
      tool_name: "Read",
      risk_level: "low",
      decision: "allow_for_session",
    },
  ],
};

describe("AuditDetailModal (QA-3)", () => {
  let ctx: DomCtx;

  beforeEach(async () => {
    ctx = await mountDom();
  });
  afterEach(async () => {
    await ctx.teardown();
    vi.restoreAllMocks();
  });

  async function render(sessionId: string | null): Promise<void> {
    await act(async () => {
      ctx.root.render(
        <FixedLocaleProvider locale="ja">
          <AuditDetailModal sessionId={sessionId} onClose={() => {}} />
        </FixedLocaleProvider>,
      );
      await Promise.resolve();
    });
  }

  it("per-session detail を pull し redaction 済み command/path を描画 (command/path 無しは command 行なし)", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        calls.push(url);
        return Promise.resolve(jsonResponse(SUMMARY));
      }),
    );
    await render("0b7df3b5-f56b-465e-a335-0b50fe769a8f");

    // detail endpoint を引く (token なし same-origin・encodeURIComponent)。
    expect(calls[0]).toBe("/realtime/audit/sessions/0b7df3b5-f56b-465e-a335-0b50fe769a8f");
    const html = ctx.rootEl.innerHTML;
    // 何を承認したか: redaction 済み command / path が出る。
    expect(html).toContain("cd ~/Files/Memorymcp &amp;&amp; git stash pop");
    expect(html).toContain("src/app.ts");
    expect(html).toContain("Bash");
    expect(html).toContain("Edit");
    // command も path も無い承認 (e3=Read) は command 行を描かない → cmd 行は 2 件のみ。
    const cmdCount = ctx.rootEl.querySelectorAll(".ad-audit-detail__cmd").length;
    expect(cmdCount).toBe(2);
    // タイムライン本体が描画されている。
    expect(ctx.rootEl.querySelector('[data-testid="audit-detail-timeline"]')).not.toBeNull();
  });

  it("sessionId=null (閉) で pull 済み summary を破棄する (command が DOM から消える)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(SUMMARY))),
    );
    await render("0b7df3b5-f56b-465e-a335-0b50fe769a8f");
    expect(ctx.rootEl.innerHTML).toContain("git stash pop");

    await render(null);
    // 閉後は summary 破棄 = 承認対象 command が DOM に残らない (メモリ衛生)。
    expect(ctx.rootEl.innerHTML).not.toContain("git stash pop");
  });
});

/**
 * INV-AUDIT-REDACTION-DRILLDOWN (decision 019f03cc): kind 別件数タグ → 個別発生イベント展開。
 * 固定する性質 (falsifiable):
 *  - kind 別件数は button (clickable chip)。click で当該 kind の occurrence endpoint を引く。
 *  - occurrence 一覧に redaction 済み command + per-event 件数を描く (原文非載せ)。
 *  - onJumpToReplay 供給時のみ Replay 導線を出し (sessionId, eventId) を渡す。
 *  - 同 kind 再 click で閉じる (一覧が DOM から消える)。
 */
const SID = "0b7df3b5-f56b-465e-a335-0b50fe769a8f";
const OCC_GITHUB = {
  session_id: SID,
  kind: "github-token",
  total: 2,
  limit: 200,
  has_more: false,
  occurrences: [
    {
      event_id: "ev1",
      timestamp: "2026-06-20T02:00:00.000Z",
      event_type: "command.started",
      count: 1,
      command: "git push https://[REDACTED:github-token]@github.com/o/r",
    },
    {
      event_id: "ev2",
      timestamp: "2026-06-20T02:05:00.000Z",
      event_type: "command.started",
      count: 1,
      command: "gh auth login --with-token [REDACTED:github-token]",
    },
  ],
};

/** fetch を URL でルーティング (detail vs redactions)。 */
function stubRoutedFetch(): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      calls.push(url);
      if (url.includes("/redactions?")) return Promise.resolve(jsonResponse(OCC_GITHUB));
      return Promise.resolve(jsonResponse(SUMMARY));
    }),
  );
  return { calls };
}

/** マイクロタスクを数回流して fetch→setState→再描画を確定させる。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

describe("AuditDetailModal redaction drill-down (019f03cc)", () => {
  let ctx: DomCtx;
  beforeEach(async () => {
    ctx = await mountDom();
  });
  afterEach(async () => {
    await ctx.teardown();
    vi.restoreAllMocks();
  });

  async function render(onJumpToReplay?: (s: string, e: string) => void): Promise<void> {
    await act(async () => {
      ctx.root.render(
        <FixedLocaleProvider locale="ja">
          <AuditDetailModal
            sessionId={SID}
            onClose={() => {}}
            {...(onJumpToReplay ? { onJumpToReplay } : {})}
          />
        </FixedLocaleProvider>,
      );
      await flush();
    });
  }

  function chip(kind: string): HTMLButtonElement {
    const el = ctx.rootEl.querySelector(`[data-testid="audit-kind-${kind}"]`);
    if (!el) throw new Error(`missing kind chip ${kind}`);
    return el as HTMLButtonElement;
  }

  it("kind 別件数は clickable chip・click で occurrence endpoint を引き redacted command を描く", async () => {
    const { calls } = stubRoutedFetch();
    await render();
    // 件数タグは button (kind ×n)。
    const gh = chip("github-token");
    expect(gh.tagName).toBe("BUTTON");
    expect(gh.textContent).toContain("github-token");
    expect(gh.getAttribute("aria-expanded")).toBe("false");
    // click → drill-down fetch。
    await act(async () => {
      gh.click();
      await flush();
    });
    expect(calls.some((u) => u.includes("/redactions?kind=github-token"))).toBe(true);
    expect(chip("github-token").getAttribute("aria-expanded")).toBe("true");
    const list = ctx.rootEl.querySelector('[data-testid="audit-occurrence-list"]');
    expect(list).not.toBeNull();
    const html = ctx.rootEl.innerHTML;
    // redaction 済み command + per-event 件数 (原文は含まない = マーカーのみ)。
    expect(html).toContain("git push https://[REDACTED:github-token]@github.com/o/r");
    expect(html).toContain("command.started");
    // occurrence 件数 2。
    expect(ctx.rootEl.querySelectorAll('[data-testid="audit-occurrence-list"] li').length).toBe(2);
  });

  it("onJumpToReplay 供給時のみ Replay 導線を出し (sessionId, eventId) を渡す", async () => {
    stubRoutedFetch();
    const jumps: Array<[string, string]> = [];
    await render((s, e) => jumps.push([s, e]));
    await act(async () => {
      chip("github-token").click();
      await flush();
    });
    const jumpBtn = ctx.rootEl.querySelector('[data-testid="audit-occurrence-jump-ev1"]');
    expect(jumpBtn).not.toBeNull();
    await act(async () => {
      (jumpBtn as HTMLButtonElement).click();
      await flush();
    });
    expect(jumps).toEqual([[SID, "ev1"]]);
  });

  it("onJumpToReplay 未供給なら Replay 導線を出さない", async () => {
    stubRoutedFetch();
    await render();
    await act(async () => {
      chip("github-token").click();
      await flush();
    });
    expect(ctx.rootEl.querySelector('[data-testid="audit-occurrence-jump-ev1"]')).toBeNull();
  });

  it("同 kind 再 click で occurrence 一覧を閉じる", async () => {
    stubRoutedFetch();
    await render();
    await act(async () => {
      chip("github-token").click();
      await flush();
    });
    expect(ctx.rootEl.querySelector('[data-testid="audit-occurrence-list"]')).not.toBeNull();
    await act(async () => {
      chip("github-token").click();
      await flush();
    });
    expect(ctx.rootEl.querySelector('[data-testid="audit-occurrences"]')).toBeNull();
  });
});
