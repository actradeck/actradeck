/**
 * INV-EVENT-MONOTONIC (bounded): TDA-3 — 順序チェッカが long-running でも無制限増加しない。
 *
 * 契約:
 * - 単調性の意味論は MonotonicTimestampChecker と同一 (>= 受理 / 巻き戻り false / 不正 false)。
 * - **大量の distinct session_id を投入しても保持数が maxSessions を超えない (bounded)**。
 * - LRU: 活動中 (直近アクセス) セッションは退避されない。最も古い静止セッションから落ちる。
 * - TTL 指定時、最終アクセスから ttlMs 超過のエントリは失効 (未観測扱い)。
 * - terminal で reset を呼ばずとも bound されることが本質 (再送巻き戻り検出を捨てない設計)。
 */
import { describe, expect, it } from "vitest";

import { BoundedMonotonicTimestampChecker } from "../src/index.js";

const isoAt = (ms: number): string => new Date(ms).toISOString();
const BASE = 1_900_000_000_000;

describe("INV-EVENT-MONOTONIC bounded (TDA-3)", () => {
  it("preserves monotonic semantics (accept >=, reject rollback, reject invalid)", () => {
    const c = new BoundedMonotonicTimestampChecker();
    expect(c.accept("s1", isoAt(BASE))).toBe(true);
    expect(c.accept("s1", isoAt(BASE))).toBe(true); // equal ok (at-least-once)
    expect(c.accept("s1", isoAt(BASE + 1000))).toBe(true);
    expect(c.accept("s1", isoAt(BASE + 999))).toBe(false); // rollback
    expect(c.lastSeen("s1")).toBe(BASE + 1000); // high-water mark not regressed
    expect(c.accept("s1", "not-a-date")).toBe(false);
  });

  it("stays bounded under a flood of distinct session_ids (no unbounded Map growth)", () => {
    const MAX = 100;
    const c = new BoundedMonotonicTimestampChecker({ maxSessions: MAX });
    for (let i = 0; i < 10_000; i++) {
      c.accept(`sess_${i}`, isoAt(BASE + i));
    }
    // 1 万 distinct を入れても保持は上限内。
    expect(c.size).toBeLessThanOrEqual(MAX);
    expect(c.size).toBe(MAX);
    // 退避された古いセッションは未観測扱い。
    expect(c.lastSeen("sess_0")).toBeUndefined();
    // 直近のセッションは保持されている。
    expect(c.lastSeen("sess_9999")).toBe(BASE + 9999);
  });

  it("LRU keeps a recently-touched session even as newer sessions arrive", () => {
    const c = new BoundedMonotonicTimestampChecker({ maxSessions: 3 });
    c.accept("a", isoAt(BASE));
    c.accept("b", isoAt(BASE));
    c.accept("c", isoAt(BASE));
    // a を再度触る → a が most-recently-used になる。
    c.accept("a", isoAt(BASE + 1));
    // d を入れると LRU の b が落ちる (a ではない)。
    c.accept("d", isoAt(BASE));
    expect(c.size).toBe(3);
    expect(c.lastSeen("a")).toBe(BASE + 1); // 残存
    expect(c.lastSeen("b")).toBeUndefined(); // 退避
    expect(c.lastSeen("c")).toBe(BASE);
    expect(c.lastSeen("d")).toBe(BASE);
  });

  it("TTL expires stale entries (treated as unobserved, no false rollback)", () => {
    let clock = BASE;
    const c = new BoundedMonotonicTimestampChecker({ ttlMs: 1000, now: () => clock });
    expect(c.accept("s1", isoAt(BASE + 5000))).toBe(true);
    clock = BASE + 2000; // 最終アクセスから 2000ms 経過 (> ttl 1000)
    // 失効により未観測扱い → 過去時刻でも巻き戻り誤検出せず受理。
    expect(c.lastSeen("s1")).toBeUndefined();
    expect(c.accept("s1", isoAt(BASE))).toBe(true);
  });

  // --- QA-1 (再#5): eviction による rollback 検出盲点をテストで固定する ---
  // peekFresh は LRU 退避 / TTL 失効エントリに undefined を返すため、accept は last=undefined を
  // 受理し、退避済みセッションの巻き戻り timestamp を **無検出受理**する (無界版なら false)。
  // これは bounded 化の意図的トレードオフ (active 維持を優先) だが、テスト未固定だと将来
  // eviction を拡大 (default 境界引き下げ) しても CI が捕捉できない。両側 (active=検出継続 /
  // evicted=受理) を明示 assert して境界をロックする。
  it("QA-1: a session that stays in the active set keeps detecting rollback under eviction pressure", () => {
    const MAX = 3;
    const c = new BoundedMonotonicTimestampChecker({ maxSessions: MAX });
    // keep を high-water mark BASE+10_000 で確立。
    expect(c.accept("keep", isoAt(BASE + 10_000))).toBe(true);
    // 退避圧をかけるが、その合間に keep を毎回触って active set 内に留める。
    // (MAX=3 なので keep + 直近 2 セッションが残る。keep は毎ラウンド most-recently-used。)
    for (let i = 0; i < 50; i++) {
      c.accept(`noise_${i}`, isoAt(BASE));
      // keep を最新 (>= hwm) で再観測 → active set の先頭へ。
      expect(c.accept("keep", isoAt(BASE + 10_000))).toBe(true);
    }
    // ★ active 維持された keep は依然として巻き戻りを検出し続ける (受理してはならない)。
    //   有効窓を active set 未満に縮める (keep が退避される) 構成にすると、ここが赤になる。
    expect(c.accept("keep", isoAt(BASE + 9_999))).toBe(false); // rollback 検出
    expect(c.lastSeen("keep")).toBe(BASE + 10_000); // high-water mark は後退しない
  });

  it("QA-1: an evicted session accepts a rollback (documented bounded trade-off)", () => {
    const MAX = 2;
    const c = new BoundedMonotonicTimestampChecker({ maxSessions: MAX });
    // gone の high-water mark を確立。
    expect(c.accept("gone", isoAt(BASE + 10_000))).toBe(true);
    // gone を二度と触らずに MAX を超える distinct を流し、gone を LRU 退避させる。
    for (let i = 0; i < 10; i++) {
      c.accept(`other_${i}`, isoAt(BASE));
    }
    // gone は退避済み (未観測扱い)。
    expect(c.lastSeen("gone")).toBeUndefined();
    // ★ 既知の限界: 退避済みセッションの巻き戻りは無検出受理される (無界版なら false)。
    //   この受理を明示 assert することで「bounded 化の許容トレードオフ」を契約として固定する。
    expect(c.accept("gone", isoAt(BASE))).toBe(true); // 巻き戻りだが受理 (= 未観測起点)
  });

  it("rejects non-positive maxSessions", () => {
    expect(() => new BoundedMonotonicTimestampChecker({ maxSessions: 0 })).toThrow();
    expect(() => new BoundedMonotonicTimestampChecker({ maxSessions: -1 })).toThrow();
  });

  it("tracks sessions independently within the bound", () => {
    const c = new BoundedMonotonicTimestampChecker({ maxSessions: 10 });
    expect(c.accept("s1", isoAt(BASE + 10_000))).toBe(true);
    expect(c.accept("s2", isoAt(BASE))).toBe(true); // s1 の時刻に干渉されない
    expect(c.accept("s2", isoAt(BASE + 1))).toBe(true);
  });
});
