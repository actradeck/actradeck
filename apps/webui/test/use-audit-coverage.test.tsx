/**
 * QA-1 ≡ TDA-4: useAuditCoverage フックの runtime を直駆動する INV (safety-demo-hook.test.tsx と同型 —
 * jsdom + createRoot + act・実フック駆動・fetch を vi 制御・fake timers)。fail-safe 分岐を falsifiable に固定:
 *
 *  (a) unmount で interval cleanup (以後 fetch しない) + in-flight resolve で setState されない (cancelled guard)。
 *  (b) `!res.ok` (5xx 等) は last-known を保持する (flicker 回避・誤って null 化しない)。
 *  (c) parse が undefined (奇形応答: generated_at 不正) でも last-known を保持する。
 *  (d) `enabled=false` → coverage を null リセットし fetch しない (非表示時メモリ衛生)。
 *  (e) enabled トグル (false→true) で再取得する。
 *
 * 受信は必ず event-model 正準 `parseAuditCoverageReportWire` を通す (NO-RAW・単一出所)。実 parser を
 * mock しない (契約検証)。fetch のみ vi 制御。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  COVERAGE_FETCH_TIMEOUT_MS,
  COVERAGE_POLL_MS,
  COVERAGE_STALE_MS,
  useAuditCoverage,
  type UseAuditCoverageResult,
} from "../src/ui/use-audit-coverage.js";
import type { AuditCoverageReport } from "@actradeck/event-model";

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

/**
 * settle しない fetch を模す。signal abort が来たときだけ AbortError で reject する
 * (= per-pull timeout が abort→reject→onStale を成立させることを検証する土台)。timeout 実装が
 * 無ければこの Promise は永久に settle せず onFresh/onStale とも呼ばれない (staleness 凍結)。
 */
