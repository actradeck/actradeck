/**
 * INV (ADR 0014 Phase 4・decision 019fd705 D1): tool.permission.resolved の
 * resolution_origin / delivery_status 契約。
 *
 * - additive optional: 両 field 欠落 (旧 sidecar イベント) は従来どおり valid (後方互換)。
 * - closed enum: 語彙は ResolutionOrigin 6 値 / DeliveryStatus 3 値のみ。未知値は EventPayload
 *   parse で拒否される (raw 文字列を enum field へ持ち込ませない・NO-RAW)。
 * - relay_lost の正直写像: decision=cancel と併用できる (backend 合成 cancel の形)。
 */
import { describe, expect, it } from "vitest";

import { DeliveryStatus, EventPayload, ResolutionOrigin } from "../src/index.js";

const BASE = { kind: "tool.permission.resolved", request_id: "s1:apr-1" } as const;

describe("INV: tool.permission.resolved resolution metadata (ADR 0014 Phase 4)", () => {
  it("両 field 欠落 (旧 sidecar) は後方互換で valid", () => {
    const parsed = EventPayload.safeParse({ ...BASE, decision: "deny" });
    expect(parsed.success).toBe(true);
  });

  it("全 origin × delivery の組が valid (closed enum 語彙 pin)", () => {
    expect(ResolutionOrigin.options).toEqual([
      "operator",
      "timeout",
      "policy",
      "shutdown",
      "child_exit",
      "relay_lost",
    ]);
    expect(DeliveryStatus.options).toEqual(["sent", "not_sent", "unknown"]);
    for (const origin of ResolutionOrigin.options) {
      for (const delivery of DeliveryStatus.options) {
        const parsed = EventPayload.safeParse({
          ...BASE,
          decision: "deny",
          resolution_origin: origin,
          delivery_status: delivery,
        });
        expect(parsed.success, `${origin}/${delivery} must be valid`).toBe(true);
      }
    }
  });

  it("未知の origin / delivery 値は拒否する (enum gate)", () => {
    expect(
      EventPayload.safeParse({ ...BASE, decision: "deny", resolution_origin: "gremlin" }).success,
    ).toBe(false);
    expect(
      EventPayload.safeParse({ ...BASE, decision: "deny", delivery_status: "maybe" }).success,
    ).toBe(false);
    // raw 文字列 (コマンド形) も構造的に弾かれる。
    expect(
      EventPayload.safeParse({ ...BASE, decision: "deny", resolution_origin: "rm -rf /" }).success,
    ).toBe(false);
  });

  it("relay_lost + cancel + not_sent (backend 合成 cancel の正直写像) が valid", () => {
    const parsed = EventPayload.safeParse({
      ...BASE,
      decision: "cancel",
      resolution_origin: "relay_lost",
      delivery_status: "not_sent",
    });
    expect(parsed.success).toBe(true);
  });
});
