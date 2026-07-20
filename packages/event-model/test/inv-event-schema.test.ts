/**
 * INV-EVENT-SCHEMA: NormalizedEvent の必須フィールド・enum 制約を zod が強制する。
 *
 * 契約 (T1):
 * - 必須フィールド (event_id/provider/source/session_id/event_type/timestamp) 欠如は拒否。
 * - 不正な provider / source / event_type / state は拒否。
 * - 正当イベントは受理し、payload/metrics は省略時に {} へ default。
 * - payload は event_type 整合の discriminated union (EventPayload) で別途厳密化できる。
 */
import { describe, expect, it } from "vitest";

import {
  NormalizedEvent,
  EventPayload,
  safeParseEvent,
  StartKind,
  EndKind,
  Recoverability,
} from "../src/index.js";
import { validEvent } from "./helpers.js";

describe("INV-EVENT-SCHEMA", () => {
  it("accepts a fully-specified valid event (plan.md §6 example shape)", () => {
    const res = safeParseEvent(validEvent());
    expect(res.success).toBe(true);
  });

  it("defaults payload and metrics to {} when omitted", () => {
    const ev = validEvent();
    delete (ev as Record<string, unknown>).payload;
    delete (ev as Record<string, unknown>).metrics;
    const res = NormalizedEvent.parse(ev);
    expect(res.payload).toEqual({});
    expect(res.metrics).toEqual({});
  });

  it("allows optional state to be omitted (delta/heartbeat events)", () => {
    const ev = validEvent({ event_type: "agent.message.delta" });
    delete (ev as Record<string, unknown>).state;
    expect(safeParseEvent(ev).success).toBe(true);
  });

  it.each(["event_id", "provider", "source", "session_id", "event_type", "timestamp"])(
    "rejects when required field %s is missing",
    (field) => {
      const ev = validEvent();
      delete (ev as Record<string, unknown>)[field];
      expect(safeParseEvent(ev).success).toBe(false);
    },
  );

  // --- ADR 019e9462: provider_session_id (optional, 後方互換) ---
  it("accepts provider_session_id when present and preserves it on parse", () => {
    const ev = validEvent({ provider_session_id: "679e5e1b-f205-4a17-9b2e-0c1d2e3f4a5b" });
    const res = safeParseEvent(ev);
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.provider_session_id).toBe("679e5e1b-f205-4a17-9b2e-0c1d2e3f4a5b");
    }
  });

  it("is backward-compatible: events WITHOUT provider_session_id still parse (optional)", () => {
    const ev = validEvent();
    delete (ev as Record<string, unknown>).provider_session_id;
    const res = safeParseEvent(ev);
    expect(res.success).toBe(true);
    if (res.success) {
      // 未指定なら undefined のまま(session_id とは独立、projection key にしない)。
      expect(res.data.provider_session_id).toBeUndefined();
    }
  });

  it("rejects a non-string provider_session_id", () => {
    expect(safeParseEvent(validEvent({ provider_session_id: 123 as never })).success).toBe(false);
  });

  // --- ADR 0014 Phase 3a: run lineage optional fields (start_kind / resumed_from_session_id /
  //     end_kind / recoverability)。provider_session_id と同じ後方互換パターン ---
  it("accepts the 4 lineage optional fields when present and preserves them on parse", () => {
    const ev = validEvent({
      start_kind: "resume",
      resumed_from_session_id: "sess_prev_run",
      end_kind: "unloaded",
      recoverability: "resumable",
    });
    const res = safeParseEvent(ev);
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.start_kind).toBe("resume");
      expect(res.data.resumed_from_session_id).toBe("sess_prev_run");
      expect(res.data.end_kind).toBe("unloaded");
      expect(res.data.recoverability).toBe("resumable");
    }
  });

  it("is backward-compatible: events WITHOUT lineage fields still parse (all optional)", () => {
    const ev = validEvent();
    // validEvent は元々 lineage fields を持たない。undefined で通ることを明示。
    const res = safeParseEvent(ev);
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.start_kind).toBeUndefined();
      expect(res.data.resumed_from_session_id).toBeUndefined();
      expect(res.data.end_kind).toBeUndefined();
      expect(res.data.recoverability).toBeUndefined();
    }
  });

  it("round-trips every StartKind enum value", () => {
    for (const v of StartKind.options) {
      const res = safeParseEvent(validEvent({ start_kind: v }));
      expect(res.success).toBe(true);
      if (res.success) expect(res.data.start_kind).toBe(v);
    }
  });

  it("round-trips every EndKind enum value", () => {
    for (const v of EndKind.options) {
      const res = safeParseEvent(validEvent({ end_kind: v }));
      expect(res.success).toBe(true);
      if (res.success) expect(res.data.end_kind).toBe(v);
    }
  });

  it("round-trips every Recoverability enum value", () => {
    for (const v of Recoverability.options) {
      const res = safeParseEvent(validEvent({ recoverability: v }));
      expect(res.success).toBe(true);
      if (res.success) expect(res.data.recoverability).toBe(v);
    }
  });

  it("rejects out-of-enum lineage values (closed enums)", () => {
    expect(safeParseEvent(validEvent({ start_kind: "rebooted" as never })).success).toBe(false);
    expect(safeParseEvent(validEvent({ end_kind: "vaporized" as never })).success).toBe(false);
    expect(safeParseEvent(validEvent({ recoverability: "maybe" as never })).success).toBe(false);
  });

  it("rejects a non-string resumed_from_session_id", () => {
    expect(safeParseEvent(validEvent({ resumed_from_session_id: 7 as never })).success).toBe(false);
  });

  // recoverability は Phase 1 の Continuation を再利用した単一出所 (新語彙を作らない・ADR 0014)。
  // Recoverability enum の値集合が Continuation 型の union と厳密一致することを固定する。
  it("Recoverability enum values match the Continuation vocabulary (single source, no drift)", () => {
    expect([...Recoverability.options].sort()).toEqual(
      ["resumable", "not_resumable", "unknown"].sort(),
    );
  });

  // provider は slug 開放 (ADR 019f2d2c D1)。未知 slug は受理される
  // (詳細な reject クラス・KNOWN 不変は inv-provider-forward-compat.test.ts)。
  it("accepts an unknown-but-valid provider slug (D1 開放)", () => {
    expect(safeParseEvent(validEvent({ provider: "gemini" })).success).toBe(true);
  });

  it("rejects a non-slug provider (uppercase)", () => {
    expect(safeParseEvent(validEvent({ provider: "Gemini" as never })).success).toBe(false);
  });

  it("rejects an unknown source (closed enum・D2)", () => {
    expect(safeParseEvent(validEvent({ source: "telnet" as never })).success).toBe(false);
  });

  it("accepts source external (D2 additive)", () => {
    expect(safeParseEvent(validEvent({ source: "external" })).success).toBe(true);
  });

  it("rejects an unknown event_type", () => {
    expect(safeParseEvent(validEvent({ event_type: "tool.exploded" as never })).success).toBe(
      false,
    );
  });

  it("rejects an unknown state", () => {
    expect(safeParseEvent(validEvent({ state: "running.vibing" as never })).success).toBe(false);
  });

  it("rejects empty session_id", () => {
    expect(safeParseEvent(validEvent({ session_id: "" })).success).toBe(false);
  });

  describe("EventPayload discriminated union", () => {
    it("accepts a well-formed command.started payload", () => {
      const res = EventPayload.safeParse({
        kind: "command.started",
        command: "npm test",
        cwd: "/repo",
        risk_level: "low",
      });
      expect(res.success).toBe(true);
    });

    it("accepts a well-formed file.change.proposed payload", () => {
      const res = EventPayload.safeParse({
        kind: "file.change.proposed",
        path: "src/auth.ts",
        diff: "@@ -1 +1 @@",
        risk_level: "medium",
      });
      expect(res.success).toBe(true);
    });

    it("rejects a command.started payload missing required command", () => {
      const res = EventPayload.safeParse({ kind: "command.started", cwd: "/repo" });
      expect(res.success).toBe(false);
    });

    it("rejects an unknown payload kind", () => {
      const res = EventPayload.safeParse({ kind: "tool.exploded" });
      expect(res.success).toBe(false);
    });

    it("rejects an invalid risk_level enum value", () => {
      const res = EventPayload.safeParse({
        kind: "command.started",
        command: "rm -rf /",
        risk_level: "apocalyptic",
      });
      expect(res.success).toBe(false);
    });
  });
});
