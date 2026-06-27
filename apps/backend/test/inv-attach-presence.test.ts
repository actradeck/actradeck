/**
 * INV-ATTACH-PRESENCE (ADR 019ea476 D4) — presence-attach は SidecarRegistry を共有する。
 *
 * membership は **authoritative-per-connection** (ADR 019eb365 で additive から変更):
 * handleHello は接続の session 集合を権威とし、集合外の session は releaseSession で grace
 * 解放する (下記 INV-PRESENCE-RELEASE が release 半面を担保)。旧記述の「無改変再利用」は失効。
 *
 * Attach は単一 daemon conn が **複数 attach session を多重所有**する (SidecarConn.sessions:Set)。
 * presence = daemon conn の link.open (= 既存 isLive)。終端差異は liveness_state で表現し、
 * presence は接続在席のまま (presence ⊥ 鮮度, 019ea2bf)。
 *
 * 固定する不変条件:
 *  - 単一 conn が 2 つの attach session を observeSession で claim → 両方 isLive=true。
 *    mutation: sessions を Set でなく単一上書きにすると片方が落ち赤化。
 *  - daemon stop (link close) で grace 後に両方 out。
 *  - controlToken 無し (hook 観測のみ) でも isLive=true (presence ⊥ relay)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PRESENCE_GRACE_MS, SidecarRegistry, type SidecarLink } from "../src/sidecar-registry.js";

class FakeLink implements SidecarLink {
  readonly sent: string[] = [];
  open = true;
  send(data: string): void {
    if (!this.open) throw new Error("closed");
    this.sent.push(data);
  }
}

describe("INV-ATTACH-PRESENCE: 単一 daemon conn が複数 attach session を多重所有", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("one conn claims TWO attach sessions → both live AND both tracked in conn.sessions (multiplex set)", () => {
    const reg = new SidecarRegistry();
    const link = new FakeLink();
    reg.add(link);
    // attach daemon: hook 観測流で per-session を claim (hello.session_ids にも両方載る)。
    reg.observeSession(link, "attachA");
    reg.observeSession(link, "attachB");

    // (i) sessionOwner 経路: 両方 presence 在席。
    //   QA-2 真ゲート化の docstring 整合: この assertion が捕捉する mutation は
    //   **sessionOwner Map の単一上書き** (claim が sessionOwner.set を上書きで潰す等)。
    //   isLive/liveSessionIds は sessionOwner を読むため conn.sessions の上書き mutation は
    //   ここでは捕捉できない (QA-2 が指摘した偽ゲート)。↓ (ii) で conn.sessions 経路を踏む。
    expect(reg.isLive("attachA")).toBe(true);
    expect(reg.isLive("attachB")).toBe(true);
    expect(reg.liveSessionIds().sort()).toEqual(["attachA", "attachB"]);

    // (ii) conn.sessions (multiplex set) 経路: remove は conn.sessions を反復し、各 session を
    //   sessionOwner から解放して grace を張り、満了で onPresenceChange(false) を発火する。
    //   conn.sessions が単一上書きで片方しか保持しないと、落ちた session には grace が張られず
    //   **out 通知 (delta.list connected=false) が永久に出ない** = UI が切断を観測できない片落ち。
    //   両 session の false delta が **必ず** 出ることを assert し、conn.sessions 上書き mutation を捕捉する。
    const outNotified: string[] = [];
    reg.onPresenceChange((sid, live) => {
      if (!live) outNotified.push(sid);
    });
    link.open = false;
    reg.remove(link);
    vi.advanceTimersByTime(PRESENCE_GRACE_MS + 1);
    // 両方に out 通知が出る (conn.sessions 上書きなら片方の通知が欠落し赤化)。
    expect(outNotified.sort()).toEqual(["attachA", "attachB"]);
    expect(reg.isLive("attachA")).toBe(false);
    expect(reg.isLive("attachB")).toBe(false);
  });

  it("daemon stop (link close) → both attach sessions out after grace", () => {
    const reg = new SidecarRegistry();
    const link = new FakeLink();
    reg.add(link);
    reg.observeSession(link, "attachA");
    reg.observeSession(link, "attachB");

    link.open = false;
    reg.remove(link);
    // grace 中は両方 live。
    expect(reg.isLive("attachA")).toBe(true);
    expect(reg.isLive("attachB")).toBe(true);
    vi.advanceTimersByTime(PRESENCE_GRACE_MS + 1);
    // grace 満了で両方 out。
    expect(reg.isLive("attachA")).toBe(false);
    expect(reg.isLive("attachB")).toBe(false);
  });

  it("presence ⊥ relay: attach observe-only (no hello) is isLive but canRelay=false", () => {
    const reg = new SidecarRegistry();
    const link = new FakeLink();
    reg.add(link);
    reg.observeSession(link, "attachA");
    expect(reg.isLive("attachA")).toBe(true);
    expect(reg.canRelay("attachA")).toBe(false);
  });
});

describe("INV-PRESENCE-RELEASE: authoritative hello が集合外 session を grace 解放 (ADR 019eb365)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("再 hello で縮小した集合 → 外れた session を release し grace 満了で presence false", () => {
    const reg = new SidecarRegistry();
    const link = new FakeLink();
    reg.add(link);
    // 初回 hello: 2 session 所有 (attach daemon の sessionIds)。
    reg.handleHello(link, { type: "hello", control_token: "tok", session_ids: ["sessA", "sessB"] });
    expect(reg.isLive("sessA")).toBe(true);
    expect(reg.isLive("sessB")).toBe(true);

    const out: string[] = [];
    reg.onPresenceChange((sid, live) => {
      if (!live) out.push(sid);
    });

    // sidecar が sessB を reap → 縮小集合で hello 再送。authoritative hello で sessB を release。
    reg.handleHello(link, { type: "hello", control_token: "tok", session_ids: ["sessA"] });
    expect(reg.isLive("sessA")).toBe(true);
    expect(reg.isLive("sessB")).toBe(true); // grace 中はまだ live (点滅吸収)。
    vi.advanceTimersByTime(PRESENCE_GRACE_MS + 1);
    // 満了で sessB のみ out。mutation: additive-only (release しない) なら out が出ず赤化。
    expect(out).toEqual(["sessB"]);
    expect(reg.isLive("sessA")).toBe(true);
    expect(reg.isLive("sessB")).toBe(false);
  });

  it("grace 中の再 claim (次 hook で復帰) は release を cancel する (self-heal・flapping なし)", () => {
    const reg = new SidecarRegistry();
    const link = new FakeLink();
    reg.add(link);
    reg.handleHello(link, { type: "hello", control_token: "tok", session_ids: ["sessA", "sessB"] });
    const out: string[] = [];
    reg.onPresenceChange((sid, live) => {
      if (!live) out.push(sid);
    });
    // sessB を一旦 release。
    reg.handleHello(link, { type: "hello", control_token: "tok", session_ids: ["sessA"] });
    // grace 満了前に sessB を再 claim (誤 reap → 次 hook で observeHook→reannounce で復帰)。
    reg.handleHello(link, { type: "hello", control_token: "tok", session_ids: ["sessA", "sessB"] });
    vi.advanceTimersByTime(PRESENCE_GRACE_MS + 1);
    expect(out).toEqual([]); // out 通知なし (claim が grace cancel)。
    expect(reg.isLive("sessB")).toBe(true);
  });

  it("別接続が所有する session は authoritative hello で release しない (multiplex 安全)", () => {
    const reg = new SidecarRegistry();
    const linkA = new FakeLink();
    const linkB = new FakeLink();
    reg.add(linkA);
    reg.add(linkB);
    // linkA が sessShared を hello、linkB が後勝ちで sessShared を再 claim (所有 = linkB)。
    reg.handleHello(linkA, { type: "hello", control_token: "tA", session_ids: ["sessShared"] });
    reg.handleHello(linkB, { type: "hello", control_token: "tB", session_ids: ["sessShared"] });
    const out: string[] = [];
    reg.onPresenceChange((sid, live) => {
      if (!live) out.push(sid);
    });
    // linkA が空集合で再 hello。所有は linkB ゆえ sessShared を release してはいけない。
    reg.handleHello(linkA, { type: "hello", control_token: "tA", session_ids: [] });
    vi.advanceTimersByTime(PRESENCE_GRACE_MS + 1);
    expect(out).toEqual([]);
    expect(reg.isLive("sessShared")).toBe(true);
  });
});
