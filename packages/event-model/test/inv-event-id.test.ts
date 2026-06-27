/**
 * INV-EVENT-ID: event_id が UUIDv7 形式であることを強制する。
 *
 * 契約 (T1):
 * - newEventId() は有効な UUIDv7 (version フィールド = 7) を採番する。
 * - 連続採番は単調 (時系列ソート可能、UUIDv7 の高位 timestamp ビット)。
 * - isUuidV7 / EventId schema は v4 や非 UUID 文字列を拒否する。
 * - NormalizedEvent.event_id は UUIDv7 を要求する。
 */
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { EventId, isUuidV7, newEventId, safeParseEvent } from "../src/index.js";
import { validEvent } from "./helpers.js";

describe("INV-EVENT-ID", () => {
  it("newEventId returns a valid UUIDv7", () => {
    const id = newEventId();
    expect(isUuidV7(id)).toBe(true);
    expect(EventId.safeParse(id).success).toBe(true);
  });

  it("mints unique ids", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newEventId()));
    expect(ids.size).toBe(1000);
  });

  it("mints monotonically non-decreasing ids (time-sortable)", () => {
    const ids = Array.from({ length: 200 }, () => newEventId());
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it("rejects a UUIDv4 as not-v7", () => {
    const v4 = randomUUID();
    expect(isUuidV7(v4)).toBe(false);
    expect(EventId.safeParse(v4).success).toBe(false);
  });

  it.each(["", "not-a-uuid", "12345", "019e8e3a-4df5-72da-8447"])(
    "rejects malformed id %s",
    (bad) => {
      expect(isUuidV7(bad)).toBe(false);
      expect(EventId.safeParse(bad).success).toBe(false);
    },
  );

  it("NormalizedEvent rejects an event whose event_id is not UUIDv7", () => {
    expect(safeParseEvent(validEvent({ event_id: randomUUID() })).success).toBe(false);
  });

  it("NormalizedEvent accepts a minted UUIDv7 event_id", () => {
    expect(safeParseEvent(validEvent({ event_id: newEventId() })).success).toBe(true);
  });
});
