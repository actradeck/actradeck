/**
 * INV-LIVE-PRESENCE — SidecarRegistry の接続在席(presence)契約 (ADR 019ea2bf).
 *
 * presence = 「いま Claude Code が起動中か」= 所有 sidecar 接続が open(または grace 中)。
 * 一覧 membership の権威信号。DB / WS を使わず偽 link + fake timer で純粋に赤化可能に固定する。
 *
 * 固定する不変条件:
 *  - claim(hello/observe)で in、onPresenceChange(true) を **一度だけ** 発火。
 *  - controlToken の有無は presence に無関係(presence ⊥ relay 認可)。
 *  - close は即 out にせず grace 経由(瞬断吸収)。grace 満了で out + onPresenceChange(false)。
 *  - grace 中の再 claim はタイマを cancel し、false を**一度も**出さない(点滅ゼロ)。
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

/** presence 変化を記録するスパイ。 */
function spyPresence(reg: SidecarRegistry): Array<{ sid: string; live: boolean }> {
  const log: Array<{ sid: string; live: boolean }> = [];
  reg.onPresenceChange((sid, live) => log.push({ sid, live }));
  return log;
}

describe("INV-LIVE-PRESENCE", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("hello claim → live + onPresenceChange(true) once; liveSessionIds に含む", () => {
    const reg = new SidecarRegistry();
    const log = spyPresence(reg);
    const link = new FakeLink();
    reg.add(link);
    reg.handleHello(link, { type: "hello", control_token: "ctl", session_ids: ["s1"] });

    expect(reg.isLive("s1")).toBe(true);
    expect(reg.liveSessionIds()).toContain("s1");
    expect(log).toEqual([{ sid: "s1", live: true }]);
  });

  it("presence ⊥ relay 認可: controlToken 未受領(observe のみ)でも isLive=true・canRelay=false", () => {
    const reg = new SidecarRegistry();
    const link = new FakeLink();
    reg.add(link);
    reg.observeSession(link, "s1"); // hello 無し = controlToken 未受領。

    expect(reg.isLive("s1")).toBe(true); // 起動中(在席)は真。
    expect(reg.canRelay("s1")).toBe(false); // relay は controlToken が要る(直交)。
  });

  it("同一 session の再 claim は二重に true を出さない(冪等)", () => {
    const reg = new SidecarRegistry();
    const log = spyPresence(reg);
    const link = new FakeLink();
    reg.add(link);
    reg.observeSession(link, "s1");
    reg.observeSession(link, "s1"); // 連続 ingest。
    reg.handleHello(link, { type: "hello", control_token: "ctl", session_ids: ["s1"] });

    expect(log).toEqual([{ sid: "s1", live: true }]); // true は一度だけ。
  });

  it("close は grace 経由: 即時は live、PRESENCE_GRACE_MS 後に out + onPresenceChange(false)", () => {
    const reg = new SidecarRegistry();
    const log = spyPresence(reg);
    const link = new FakeLink();
    reg.add(link);
    reg.handleHello(link, { type: "hello", control_token: "ctl", session_ids: ["s1"] });

    link.open = false;
    reg.remove(link);
    // grace 中: まだ在席。
    expect(reg.isLive("s1")).toBe(true);
    vi.advanceTimersByTime(PRESENCE_GRACE_MS - 1);
    expect(reg.isLive("s1")).toBe(true);
    // grace 満了: out 確定。
    vi.advanceTimersByTime(1);
    expect(reg.isLive("s1")).toBe(false);
    expect(reg.liveSessionIds()).not.toContain("s1");
    expect(log).toEqual([
      { sid: "s1", live: true },
      { sid: "s1", live: false },
    ]);
  });

  it("flapping: grace 中の再接続(再 claim)で false を一度も出さず live 維持(点滅ゼロ)", () => {
    const reg = new SidecarRegistry();
    const log = spyPresence(reg);
    const link1 = new FakeLink();
    reg.add(link1);
    reg.handleHello(link1, { type: "hello", control_token: "ctl", session_ids: ["s1"] });

    link1.open = false;
    reg.remove(link1); // 瞬断 → grace 開始。
    expect(reg.isLive("s1")).toBe(true);

    // grace 満了前に新接続が同 session を claim(自動再接続+再 hello)。
    vi.advanceTimersByTime(PRESENCE_GRACE_MS - 10);
    const link2 = new FakeLink();
    reg.add(link2);
    reg.handleHello(link2, { type: "hello", control_token: "ctl", session_ids: ["s1"] });

    // QA-1 直接 pin: 再 claim が grace タイマを **cancel** したこと(dangling timer 不在)を
    // 観測でなく実体で固定する(claim の clearTimeout を外すと pendingGraceCount=1 で赤化)。
    expect(reg.pendingGraceCount).toBe(0);

    // 旧 grace タイマが満了する時刻を過ぎても false は出ない(cancel 済)。
    vi.advanceTimersByTime(PRESENCE_GRACE_MS);
    expect(reg.isLive("s1")).toBe(true);
    expect(log).toEqual([{ sid: "s1", live: true }]); // 終始 live、false 0 件。
  });

  it("dispose(): pending grace タイマを全 clear し、以降 false を emit しない(shutdown 即時化)", () => {
    const reg = new SidecarRegistry();
    const log = spyPresence(reg);
    const link = new FakeLink();
    reg.add(link);
    reg.handleHello(link, { type: "hello", control_token: "ctl", session_ids: ["s1", "s2"] });

    link.open = false;
    reg.remove(link); // 2 件 grace 開始。
    expect(reg.pendingGraceCount).toBe(2);

    reg.dispose();
    expect(reg.pendingGraceCount).toBe(0); // 全 timer clear(event loop を居座らせない)。

    // dispose 後は満了コールバックも走らず、リスナ解放で false 通知も出ない。
    vi.advanceTimersByTime(PRESENCE_GRACE_MS * 2);
    expect(log.filter((e) => !e.live)).toEqual([]);
  });

  it("複数 session を所有: close で各々独立に grace→out", () => {
    const reg = new SidecarRegistry();
    const log = spyPresence(reg);
    const link = new FakeLink();
    reg.add(link);
    reg.handleHello(link, { type: "hello", control_token: "ctl", session_ids: ["a", "b"] });
    expect(reg.liveSessionIds().sort()).toEqual(["a", "b"]);

    link.open = false;
    reg.remove(link);
    vi.advanceTimersByTime(PRESENCE_GRACE_MS);
    expect(reg.isLive("a")).toBe(false);
    expect(reg.isLive("b")).toBe(false);
    const falses = log
      .filter((e) => !e.live)
      .map((e) => e.sid)
      .sort();
    expect(falses).toEqual(["a", "b"]);
  });
});
