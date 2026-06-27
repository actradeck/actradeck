/**
 * INV-EVENT-ORDER (P0): 同一 event_id 冪等・セッション内順序保持 + 再送順序。
 *
 * SQLite append-only event log の不変条件:
 * - event_id UNIQUE で冪等 (二重投入は無視, 行は増えない)。
 * - pendingUnsent は seq 昇順 (= 発生順) で返す。
 * - markSent 後は unsent から外れ、再送で順序が壊れない。
 * - append-only: markSent は行を消さず sent_at のみ設定。
 */
import { describe, expect, it } from "vitest";

import { buildEvent } from "../src/event-factory.js";
import { EventSink, type OutOfOrderObservation } from "../src/sink.js";
import { EventStore } from "../src/store.js";
import type { WsClient } from "../src/ws-client.js";

describe("INV-EVENT-ORDER: EventStore append-only / idempotent / ordered", () => {
  it("assigns increasing seq in append order", () => {
    const store = new EventStore(":memory:");
    const e1 = buildEvent({
      session_id: "s1",
      event_type: "session.started",
      payload: { kind: "session.started" },
    });
    const e2 = buildEvent({
      session_id: "s1",
      event_type: "turn.started",
      payload: { kind: "turn.started" },
    });
    const seq1 = store.append(e1);
    const seq2 = store.append(e2);
    expect(seq2).toBeGreaterThan(seq1);
    const rows = store.allRows();
    expect(rows.map((r) => r.event_id)).toEqual([e1.event_id, e2.event_id]);
    store.close();
  });

  it("is idempotent on duplicate event_id (no extra row)", () => {
    const store = new EventStore(":memory:");
    const e1 = buildEvent({
      session_id: "s1",
      event_type: "heartbeat",
      payload: { kind: "heartbeat" },
    });
    const first = store.append(e1);
    const second = store.append(e1); // 二重投入
    expect(store.totalCount()).toBe(1);
    expect(second).toBe(first); // 同一 seq を返す
    store.close();
  });

  it("pendingUnsent returns seq-ascending and markSent removes from unsent (append-only)", () => {
    const store = new EventStore(":memory:");
    const events = Array.from({ length: 5 }, (_, i) =>
      buildEvent({
        session_id: "s1",
        event_type: "heartbeat",
        summary: `h${i}`,
        payload: { kind: "heartbeat" },
      }),
    );
    for (const e of events) store.append(e);

    const unsent = store.pendingUnsent();
    expect(unsent.map((r) => r.event_id)).toEqual(events.map((e) => e.event_id));

    // 先頭 2 件を送信済みに。
    store.markSent([events[0]!.event_id, events[1]!.event_id]);
    expect(store.unsentCount()).toBe(3);
    // append-only: 行数は減らない。
    expect(store.totalCount()).toBe(5);

    // 残りは順序を保ったまま。
    const rest = store.pendingUnsent();
    expect(rest.map((r) => r.event_id)).toEqual([
      events[2]!.event_id,
      events[3]!.event_id,
      events[4]!.event_id,
    ]);
    store.close();
  });

  // --- 3#QA-2: INV-EVENT-ORDER の production 配線 (EventSink.emit で out-of-order 観測) ---
  it("observes out-of-order on a timestamp regression via EventSink.emit (production path)", () => {
    const store = new EventStore(":memory:");
    const wsClient = { notifyAppended: () => {} } as unknown as WsClient;
    const observed: OutOfOrderObservation[] = [];
    const sink = new EventSink({ store, wsClient, onOutOfOrder: (o) => observed.push(o) });

    const t0 = "2026-06-04T10:00:05.000Z";
    const tBack = "2026-06-04T10:00:02.000Z"; // 3s 巻き戻り

    sink.emit(
      buildEvent({
        session_id: "s1",
        event_type: "heartbeat",
        timestamp: t0,
        payload: { kind: "heartbeat" },
      }),
    );
    // 時刻が後退したイベントを流す → out-of-order が観測される。
    const back = sink.emit(
      buildEvent({
        session_id: "s1",
        event_type: "heartbeat",
        timestamp: tBack,
        payload: { kind: "heartbeat" },
      }),
    );

    // (1) イベントは落とさない: persist/return される。
    expect(back).toBeDefined();
    expect(store.totalCount()).toBe(2);
    // (2) out-of-order が 1 件観測され、根拠 (regression_ms, high-water mark) が分解される。
    expect(observed).toHaveLength(1);
    expect(observed[0]?.session_id).toBe("s1");
    expect(observed[0]?.regression_ms).toBe(3000);
    expect(observed[0]?.high_water_mark_ms).toBe(Date.parse(t0));
    store.close();
  });

  it("does NOT flag monotonic non-decreasing timestamps (>= allowed, re-send safe)", () => {
    const store = new EventStore(":memory:");
    const wsClient = { notifyAppended: () => {} } as unknown as WsClient;
    const observed: OutOfOrderObservation[] = [];
    const sink = new EventSink({ store, wsClient, onOutOfOrder: (o) => observed.push(o) });

    const ts = "2026-06-04T10:00:05.000Z";
    // 同一時刻 (>=) の連続は at-least-once 再送で正常。後退ではないので観測しない。
    for (let i = 0; i < 3; i++) {
      sink.emit(
        buildEvent({
          session_id: "s1",
          event_type: "heartbeat",
          timestamp: ts,
          payload: { kind: "heartbeat" },
        }),
      );
    }
    // 別セッションの後退は s1 の high-water mark に影響しない (per-session)。
    sink.emit(
      buildEvent({
        session_id: "s2",
        event_type: "heartbeat",
        timestamp: "2026-06-04T09:00:00.000Z",
        payload: { kind: "heartbeat" },
      }),
    );
    expect(observed).toHaveLength(0);
    store.close();
  });

  // --- QA-1 (再#2): sink レベルの bounded order-checker (backend と対称) ---
  // long-running daemon で distinct session_id の flood を受けても、順序チェッカが保持する
  // 内部セッション数が上限を超えない (無界 Map によるメモリリークがない)。
  // 無界実装 (MonotonicTimestampChecker) へ戻すと size が flood 件数まで膨らみ赤になる。
  it("keeps order-checker bounded under a distinct-session_id flood (no unbounded growth)", () => {
    const store = new EventStore(":memory:");
    const wsClient = { notifyAppended: () => {} } as unknown as WsClient;
    const observed: OutOfOrderObservation[] = [];
    const MAX = 100;
    const FLOOD = 10_000;
    const sink = new EventSink({
      store,
      wsClient,
      maxOrderSessions: MAX,
      onOutOfOrder: (o) => observed.push(o),
    });

    const base = Date.parse("2026-06-04T10:00:00.000Z");
    for (let i = 0; i < FLOOD; i++) {
      const ev = sink.emit(
        buildEvent({
          session_id: `sess_${i}`,
          event_type: "heartbeat",
          timestamp: new Date(base + i).toISOString(),
          payload: { kind: "heartbeat" },
        }),
      );
      // INV-EVENT-ORDER: イベントは 1 件も落とさない (bounded 化しても persist 継続)。
      expect(ev).toBeDefined();
    }

    // (1) 全イベントが append される (非破棄)。
    expect(store.totalCount()).toBe(FLOOD);
    // (2) 各セッションは初出のみ (後退なし) なので out-of-order は 0 件 (挙動不変)。
    expect(observed).toHaveLength(0);
    // (3) bounded: 内部で追跡するセッション数は上限を超えない。
    //     無界実装に戻すと orderTrackedSessions === FLOOD となり、この 2 つの assert が赤になる。
    expect(sink.orderTrackedSessions).toBeLessThanOrEqual(MAX);
    expect(sink.orderTrackedSessions).toBe(MAX);
    store.close();
    // 意図的に重い stress テスト (10k distinct-session flood)。フル並列実行の CPU 競合で
    // default 5s を割ることがある contention flake を防ぐため明示 timeout を与える。
    // 不変条件アサート (非破棄 / bounded ≤ MAX / 無界実装なら赤) は一切変えていない。
  }, 30_000);

  // --- QA-1 (再#5): flood (size==MAX) 後も追跡継続中セッションは out-of-order を検出し続ける ---
  // bounded order-checker は退避済みセッションの巻き戻りを取りこぼすが (既知トレードオフ)、
  // **active set に残るセッション**は検出を維持しなければならない。flood で MAX を埋めた後でも
  // 追跡継続中セッションへ後退イベントを流すと onOutOfOrder が発火することを sink レベルで固定する。
  // (eviction を active set 未満へ広げると active セッションが退避され、この assert が赤になる。)
  it("QA-1: a tracked active session keeps firing onOutOfOrder after a distinct-session flood (size==MAX)", () => {
    const store = new EventStore(":memory:");
    const wsClient = { notifyAppended: () => {} } as unknown as WsClient;
    const observed: OutOfOrderObservation[] = [];
    const MAX = 50;
    const sink = new EventSink({
      store,
      wsClient,
      maxOrderSessions: MAX,
      onOutOfOrder: (o) => observed.push(o),
    });

    const base = Date.parse("2026-06-04T10:00:00.000Z");
    // (a) active セッション "live" の high-water mark を確立。
    sink.emit(
      buildEvent({
        session_id: "live",
        event_type: "heartbeat",
        timestamp: new Date(base + 10_000).toISOString(),
        payload: { kind: "heartbeat" },
      }),
    );

    // (b) MAX を超える distinct session_id を flood しつつ、合間に "live" を毎回触って
    //     active set 内に留める (LRU で退避されないよう most-recently-used に保つ)。
    for (let i = 0; i < 5_000; i++) {
      sink.emit(
        buildEvent({
          session_id: `flood_${i}`,
          event_type: "heartbeat",
          timestamp: new Date(base + i).toISOString(),
          payload: { kind: "heartbeat" },
        }),
      );
      if (i % 10 === 0) {
        // "live" を high-water mark で再観測 (>= なので非後退・onOutOfOrder は発火しない)。
        sink.emit(
          buildEvent({
            session_id: "live",
            event_type: "heartbeat",
            timestamp: new Date(base + 10_000).toISOString(),
            payload: { kind: "heartbeat" },
          }),
        );
      }
    }

    // bounded: 追跡数は上限内。
    expect(sink.orderTrackedSessions).toBeLessThanOrEqual(MAX);
    expect(sink.orderTrackedSessions).toBe(MAX);
    // ここまで "live" の後退は無いので観測ゼロ。
    expect(observed).toHaveLength(0);

    // (c) ★ flood 後、追跡継続中の "live" へ後退イベントを流す → onOutOfOrder が発火すること。
    //     "live" が退避されていれば未観測扱いとなり発火せず (赤)。active 維持を契約として固定。
    const back = sink.emit(
      buildEvent({
        session_id: "live",
        event_type: "heartbeat",
        timestamp: new Date(base + 7_000).toISOString(), // 3s 後退
        payload: { kind: "heartbeat" },
      }),
    );
    expect(back).toBeDefined(); // イベントは落とさない (append-only)
    expect(observed).toHaveLength(1);
    expect(observed[0]?.session_id).toBe("live");
    expect(observed[0]?.regression_ms).toBe(3_000);
    expect(observed[0]?.high_water_mark_ms).toBe(base + 10_000);
    store.close();
    // 同上: flood (5k) を伴う重い stress テスト。明示 timeout で contention flake を防ぐ
    // (active-set 維持 / 後退検出継続のアサートは不変)。
  }, 30_000);

  it("survives reopen (persisted) and preserves order — re-send after net outage", () => {
    // ネット断後の再送シナリオ: 一時ファイルに書いて再オープン。
    const path = `${process.env.TMPDIR ?? "/tmp"}/actradeck-order-${Date.now()}.db`;
    const store = new EventStore(path);
    const e1 = buildEvent({
      session_id: "s1",
      event_type: "session.started",
      payload: { kind: "session.started" },
    });
    const e2 = buildEvent({
      session_id: "s1",
      event_type: "session.ended",
      payload: { kind: "session.ended" },
    });
    store.append(e1);
    store.append(e2);
    store.close();

    const reopened = new EventStore(path);
    const unsent = reopened.pendingUnsent();
    expect(unsent.map((r) => r.event_id)).toEqual([e1.event_id, e2.event_id]);
    reopened.close();
  });
});
