/**
 * ADR 019f0eca: usePolicyAdmin フック (per-repo master-detail) + parser の INV。
 *
 * use-policy.test.tsx と同型 (jsdom + createRoot + act・実フック駆動・fetch を vi 制御)。
 * 固定する不変条件 (falsifiable):
 *  - parsePolicyAdmin: default + repos[] を closed-enum 投影し、未知/raw/不正 key を落とす。
 *  - parsePolicyScope: repo_scope 必須・closed-enum 投影・余剰 raw を落とす。
 *  - reload は GET .../list を叩き data を populate / save は POST .../set (repo_scope 任意) → reload /
 *    unset は POST .../unset {repo_scope} → reload / resolve は POST .../resolve {path} を返す。
 *  - NO-RAW: 生コマンドは投影で構造的に落ちる。
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POLICY_ADMIN_CACHE_KEY } from "../src/ui/policy-cache";
import {
  parsePolicyAdmin,
  parsePolicyScope,
  usePolicyAdmin,
  type UsePolicyAdminResult,
} from "../src/ui/use-policy-admin";

let dom: import("jsdom").JSDOM | undefined;

interface DomCtx {
  root: Root;
  teardown: () => Promise<void>;
}

async function mountDom(): Promise<DomCtx> {
  const { JSDOM } = await import("jsdom");
  // url 指定で非 opaque origin に (localStorage キャッシュ検証に必要)。
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

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: () => Promise.resolve(body) } as unknown as Response;
}

const LIST_BODY = {
  enabled: true,
  categories: ["recursive-rm"],
  env_gate_enabled: true,
  repos: [
    {
      repo_scope: "aaaa0001",
      repo_label: "sandbox",
      enabled: true,
      categories: ["db-drop", "rm -rf SHOULD_NOT_LEAK"],
    },
  ],
};

afterEach(() => vi.restoreAllMocks());

describe("parsePolicyAdmin (closed-enum 投影・NO-RAW)", () => {
  it("default + repos[] を投影し未知/raw を落とす", () => {
    const v = parsePolicyAdmin(LIST_BODY);
    expect(v).toBeDefined();
    expect(v!.defaultView.categories).toEqual(["recursive-rm"]);
    expect(v!.defaultView.isOverride).toBe(false);
    expect(v!.repos).toHaveLength(1);
    expect(v!.repos[0]!.repoScope).toBe("aaaa0001");
    expect(v!.repos[0]!.categories).toEqual(["db-drop"]); // raw は投影で落ちる。
    expect(JSON.stringify(v)).not.toContain("SHOULD_NOT_LEAK");
  });

  it("repos 非配列は空 repos へ畳む (壊れ応答でも default は返す)", () => {
    const v = parsePolicyAdmin({ enabled: true, categories: [], repos: "nope" });
    expect(v!.repos).toEqual([]);
  });

  it("repo_scope 非 string のエントリは落とす", () => {
    const v = parsePolicyAdmin({
      enabled: true,
      categories: [],
      repos: [{ enabled: true, categories: [] }, { repo_scope: 1 }],
    });
    expect(v!.repos).toHaveLength(0);
  });

  it("categories が非配列なら undefined (壊れ応答を弾く)", () => {
    expect(parsePolicyAdmin({ enabled: true, categories: "x" })).toBeUndefined();
    expect(parsePolicyAdmin(null)).toBeUndefined();
  });

  it("repo_label を canonical sanitize へ畳む (untrusted cache 経路の NO-RAW parity)", () => {
    const ctrlLabel = "x" + String.fromCharCode(1) + "y"; // 制御文字 (生バイト回避で動的構築)。
    const v = parsePolicyAdmin({
      enabled: true,
      categories: [],
      repos: [
        {
          repo_scope: "aaaa0001",
          repo_label: "/home/user/secret/repo",
          enabled: true,
          categories: [],
        },
        { repo_scope: "bbbb0002", repo_label: ctrlLabel, enabled: true, categories: [] },
      ],
    });
    expect(v!.repos[0]!.repoLabel).toBe("repo"); // 絶対パス→basename
    expect(v!.repos[1]!.repoLabel).toBe("xy"); // 制御文字除去
  });
});

describe("parsePolicyScope (単一 scope・closed-enum)", () => {
  it("repo_scope + closed-enum を投影し raw を落とす", () => {
    const v = parsePolicyScope({
      enabled: true,
      categories: ["recursive-rm", "rm -rf /"],
      repo_scope: "bbbb0002",
      repo_label: "prod",
      is_override: false,
    });
    expect(v).toEqual({
      repoScope: "bbbb0002",
      repoLabel: "prod",
      isOverride: false,
      enabled: true,
      categories: ["recursive-rm"],
    });
  });

  it("repo_scope 欠落 / categories 非配列は undefined", () => {
    expect(parsePolicyScope({ enabled: true, categories: [] })).toBeUndefined();
    expect(parsePolicyScope({ repo_scope: "x", categories: "y" })).toBeUndefined();
  });

  it("repo_label を canonical sanitize へ畳む (untrusted)", () => {
    const v = parsePolicyScope({
      enabled: true,
      categories: [],
      repo_scope: "cccc0003",
      repo_label: "/abs/path/work",
    });
    expect(v!.repoLabel).toBe("work");
  });
});

describe("usePolicyAdmin hook", () => {
  let ctx: DomCtx;
  let latest: UsePolicyAdminResult;

  beforeEach(async () => {
    ctx = await mountDom();
  });
  afterEach(async () => {
    await ctx.teardown();
  });

  async function render(sessionId: string | null): Promise<void> {
    function Probe(): null {
      // ADR 019f1582: usePolicyAdmin は relay-target descriptor を取る。本 suite は session 経路を検証
      // (daemon 経路の base 分岐は別 it で固定)。
      latest = usePolicyAdmin(sessionId === null ? null : { kind: "session", id: sessionId });
      return null;
    }
    await act(async () => {
      ctx.root.render(<Probe />);
    });
  }

  it("reload は GET .../list を叩き data を populate する", async () => {
    const calls: Array<[string, unknown]> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: unknown) => {
        calls.push([url, init]);
        return Promise.resolve(jsonResponse(LIST_BODY));
      }),
    );
    await render("s1");
    await act(async () => {
      latest.reload();
      await Promise.resolve();
    });
    expect(calls[0]![0]).toBe("/realtime/sessions/s1/approvals/policy/list");
    expect(calls[0]![1]).toBeUndefined(); // list は GET。
    expect(latest.data?.defaultView.categories).toEqual(["recursive-rm"]);
    expect(latest.data?.repos[0]?.repoScope).toBe("aaaa0001");
  });

  // ADR 019f1582: daemon relay-target は base path を /realtime/daemons/:id/... に分岐する
  // (エージェント未稼働でも per-repo 設定可)。session 経路は不変。
  it("daemon relay-target は GET /realtime/daemons/:id/.../list を叩く (base 分岐)", async () => {
    const calls: Array<[string, unknown]> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: unknown) => {
        calls.push([url, init]);
        return Promise.resolve(jsonResponse(LIST_BODY));
      }),
    );
    function Probe(): null {
      latest = usePolicyAdmin({ kind: "daemon", id: "dae-mon-id" });
      return null;
    }
    await act(async () => {
      ctx.root.render(<Probe />);
    });
    await act(async () => {
      latest.reload();
      await Promise.resolve();
    });
    expect(calls[0]![0]).toBe("/realtime/daemons/dae-mon-id/approvals/policy/list");
    expect(latest.data?.repos[0]?.repoScope).toBe("aaaa0001");
  });

  it("save(repoScope) は POST .../set に repo_scope+repo_label を載せ reload する", async () => {
    const calls: Array<{ url: string; init: { method?: string; body?: string } }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: { method?: string; body?: string }) => {
        calls.push({ url, init: init ?? {} });
        return Promise.resolve(jsonResponse(LIST_BODY)); // set 応答 + 後続 list 応答とも流用。
      }),
    );
    await render("s1");
    await act(async () => {
      await latest.save("bbbb0002", { categories: ["db-drop"], repoLabel: "prod" });
      await Promise.resolve();
    });
    expect(calls[0]!.url).toBe("/realtime/sessions/s1/approvals/policy/set");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({
      categories: ["db-drop"],
      repo_scope: "bbbb0002",
      repo_label: "prod",
    });
    // save 成功で reload (GET .../list) が後続する。
    expect(calls.some((c) => c.url.endsWith("/policy/list"))).toBe(true);
  });

  it("save(undefined) は Default 更新で repo_scope を載せない", async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: { body?: string }) => {
        if (init?.body) bodies.push(init.body);
        return Promise.resolve(jsonResponse(LIST_BODY));
      }),
    );
    await render("s1");
    await act(async () => {
      await latest.save(undefined, { enabled: false, categories: ["recursive-rm"] });
      await Promise.resolve();
    });
    expect(JSON.parse(bodies[0]!)).toEqual({ enabled: false, categories: ["recursive-rm"] });
  });

  it("unset は POST .../unset {repo_scope} を送り reload する", async () => {
    const calls: Array<{ url: string; init: { method?: string; body?: string } }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: { method?: string; body?: string }) => {
        calls.push({ url, init: init ?? {} });
        return Promise.resolve(jsonResponse(LIST_BODY));
      }),
    );
    await render("s1");
    await act(async () => {
      await latest.unset("aaaa0001");
      await Promise.resolve();
    });
    expect(calls[0]!.url).toBe("/realtime/sessions/s1/approvals/policy/unset");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({ repo_scope: "aaaa0001" });
    expect(calls.some((c) => c.url.endsWith("/policy/list"))).toBe(true);
  });

  it("resolve は POST .../resolve {path} を送り scope+effective を返す (生 path を保持しない)", async () => {
    const calls: Array<{ url: string; init: { method?: string; body?: string } }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: { method?: string; body?: string }) => {
        calls.push({ url, init: init ?? {} });
        return Promise.resolve(
          jsonResponse({
            enabled: true,
            categories: ["recursive-rm"],
            repo_scope: "cccc0003",
            repo_label: "work",
            is_override: false,
          }),
        );
      }),
    );
    await render("s1");
    let result: Awaited<ReturnType<UsePolicyAdminResult["resolve"]>> | undefined;
    await act(async () => {
      result = await latest.resolve("/home/me/work");
    });
    expect(calls[0]!.url).toBe("/realtime/sessions/s1/approvals/policy/resolve");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init.body!)).toEqual({ path: "/home/me/work" });
    expect(result).toEqual({
      repoScope: "cccc0003",
      repoLabel: "work",
      isOverride: false,
      enabled: true,
      categories: ["recursive-rm"],
    });
  });

  it("resolve 失敗 (404) は本文 error で throw する", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({ error: "path is not a resolvable git repository" }, false, 404),
        ),
      ),
    );
    await render("s1");
    await act(async () => {
      await expect(latest.resolve("/not/a/repo")).rejects.toThrow(
        "path is not a resolvable git repository",
      );
    });
  });

  it("reload 成功で last-known を localStorage キャッシュ (raw+fetchedAt) へ書く", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(LIST_BODY))),
    );
    await render("s1");
    await act(async () => {
      latest.reload();
      await Promise.resolve();
    });
    const cached = window.localStorage.getItem(POLICY_ADMIN_CACHE_KEY);
    expect(cached).not.toBeNull();
    const env = JSON.parse(cached!) as { raw: unknown; fetchedAt: number };
    expect(env.raw).toEqual(LIST_BODY);
    expect(typeof env.fetchedAt).toBe("number");
    expect(env.fetchedAt).toBeGreaterThan(0);
  });

  it("接続ゼロ (sessionId=null) でもマウント時にキャッシュから data を復元する", async () => {
    window.localStorage.setItem(
      POLICY_ADMIN_CACHE_KEY,
      JSON.stringify({ raw: LIST_BODY, fetchedAt: 1717000000000 }),
    );
    const fetchSpy = vi.fn(() => Promise.resolve(jsonResponse(LIST_BODY)));
    vi.stubGlobal("fetch", fetchSpy);
    await render(null);
    // session 無しゆえ fetch は呼ばれず、キャッシュ (closed-enum 再射影済) を read-only 表示できる。
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(latest.data?.repos[0]?.repoScope).toBe("aaaa0001");
    expect(latest.data?.defaultView.categories).toEqual(["recursive-rm"]);
    expect(latest.cachedAt).toBe(1717000000000); // SEC-2: stale 度表示用の取得時刻。
  });

  // QA-4 (INV-APPROVAL アンカー): 接続ゼロ時、mutation は hook 層で no-op/throw する (UI disabled は表層・
  // これが実質の承認バイパス防止)。cache で data が在る状態でも sessionId=null なら書込経路は塞がれる。
  it("INV-APPROVAL: sessionId=null で save/unset は fetch せず・resolve は throw する", async () => {
    window.localStorage.setItem(
      POLICY_ADMIN_CACHE_KEY,
      JSON.stringify({ raw: LIST_BODY, fetchedAt: 1717000000000 }),
    );
    const fetchSpy = vi.fn(() => Promise.resolve(jsonResponse(LIST_BODY)));
    vi.stubGlobal("fetch", fetchSpy);
    await render(null);
    // cache 復元で data は在るが、書込は一切 relay されない。
    expect(latest.data?.repos[0]?.repoScope).toBe("aaaa0001");
    await act(async () => {
      await latest.save("aaaa0001", { categories: ["db-drop"] });
      await latest.save(undefined, { enabled: false });
      await latest.unset("aaaa0001");
    });
    expect(fetchSpy).not.toHaveBeenCalled(); // save/unset は no-op (fetch 0)。
    await act(async () => {
      await expect(latest.resolve("/any/path")).rejects.toThrow("no relay target");
    });
    expect(fetchSpy).not.toHaveBeenCalled(); // resolve も throw 前に fetch しない。
  });

  it("QA-1: parsePolicyAdmin は非 hex repo_scope の repo を drop する (untrusted admin-cache)", () => {
    const v = parsePolicyAdmin({
      enabled: true,
      categories: [],
      repos: [
        { repo_scope: "aaaa0001", repo_label: "ok", enabled: true, categories: [] },
        { repo_scope: "/abs/path", repo_label: "evil", enabled: true, categories: [] }, // 非 hex
        { repo_scope: "ZZZZ", enabled: true, categories: [] }, // 非 hex
      ],
    });
    expect(v!.repos.map((r) => r.repoScope)).toEqual(["aaaa0001"]);
  });

  it("QA-1: parsePolicyScope は非 hex repo_scope を undefined にする", () => {
    expect(
      parsePolicyScope({ enabled: true, categories: [], repo_scope: "/abs/path" }),
    ).toBeUndefined();
    expect(parsePolicyScope({ enabled: true, categories: [], repo_scope: "ZZZZ" })).toBeUndefined();
  });
});
