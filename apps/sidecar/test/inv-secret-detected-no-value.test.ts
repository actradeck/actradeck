/**
 * INV-SECRET-DETECTED-NO-VALUE (最重要・INV-REDACTION 隣接) — ADR 019ea4ba 段階2 / task 019ea4db.
 *
 * 契約 (sink 観測点側): secret を含む event を sink.emit すると、
 *  (1) 秘匿値そのものは persist / 送信路 / redacted event のどこにも出ない (redaction 不変条件)、
 *  (2) 代わりに redacted event の top-level `redaction_count` が **件数のみ** 上がる。
 *
 * 観測点は **redactDeep 適用後の redacted のみ** (sink の唯一の choke point)。raw event は見ない。
 * session 単位の bool OR / 合算畳み込み (secret_detected) と冪等は projection package の
 * INV-SECRET-DETECTED-FOLD で別途 pin する (projection は sidecar の依存ではないため層を分離)。
 *
 * sink は TDA-1 で `redactDeepWithCount` (走査内集計) を使い、二重 JSON.stringify を排した。
 * redactDeepWithCount が redactDeep と同値 + 件数一致であることは INV-REDACTDEEP-COUNT-PARITY
 * (inv-redaction.test.ts) で別途 pin する。
 *
 * mutation 赤化の設計 (自己反証):
 *  - sink.ts が「件数」でなく「値」を載せる改変、または count を 0 固定・走査集計を外す改変を
 *    すると (1) の `not.toContain(SECRET)` または件数 assert が赤化する。
 */
import { newEventId, parseEvent } from "@actradeck/event-model";
import { describe, expect, it } from "vitest";

import { EventSink } from "../src/sink.js";
import { EventStore } from "../src/store.js";
import type { WsClient } from "../src/ws-client.js";

// ダミー秘匿値 (実在しない・テスト専用)。github-token ルールに合致する形。
const SECRET = "ghp_REALFAKE0123456789abcdefABCDEF0123456789";

describe("INV-SECRET-DETECTED-NO-VALUE: 件数のみ・原文を一切載せない", () => {
  function makeSink(): { sink: EventSink; store: EventStore; sent: string[] } {
    const store = new EventStore(":memory:");
    const sent: string[] = [];
    const wsClient = {
      notifyAppended: () => {
        for (const row of store.pendingUnsent()) sent.push(row.event_json);
      },
    } as unknown as WsClient;
    return { sink: new EventSink({ store, wsClient }), store, sent };
  }

  it("secret を emit すると原文は persist/送信に出ず redaction_count のみ上がる", () => {
    const { sink, store, sent } = makeSink();
    const ev = sink.emit({
      event_id: newEventId(),
      provider: "claude_code",
      source: "hooks",
      session_id: "s1",
      event_type: "agent.message.delta",
      timestamp: new Date().toISOString(),
      summary: "secret in message",
      payload: { kind: "agent.message.delta", delta: `here is a token ${SECRET} ok` },
      metrics: {},
    });
    expect(ev).toBeDefined();

    // (2) redacted event に件数が載る (>0)。
    expect(ev!.redaction_count).toBeGreaterThan(0);
    // redacted event を JSON 化しても原文は一切出ない (件数のみ)。
    expect(JSON.stringify(ev)).not.toContain(SECRET);

    // (1) 原文は persist された行に残らない・redaction マーカーは残る・件数のみ載る。
    const rows = store.allRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.event_json, "raw secret persisted to SQLite").not.toContain(SECRET);
      expect(row.event_json).toContain("[REDACTED:");
      expect(JSON.parse(row.event_json).redaction_count).toBeGreaterThan(0);
    }

    // (1) 送信ペイロードにも原文は残らない。
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.join(""), "raw secret sent over WS").not.toContain(SECRET);

    store.close();
  });

  it("secret を含まない event は redaction_count=0", () => {
    const { sink, store } = makeSink();
    const clean = sink.emit({
      event_id: newEventId(),
      provider: "claude_code",
      source: "hooks",
      session_id: "s2",
      event_type: "agent.message.delta",
      timestamp: "2026-06-06T00:00:00.000Z",
      summary: "no secret",
      payload: { kind: "agent.message.delta", delta: "just a normal message" },
      metrics: {},
    });
    expect(clean).toBeDefined();
    expect(clean!.redaction_count ?? 0).toBe(0);
    store.close();
  });

  it("count は複数 secret を数え redacted event を parseEvent が生き残る (additive optional)", () => {
    const { sink, store } = makeSink();
    const ev = sink.emit({
      event_id: newEventId(),
      provider: "claude_code",
      source: "hooks",
      session_id: "s3",
      event_type: "agent.message.delta",
      timestamp: "2026-06-06T00:00:00.000Z",
      payload: { kind: "agent.message.delta", delta: `a ${SECRET} b ${SECRET}` },
      metrics: {},
    });
    expect(ev).toBeDefined();
    expect(ev!.redaction_count).toBeGreaterThanOrEqual(2);
    const reparsed = parseEvent(JSON.parse(JSON.stringify(ev)));
    expect(reparsed.redaction_count).toBe(ev!.redaction_count);
    store.close();
  });
});

