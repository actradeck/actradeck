/**
 * INV-SESSION-IDENTITY (P0, ADR 019e9462 / task 019e943b).
 *
 * 1 managed claude = 1 session (LEVEL 0 KPI)。hook 由来(claude UUID)と監視由来
 * (heartbeat/diff/output)が **同一 canonical session_id** に集約されることを固定する。
 *
 * 不変条件:
 *  (i)   learn 後の監視 emit が canonical(= hook session_id)を載せる(固定 id を捨てている)。
 *  (ii)  canonical 確定**前**の監視イベントは hold され、確定後に canonical id で
 *        **発生時刻(ts)順**に flush される(別 id 漏れゼロ・INV-EVENT-ORDER 整合)。
 *  (iii) hook 皆無 + timeout で fallback(ACTRADECK_SESSION)に flush され**非破棄**。
 *
 * 整合性(他 INV を破らない根拠):
 *  - INV-REDACTION: hold するのは raw でなく `() => sink.emit(builder())` の thunk。flush も
 *    必ず sink.emit(redact→parse→persist→send)を通る → choke point 不変(別途 sink 経路で検証)。
 *  - INV-IDEMPOTENCY: thunk は flush 時に buildEvent(event_id 採番)を 1 回だけ呼ぶ。
 *  - INV-EVENT-ORDER: flush は投入順=発生時刻順。thunk が固定 timestamp を保持する。
 *
 * mutation kill: learn を no-op 化 / hold をバイパス(即 fallback emit) / flush 時刻で
 * timestamp 上書き、のいずれでも本テストが赤になる。
 */
import { describe, expect, it } from "vitest";

import { buildEvent } from "../src/event-factory.js";
import { SessionIdentity } from "../src/session-identity.js";
import { EventSink } from "../src/sink.js";
import { EventStore } from "../src/store.js";
import type { WsClient } from "../src/ws-client.js";

interface Emitted {
  readonly session_id: string;
  readonly provider_session_id?: string;
  readonly event_type: string;
  readonly timestamp: string;
  readonly category: "heartbeat" | "diff" | "output";
}

/**
 * 監視 emitter の挙動を最小再現する。identity.emitMonitoring 経由で、確定済みなら即 emit、
 * 未確定なら hold し、確定後に canonical id で flush する(本番 emitter と同型の配線)。
 */
function emitMonitoring(
  identity: SessionIdentity,
  sink: Emitted[],
  category: Emitted["category"],
  event_type: string,
  observedAt: string,
  providerSessionId?: string,
): void {
  identity.emitMonitoring(category, (canonicalSessionId) => {
    // category ごとに判別 union(EventPayload)へ適合する最小 payload を組む。
    const payload: Record<string, unknown> =
      category === "heartbeat"
        ? { kind: "heartbeat", process_alive: true }
        : category === "diff"
          ? {
              kind: "diff.updated",
              diff_hash: "h",
              changed_files: 1,
              added_lines: 1,
              removed_lines: 0,
            }
          : { kind: "command.output.delta", stream: "stdout", delta: "x" };
    // 本番同様 buildEvent を flush 時に呼ぶ(event_id 採番は 1 回・INV-IDEMPOTENCY)。
    const ev = buildEvent({
      session_id: canonicalSessionId,
      event_type: event_type as Parameters<typeof buildEvent>[0]["event_type"],
      timestamp: observedAt,
      ...(providerSessionId !== undefined ? { provider_session_id: providerSessionId } : {}),
      payload,
    });
    sink.push({
      session_id: ev.session_id,
      ...(ev.provider_session_id !== undefined
        ? { provider_session_id: ev.provider_session_id }
        : {}),
      event_type: ev.event_type,
      timestamp: ev.timestamp,
      category,
    });
  });
}

const HOOK_SID = "679e5e1b-f205-4a17-9b2e-0c1d2e3f4a5b"; // claude hook session_id (UUID)
const FALLBACK = "sess_live_probe_002"; // ACTRADECK_SESSION 自動採番

