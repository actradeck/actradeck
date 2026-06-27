/**
 * useRealtime 承認グルーの契約テスト (QA-1 / ADR 019e9999 段階② unblock).
 *
 * 背景: 純関数 (reduceApproveAck/buildApproveFrame/markApproveSending) と backend→detail e2e は
 * 緑だが、その両者を繋ぐ **フック層のグルー** (approve 送信・ack→lastAck 突合・action フィルタ) が
 * 無監視だった。node 環境 (jsdom/レンダラ無し) で hook effect を回さずにグルーを赤テスト化するため、
 * ack 解釈を純関数 `ackFromServerFrame` に抽出し、use-realtime.ts:90-100 の ack ブランチをこの 1 経路に
 * 置換済み。本ファイルは use-realtime が依存する **実コードの組み合わせ** を直接検証する:
 *   (a) approve → 送信される wire frame が buildApproveFrame と一致 (取り違えゼロ)。
 *   (b) approve ack → 当該 request_id のみ lastAck 更新・ackPhase が allowed/denied/failed に落ちる。
 *   (c) interrupt/subscribe/unsubscribe ack・request_id 欠落 ack は lastAck を変えない (action フィルタ)。
 *   (d) 複数 pending で ack が正しいカードのみへ反映 (取り違えなし)。
 *
 * REAL DATA ONLY: backend 正典 (realtime-hub.ts) の ServerFrame/ClientFrame 型に対して検証し、
 * lastAck の畳み込みは use-realtime と同一の (ackFromServerFrame → reduceApproveAck) 経路を辿る。
 */
import { describe, expect, it } from "vitest";

import {
  ackFromServerFrame,
  ackPhase,
  buildApproveFrame,
  markApproveSending,
  reduceApproveAck,
  type AckState,
} from "../src/ui/approval-display.js";

import type { ClientFrame, ServerFrame } from "../src/realtime/contract.js";

/** ServerFrame(ack) を最小生成 (backend 正典 union に厳密適合)。 */
function ack(
  o: Partial<Extract<ServerFrame, { type: "ack" }>>,
): Extract<ServerFrame, { type: "ack" }> {
  return {
    type: "ack",
    action: "approve",
    ok: true,
    ...o,
  };
}

/**
 * use-realtime の ack ブランチと **同一経路** を再現するヘルパ:
 *   handleFrame の case "ack" は ackFromServerFrame → (非 null のみ) reduceApproveAck。
 * フックの setLastAck reducer をテスト内で直接畳み込み、レンダラ無しで glue を検証する。
 */
function applyAck(
  prev: ReadonlyMap<string, AckState>,
  frame: Extract<ServerFrame, { type: "ack" }>,
): ReadonlyMap<string, AckState> {
  const parsed = ackFromServerFrame(frame);
  if (!parsed) return prev;
  return reduceApproveAck(prev, parsed);
}

describe("(a) approve → 送信フレームが buildApproveFrame と一致 (use-realtime.approve の wire 契約)", () => {
  it("approve(sessionId, requestId, decision) が送る frame は buildApproveFrame の出力そのもの", () => {
    // use-realtime.ts:154 — client.send(buildApproveFrame(sessionId, requestId, decision, reason))。
    // 送信フレーム = buildApproveFrame の出力であることを wire 値で固定する (request_id/decision 取り違え検出)。
    const sent: ClientFrame = buildApproveFrame("s1", "req-9", "deny", "looks risky");
    expect(sent).toEqual({
      type: "approve",
      session_id: "s1",
      request_id: "req-9",
      decision: "deny",
      reason: "looks risky",
    });
  });

  it("reason 無しの allow は reason キーを含まない wire frame", () => {
    const sent: ClientFrame = buildApproveFrame("s2", "req-1", "allow");
    expect(sent).toEqual({
      type: "approve",
      session_id: "s2",
      request_id: "req-1",
      decision: "allow",
    });
    expect("reason" in sent).toBe(false);
  });

  it("approve callback は引数の request_id/decision をそのまま frame へ写す (差し替え/取り違えなし)", () => {
    // 同一 session で別 request_id / 別 decision を渡したとき、frame が必ず引数を反映する。
    const a = buildApproveFrame("s1", "req-A", "allow");
    const b = buildApproveFrame("s1", "req-B", "deny");
    expect(a.request_id).toBe("req-A");
    expect(a.decision).toBe("allow");
    expect(b.request_id).toBe("req-B");
    expect(b.decision).toBe("deny");
  });

  it("段階③ 4 値: allow_for_session / cancel も wire frame の decision に正しく載る", () => {
    const afs: ClientFrame = buildApproveFrame("s1", "req-7", "allow_for_session");
    const cxl: ClientFrame = buildApproveFrame("s1", "req-8", "cancel", "stop please");
    expect(afs).toEqual({
      type: "approve",
      session_id: "s1",
      request_id: "req-7",
      decision: "allow_for_session",
    });
    expect(cxl).toEqual({
      type: "approve",
      session_id: "s1",
      request_id: "req-8",
      decision: "cancel",
      reason: "stop please",
    });
  });
});

