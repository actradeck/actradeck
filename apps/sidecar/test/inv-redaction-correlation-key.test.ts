/**
 * INV-REDACTION (LIVE-1): correlation-key (session_id) 保持の不変条件。
 *
 * 背景 (decision 019e956e): fallback session_id `sess_<uuidv7>` が high-entropy ルールに
 *   当たり `[REDACTED:high-entropy-secret]` へ化けていた。session_id は **秘密ではなく相関キー**。
 *   redaction されると全 fallback セッションが単一バケツへ衝突し、Cockpit の projection
 *   (セッション分離・degraded 表示) が崩壊する。canonical 純 UUID を使う既存 e2e はこれをすり抜けた。
 *
 * ## 不変条件 (精緻化した INV-REDACTION)
 *   「秘密は消す。ただし **構造化イベントの相関キーフィールド (session_id 等) は、その値が
 *    相関キーの形 (`sess_<uuid>` / 純 UUID / `sess_<wordlike>`) のとき保持** する。」
 *
 * ## leak を増やさない (回帰)
 *   - 相関キーフィールドに紛れた **本物の秘密** (gh トークン / base64 鍵 / `key=...`) は依然マスク。
 *   - 相関キー以外のフィールド・payload・summary は従来どおり全マスク経路を通る。
 */
import { describe, expect, it } from "vitest";

import { newEventId } from "@actradeck/event-model";

import { redactDeep, redactValue } from "../src/redactor.js";

const REDACTED_HIGH_ENTROPY = "[REDACTED:high-entropy-secret]";

