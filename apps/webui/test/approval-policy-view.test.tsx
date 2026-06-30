/**
 * ADR 019f0eca: ApprovalPolicyView の静的描画 INV (master-detail 設定画面)。
 *
 * - relayTarget=null (session も daemon も無し): 一覧/詳細を出さず「接続中のセッションがありません」を出す。
 * - relayTarget 有り (session/daemon): タイトル + Default 項目 + repo 追加導線 (方式B パス入力) を描く。
 * (ADR 019f1582: daemon-addressed relay で relayTarget は session | daemon。daemon-only 時の編集可/allowlist
 *  非表示は本ファイル末尾の「daemon-addressed relay-target」describe で固定。)
 * - i18n ja/en が反映され、ハードコード日本語が en に漏れない。
 * (master-detail の選択/編集/resolve の interaction は jsdom 駆動の use-policy-admin.test.tsx で固定。)
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApprovalPolicyView } from "../src/ui/ApprovalPolicyView.js";
import { FixedLocaleProvider } from "../src/ui/LocaleProvider.js";
import { POLICY_ADMIN_CACHE_KEY, POLICY_CANDIDATES_KEY } from "../src/ui/policy-cache.js";

function render(node: React.ReactNode, locale: "ja" | "en"): string {
  return renderToStaticMarkup(<FixedLocaleProvider locale={locale}>{node}</FixedLocaleProvider>);
}

describe("ApprovalPolicyView 静的描画", () => {
  it("relay session 無し: no-session alert を出し一覧/詳細は出さない", () => {
    const html = render(<ApprovalPolicyView active relayTarget={null} />, "ja");
    expect(html).toContain('data-testid="policyview"');
    expect(html).toContain('data-testid="policyview-no-session"');
    expect(html).toContain("接続中のセッションがありません");
    expect(html).not.toContain('data-testid="policyview-scopes"');
    expect(html).not.toContain('data-testid="policyview-detail"');
  });

  it("relay session 有り: タイトル + Default 項目 + repo 追加導線を描く", () => {
    const html = render(
      <ApprovalPolicyView active relayTarget={{ kind: "session", id: "s1" }} nowMs={1000} />,
      "ja",
    );
    expect(html).toContain('data-testid="policyview-scopes"');
    expect(html).toContain('data-testid="policyview-scope-default"');
    expect(html).toContain("Default");
    expect(html).toContain("マシン基準");
    // 方式B repo 追加導線 (絶対パス入力)。
    expect(html).toContain('data-testid="policyview-add-path"');
    expect(html).toContain('data-testid="policyview-add-button"');
  });

  it("en: 英語ラベルが出てハードコード日本語が漏れない", () => {
    const noSession = render(<ApprovalPolicyView active relayTarget={null} />, "en");
    expect(noSession).toContain("No connected session");
    expect(noSession).not.toMatch(/[ぁ-んァ-ン一-龥]/);

    const withSession = render(
      <ApprovalPolicyView active relayTarget={{ kind: "session", id: "s1" }} />,
      "en",
    );
    expect(withSession).toContain("Machine baseline");
    expect(withSession).toContain("Add repo by path");
    expect(withSession).not.toMatch(/[ぁ-んァ-ン一-龥]/);
  });

  // ADR 019f0eca §8: 観測 cwd サジェスト。NO-RAW — basename のみ描画し生パス断片を DOM へ出さない。
  it("観測 cwd: basename のみ表示し生パスを DOM へ出さない (NO-RAW)", () => {
    const html = render(
      <ApprovalPolicyView
        active
        relayTarget={{ kind: "session", id: "s1" }}
        observedCwds={["/home/user/secret/myrepo", "/srv/work/data-pipeline"]}
      />,
      "ja",
    );
    expect(html).toContain('data-testid="policyview-observed"');
    expect(html).toContain("myrepo"); // basename ラベル
    expect(html).toContain("data-pipeline");
    expect(html).toContain("観測（クリックで設定）"); // badge (TDA-1: 「未設定」断定を避ける)
    // 生パス断片は一切 DOM に出ない (label/testid/属性すべて)。
    expect(html).not.toContain("/home/user/secret");
    expect(html).not.toContain("/srv/work");
    expect(html).not.toContain("secret/myrepo");
  });

  it("観測 cwd 無し: observed セクションを描かない", () => {
    const html = render(
      <ApprovalPolicyView active relayTarget={{ kind: "session", id: "s1" }} observedCwds={[]} />,
      "ja",
    );
    expect(html).not.toContain('data-testid="policyview-observed"');
  });

  // QA-3: basename 化できない cwd (例 "/" = sanitize 後空→undefined) はサジェストしない (NO-RAW backstop)。
  it('QA-3: basename 化できない cwd ("/") はサジェストしない', () => {
    const html = render(
      <ApprovalPolicyView
        active
        relayTarget={{ kind: "session", id: "s1" }}
        observedCwds={["/"]}
      />,
      "ja",
    );
    expect(html).not.toContain('data-testid="policyview-observed"');
  });
});

/**
 * QA-3 (ADR 019f0eca full 監査・decision 019f0f2f): 緩和警告 (policyview-loosen) の描画を jsdom 駆動で固定する。
 * empty-categories や Default が gate する category を外した repo override は YOLO 下で high-risk を素通しする
 * (hard-floor 無し・decision 019f0ecd) ため、この警告が唯一の可視ガード。draft が Default より緩いときのみ
 * 出ることを pin する (常時 true/false に退行すると RED)。
 */