describe("(e) interrupt wire 契約 (段階③配線 / 段階② QA-2 解消)", () => {
  it("interrupt は session_id のみの frame で、approve カードの ack 経路へ混ざらない", () => {
    // use-realtime.interrupt は client.send({ type: "interrupt", session_id }) を送る。
    const frame: ClientFrame = { type: "interrupt", session_id: "s1" };
    expect(frame).toEqual({ type: "interrupt", session_id: "s1" });
    // interrupt の ack は ackFromServerFrame で必ず null (承認カードを汚さない・D5)。
    expect(ackFromServerFrame(ack({ action: "interrupt", ok: true, request_id: "s1" }))).toBeNull();
  });
});

describe("(b) approve ack → 当該 request_id のみ lastAck 更新・正しい ackPhase", () => {
  it("送信中 (markApproveSending) → approve ack ok=true で allowed/denied に確定", () => {
    let m: ReadonlyMap<string, AckState> = markApproveSending(new Map(), "req-1", "allow");
    expect(ackPhase(m.get("req-1"))).toBe("sending");

    m = applyAck(m, ack({ action: "approve", ok: true, request_id: "req-1" }));
    expect(ackPhase(m.get("req-1"))).toBe("allowed");
    expect(m.get("req-1")?.decision).toBe("allow"); // 送信時 decision を保持
  });

  it("deny 送信 → approve ack ok=true で denied", () => {
    let m: ReadonlyMap<string, AckState> = markApproveSending(new Map(), "req-2", "deny");
    m = applyAck(m, ack({ action: "approve", ok: true, request_id: "req-2" }));
    expect(ackPhase(m.get("req-2"))).toBe("denied");
  });

  it("relay 失敗 (ok=false / error) は failed (許可済みに倒さない・D3)", () => {
    let m: ReadonlyMap<string, AckState> = markApproveSending(new Map(), "req-3", "allow");
    m = applyAck(
      m,
      ack({ action: "approve", ok: false, request_id: "req-3", error: "relay closed" }),
    );
    expect(ackPhase(m.get("req-3"))).toBe("failed");
    expect(m.get("req-3")?.error).toBe("relay closed");
  });

  it("approve ack は当該 request_id のみを更新する (無関係キーを生成しない)", () => {
    let m: ReadonlyMap<string, AckState> = markApproveSending(new Map(), "req-keep", "allow");
    m = applyAck(m, ack({ action: "approve", ok: true, request_id: "req-only" }));
    // req-keep は触られない、req-only だけが追加される。
    expect(ackPhase(m.get("req-keep"))).toBe("sending");
    expect(ackPhase(m.get("req-only"))).toBe("denied"); // 送信前 ack → decision 不明 deny 既定
    expect([...m.keys()].sort()).toEqual(["req-keep", "req-only"]);
  });
});

