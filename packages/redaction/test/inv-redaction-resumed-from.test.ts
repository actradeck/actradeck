/**
 * ADR 0014 Phase 3b-1 — INV-REDACTION-CORRELATION-RESUMED-FROM (SEC-1・D8).
 *
 * `resumed_from_session_id` は resume run の継続元 canonical session_id (lineage エッジ)。値は
 *   provider-uuid か fallback `sess_<uuidv7>` 形。後者は high-entropy ルール
 *   ([A-Za-z0-9+/_-]{40,} + 3-class) に誤発火し `[REDACTED:high-entropy-secret]` へ化けると lineage 断 +
 *   secret_redaction_count 汚染 + secret_detected 誤 true を招く。provider_session_id と **完全に同一の**
 *   depth-0 限定 + isCorrelationKeyValue shape gate で救済する。
 *
 * falsifiable (反証): 相関 id 形は keep・埋込 real secret は依然 mask・nested 同名 key は mask。
 *   CORRELATION_KEY_FIELDS から `resumed_from_session_id` を外すと最初の keep ケースが赤化する。
 */
import { describe, expect, it } from "vitest";

import { newEventId } from "@actradeck/event-model";
import { redactDeep } from "@actradeck/redaction";

const REDACTED_HIGH_ENTROPY = "[REDACTED:high-entropy-secret]";

describe("INV-REDACTION-CORRELATION-RESUMED-FROM (SEC-1・D8)", () => {
  it("depth-0 の resumed_from_session_id が `sess_<uuidv7>` 形なら redaction 後も保持される", () => {
    const parent = `sess_${newEventId()}`;
    const out = redactDeep({ resumed_from_session_id: parent }) as Record<string, unknown>;
    expect(out.resumed_from_session_id).toBe(parent);
    expect(out.resumed_from_session_id).not.toBe(REDACTED_HIGH_ENTROPY);
  });

  it("純 UUID の resumed_from_session_id も相関キーとして保持される", () => {
    const parent = newEventId(); // 019xxxxx-... uuidv7
    const out = redactDeep({ resumed_from_session_id: parent }) as Record<string, unknown>;
    expect(out.resumed_from_session_id).toBe(parent);
  });

  it("2 つの異なる親 id は redaction 後も別物のまま (lineage エッジがバケツ衝突しない)", () => {
    const a = `sess_${newEventId()}`;
    const b = `sess_${newEventId()}`;
    const ra = redactDeep({ resumed_from_session_id: a }) as Record<string, unknown>;
    const rb = redactDeep({ resumed_from_session_id: b }) as Record<string, unknown>;
    expect(ra.resumed_from_session_id).toBe(a);
    expect(rb.resumed_from_session_id).toBe(b);
    expect(ra.resumed_from_session_id).not.toBe(rb.resumed_from_session_id);
  });

  it("resumed_from_session_id に紛れ込んだ real secret (github-token) は依然 mask される", () => {
    const ghp = `ghp_${"a1B2c3D4e5".repeat(4)}`; // github token 形
    const out = redactDeep({ resumed_from_session_id: ghp }) as Record<string, unknown>;
    expect(out.resumed_from_session_id).not.toBe(ghp);
    expect(String(out.resumed_from_session_id)).toContain("REDACTED");
  });

  it("40+ 字 3-class high-entropy secret を `_`/`-` で刻んでも依然 mask (charset 対称化)", () => {
    // `_` 込み 40+ 字・3-class → high-entropy が 1 run でマスクするため correlation keep しない。
    const secret = "aB3xZ9qK_cD4eF6gH_iJ7kL8mN_oP1qR2sT_uV5wX6yZ";
    const out = redactDeep({ resumed_from_session_id: secret }) as Record<string, unknown>;
    expect(out.resumed_from_session_id).not.toBe(secret);
  });

  it("SEC-2: nested (depth>0) の resumed_from_session_id は keep せず従来 redaction 経路を通る", () => {
    // 攻撃者影響下の payload に `{resumed_from_session_id:<高エントロピー分割 secret>}` を仕込む回避を塞ぐ。
    const secret = "aB3xZ9qK_cD4eF6gH_iJ7kL8mN_oP1qR2sT_uV5wX6yZ";
    const out = redactDeep({
      payload: { nested: { resumed_from_session_id: secret } },
    }) as Record<string, unknown>;
    const nested = (out.payload as Record<string, Record<string, unknown>>).nested;
    expect(nested.resumed_from_session_id).not.toBe(secret);
  });
});