describe("INV-REDACTION: correlation-key 保持 (LIVE-1)", () => {
  it("fallback session_id `sess_<uuidv7>` は redaction 後も相関キーとして保持される", () => {
    const sid = `sess_${newEventId()}`; // 例: sess_019e9529-f154-741e-80d5-d90a205fc82e
    const out = redactDeep({ session_id: sid }) as Record<string, unknown>;
    expect(out.session_id).toBe(sid);
    expect(out.session_id).not.toBe(REDACTED_HIGH_ENTROPY);
  });

  it("2 つの異なる fallback session_id は redaction 後も別物のまま (バケツ衝突しない)", () => {
    const a = `sess_${newEventId()}`;
    const b = `sess_${newEventId()}`;
    expect(a).not.toBe(b);
    const ra = redactDeep({ session_id: a }) as Record<string, unknown>;
    const rb = redactDeep({ session_id: b }) as Record<string, unknown>;
    expect(ra.session_id).toBe(a);
    expect(rb.session_id).toBe(b);
    expect(ra.session_id).not.toBe(rb.session_id);
  });

  it("純 UUID / ACTRADECK_SESSION 風 id / 短 id も相関キーとして保持される", () => {
    for (const sid of [
      "019e9529-f154-741e-80d5-d90a205fc82e",
      "sess_live_probe_002",
      "sess_abc123",
    ]) {
      const out = redactDeep({ session_id: sid }) as Record<string, unknown>;
      expect(out.session_id).toBe(sid);
    }
  });

  it("他の相関キーフィールド (provider_session_id / thread_id / turn_id / agent_id) も保持", () => {
    const sid = `sess_${newEventId()}`;
    const out = redactDeep({
      session_id: sid,
      provider_session_id: sid,
      thread_id: `sess_${newEventId()}`,
      turn_id: "019e9529-f154-741e-80d5-d90a205fc82e",
      agent_id: "sess_subagent_001",
    }) as Record<string, unknown>;
    expect(out.session_id).toBe(sid);
    expect(out.provider_session_id).toBe(sid);
    expect(typeof out.thread_id).toBe("string");
    expect((out.thread_id as string).startsWith("sess_")).toBe(true);
    expect(out.turn_id).toBe("019e9529-f154-741e-80d5-d90a205fc82e");
    expect(out.agent_id).toBe("sess_subagent_001");
  });

  // --- leak 回帰: 相関キーフィールドに紛れた本物の秘密は依然マスクされる ----------
  it("session_id フィールドに本物の github トークンが紛れたら依然マスクされる", () => {
    const out = redactDeep({
      session_id: "ghp_1234567890abcdefABCDEF1234567890abcd",
    }) as Record<string, unknown>;
    expect(out.session_id).not.toBe("ghp_1234567890abcdefABCDEF1234567890abcd");
    expect(String(out.session_id)).toContain("REDACTED");
  });

  it("session_id フィールドに base64 高エントロピー鍵が紛れたら依然マスクされる", () => {
    const secret = "AKIAIOSFODNN7EXAMPLEbPxRfiCYzEXAMPLEKEY12"; // 40+ 字 high-entropy
    const out = redactDeep({ session_id: secret }) as Record<string, unknown>;
    expect(out.session_id).not.toBe(secret);
    expect(String(out.session_id)).toContain("REDACTED");
  });

  it("session_id フィールドに `key=<secret>` 代入形が紛れたら依然マスクされる", () => {
    const out = redactDeep({
      session_id: "api_key=supersecretvalue1234567890",
    }) as Record<string, unknown>;
    expect(String(out.session_id)).toContain("REDACTED");
  });

  it("相関キー名でも anthropic / slack / aws / sendgrid 等の特異 token は依然マスク (G2 ゲート)", () => {
    // 構造形 (語的トークン) を満たしても high-entropy 以外のルールが発火する値は保持しない。
    const tokens = [
      "sk-ant-aaaaaaaaaaaaaaaaaaaaaaaaaaaa", // anthropic
      "ghp_1234567890abcdefABCDEF1234567890abcd", // github (mixed)
      "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", // github (lower)
      "xoxb-1234567890-abcdefABCDEF", // slack
    ];
    for (const t of tokens) {
      const out = redactDeep({ session_id: t }) as Record<string, unknown>;
      expect(out.session_id).not.toBe(t);
      expect(String(out.session_id)).toContain("REDACTED");
    }
  });

  it("相関キー名でも 'sess_' を欠く高エントロピー値は保持しない (形ゲートが効く)", () => {
    // sess_ prefix も uuid 形も無い純高エントロピー文字列はマスク側に倒す (fail-safe)。
    const secret = "bPxRfiCYzEXAMPLEKEYaZ9qWmKpLnTvUxYbCdEfG"; // 40 字 mixed
    const out = redactDeep({ session_id: secret }) as Record<string, unknown>;
    expect(out.session_id).not.toBe(secret);
  });

  // --- 非相関キーフィールドは従来どおり全マスク経路 ---------------------------------
  it("payload / summary 内の session_id 形でない高エントロピー値は従来どおりマスク", () => {
    const secret = "bPxRfiCYzEXAMPLEKEYaZ9qWmKpLnTvUxYbCdEfG";
    const out = redactValue({ summary: secret, payload: { blob: secret } }) as Record<
      string,
      unknown
    >;
    expect(out.summary).not.toBe(secret);
    expect((out.payload as Record<string, unknown>).blob).not.toBe(secret);
  });
});

/**
 * SEC-1 = QA-1 = TDA-1 (redaction 019e98aa BLOCK): charset 非対称 leak の回帰固定。
 *   `_`/`-` で ≤8 字に刻んだ 40+ 字・3-class secret が high-entropy charset (`[A-Za-z0-9+/_-]`) では
 *   1 run としてマスクされるのに、相関キーゲートが `_`/`-` を segment 区切りとして扱う非対称で
 *   未マスク保持されていた。**5 相関フィールド全てでマスクされること**を固定する。
 */
const CORRELATION_FIELDS = [
  "session_id",
  "provider_session_id",
  "thread_id",
  "turn_id",
  "agent_id",
] as const;

const SPLIT_SECRET_LEAKS = [
  "aB3xZ9qK_cD4eF6gH_iJ5kL2mN_oP8qR0sT_uV1wX3yZ", // `_` で ≤8 字に分割した 40+ 字 3-class
  "tok_3kJ9-vBn2-Qx7w-Lm4p-Rt6y-Zc8d-Ef0g-Hj1k", // `-` で分割
  "wJalrXU_tnFEMI-K7MDEN_GbPxRf-iCYEXAM_PLEKEY1", // AWS secret 風 (`_`/`-` 混在)
  "Xy9_Zw8_Vu7_Ts6_Rq5_Po4_Nm3_Lk2_Ji1_Hg0_Fe9", // 多数の短 segment
] as const;