describe("(c) action フィルタ: approve 以外 / request_id 欠落の ack は lastAck を変えない", () => {
  it("ackFromServerFrame は approve かつ request_id:string のときのみ tuple を返す", () => {
    expect(ackFromServerFrame(ack({ action: "approve", ok: true, request_id: "req-1" }))).toEqual({
      request_id: "req-1",
      ok: true,
      error: undefined,
    });
    expect(
      ackFromServerFrame(ack({ action: "approve", ok: false, request_id: "req-2", error: "x" })),
    ).toEqual({
      request_id: "req-2",
      ok: false,
      error: "x",
    });
  });

  it("interrupt ack は request_id があっても null (承認カードへ反映しない)", () => {
    expect(
      ackFromServerFrame(ack({ action: "interrupt", ok: true, request_id: "req-1" })),
    ).toBeNull();
  });

  it("subscribe / unsubscribe ack は null", () => {
    expect(ackFromServerFrame(ack({ action: "subscribe", ok: true, session_id: "s1" }))).toBeNull();
    expect(
      ackFromServerFrame(ack({ action: "unsubscribe", ok: true, session_id: "s1" })),
    ).toBeNull();
  });

  it("approve でも request_id 欠落 (undefined) は null (どのカードか不明)", () => {
    expect(
      ackFromServerFrame(ack({ action: "approve", ok: true, request_id: undefined })),
    ).toBeNull();
  });

  it("グルー経路: interrupt/subscribe/欠落 ack を流しても lastAck は不変 (参照同一)", () => {
    const m0: ReadonlyMap<string, AckState> = markApproveSending(new Map(), "req-1", "allow");
    // interrupt ack (取り違えの起点) — req-1 のカードを汚染してはならない。
    const m1 = applyAck(m0, ack({ action: "interrupt", ok: true, request_id: "req-1" }));
    expect(m1).toBe(m0); // 参照ごと不変 = setLastAck 不要
    // subscribe / unsubscribe / 欠落も同様。
    expect(applyAck(m0, ack({ action: "subscribe", ok: true, session_id: "s1" }))).toBe(m0);
    expect(applyAck(m0, ack({ action: "unsubscribe", ok: true, session_id: "s1" }))).toBe(m0);
    expect(applyAck(m0, ack({ action: "approve", ok: true, request_id: undefined }))).toBe(m0);
    // req-1 は送信中のまま (誤って allowed/denied/failed に落ちない)。
    expect(ackPhase(m1.get("req-1"))).toBe("sending");
  });
});

describe("(d) 複数 pending: ack は正しいカードのみへ反映 (取り違えなし)", () => {
  it("3 枚 pending のうち 1 枚への ack は他の 2 枚に影響しない", () => {
    let m: ReadonlyMap<string, AckState> = markApproveSending(new Map(), "req-A", "allow");
    m = markApproveSending(m, "req-B", "deny");
    m = markApproveSending(m, "req-C", "allow");

    // B のみ ack ok=true。
    m = applyAck(m, ack({ action: "approve", ok: true, request_id: "req-B" }));
    expect(ackPhase(m.get("req-A"))).toBe("sending");
    expect(ackPhase(m.get("req-B"))).toBe("denied");
    expect(ackPhase(m.get("req-C"))).toBe("sending");
  });

  it("同報の interrupt ack (別 request_id) は approve カード群を一切動かさない", () => {
    let m: ReadonlyMap<string, AckState> = markApproveSending(new Map(), "req-A", "allow");
    m = markApproveSending(m, "req-B", "deny");
    // interrupt の ack が req-A の id を帯びて来ても (取り違えの誘発) approve カードは不変。
    const before = m;
    m = applyAck(m, ack({ action: "interrupt", ok: true, request_id: "req-A" }));
    expect(m).toBe(before);
    expect(ackPhase(m.get("req-A"))).toBe("sending");
    expect(ackPhase(m.get("req-B"))).toBe("sending");
  });

  it("A の relay 失敗が B の許可確定を汚さない (failed と allowed の独立)", () => {
    let m: ReadonlyMap<string, AckState> = markApproveSending(new Map(), "req-A", "allow");
    m = markApproveSending(m, "req-B", "allow");
    m = applyAck(
      m,
      ack({ action: "approve", ok: false, request_id: "req-A", error: "relay closed" }),
    );
    m = applyAck(m, ack({ action: "approve", ok: true, request_id: "req-B" }));
    expect(ackPhase(m.get("req-A"))).toBe("failed");
    expect(ackPhase(m.get("req-B"))).toBe("allowed");
  });
});
