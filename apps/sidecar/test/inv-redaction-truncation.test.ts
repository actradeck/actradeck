/**
 * INV-REDACTION-TRUNCATION (3#SEC-2): truncation-before-redaction 違反の回帰テスト。
 *
 * 背景: round-2 で ReDoS 対策として normalize.ts の summarize()/MAX_COMMAND_LEN 切り詰めと
 * redactor.ts の MAX_REDACT_INPUT slice を入れたが、これらが redactDeep (sink) より「前段」で
 * 走ると、cut 境界を跨ぐ secret の断片 (例: `ghp_` 本体が最小長ルール未満まで切られる) が
 * 未マスクのまま summary/payload に残留し store/WS へ流れる。INV-REDACTION の順序
 * (redact→persist→send) 違反。
 *
 * 対策後の不変条件: 切り詰め (summarize / MAX_REDACT_INPUT) は redaction の「後」に走る。
 * vendor token / URL credential / Cookie / basic-auth を **各 cut 長境界** に配置しても、
 *   (a) summarize(60/100/MAX_COMMAND_LEN) の出力、
 *   (b) redactString(MAX_REDACT_INPUT 境界) の出力、
 *   (c) normalizeHook → EventSink.emit 後の store 行 (実 SQLite)、
 * のいずれにも secret 断片が残らないことを assert する。
 *
 * 「赤→緑」: summarize が slice→redact 順 (修正前) だと境界跨ぎ断片が残り赤。
 *           redact→slice 順 (修正後) で緑。
 */
import { describe, expect, it, vi } from "vitest";

import { MAX_COMMAND_LEN, normalizeHook } from "../src/normalize.js";
import { MAX_REDACT_INPUT, redactString } from "../src/redactor.js";
import { EventSink } from "../src/sink.js";
import { EventStore } from "../src/store.js";
import type { WsClient } from "../src/ws-client.js";

/**
 * cut 境界に置いて「跨ぎ断片」を作る vendor token サンプル。
 * value: 完全な secret 文字列 / fragMin: 残ってはいけない判別可能な断片
 * (短く切られても秘匿性が漏れる識別子部分)。
 */
const VENDOR: Array<{ kind: string; value: string; frag: string }> = [
  {
    kind: "github-pat",
    value: "ghp_1234567890abcdefABCDEF1234567890abcd",
    frag: "ghp_1234567890abcdef",
  },
  {
    kind: "anthropic",
    value: "sk-ant-api03-aBcDeFgHiJkLmNoPqRsTuVwXyZ012345",
    frag: "sk-ant-api03-aBcDeFgHiJkLmNoP",
  },
  {
    kind: "aws-access-key",
    value: "AKIAIOSFODNN7EXAMPLE",
    frag: "AKIAIOSFODNN7EXAMPLE",
  },
  {
    kind: "gitlab-pat",
    value: "glpat-ABCDEF1234567890wxyz",
    frag: "glpat-ABCDEF1234567890",
  },
];

/** URL / Cookie / basic-auth の値も境界跨ぎ対象。 */
const STRUCTURAL: Array<{ kind: string; value: string; frag: string }> = [
  {
    kind: "url-credential",
    value: "postgres://app:s3cretP4ssXyz@db.internal:5432/x",
    frag: "s3cretP4ssXyz",
  },
  {
    kind: "cookie",
    value: "Cookie: session=abc123def456ghi789xyzSECRET",
    frag: "abc123def456ghi789xyzSECRET",
  },
  {
    kind: "basic-auth",
    value: "Authorization: Basic dXNlcjpwYXNzd29yZFNlY3JldA==",
    frag: "dXNlcjpwYXNzd29yZFNlY3JldA",
  },
];

const ALL = [...VENDOR, ...STRUCTURAL];

/**
 * secret を offset の位置に置いた長い command 文字列を作る (cut 境界跨ぎを誘発)。
 *
 * 現実の出現形に合わせ、secret 直前に区切り (空白) を挟む。これは
 *   (1) 多くのルールが要求する `\b` 単語境界を成立させる (= テスト人工物で未マッチにしない)、
 *   (2) Cookie:/Bearer 等のラベル付き secret がラベルから始まるのを許す、
 * ためで、redaction 自体の振る舞いを変えるものではない (padding は秘匿対象外)。
 */
function placeAt(secret: string, offset: number, totalLen: number): string {
  // offset 位置の 1 つ手前を区切りにして単語境界を作る。
  const padLen = Math.max(0, offset - 1);
  const pad = "x".repeat(padLen) + (padLen > 0 ? " " : "");
  const tail = " " + "y".repeat(Math.max(0, totalLen - offset - secret.length));
  return pad + secret + tail;
}

