/**
 * INV-CURRENT-ACTION-I18N / INV-CURRENT-ACTION-FALLBACK (ADR 019eeac6).
 *
 * 「現在のアクション要約 (current_action)」の **表示時ローカライズ** の不変条件。
 * 根因: normalizer が event.summary に日本語固定文字列を焼き込み、それが current_action として
 * DTO→UI へ素通しされ、UI を英語にしても要約が日本語のまま残る。対策: 保存は言語非依存にし、
 * 表示する瞬間に viewer の locale で (kind, subject) から述語を組み立てる (formatCurrentAction)。
 *
 *  - INV-CURRENT-ACTION-I18N:     同一 (kind, subject) から ja/en で**異なる正しい述語**を返す。
 *                                 mutation: locale を無視して ja 固定にすると en ケースが赤。
 *  - INV-CURRENT-ACTION-FALLBACK: kind 欠落 (legacy 行) → fallback(current_action) を返す。
 *                                 subject 欠落 → 述語のみ。全欠落 → undefined (state→dash は呼び元)。
 *                                 mutation: fallback chain を削ると legacy 行が undefined で赤。
 *
 * 写像の単一出所: formatCurrentAction は actionVerb と同一の actionVerbKey 写像を共有する
 * (kind→述語のドリフト防止・TDA 指摘)。本テストはその共有結果が両 locale で正しいことを実証する。
 */
import { describe, expect, it } from "vitest";

import { foldActionUnits } from "../src/ui/action-units.js";
import { actionVerb, formatCurrentAction } from "../src/ui/action-units-display.js";
import { t } from "../src/ui/i18n/messages.js";

import type { ActionKind } from "../src/ui/action-units.js";
import type { ReplayEventDTO } from "../src/realtime/contract.js";

describe("INV-CURRENT-ACTION-I18N: formatCurrentAction の表示時ローカライズ", () => {
  it("同一 (kind, subject) から ja/en で異なる正しい述語 + subject を返す (command)", () => {
    const ja = formatCurrentAction({ kind: "command", subject: "npm test" }, "ja");
    const en = formatCurrentAction({ kind: "command", subject: "npm test" }, "en");

    // 述語が locale 別で異なる (焼き込み日本語固定からの脱却)。
    expect(ja).toBe("コマンド実行: npm test");
    expect(en).toBe("Run command: npm test");
    // mutation 反証: locale を無視して ja 固定にすると en !== ja で赤になる。
    expect(en).not.toBe(ja);
  });

  it("全 ActionKind (other 以外) が ja/en で述語を持ち、両 locale で異なる", () => {
    const kinds: ActionKind[] = [
      "approval",
      "command",
      "file",
      "tool",
      "mcp",
      "web",
      "turn",
      "session",
      "message",
      "liveness",
    ];
    for (const kind of kinds) {
      const ja = formatCurrentAction({ kind, subject: "X" }, "ja");
      const en = formatCurrentAction({ kind, subject: "X" }, "en");
      expect(ja).toBeDefined();
      expect(en).toBeDefined();
      // 述語部分が両 locale で異なる (subject "X" は共通なので述語差で全体差になる)。
      expect(ja).not.toBe(en);
      // subject が末尾に付く。
      expect(ja!.endsWith("X")).toBe(true);
      expect(en!.endsWith("X")).toBe(true);
    }
  });

  it("approval は current_action では単一トーン述語 (approvalPending) を使う", () => {
    expect(formatCurrentAction({ kind: "approval" }, "ja")).toBe(
      t("ja", "action.verb.approvalPending"),
    );
    expect(formatCurrentAction({ kind: "approval" }, "en")).toBe(
      t("en", "action.verb.approvalPending"),
    );
  });

  it("subject 欠落時は述語のみ (locale 別)", () => {
    expect(formatCurrentAction({ kind: "command" }, "ja")).toBe("コマンド実行");
    expect(formatCurrentAction({ kind: "command" }, "en")).toBe("Run command");
  });

  it("写像の単一出所: 非承認 standalone unit の actionVerb と述語キーが一致する", () => {
    // actionVerb (timeline) と formatCurrentAction (current_action) は actionVerbKey を共有する。
    let seq = 0;
    const ev = (o: Partial<ReplayEventDTO>): ReplayEventDTO => ({
      event_id: `e${(seq += 1)}`,
      provider: "claude_code",
      source: "hooks",
      session_id: "s1",
      event_type: "web.search.started",
      kind: "web",
      timestamp: "2026-06-12T01:02:03.000Z",
      state: undefined,
      cwd: undefined,
      summary: undefined,
      display_text: "x",
      subject: undefined,
      request_id: undefined,
      tool_name: undefined,
      command: undefined,
      path: undefined,
      decision: undefined,
      risk_level: undefined,
      auto_allowed: undefined,
      exit_code: undefined,
      elapsed_ms: undefined,
      ...o,
    });
    const [unit] = foldActionUnits([ev({ kind: "web", event_type: "web.search.started" })]);
    const verb = actionVerb(unit!, "en");
    // formatCurrentAction(subject 無し) は述語のみ → actionVerb の label と一致 (共有写像)。
    expect(formatCurrentAction({ kind: "web" }, "en")).toBe(verb.label);
  });
});

describe("INV-CURRENT-ACTION-FALLBACK: 後方互換 fallback チェーン", () => {
  it("kind 欠落 (legacy 行) は fallback (current_action 文字列) を返す", () => {
    expect(formatCurrentAction({ fallback: "コマンド実行: legacy" }, "en")).toBe(
      "コマンド実行: legacy",
    );
    // mutation 反証: return input.fallback を削ると legacy 行が undefined になり赤。
  });

  it("kind=other (述語なし) も fallback へ落ちる", () => {
    expect(formatCurrentAction({ kind: "other", fallback: "legacy summary" }, "en")).toBe(
      "legacy summary",
    );
    expect(formatCurrentAction({ kind: "other", subject: "ignored" }, "en")).toBeUndefined();
  });

  it("全欠落は undefined (state→dash は呼び元の既存チェーンに委ねる)", () => {
    expect(formatCurrentAction({}, "ja")).toBeUndefined();
    expect(
      formatCurrentAction({ kind: undefined, subject: undefined, fallback: undefined }, "en"),
    ).toBeUndefined();
  });

  it("kind ありなら fallback より kind+subject を優先する", () => {
    expect(
      formatCurrentAction({ kind: "command", subject: "ls", fallback: "古い日本語要約" }, "en"),
    ).toBe("Run command: ls");
  });
});