describe("INV-REDACTION: SEC-1 charset 非対称 leak (split-secret) は全相関フィールドでマスク", () => {
  for (const leak of SPLIT_SECRET_LEAKS) {
    for (const field of CORRELATION_FIELDS) {
      it(`${field} に分割 secret "${leak.slice(0, 12)}…" を入れたらマスクされる`, () => {
        const out = redactDeep({ [field]: leak }) as Record<string, unknown>;
        expect(out[field]).not.toBe(leak);
        expect(String(out[field])).toContain("REDACTED");
      });
    }
  }

  it("baseline redactString が分割 secret をマスクするのと整合 (charset 対称)", () => {
    for (const leak of SPLIT_SECRET_LEAKS) {
      // 相関フィールドでも baseline と同じく必ずマスク (override は high-entropy 非該当値のみ)。
      const field = redactDeep({ session_id: leak }) as Record<string, unknown>;
      expect(String(field.session_id)).toContain("REDACTED");
    }
  });

  it("正規 id は SEC-1 修正後も keep され続ける (回帰維持)", () => {
    const keep = [
      `sess_${newEventId()}`,
      "019e9529-f154-741e-80d5-d90a205fc82e",
      "sess_live_probe_002",
      "sess_abc123",
      "s1",
    ];
    for (const id of keep) {
      const out = redactDeep({ session_id: id }) as Record<string, unknown>;
      expect(out.session_id).toBe(id);
    }
  });
});

/**
 * SEC-2 (redaction 019e98aa BLOCK): correlation-keep は **depth 0 (イベント identity top-level) 限定**。
 *   nested object / array 要素内の同名 `session_id` で keep が発火すると、攻撃者影響下の payload に
 *   `{session_id:<分割secret>}` を仕込んで redaction を回避できる (SEC-1 の exfil 面拡大)。
 *   nested/array では従来 redaction 経路へ戻し、secret がマスクされることを固定する。
 */
describe("INV-REDACTION: SEC-2 correlation-keep は depth 0 限定 (nested/array は従来 redaction)", () => {
  const secret = SPLIT_SECRET_LEAKS[0];

  it("payload.session_id (depth 1) に入れた分割 secret はマスクされる", () => {
    const out = redactDeep({ payload: { session_id: secret } }) as Record<string, unknown>;
    const inner = out.payload as Record<string, unknown>;
    expect(inner.session_id).not.toBe(secret);
    expect(String(inner.session_id)).toContain("REDACTED");
  });

  it("a.b.c.session_id (深い nest) の分割 secret はマスクされる", () => {
    const out = redactDeep({ a: { b: { c: { session_id: secret } } } }) as Record<string, unknown>;
    const a = out.a as Record<string, unknown>;
    const b = a.b as Record<string, unknown>;
    const c = b.c as Record<string, unknown>;
    expect(String(c.session_id)).toContain("REDACTED");
  });

  it("items[0].session_id (array 要素内) の分割 secret はマスクされる", () => {
    const out = redactDeep({ items: [{ session_id: secret }] }) as Record<string, unknown>;
    const item0 = (out.items as Array<Record<string, unknown>>)[0]!;
    expect(String(item0.session_id)).toContain("REDACTED");
  });

  it("nested の正規 session_id も depth>0 では keep されない (top-level 限定の対称確認)", () => {
    // 正規 `sess_<uuid>` は high-entropy が当たるため nested では従来どおりマスクされる
    //   (= keep は top-level の identity フィールドのみ。projection は top-level session_id で行う)。
    const sid = `sess_${newEventId()}`;
    const out = redactDeep({ payload: { session_id: sid } }) as Record<string, unknown>;
    const inner = out.payload as Record<string, unknown>;
    expect(inner.session_id).not.toBe(sid); // depth>0 では keep されない
  });

  it("top-level session_id は keep されつつ、同イベントの payload.session_id はマスクされる (両立)", () => {
    const sid = `sess_${newEventId()}`;
    const out = redactDeep({
      session_id: sid, // top-level = keep
      payload: { session_id: secret }, // nested = mask
    }) as Record<string, unknown>;
    expect(out.session_id).toBe(sid);
    expect(String((out.payload as Record<string, unknown>).session_id)).toContain("REDACTED");
  });
});