describe("ApprovalPolicyView 緩和警告 (QA-3・jsdom interaction)", () => {
  // Default は recursive-rm を gate。sandbox は空 (緩い) / prod は superset (厳格)。
  const LIST_BODY = {
    enabled: true,
    categories: ["recursive-rm"],
    env_gate_enabled: true,
    repos: [
      { repo_scope: "aaaa0001", repo_label: "sandbox", enabled: true, categories: [] },
      {
        repo_scope: "bbbb0002",
        repo_label: "prod",
        enabled: true,
        categories: ["recursive-rm", "db-drop"],
      },
    ],
  };

  let dom: import("jsdom").JSDOM | undefined;
  let root: Root;
  let restore: () => void;

  beforeEach(async () => {
    const { JSDOM } = await import("jsdom");
    dom = new JSDOM('<!doctype html><div id="root"></div>');
    const g = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const prev = { act: g.IS_REACT_ACT_ENVIRONMENT, window: g.window, document: g.document };
    g.IS_REACT_ACT_ENVIRONMENT = true;
    g.window = dom.window as unknown as Window & typeof globalThis;
    g.document = dom.window.document;
    root = createRoot(dom.window.document.getElementById("root")!);
    restore = () => {
      g.window = prev.window;
      g.document = prev.document;
      g.IS_REACT_ACT_ENVIRONMENT = prev.act;
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(LIST_BODY),
        } as Response),
      ),
    );
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    restore();
    dom?.window.close();
    dom = undefined;
    vi.restoreAllMocks();
  });

  function q(testid: string): Element | null {
    return dom!.window.document.querySelector(`[data-testid="${testid}"]`);
  }
  async function clickScope(scope: string): Promise<void> {
    await act(async () => {
      (q(`policyview-scope-${scope}`) as HTMLButtonElement).click();
    });
  }

  it("Default より緩い override 選択で警告・厳格/Default 選択で非表示", async () => {
    await act(async () => {
      root.render(
        <FixedLocaleProvider locale="ja">
          <ApprovalPolicyView active relayTarget={{ kind: "session", id: "s1" }} nowMs={1000} />
        </FixedLocaleProvider>,
      );
    });
    // 非同期 reload (fetch→list) を flush。
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // データ読込後、override が一覧に出る。
    expect(q("policyview-scope-aaaa0001")).not.toBeNull();

    // sandbox (空 categories = Default の recursive-rm を外す) → 緩和警告。
    await clickScope("aaaa0001");
    expect(q("policyview-loosen")).not.toBeNull();

    // prod (recursive-rm を含む superset) → 緩和でない → 警告なし。
    await clickScope("bbbb0002");
    expect(q("policyview-loosen")).toBeNull();

    // Default 選択 → isRepo=false → 警告なし。
    await clickScope("default");
    expect(q("policyview-loosen")).toBeNull();
  });
});