describe("INV-REDACTION-TRUNCATION (3#SEC-2): summarize redacts BEFORE truncating", () => {
  // summarize は max=60/100/MAX_COMMAND_LEN で呼ばれる。各 cut 長の「直前」に secret を
  // 置くと、slice→redact 順 (修正前) なら secret が途中で切られ断片残留 = 赤。
  const CUTS = [60, 100, MAX_COMMAND_LEN];

  for (const { kind, value, frag } of ALL) {
    for (const cut of CUTS) {
      it(`summarize(${cut}) never leaves a fragment of ${kind} straddling the cut`, () => {
        // secret 開始位置を cut 境界の数文字手前に置く (= cut が secret 本体を割る)。
        for (const off of [cut - 5, cut - 10, cut - Math.floor(value.length / 2)]) {
          if (off < 0) continue;
          const raw = placeAt(value, off, cut + value.length + 20);
          // summarize は内部で redactString → 1行化 → slice する。
          const out = normalizeSummaryProbe(raw, cut);
          expect(
            out,
            `${kind} frag leaked at cut=${cut} off=${off}: ${out.slice(0, 80)}`,
          ).not.toContain(frag);
        }
      });
    }
  }
});

/**
 * summarize は module-private のため、PreToolUse(Bash) 経路で間接的に呼ぶ。
 * `コマンド実行: ${summarize(command, 100)}` と payload.command=`summarize(command, MAX_COMMAND_LEN)`。
 * ここでは summary 文字列を取り出して cut=100 / MAX_COMMAND_LEN 双方を検査する。
 */
function normalizeSummaryProbe(command: string, _cut: number): string {
  const evs = normalizeHook({
    session_id: "s1",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
  });
  const ev = evs[0]!;
  // summary(cut=100) と payload.command(cut=MAX_COMMAND_LEN) の両方を連結して検査対象に。
  const cmd = (ev.payload as { command?: string }).command ?? "";
  return `${ev.summary ?? ""}${String.fromCharCode(0)}${cmd}`;
}

describe("INV-REDACTION-TRUNCATION (3#SEC-2): redactString truncates AFTER masking", () => {
  for (const { kind, value, frag } of ALL) {
    it(`redactString masks ${kind} straddling the MAX_REDACT_INPUT boundary`, () => {
      // secret を MAX_REDACT_INPUT 境界の手前に置く (= 表示用 slice が本体を割る位置)。
      const raw = placeAt(
        value,
        MAX_REDACT_INPUT - Math.floor(value.length / 2),
        MAX_REDACT_INPUT + value.length + 100,
      );
      const out = redactString(raw);
      expect(out, `${kind} fragment survived MAX_REDACT_INPUT cut`).not.toContain(frag);
    });
  }
});

describe("INV-REDACTION-TRUNCATION (3#SEC-2): full normalize → EventSink.emit (real SQLite)", () => {
  for (const { kind, value, frag } of ALL) {
    it(`no fragment of ${kind} persists to store after emit (cut boundary)`, () => {
      const store = new EventStore(":memory:");
      const wsClient = { notifyAppended: () => {} } as unknown as WsClient;
      const sink = new EventSink({ store, wsClient });

      // PreToolUse(Bash) を MAX_COMMAND_LEN 境界跨ぎ位置の secret で正規化 → emit。
      const command = placeAt(value, MAX_COMMAND_LEN - 8, MAX_COMMAND_LEN + value.length + 50);
      for (const ev of normalizeHook({
        session_id: "s1",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
      })) {
        sink.emit(ev);
      }

      for (const row of store.allRows()) {
        expect(row.event_json, `${kind} frag persisted to SQLite`).not.toContain(frag);
        expect(row.event_json).not.toContain(value);
      }
      expect(store.totalCount()).toBeGreaterThan(0);
      store.close();
    });
  }

  it("PermissionRequest summary/command also redact before the 60/MAX_COMMAND_LEN cuts", () => {
    const store = new EventStore(":memory:");
    const appendSpy = vi.spyOn(store, "append");
    const wsClient = { notifyAppended: () => {} } as unknown as WsClient;
    const sink = new EventSink({ store, wsClient });

    // 承認サマリは summarize(...,60); payload.command は summarize(...,MAX_COMMAND_LEN)。
    const command = `git push --force ghp_1234567890abcdefABCDEF1234567890abcd`;
    for (const ev of normalizeHook({
      session_id: "s1",
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command },
    })) {
      sink.emit(ev);
    }

    for (const call of appendSpy.mock.calls) {
      const json = JSON.stringify(call[0]);
      expect(json).not.toContain("ghp_1234567890abcdefABCDEF1234567890abcd");
      expect(json).not.toContain("ghp_1234567890abcdef");
    }
    store.close();
  });
});
