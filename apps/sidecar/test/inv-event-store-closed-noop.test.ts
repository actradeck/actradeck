/**
 * INV-EVENT-STORE-CLOSED-NOOP — store operations after close() are safe no-ops, not throws.
 *
 * shutdown-race の class-wide backstop (SEC/QA/TDA 合同所見)。better-sqlite3 は close 後の文実行で
 * 同期 throw する。sidecar の emit/flush 経路は await 境界を跨いで store を触りうる:
 *   - process-monitor / codex-rollout-tailer / git-watcher の各 in-flight emit → store.append
 *   - ws-client.flush (QA-1 H) → await send 後に store.pendingUnsent / store.markSent
 * close 後にこれらが走ると、throw が fire-and-forget(void)を通って unhandledRejection 化し、
 * unhandledRejection handler を持たない daemon (cli.ts mainDaemon / mainCodexRolloutAttach) を
 * **クラッシュ**させる。EventStore は close 後に全 store 操作を **no-op** (throw でなく) 化して
 * このクラッシュを構造的に断つ (throw は再び unhandledRejection に戻り逆効果ゆえ採らない)。
 *
 * falsifiable: store.ts の各メソッド先頭から `if (this.closed) return ...;` を外すと、close 後の
 * pendingUnsent / markSent / append 等が better-sqlite3 の "database connection is not open" を
 * throw し、本テストの `expect(...).not.toThrow()` が赤になる。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildEvent } from "../src/event-factory.js";
import { EventStore } from "../src/store.js";

describe("INV-EVENT-STORE-CLOSED-NOOP: store ops after close() are safe no-ops", () => {
  let tmp: string;
  let store: EventStore;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "actradeck-store-noop-"));
    store = new EventStore(join(tmp, "events.sqlite"));
  });

  afterEach(() => {
    store.close(); // close 後の二重 close も no-op (冪等) であることを兼ねて確認。
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeEvent(sessionId: string) {
    return buildEvent({ session_id: sessionId, event_type: "session.started" });
  }

  it("does not throw on any store operation after close()", () => {
    const e1 = makeEvent("sess_a");
    store.append(e1);
    store.close();

    // close 後はどの操作も throw しない (handler 無し daemon のクラッシュを断つ核心)。
    expect(() => store.append(makeEvent("sess_b"))).not.toThrow();
    expect(() => store.pendingUnsent(200)).not.toThrow();
    expect(() => store.markSent([e1.event_id])).not.toThrow();
    expect(() => store.unsentCount()).not.toThrow();
    expect(() => store.totalCount()).not.toThrow();
    expect(() => store.allRows()).not.toThrow();
  });

  it("returns safe sentinel values after close() (no-op semantics)", () => {
    store.append(makeEvent("sess_a"));
    store.close();

    expect(store.append(makeEvent("sess_b"))).toBe(-1); // 「未 append」sentinel (既存 -1 と同値)
    expect(store.pendingUnsent(200)).toEqual([]);
    expect(store.unsentCount()).toBe(0);
    expect(store.totalCount()).toBe(0);
    expect(store.allRows()).toEqual([]);
  });

  it("survives the exact ws-client.flush sequence after close() [QA-1]", () => {
    // ws-client.flush: pendingUnsent(200) → await send → markSent(sentIds)。
    // store.close() が await 境界で割り込むと、resume 後の pendingUnsent/markSent が閉じた DB を
    // 触る。これが no-op で吸収され throw しないことを直接再現する。
    const e1 = makeEvent("sess_flush");
    store.append(e1);
    store.close(); // flush の await 中に shutdown が store.close したのと同じ状態。

    expect(() => {
      const batch = store.pendingUnsent(200); // 閉じた DB → [] (空 → flush は即 break)
      const sentIds = batch.map((r) => r.event_id);
      store.markSent(sentIds); // 閉じた DB → no-op
    }).not.toThrow();
  });

  it("close() is idempotent (double close does not throw)", () => {
    store.append(makeEvent("sess_a"));
    store.close();
    expect(() => store.close()).not.toThrow();
  });

  it("operates normally before close() (guard does not break the happy path)", () => {
    const e1 = makeEvent("sess_a");
    const e2 = makeEvent("sess_a");
    const seq1 = store.append(e1);
    const seq2 = store.append(e2);
    expect(seq2).toBeGreaterThan(seq1);
    expect(store.totalCount()).toBe(2);
    expect(store.unsentCount()).toBe(2);

    const pending = store.pendingUnsent(200);
    expect(pending.map((r) => r.event_id)).toEqual([e1.event_id, e2.event_id]);

    store.markSent([e1.event_id]);
    expect(store.unsentCount()).toBe(1);
    expect(store.allRows()).toHaveLength(2);
  });
});