describe("INV-SESSION-IDENTITY: 1 managed run = 1 canonical session_id", () => {
  it("(i) post-learn monitoring emits carry the canonical hook session_id (not the baked fallback)", () => {
    const identity = new SessionIdentity({ fallbackSessionId: FALLBACK });
    const emitted: Emitted[] = [];

    // hook が先に来て canonical を確定。
    expect(identity.learn(HOOK_SID)).toBe(true);
    expect(identity.isResolved()).toBe(true);
    expect(identity.resolvedSessionId()).toBe(HOOK_SID);

    // 確定後の監視 emit は canonical(= HOOK_SID)を載せる。固定 fallback は出ない。
    emitMonitoring(identity, emitted, "heartbeat", "heartbeat", "2026-06-04T10:00:01.000Z");
    emitMonitoring(identity, emitted, "diff", "diff.updated", "2026-06-04T10:00:02.000Z");
    emitMonitoring(identity, emitted, "output", "command.output.delta", "2026-06-04T10:00:03.000Z");

    expect(emitted).toHaveLength(3);
    expect(emitted.every((e) => e.session_id === HOOK_SID)).toBe(true);
    expect(emitted.some((e) => e.session_id === FALLBACK)).toBe(false);
  });

  it("(ii) pre-confirm monitoring events are HELD then flushed in occurrence-time order with canonical id", () => {
    const identity = new SessionIdentity({ fallbackSessionId: FALLBACK });
    const emitted: Emitted[] = [];

    // canonical 未確定の状態で監視イベントが発生(起動直後 heartbeat / 初回 diff / 早期 output)。
    emitMonitoring(identity, emitted, "heartbeat", "heartbeat", "2026-06-04T10:00:00.100Z");
    emitMonitoring(identity, emitted, "diff", "diff.updated", "2026-06-04T10:00:00.200Z");
    emitMonitoring(identity, emitted, "output", "command.output.delta", "2026-06-04T10:00:00.300Z");

    // hold されており、まだ 1 件も emit されていない(別 id で先に漏れていない)。
    expect(emitted).toHaveLength(0);
    expect(identity.heldCount).toBe(3);

    // 最初の hook 到着で canonical 確定 → held が flush される。
    identity.learn(HOOK_SID);

    // 3 件すべてが canonical id で、**発生時刻順**(投入順)に flush。
    expect(emitted).toHaveLength(3);
    expect(emitted.map((e) => e.session_id)).toEqual([HOOK_SID, HOOK_SID, HOOK_SID]);
    expect(emitted.map((e) => e.event_type)).toEqual([
      "heartbeat",
      "diff.updated",
      "command.output.delta",
    ]);
    // timestamp は **観測時刻**を保持(flush 時刻で上書きしない)→ 単調非減少。
    expect(emitted.map((e) => e.timestamp)).toEqual([
      "2026-06-04T10:00:00.100Z",
      "2026-06-04T10:00:00.200Z",
      "2026-06-04T10:00:00.300Z",
    ]);
    const ms = emitted.map((e) => Date.parse(e.timestamp));
    expect(ms[1]!).toBeGreaterThanOrEqual(ms[0]!);
    expect(ms[2]!).toBeGreaterThanOrEqual(ms[1]!);
    expect(identity.heldCount).toBe(0);
  });

  it("(ii) post-confirm + pre-confirm of the SAME run all collapse into ONE session_id", () => {
    const identity = new SessionIdentity({ fallbackSessionId: FALLBACK });
    const emitted: Emitted[] = [];

    // 早期(確定前)監視。
    emitMonitoring(identity, emitted, "heartbeat", "heartbeat", "2026-06-04T10:00:00.000Z");
    // hook が learn → 確定 + flush。
    identity.learn(HOOK_SID);
    // 確定後の監視。
    emitMonitoring(identity, emitted, "heartbeat", "heartbeat", "2026-06-04T10:00:01.000Z");

    // 早期 + 後期が単一 canonical に集約(2 セッションに割れない = LEVEL 0 KPI)。
    const distinct = new Set(emitted.map((e) => e.session_id));
    expect(distinct.size).toBe(1);
    expect([...distinct][0]).toBe(HOOK_SID);
  });

  it("(iii) with NO hook, fallback flush uses ACTRADECK_SESSION and drops nothing", () => {
    const identity = new SessionIdentity({ fallbackSessionId: FALLBACK });
    const emitted: Emitted[] = [];

    emitMonitoring(identity, emitted, "heartbeat", "heartbeat", "2026-06-04T10:00:00.100Z");
    emitMonitoring(identity, emitted, "diff", "diff.updated", "2026-06-04T10:00:00.200Z");
    expect(emitted).toHaveLength(0); // hold 中

    // hook 皆無 → タイムアウト相当の fallback flush(本番は timer、ここは手動駆動)。
    identity.flushWithFallback();

    // fallback id で**非破棄**(全件 flush)。
    expect(emitted).toHaveLength(2);
    expect(emitted.every((e) => e.session_id === FALLBACK)).toBe(true);
    expect(identity.isResolved()).toBe(true);
    expect(identity.resolvedSessionId()).toBe(FALLBACK);
  });

  it("learn-once: a later DIFFERENT session_id does not override the first (no projection split)", () => {
    const identity = new SessionIdentity({ fallbackSessionId: FALLBACK });
    expect(identity.learn(HOOK_SID)).toBe(true);
    // resume 等で別 id が来ても最初を保持(後勝ち併合しない)。
    expect(identity.learn("00000000-1111-2222-3333-444444444444")).toBe(false);
    expect(identity.resolvedSessionId()).toBe(HOOK_SID);
  });

  it("explicit mode (backward compat): externally-given session_id resolves immediately, no hold", () => {
    const identity = new SessionIdentity({
      fallbackSessionId: "s1",
      explicitSessionId: "s1",
    });
    const emitted: Emitted[] = [];
    expect(identity.isResolved()).toBe(true);
    emitMonitoring(identity, emitted, "heartbeat", "heartbeat", "2026-06-04T10:00:00.000Z");
    // 即 emit(hold しない)。canonical = 明示 id。
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.session_id).toBe("s1");
    // explicit 確定後に hook が来ても明示値を保持(外部指定が勝つ)。
    expect(identity.learn(HOOK_SID)).toBe(false);
    expect(identity.resolvedSessionId()).toBe("s1");
  });

  it("hold buffer is bounded: heartbeats are trimmed (newest-first) but diff/output are kept", () => {
    const dropped: { category: string; reason: string }[] = [];
    const identity = new SessionIdentity({
      fallbackSessionId: FALLBACK,
      maxHeld: 3,
      onHoldDropped: (category, reason) => dropped.push({ category, reason }),
    });
    const emitted: Emitted[] = [];

    // diff/output は保持優先で 2 件積む。
    emitMonitoring(identity, emitted, "diff", "diff.updated", "2026-06-04T10:00:00.000Z");
    emitMonitoring(identity, emitted, "output", "command.output.delta", "2026-06-04T10:00:00.001Z");
    // heartbeat を上限超過まで積む(最古から間引かれる)。
    for (let i = 0; i < 5; i++) {
      emitMonitoring(
        identity,
        emitted,
        "heartbeat",
        "heartbeat",
        new Date(Date.parse("2026-06-04T10:00:01.000Z") + i).toISOString(),
      );
    }

    // bounded: held は maxHeld を超えない。
    expect(identity.heldCount).toBeLessThanOrEqual(3);
    // 間引かれたのは heartbeat のみ(diff/output は保持優先)。
    expect(dropped.every((d) => d.category === "heartbeat")).toBe(true);
    expect(dropped.length).toBeGreaterThan(0);

    // 確定後 flush。diff/output は必ず残る(情報価値が高い)。
    identity.learn(HOOK_SID);
    const cats = emitted.map((e) => e.category);
    expect(cats).toContain("diff");
    expect(cats).toContain("output");
    // 残った最新 heartbeat が含まれる(最古が落ちている)。
    expect(cats).toContain("heartbeat");
    expect(emitted.every((e) => e.session_id === HOOK_SID)).toBe(true);
  });

  it("dispose flushes still-held events via fallback (no loss on shutdown)", () => {
    const identity = new SessionIdentity({ fallbackSessionId: FALLBACK });
    const emitted: Emitted[] = [];
    emitMonitoring(identity, emitted, "diff", "diff.updated", "2026-06-04T10:00:00.000Z");
    expect(emitted).toHaveLength(0);
    identity.dispose();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.session_id).toBe(FALLBACK);
  });

  // --- INV-REDACTION choke point 不変: hold→flush も sink.emit(redact→parse→persist)を通る ---
  // hold は raw を保持しない(thunk のみ)。flush 時に sink.emit を通すため、held 監視イベントの
  // payload に混入した secret も redaction される(SQLite に平文残留しない)。
  // hold をバイパスして raw を直接 persist する実装に変えると、この test が赤になる。
  it("INV-REDACTION: a held monitoring event flushed post-confirm is redacted in SQLite under the canonical id", () => {
    const store = new EventStore(":memory:");
    const wsClient = { notifyAppended: () => {} } as unknown as WsClient;
    const sink = new EventSink({ store, wsClient });
    const identity = new SessionIdentity({ fallbackSessionId: FALLBACK });

    const SECRET = "ghp_0123456789abcdefghijABCDEFGHIJ0123"; // github-token (redact 対象)

    // canonical 未確定で、secret を含む output delta を hold(emit を遅らせる)。
    const observedAt = "2026-06-04T10:00:00.000Z";
    identity.emitMonitoring("output", (canonicalSessionId) => {
      sink.emit(
        buildEvent({
          session_id: canonicalSessionId,
          event_type: "command.output.delta",
          timestamp: observedAt,
          payload: { kind: "command.output.delta", stream: "stdout", delta: `token=${SECRET}` },
        }),
      );
    });
    // hold 中: まだ persist されていない(別 id でも平文でも漏れていない)。
    expect(store.totalCount()).toBe(0);

    // hook 確定 → flush → sink.emit(redact→parse→persist)を通る。
    identity.learn(HOOK_SID);

    const rows = store.allRows();
    expect(rows).toHaveLength(1);
    // canonical id で永続。
    expect(rows[0]!.session_id).toBe(HOOK_SID);
    // secret は平文で残らない(redaction choke point 通過)。token= プレフィックスにより
    // credential-assignment / github-token いずれかの REDACTED マーカへ置換される(どちらも可)。
    expect(rows[0]!.event_json).not.toContain(SECRET);
    expect(rows[0]!.event_json).toContain("[REDACTED:");
    store.close();
  });
});