/**
 * 接続ゼロ閲覧 + candidate 永続 (ユーザー指摘 2026-06-29・ADR 019f0eca):
 *  - relaySessionId=null でも localStorage キャッシュ (last-known) が在れば一覧/詳細を read-only 表示し、
 *    no-session の行き止まりに落ちない。offline バナーを出し、mutation (add/save) を無効化する。
 *  - 手動 add した未保存 candidate (永続スタブ) を一覧へ復元する (Default 継承)。
 * これらは表示専用で live gate に影響しない (mutation は接続中 relay 必須)。
 */
describe("ApprovalPolicyView offline 閲覧 (接続ゼロ・キャッシュ)", () => {
  // TDA-5: キーは policy-cache から import。
  const ADMIN_KEY = POLICY_ADMIN_CACHE_KEY;
  const CANDIDATES_KEY = POLICY_CANDIDATES_KEY;
  const LIST_BODY = {
    enabled: true,
    categories: ["recursive-rm"],
    env_gate_enabled: true,
    repos: [{ repo_scope: "aaaa0001", repo_label: "sandbox", enabled: true, categories: [] }],
  };

  let dom: import("jsdom").JSDOM | undefined;
  let root: Root;
  let restore: () => void;

  beforeEach(async () => {
    const { JSDOM } = await import("jsdom");
    // url 指定で非 opaque origin に (localStorage キャッシュ検証に必要)。
    dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://localhost/" });
    const g = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const prev = { act: g.IS_REACT_ACT_ENVIRONMENT, window: g.window, document: g.document };
    g.IS_REACT_ACT_ENVIRONMENT = true;
    g.window = dom.window as unknown as Window & typeof globalThis;
    g.document = dom.window.document;
    root = createRoot(dom.window.document.getElementById("root")!);
    restore = () => {
      g.window = prev.window;
      g.document = prev.document;
      g.IS_REACT_ACT_ENVIRONMENT = prev.act;
    };
    // 接続ゼロでも fetch されないことを確認するため stub を置く (呼ばれたら検出可能)。
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("offline must not fetch"))),
    );
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    restore();
    dom?.window.close();
    dom = undefined;
    vi.restoreAllMocks();
  });

  function q(testid: string): Element | null {
    return dom!.window.document.querySelector(`[data-testid="${testid}"]`);
  }
  function seedAdmin(): void {
    dom!.window.localStorage.setItem(
      ADMIN_KEY,
      JSON.stringify({ raw: LIST_BODY, fetchedAt: 1717000000000 }),
    );
  }

  async function renderOffline(): Promise<void> {
    await act(async () => {
      root.render(
        <FixedLocaleProvider locale="ja">
          <ApprovalPolicyView active relayTarget={null} nowMs={1000} />
        </FixedLocaleProvider>,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("キャッシュ在りなら接続ゼロでも read-only 表示し no-session に落ちない", async () => {
    seedAdmin();
    await renderOffline();

    expect(q("policyview-offline")).not.toBeNull(); // offline バナー。
    expect(q("policyview-no-session")).toBeNull(); // 行き止まりに落ちない。
    expect(q("policyview-scopes")).not.toBeNull();
    expect(q("policyview-scope-aaaa0001")).not.toBeNull(); // キャッシュ済 override が出る。
    expect(q("policyview-allowlist")).toBeNull(); // allowlist は relay 取得ゆえ非表示。
  });

  // QA-3 (INV-APPROVAL 表層): offline 時、詳細ペイン (Default 選択中) の全 mutation 要素が disabled。
  // 1 ボタンだけの assert では将来 save/categories の offline disable が外れても緑のまま通るため網羅する。
  it("offline では全 mutation 要素 (save/enabled/categories/reload/add) が disabled", async () => {
    seedAdmin();
    await renderOffline();
    const disabled = (testid: string): boolean =>
      (q(testid) as HTMLButtonElement | HTMLInputElement | HTMLFieldSetElement).disabled;
    expect(disabled("policyview-add-path")).toBe(true);
    expect(disabled("policyview-add-button")).toBe(true);
    expect(disabled("policyview-reload")).toBe(true);
    expect(disabled("policyview-enabled-input")).toBe(true);
    expect(disabled("policyview-categories")).toBe(true); // fieldset disabled。
    expect(disabled("policyview-save")).toBe(true);
  });

  it("offline バナーに最終取得時刻を併記する (SEC-2: stale 誤認緩和)", async () => {
    seedAdmin();
    await renderOffline();
    // ja の offlineHintCached は「最終取得:」を含む。fetchedAt が banner subtitle に反映される。
    expect(q("policyview-offline")?.textContent).toContain("最終取得");
  });

  it("手動 add した未保存 candidate を一覧へ復元する (Default 継承)", async () => {
    seedAdmin();
    dom!.window.localStorage.setItem(
      CANDIDATES_KEY,
      JSON.stringify([{ repoScope: "eeee0005", repoLabel: "candidate-repo" }]),
    );
    await renderOffline();

    // 永続スタブが Default 継承 candidate として一覧に出る (override 化はしていない)。
    expect(q("policyview-scope-eeee0005")).not.toBeNull();
    expect(q("policyview-badge-eeee0005")?.textContent).toContain("Default");
  });

  it("キャッシュも無ければ従来どおり no-session を出す", async () => {
    await renderOffline();
    expect(q("policyview-no-session")).not.toBeNull();
    expect(q("policyview-scopes")).toBeNull();
  });
});

/**
 * reconnect auto-refresh (QA-2・M) + candidate 永続 round-trip (QA-5/QA-6・L)。online (relaySessionId 有り)
 * で fetch を制御し、(a) null→session でちょうど1回 pull・同session再renderで再fetchしない、(b) add した
 * candidate が localStorage に永続し hydration が既存スタブを wipe しない、を jsdom で固定する。
 */
describe("ApprovalPolicyView reconnect + candidate 永続 (QA-2/QA-5/QA-6・jsdom)", () => {
  const ADMIN_KEY = POLICY_ADMIN_CACHE_KEY;
  const CANDIDATES_KEY = POLICY_CANDIDATES_KEY;
  const LIST_BODY = {
    enabled: true,
    categories: ["recursive-rm"],
    env_gate_enabled: true,
    repos: [{ repo_scope: "aaaa0001", repo_label: "sandbox", enabled: true, categories: [] }],
  };
  const RESOLVE_BODY = {
    enabled: true,
    categories: ["recursive-rm"],
    repo_scope: "ffff0006",
    repo_label: "added",
    is_override: false,
  };

  let dom: import("jsdom").JSDOM | undefined;
  let root: Root;
  let restore: () => void;
  let fetchSpy: ReturnType<typeof vi.fn>;

  function jsonResponse(body: unknown): Response {
    return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response;
  }

  beforeEach(async () => {
    const { JSDOM } = await import("jsdom");
    dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "http://localhost/" });
    const g = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const prev = { act: g.IS_REACT_ACT_ENVIRONMENT, window: g.window, document: g.document };
    g.IS_REACT_ACT_ENVIRONMENT = true;
    g.window = dom.window as unknown as Window & typeof globalThis;
    g.document = dom.window.document;
    root = createRoot(dom.window.document.getElementById("root")!);
    restore = () => {
      g.window = prev.window;
      g.document = prev.document;
      g.IS_REACT_ACT_ENVIRONMENT = prev.act;
    };
    fetchSpy = vi.fn((url: string) =>
      Promise.resolve(jsonResponse(String(url).endsWith("/resolve") ? RESOLVE_BODY : LIST_BODY)),
    );
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    restore();
    dom?.window.close();
    dom = undefined;
    vi.restoreAllMocks();
  });

  function q(testid: string): Element | null {
    return dom!.window.document.querySelector(`[data-testid="${testid}"]`);
  }
  async function flush(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }
  async function renderWith(sid: string | null): Promise<void> {
    await act(async () => {
      root.render(
        <FixedLocaleProvider locale="ja">
          <ApprovalPolicyView
            active
            relayTarget={sid ? { kind: "session", id: sid } : null}
            nowMs={1000}
          />
        </FixedLocaleProvider>,
      );
    });
  }
  const listCalls = (): number =>
    fetchSpy.mock.calls.filter((c) => String(c[0]).endsWith("/list")).length;

  it("QA-2: 接続ゼロ→session でちょうど1回 reload・同session再renderで再fetchしない", async () => {
    dom!.window.localStorage.setItem(
      ADMIN_KEY,
      JSON.stringify({ raw: LIST_BODY, fetchedAt: 1717000000000 }),
    );
    await renderWith(null); // offline: cache 復元のみ・fetch しない。
    await flush();
    expect(listCalls()).toBe(0);

    await renderWith("s1"); // reconnect: ちょうど 1 回 pull。
    await flush();
    expect(listCalls()).toBe(1);

    await renderWith("s1"); // 同 session 再render: 追加 fetch なし (loadedSidRef de-dup)。
    await flush();
    expect(listCalls()).toBe(1);
  });

  it("QA-6: pre-seed candidate スタブを mount で wipe せず一覧へ復元する (hydration 前の空上書き防止)", async () => {
    // online でも candidate hydration は data 確定後 1 回走る。persist effect が hydration 前に
    // 空集合で localStorage を wipe しないこと (candidatesHydratedRef ガード) を固定する。
    dom!.window.localStorage.setItem(
      CANDIDATES_KEY,
      JSON.stringify([{ repoScope: "eeee0005", repoLabel: "preseeded" }]),
    );
    await renderWith("s1");
    await flush();
    expect(q("policyview-scope-eeee0005")).not.toBeNull(); // Default 継承 candidate として復元。
    // localStorage の既存スタブは保持される (空 wipe されない)。
    expect(JSON.parse(dom!.window.localStorage.getItem(CANDIDATES_KEY) ?? "[]")).toContainEqual({
      repoScope: "eeee0005",
      repoLabel: "preseeded",
    });
    // override 済 (list 由来) の aaaa0001 も併存表示。
    expect(q("policyview-scope-aaaa0001")).not.toBeNull();
  });
  // NB: QA-5 の「方式B add (resolve) → onAdd → localStorage 書込」の DOM 入力経路は、React 19 + jsdom の
  // controlled-input value-tracker bypass が当環境で発火せず、tech-debt sweep へ carryover
  // (helper 往復は policy-cache.test.ts で・hydration no-wipe は上で固定済)。fetchSpy の /resolve 分岐
  // (RESOLVE_BODY) はその carryover テストが付く際の土台として残す。

  // ADR 019f0eca §8: 観測 cwd サジェストのクリック→resolve→candidate 化。**ボタンクリック**は jsdom で
  // 発火する (詰まるのは controlled text input のみ)。resolve は既存 endpoint 経由 (生 cwd は resolve 入力に限る)。
  it("観測 cwd クリックで resolve→candidate 化し scope エントリが出る・サジェストから消える", async () => {
    await act(async () => {
      root.render(
        <FixedLocaleProvider locale="ja">
          <ApprovalPolicyView
            active
            relayTarget={{ kind: "session", id: "s1" }}
            nowMs={1000}
            observedCwds={["/x/work/myrepo"]}
          />
        </FixedLocaleProvider>,
      );
    });
    await flush();
    const obsBtn = dom!.window.document.querySelector(
      '[data-testid="policyview-observed-list"] button',
    ) as HTMLButtonElement | null;
    expect(obsBtn).not.toBeNull();
    expect(obsBtn!.textContent).toContain("myrepo"); // basename 表示。

    await act(async () => {
      obsBtn!.click();
    });
    await flush();
    await flush();
    // resolve(/x/work/myrepo) → RESOLVE_BODY(ffff0006) が candidate 化して一覧へ。
    expect(q("policyview-scope-ffff0006")).not.toBeNull();
    // resolve 済ゆえ観測サジェストから消える (distinct が 1 件のみ→ section ごと消える)。
    expect(q("policyview-observed")).toBeNull();
    // resolve に生 cwd を渡したことを確認 (resolve 経路の入力)。
    const resolveCall = fetchSpy.mock.calls.find((c) => String(c[0]).endsWith("/resolve"));
    expect(resolveCall).toBeDefined();
    expect(JSON.parse((resolveCall![1] as { body: string }).body)).toEqual({
      path: "/x/work/myrepo",
    });
    // QA-1 (INV-APPROVAL 表層): pick は表示専用。resolve のみで mutation (/set・/unset) を一切呼ばない
    // (override 化は明示 save→relay が別途必須)。auto-save/auto-relay へ退行したら RED。
    expect(fetchSpy.mock.calls.find((c) => /\/(set|unset)$/.test(String(c[0])))).toBeUndefined();
  });

  it("観測 cwd サジェストは offline で無効化される", async () => {
    dom!.window.localStorage.setItem(
      ADMIN_KEY,
      JSON.stringify({ raw: LIST_BODY, fetchedAt: 1717000000000 }),
    );
    await act(async () => {
      root.render(
        <FixedLocaleProvider locale="ja">
          <ApprovalPolicyView active relayTarget={null} nowMs={1000} observedCwds={["/x/myrepo"]} />
        </FixedLocaleProvider>,
      );
    });
    await flush();
    const obsBtn = dom!.window.document.querySelector(
      '[data-testid="policyview-observed-list"] button',
    ) as HTMLButtonElement | null;
    expect(obsBtn).not.toBeNull();
    expect(obsBtn!.disabled).toBe(true); // offline は resolve 不能ゆえ無効。
  });

  // QA-2 + SEC error-channel: resolve 失敗時はサジェストを残し addError を出す。エラー表示へ生 cwd を漏らさない。
  it("QA-2: 観測 cwd の resolve 失敗でサジェストが残り addError を出す・生 cwd を漏らさない", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        String(url).endsWith("/resolve")
          ? Promise.resolve({
              ok: false,
              status: 404,
              json: () => Promise.resolve({ error: "path is not a resolvable git repository" }),
            } as Response)
          : Promise.resolve(jsonResponse(LIST_BODY)),
      ),
    );
    await act(async () => {
      root.render(
        <FixedLocaleProvider locale="ja">
          <ApprovalPolicyView
            active
            relayTarget={{ kind: "session", id: "s1" }}
            nowMs={1000}
            observedCwds={["/x/fail/myrepo"]}
          />
        </FixedLocaleProvider>,
      );
    });
    await flush();
    const obsBtn = dom!.window.document.querySelector(
      '[data-testid="policyview-observed-list"] button',
    ) as HTMLButtonElement | null;
    expect(obsBtn).not.toBeNull();
    await act(async () => {
      obsBtn!.click();
    });
    await flush();
    await flush();
    // 失敗ゆえサジェストは残る (resolvedCwds へ入れない→再試行可)。
    expect(q("policyview-observed")).not.toBeNull();
    expect(q("policyview-add-error")).not.toBeNull();
    // エラー表示 (および DOM 全体) に生 cwd を漏らさない (NO-RAW・固定リテラルのみ)。
    const html = dom!.window.document.body.innerHTML;
    expect(html).not.toContain("/x/fail");
    expect(html).not.toContain("fail/myrepo");
  });

  // ADR 019f1582: daemon relay-target (エージェント未稼働でも設定可)。daemon target は offline でなく編集可。
  // allowlist は session-scoped 維持ゆえ daemon-only では非表示。fetch は daemon path を叩く。
  it("daemon relay-target: offline でなく編集可・allowlist 非表示・daemon path を叩く", async () => {
    await act(async () => {
      root.render(
        <FixedLocaleProvider locale="ja">
          <ApprovalPolicyView active relayTarget={{ kind: "daemon", id: "d1" }} nowMs={1000} />
        </FixedLocaleProvider>,
      );
    });
    await flush();
    // offline でない: バナー/no-session 無し・scopes 表示。
    expect(q("policyview-offline")).toBeNull();
    expect(q("policyview-no-session")).toBeNull();
    expect(q("policyview-scopes")).not.toBeNull();
    // mutation 要素は **有効** (offline テストの厳密な逆: offline 専一ゲートの要素を網羅)。
    const enabled = (testid: string): boolean =>
      !(q(testid) as HTMLButtonElement | HTMLInputElement | HTMLFieldSetElement).disabled;
    expect(enabled("policyview-add-path")).toBe(true);
    expect(enabled("policyview-reload")).toBe(true);
    expect(enabled("policyview-enabled-input")).toBe(true);
    expect(enabled("policyview-categories")).toBe(true);
    // allowlist (list/revoke) は session-scoped 維持 → daemon-only では非表示。
    expect(q("policyview-allowlist")).toBeNull();
    // fetch は daemon path (/realtime/daemons/d1/...) を叩く (base 分岐確認)。
    expect(
      fetchSpy.mock.calls.some((c) =>
        String(c[0]).startsWith("/realtime/daemons/d1/approvals/policy"),
      ),
    ).toBe(true);
  });
});
