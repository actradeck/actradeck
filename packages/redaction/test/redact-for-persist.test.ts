/**
 * INV-INGRESS-REDACTION の unit 層 (共有権威付与ヘルパ)。
 *
 * `redactEventWithAuthoritativeCounts` は sidecar sink choke と backend ingress 床が共有する
 * 単一出所 (ADR 019f2d2c D3)。ここでは (a) count spoof の権威上書き、(b) by_kind の権威付与、
 * (c) 冪等 (既 redacted marker の再適用でマスク不変・二重計上なし)、(d) 非 object passthrough を
 * pin する。sink / backend の real-SQLite / real-PG 統合は別ファイル (inv-redaction / inv-ingress-redaction)。
 */
import { describe, expect, it } from "vitest";

import { redactEventWithAuthoritativeCounts } from "@actradeck/redaction";

const GH = "ghp_1234567890abcdefABCDEF1234567890abcd";

describe("redactEventWithAuthoritativeCounts: 権威 count 付与 + redaction", () => {
  it("client 申告の redaction_count を実マーカー数で上書きする (spoof 封じ)", () => {
    const out = redactEventWithAuthoritativeCounts({
      event_type: "command.output.delta",
      payload: { delta: `export GH=${GH}` },
      redaction_count: 999, // 嘘の申告値
      redaction_count_by_kind: { "totally-fake": 42 },
    }) as Record<string, unknown>;

    // raw secret は残らない。
    expect(JSON.stringify(out)).not.toContain(GH);
    // count は実マーカー数 (1) で上書き。
    expect(out.redaction_count).toBe(1);
    expect(out.redaction_count_by_kind).toEqual({ "github-token": 1 });
  });

  it("secret 不在なら redaction_count は 0 に権威上書き (spoof 999 → 0)", () => {
    const out = redactEventWithAuthoritativeCounts({
      event_type: "heartbeat",
      payload: { ok: true },
      redaction_count: 999,
    }) as Record<string, unknown>;
    expect(out.redaction_count).toBe(0);
    expect(out.redaction_count_by_kind).toEqual({});
  });

  it("冪等: 既 redacted (marker 入り) を再適用しても marker 不変・count=マーカー数・二重マスクなし", () => {
    const once = redactEventWithAuthoritativeCounts({
      event_type: "command.output.delta",
      payload: { delta: `export GH=${GH}` },
    }) as Record<string, unknown>;
    const twice = redactEventWithAuthoritativeCounts(once) as Record<string, unknown>;
    // marker 文字列は不変 (二重マスク [REDACTED:[REDACTED:...]] にならない)。
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    // count は marker 数のまま (再計上で膨らまない)。
    expect(twice.redaction_count).toBe(1);
    expect(twice.redaction_count_by_kind).toEqual({ "github-token": 1 });
  });

  it("非 object 入力 (primitive / array) は redacted 値をそのまま返す (権威 count を載せない)", () => {
    // primitive: parseEvent が後段で T1 拒否する前提。raw は redaction 済で漏れない。
    expect(redactEventWithAuthoritativeCounts(`tok=${GH}`)).not.toContain(GH);
    expect(redactEventWithAuthoritativeCounts(42)).toBe(42);
    expect(redactEventWithAuthoritativeCounts(null)).toBe(null);
    const arr = redactEventWithAuthoritativeCounts([`tok=${GH}`]) as unknown[];
    expect(Array.isArray(arr)).toBe(true);
    expect(JSON.stringify(arr)).not.toContain(GH);
  });

  it("入力を破壊しない (純関数)", () => {
    const input = { event_type: "heartbeat", payload: { delta: `x ${GH}` } };
    const snap = JSON.stringify(input);
    redactEventWithAuthoritativeCounts(input);
    expect(JSON.stringify(input)).toBe(snap);
  });
});
