/**
 * INV-REPLAY-DISPLAY-I18N / INV-REPLAY-DISPLAY-FALLBACK (P2・ADR 019eeac6 D6・decision 019eeb1d).
 *
 * replay の timeline 行 / replay current_action の **表示時ローカライズ** の不変条件。
 * 根因 (P1 と同型): normalizer が event.summary に日本語固定文字列を焼き込み、それが
 * ReplayEventDTO.display_text として UI へ素通しされ、UI を英語にしても要約が日本語のまま残る。
 * 対策: replay 行は `formatCurrentAction({kind, subject, fallback: display_text}, locale)` で
 * 表示時に viewer locale で述語を組み立てる (保存は言語非依存)。
 *
 *  - INV-REPLAY-DISPLAY-I18N:     同一 ReplayEvent(kind, subject) から ja/en で**異なる正しい
 *                                 述語 + subject** を返す。mutation: locale を無視して ja 固定に
 *                                 すると en ケースが赤。
 *  - INV-REPLAY-DISPLAY-FALLBACK: kind 欠落 → display_text(fallback)。subject 欠落 → 述語のみ。
 *                                 mutation: fallback chain を削ると legacy 行が undefined で赤。
 *
 * error kind: ReplayEventKind = ActionKind ∪ {"error"}。formatCurrentAction は replay 経路では
 * error を `action.verb.error` (ja「エラー」/ en「Error」) へ写す (cockpit 経路の ActionKind 契約不変)。
 */
import { describe, expect, it } from "vitest";

import { formatCurrentAction } from "../src/ui/action-units-display.js";
import { t } from "../src/ui/i18n/messages.js";

import type { ReplayEventDTO } from "../src/realtime/contract.js";

/** replay 行レンダラ (RawRow) と同じ表示文字列組み立て (テスト対象の純化)。 */
function replayRowText(
  // subject は欠落しうる (旧 DTO / subject に出せる構造値が無い event)。表示時ローカライズの
  // fallback 経路 (INV-REPLAY-DISPLAY-FALLBACK) を実証するため optional にする。
  event: Pick<ReplayEventDTO, "kind" | "display_text"> & Partial<Pick<ReplayEventDTO, "subject">>,
  locale: "ja" | "en",
): string {
  return (
    formatCurrentAction(
      { kind: event.kind, subject: event.subject, fallback: event.display_text },
      locale,
    ) ?? event.display_text
  );
}

describe("INV-REPLAY-DISPLAY-I18N: replay 行の表示時ローカライズ", () => {
  it("同一 ReplayEvent(kind, subject) から ja/en で異なる正しい述語 + subject を返す (command)", () => {
    const event = {
      kind: "command" as const,
      subject: "npm test",
      // display_text は日本語焼き込み (legacy summary)。表示時ローカライズで参照しない。
      display_text: "コマンド実行: npm test",
    };
    const ja = replayRowText(event, "ja");
    const en = replayRowText(event, "en");

    expect(ja).toBe("コマンド実行: npm test");
    expect(en).toBe("Run command: npm test");
    // mutation 反証: locale を無視し ja 固定 (display_text 直表示含む) にすると en !== ja で赤。
    expect(en).not.toBe(ja);
    // display_text (日本語焼き込み) が en で漏れていないことを明示。
    expect(en).not.toContain("コマンド実行");
  });

  it("全 ReplayEventKind (other 以外) が ja/en で述語を持ち、両 locale で異なる (error 含む)", () => {
    const kinds: ReplayEventDTO["kind"][] = [
      "session",
      "turn",
      "approval",
      "command",
      "file",
      "tool",
      "mcp",
      "web",
      "message",
      "liveness",
      "error",
    ];
    for (const kind of kinds) {
      const ja = replayRowText({ kind, subject: "X", display_text: "焼込" }, "ja");
      const en = replayRowText({ kind, subject: "X", display_text: "焼込" }, "en");
      expect(ja, `${kind} ja`).toBeDefined();
      expect(en, `${kind} en`).toBeDefined();
      // 述語部分が両 locale で異なる (subject "X" 共通なので述語差で全体差)。
      expect(ja, `${kind} ja!=en`).not.toBe(en);
      // subject が末尾に付く (述語 + subject の組み立て)。
      expect(ja.endsWith("X"), `${kind} ja subject`).toBe(true);
      expect(en.endsWith("X"), `${kind} en subject`).toBe(true);
      // display_text (焼込) が漏れていない。
      expect(ja).not.toContain("焼込");
      expect(en).not.toContain("焼込");
    }
  });

  it("error kind の表示が ja/en で正しい (エラー / Error)", () => {
    expect(formatCurrentAction({ kind: "error" }, "ja")).toBe(t("ja", "action.verb.error"));
    expect(formatCurrentAction({ kind: "error" }, "en")).toBe(t("en", "action.verb.error"));
    expect(formatCurrentAction({ kind: "error" }, "ja")).toBe("エラー");
    expect(formatCurrentAction({ kind: "error" }, "en")).toBe("Error");
    // subject ありなら「述語: subject」。
    expect(formatCurrentAction({ kind: "error", subject: "EPIPE" }, "en")).toBe("Error: EPIPE");
    expect(formatCurrentAction({ kind: "error", subject: "EPIPE" }, "ja")).toBe("エラー: EPIPE");
  });
});

describe("INV-REPLAY-DISPLAY-FALLBACK: replay 行の後方互換 fallback", () => {
  it("kind 欠落 (旧 DTO) は display_text(fallback) を返す", () => {
    // 旧クライアント/旧 DTO で kind が undefined のケースを replayRowText 経由で実証。
    const text = replayRowText(
      { kind: undefined as unknown as ReplayEventDTO["kind"], display_text: "旧 summary" },
      "en",
    );
    expect(text).toBe("旧 summary");
    // mutation 反証: formatCurrentAction の `return input.fallback` を削ると undefined→
    // `?? event.display_text` で救われるが、fallback 経路自体を消すと kind あり subject 無し時に
    // 述語へ落ちず壊れる (下の subject 欠落ケースで担保)。
  });

  it("subject 欠落時は述語のみ (locale 別・display_text には落ちない)", () => {
    const ja = replayRowText({ kind: "file", display_text: "ファイル変更: /secret" }, "ja");
    const en = replayRowText({ kind: "file", display_text: "ファイル変更: /secret" }, "en");
    expect(ja).toBe("ファイル変更");
    expect(en).toBe("Change file");
    // mutation 反証: kind を無視して fallback(display_text) 直表示にすると en が日本語焼込で赤。
    expect(en).not.toContain("ファイル変更");
  });

  it("kind=other (述語なし) は display_text(fallback) へ落ちる", () => {
    const text = replayRowText(
      { kind: "other", subject: "ignored", display_text: "raw event_type 文字列" },
      "en",
    );
    expect(text).toBe("raw event_type 文字列");
  });

  it("kind ありなら fallback(display_text) より kind+subject を優先 (英語 UI で日本語焼込を出さない)", () => {
    const en = replayRowText(
      { kind: "command", subject: "ls", display_text: "コマンド実行: ls" },
      "en",
    );
    expect(en).toBe("Run command: ls");
  });
});