function neverSettlingUnlessAborted(init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return; // signal 不在 = timeout 未配線 → 永久に settle しない (frozen)
    const fail = (): void => reject(new DOMException("aborted", "AbortError"));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

const GEN = "2026-04-02T12:00:00.000Z";
/** 妥当な wire report (parse を通ると 1 provider の coverage になる)。 */
const VALID_BODY = {
  generated_at: GEN,
  providers: [
    {
      provider: "codex",
      last_received_at: "2026-04-02T11:59:48.000Z",
      last_event_timestamp: "2026-04-02T11:59:48.000Z",
      active_session_count: 1,
      total_session_count: 1,
      gap_candidate_ms: 12_000,
    },
  ],
};

describe("useAuditCoverage runtime (QA-1 / TDA-4)", () => {
  let ctx: DomCtx;
  let tornDown: boolean;
  let latest: AuditCoverageReport | null;
  let result: UseAuditCoverageResult;

  beforeEach(async () => {
    vi.useFakeTimers();
    ctx = await mountDom();
    tornDown = false;
    latest = null;
  });
  afterEach(async () => {
    if (!tornDown) await ctx.teardown();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // 安定 component 識別 (再 render で hook state を保つ・render 内定義は毎回別 type で再マウントされる)。
  function Probe({ enabled }: { enabled: boolean }): null {
    result = useAuditCoverage({ enabled });
    latest = result.coverage;
    return null;
  }
  async function render(enabled: boolean): Promise<void> {
    await act(async () => {
      ctx.root.render(<Probe enabled={enabled} />);
    });
  }

  it("enabled: same-origin GET (accept json) で妥当応答を parse し coverage を確立する", async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(jsonResponse(VALID_BODY)),
    );
    vi.stubGlobal("fetch", fetchMock);
    await render(true);
    await act(async () => {
      await flush();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/realtime/audit/coverage");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ accept: "application/json" });
    // GET 契約 (mutating method を送らない)。
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBeUndefined();
    expect(latest?.generated_at).toBe(GEN);
    expect(latest?.providers).toHaveLength(1);
    expect(latest?.providers[0]!.provider).toBe("codex");
  });

  it("(d) enabled=false は fetch せず coverage を null に保つ", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(VALID_BODY)));
    vi.stubGlobal("fetch", fetchMock);
    await render(false);
    await act(async () => {
      await flush();
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(latest).toBeNull();
  });

  it("(d)+(e) enabled トグル: true で取得 → false で null リセット → true で再取得", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(VALID_BODY)));
    vi.stubGlobal("fetch", fetchMock);
    await render(true);
    await act(async () => {
      await flush();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(latest?.providers).toHaveLength(1);
    // false へ: 破棄 (null リセット)・新規 fetch なし。
    await render(false);
    await act(async () => {
      await flush();
    });
    expect(latest).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // true へ戻す: 再取得。
    await render(true);
    await act(async () => {
      await flush();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(latest?.providers).toHaveLength(1);
  });

  it("(b) !res.ok (503) は last-known を保持する (誤って null 化しない)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(VALID_BODY)) // 初回: 確立
      .mockResolvedValueOnce(jsonResponse({ error: "internal error" }, false, 503)); // 2 回目: 5xx
    vi.stubGlobal("fetch", fetchMock);
    await render(true);
    await act(async () => {
      await flush();
    });
    expect(latest?.providers).toHaveLength(1);
    // interval で 2 回目 pull → 503。last-known を保持。
    await act(async () => {
      vi.advanceTimersByTime(COVERAGE_POLL_MS);
      await flush();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(latest?.providers).toHaveLength(1); // 変わらず (null 化しない)
    expect(latest?.generated_at).toBe(GEN);
  });

  it("(c) parse undefined (奇形応答: generated_at 不正) は last-known を保持する", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(VALID_BODY)) // 初回: 確立
      .mockResolvedValueOnce(jsonResponse({ generated_at: "yesterday", providers: [] })); // 奇形
    vi.stubGlobal("fetch", fetchMock);
    await render(true);
    await act(async () => {
      await flush();
    });
    expect(latest?.providers).toHaveLength(1);
    await act(async () => {
      vi.advanceTimersByTime(COVERAGE_POLL_MS);
      await flush();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // 奇形 (parse=undefined) は反映せず last-known を保持。
    expect(latest?.providers).toHaveLength(1);
    expect(latest?.generated_at).toBe(GEN);
  });

  // ── staleness 可視化 (誤安心の是正・「古い正常値」を老化させず出し続ける欠陥の回帰ガード) ──
  // これらは旧挙動 (失敗を握り潰し last-known を無期限保持・stale 信号なし) を注入すると赤くなる:
  //   staleForMs/isStale/unreachable の露出を止めると (b)-(e) が落ちる (falsifiable)。

  it("(stale-a) 成功→連続失敗で staleForMs が pull 毎に増加し 3×POLL 超で isStale=true", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(VALID_BODY)) // 初回: 確立 (lastSuccess = T0)
      .mockResolvedValue(jsonResponse({ error: "gone" }, false, 503)); // 以後すべて失敗
    vi.stubGlobal("fetch", fetchMock);
    await render(true);
    await act(async () => {
      await flush();
    });
    // 成功直後: staleForMs=0・isStale=false (回復状態)。
    expect(result.staleForMs).toBe(0);
    expect(result.isStale).toBe(false);
    expect(result.unreachable).toBe(false);

    // 失敗 pull ごとに staleForMs が client 時計差分で増加する (last-known は保持)。
    // QA-1: strict `>` 境界を下側から pin する。1×/2×/**ちょうど 3×POLL (= COVERAGE_STALE_MS)** の
    //   いずれでも isStale=false であることを assert (閾値を `>=` や `> 0` に緩める mutant を赤化させる)。
    const seen: number[] = [];
    for (let i = 1; i <= 4; i += 1) {
      await act(async () => {
        vi.advanceTimersByTime(COVERAGE_POLL_MS);
        await flush();
      });
      seen.push(result.staleForMs ?? -1);
      expect(latest?.providers).toHaveLength(1); // last-known 保持 (null 化しない)
      if (i < 4) {
        // i=1,2,3 → staleForMs = 1×/2×/3×POLL。3×POLL = COVERAGE_STALE_MS ちょうどでも strict `>` ゆえ false。
        expect(result.staleForMs).toBe(i * COVERAGE_POLL_MS);
        expect(result.isStale).toBe(false);
      }
    }
    // 3×POLL ちょうど (i=3) では isStale=false だったことを明示 pin (下側境界)。
    expect(3 * COVERAGE_POLL_MS).toBe(COVERAGE_STALE_MS);
    // 単調増加 (POLL, 2·POLL, 3·POLL, 4·POLL)。
    expect(seen).toEqual([
      COVERAGE_POLL_MS,
      2 * COVERAGE_POLL_MS,
      3 * COVERAGE_POLL_MS,
      4 * COVERAGE_POLL_MS,
    ]);
    // 4 回目の連続失敗 (~80s) で初めて stale と判定 (4·POLL > COVERAGE_STALE_MS)。
    expect((result.staleForMs ?? 0) > COVERAGE_STALE_MS).toBe(true);
    expect(result.isStale).toBe(true);
  });

  it("(stale-b) 奇形応答 (parse undefined) も staleness に計上する", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(VALID_BODY)) // 確立
      .mockResolvedValue(jsonResponse({ generated_at: "yesterday", providers: [] })); // 奇形
    vi.stubGlobal("fetch", fetchMock);
    await render(true);
    await act(async () => {
      await flush();
    });
    expect(result.staleForMs).toBe(0);
    for (let i = 1; i <= 4; i += 1) {
      await act(async () => {
        vi.advanceTimersByTime(COVERAGE_POLL_MS);
        await flush();
      });
    }
    // 奇形も「新鮮データなし」= 経過を計上し、last-known は保持する。
    expect(result.staleForMs).toBe(4 * COVERAGE_POLL_MS);
    expect(result.isStale).toBe(true);
    expect(latest?.providers).toHaveLength(1);
    expect(latest?.generated_at).toBe(GEN);
  });

  it("(stale-c) 未成功 + 3 連続失敗で unreachable=true (coverage は null のまま)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "down" }, false, 503));
    vi.stubGlobal("fetch", fetchMock);
    await render(true);
    await act(async () => {
      await flush(); // pull#1 fail
    });
    expect(result.unreachable).toBe(false); // 1 失敗では断定しない
    expect(result.staleForMs).toBeNull(); // 未成功ゆえ null
    await act(async () => {
      vi.advanceTimersByTime(COVERAGE_POLL_MS);
      await flush(); // pull#2 fail
    });
    expect(result.unreachable).toBe(false); // 2 失敗でもまだ
    await act(async () => {
      vi.advanceTimersByTime(COVERAGE_POLL_MS);
      await flush(); // pull#3 fail → 閾値到達
    });
    expect(result.unreachable).toBe(true);
    expect(latest).toBeNull(); // 一度も取得できていない
  });

  it("(stale-c2 / QA-2) unreachable 確立後に成功すると unreachable=false・coverage 確立・staleForMs=0 へ回復する", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "down" }, false, 503)) // pull#1 fail
      .mockResolvedValueOnce(jsonResponse({ error: "down" }, false, 503)) // pull#2 fail
      .mockResolvedValueOnce(jsonResponse({ error: "down" }, false, 503)) // pull#3 fail → unreachable
      .mockResolvedValue(jsonResponse(VALID_BODY)); // pull#4 成功 (回復)
    vi.stubGlobal("fetch", fetchMock);
    await render(true);
    await act(async () => {
      await flush(); // pull#1
    });
    for (let i = 2; i <= 3; i += 1) {
      await act(async () => {
        vi.advanceTimersByTime(COVERAGE_POLL_MS);
        await flush();
      });
    }
    expect(result.unreachable).toBe(true); // 3 連続失敗で到達不能を確立
    expect(latest).toBeNull();
    // 次 pull は成功 → 到達不能解消・coverage 確立・staleForMs=0 (回復)。
    await act(async () => {
      vi.advanceTimersByTime(COVERAGE_POLL_MS);
      await flush();
    });
    expect(result.unreachable).toBe(false);
    expect(latest?.providers).toHaveLength(1);
    expect(result.staleForMs).toBe(0);
    expect(result.isStale).toBe(false);
  });

  it("(stale-d) 回復 (成功) で isStale/staleForMs をリセットする", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(VALID_BODY)) // 確立
      .mockResolvedValueOnce(jsonResponse({ error: "x" }, false, 503)) // fail
      .mockResolvedValueOnce(jsonResponse({ error: "x" }, false, 503)) // fail
      .mockResolvedValueOnce(jsonResponse({ error: "x" }, false, 503)) // fail
      .mockResolvedValueOnce(jsonResponse({ error: "x" }, false, 503)) // fail → stale
      .mockResolvedValue(jsonResponse(VALID_BODY)); // 回復
    vi.stubGlobal("fetch", fetchMock);
    await render(true);
    await act(async () => {
      await flush();
    });
    for (let i = 1; i <= 4; i += 1) {
      await act(async () => {
        vi.advanceTimersByTime(COVERAGE_POLL_MS);
        await flush();
      });
    }
    expect(result.isStale).toBe(true);
    // 次 pull は成功 → staleForMs=0・isStale=false へ回復。
    await act(async () => {
      vi.advanceTimersByTime(COVERAGE_POLL_MS);
      await flush();
    });
    expect(result.staleForMs).toBe(0);
    expect(result.isStale).toBe(false);
    expect(latest?.providers).toHaveLength(1);
  });

  it("(stale-e) enabled=false は staleness 簿記も初期化する", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "down" }, false, 503));
    vi.stubGlobal("fetch", fetchMock);
    await render(true);
    await act(async () => {
      await flush();
      vi.advanceTimersByTime(COVERAGE_POLL_MS);
      await flush();
      vi.advanceTimersByTime(COVERAGE_POLL_MS);
      await flush();
    });
    expect(result.unreachable).toBe(true);
    await render(false);
    await act(async () => {
      await flush();
    });
    expect(result.unreachable).toBe(false);
    expect(result.staleForMs).toBeNull();
    expect(result.isStale).toBe(false);
    expect(latest).toBeNull();
  });

  // ── SEC-1: per-pull fetch timeout で fail-visible を自己完結化 (settle しない pull を凍結させない) ──
  // timeout 実装を除去すると neverSettlingUnlessAborted が永久に settle せず onStale が呼ばれない
  // → isStale / unreachable が flip せず RED になる (両方向 falsifiable)。

  it("(stale-timeout-a) 成功確立後に settle しない pull が続いても timeout→onStale で isStale が flip する", async () => {
    let call = 0;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      call += 1;
      if (call === 1) return Promise.resolve(jsonResponse(VALID_BODY)); // 初回: 確立
      return neverSettlingUnlessAborted(init); // 以後: hang (abort でのみ reject)
    });
    vi.stubGlobal("fetch", fetchMock);
    await render(true);
    await act(async () => {
      await flush();
    });
    expect(result.staleForMs).toBe(0);
    expect(result.isStale).toBe(false);
    // interval + per-pull timeout (どちらも POLL 間隔) を跨がせる。hang な pull は
    // COVERAGE_FETCH_TIMEOUT_MS 後に abort→reject→onStale へ落ちるので staleForMs が育ち isStale へ。
    expect(COVERAGE_FETCH_TIMEOUT_MS).toBe(COVERAGE_POLL_MS);
    for (let i = 0; i < 6; i += 1) {
      await act(async () => {
        vi.advanceTimersByTime(COVERAGE_POLL_MS);
        await flush();
      });
    }
    // 一度も settle しない fetch でも凍結せず stale を可視化できている。
    expect((result.staleForMs ?? 0) > COVERAGE_STALE_MS).toBe(true);
    expect(result.isStale).toBe(true);
    expect(latest?.providers).toHaveLength(1); // last-known は保持
  });

  it("(stale-timeout-b) 未成功のまま settle しない pull が続くと timeout→onStale で unreachable が flip する", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => neverSettlingUnlessAborted(init));
    vi.stubGlobal("fetch", fetchMock);
    await render(true);
    await act(async () => {
      await flush();
    });
    expect(result.unreachable).toBe(false); // まだ abort していない (hang 中)
    // 各 hang pull が timeout で abort→onStale。3 回の failure で unreachable=true。
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        vi.advanceTimersByTime(COVERAGE_POLL_MS);
        await flush();
      });
    }
    expect(result.unreachable).toBe(true);
    expect(result.staleForMs).toBeNull(); // 未成功ゆえ null
    expect(latest).toBeNull();
  });

  it("(a) unmount: interval cleanup で以後 fetch しない + in-flight resolve で setState されない", async () => {
    // 制御可能な deferred fetch (unmount 中に in-flight のまま resolve させる)。
    let resolveFetch!: (r: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((res) => {
          resolveFetch = res;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await render(true);
    expect(fetchMock).toHaveBeenCalledTimes(1); // マウント時 pull (未 resolve = in-flight)
    // unmount (cancelled=true + clearInterval)。
    await ctx.teardown();
    tornDown = true;
    // in-flight fetch を unmount 後に resolve → cancelled guard で setState されない (throw/warn なし)。
    await expect(
      act(async () => {
        resolveFetch(jsonResponse(VALID_BODY));
        await flush();
      }),
    ).resolves.toBeUndefined();
    // interval が cleanup 済 = タイマを進めても再 pull しない。
    await act(async () => {
      vi.advanceTimersByTime(COVERAGE_POLL_MS * 3);
      await flush();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