// AWS secret access key 形 (40 字 base64 風・擬似値)。high-entropy ルールに当たる。
const AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

describe("INV-SECRET-DETECTED-NO-VALUE (kind 別版): redaction_count_by_kind は件数+kind名のみ", () => {
  function makeSink(): { sink: EventSink; store: EventStore; sent: string[] } {
    const store = new EventStore(":memory:");
    const sent: string[] = [];
    const wsClient = {
      notifyAppended: () => {
        for (const row of store.pendingUnsent()) sent.push(row.event_json);
      },
    } as unknown as WsClient;
    return { sink: new EventSink({ store, wsClient }), store, sent };
  }

  it("複数 kind の secret を emit → kind 別件数が載り原文は persist/送信に出ない", () => {
    const { sink, store, sent } = makeSink();
    const ev = sink.emit({
      event_id: newEventId(),
      provider: "claude_code",
      source: "hooks",
      session_id: "sk1",
      event_type: "agent.message.delta",
      timestamp: "2026-06-06T00:00:00.000Z",
      summary: "multi-kind secrets",
      payload: {
        kind: "agent.message.delta",
        delta: `gh1 ${SECRET} gh2 ${SECRET} aws ${AWS_SECRET}`,
      },
      metrics: {},
    });
    expect(ev).toBeDefined();

    // kind 別件数が載る (github-token×2, high-entropy-secret×1)。
    const byKind = ev!.redaction_count_by_kind;
    expect(byKind).toBeDefined();
    expect(byKind!["github-token"]).toBe(2);
    expect(byKind!["high-entropy-secret"]).toBe(1);

    // 正直な INV (QA-1/TDA-2): sum(by_kind) <= redaction_count。本ケースは全 secret が既知 kind
    //   ゆえ等号も成立する (phantom/legacy のときだけ厳密に <)。
    const sum = Object.values(byKind!).reduce((a, b) => a + b, 0);
    expect(sum).toBeLessThanOrEqual(ev!.redaction_count!);
    expect(sum).toBe(ev!.redaction_count);

    // 原文は redacted event / persist / 送信路のどこにも出ない (件数 + kind 名のみ)。
    const evJson = JSON.stringify(ev);
    expect(evJson).not.toContain(SECRET);
    expect(evJson).not.toContain(AWS_SECRET);
    // by_kind のキーは kind 名 (公開 enum) のみで原文断片を含まない。
    expect(JSON.stringify(byKind)).not.toContain(SECRET);
    expect(JSON.stringify(byKind)).not.toContain(AWS_SECRET);

    const rows = store.allRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.event_json, "raw secret persisted to SQLite").not.toContain(SECRET);
      expect(row.event_json).not.toContain(AWS_SECRET);
      const parsed = JSON.parse(row.event_json);
      const persistedByKind = parsed.redaction_count_by_kind as Record<string, number>;
      const persistedSum = Object.values(persistedByKind).reduce((a, b) => a + b, 0);
      expect(persistedSum).toBe(parsed.redaction_count);
    }

    expect(sent.length).toBeGreaterThan(0);
    expect(sent.join(""), "raw secret sent over WS").not.toContain(SECRET);
    expect(sent.join("")).not.toContain(AWS_SECRET);

    store.close();
  });

  it("secret を含まない event は redaction_count_by_kind={} (sum 0 === redaction_count 0)", () => {
    const { sink, store } = makeSink();
    const clean = sink.emit({
      event_id: newEventId(),
      provider: "claude_code",
      source: "hooks",
      session_id: "sk2",
      event_type: "agent.message.delta",
      timestamp: "2026-06-06T00:00:00.000Z",
      payload: { kind: "agent.message.delta", delta: "nothing secret here" },
      metrics: {},
    });
    expect(clean).toBeDefined();
    expect(clean!.redaction_count_by_kind).toEqual({});
    const sum = Object.values(clean!.redaction_count_by_kind ?? {}).reduce((a, b) => a + b, 0);
    expect(sum).toBe(clean!.redaction_count ?? 0);
    store.close();
  });

  it("sink が権威で上書き: 呼び出し側の偽 by_kind は redacted 走査の正準値へ置換される", () => {
    const { sink } = makeSink();
    const ev = sink.emit({
      event_id: newEventId(),
      provider: "claude_code",
      source: "hooks",
      session_id: "sk3",
      event_type: "agent.message.delta",
      timestamp: "2026-06-06T00:00:00.000Z",
      // 攻撃的: 呼び出し側が嘘の kind 別件数を載せても sink が choke で上書きする。
      redaction_count_by_kind: { "fake-kind": 999 } as unknown as Record<string, number>,
      payload: { kind: "agent.message.delta", delta: `real ${SECRET}` },
      metrics: {},
    } as unknown as Record<string, unknown>);
    expect(ev).toBeDefined();
    expect(ev!.redaction_count_by_kind).toEqual({ "github-token": 1 });
    expect(ev!.redaction_count_by_kind!["fake-kind"]).toBeUndefined();
  });
});
