/**
 * PAL-v2 (ADR 019ee147): PersistedApprovalsPanel の静的描画 + parseAllowlist の NO-RAW 投影 INV。
 *
 * - parseAllowlist (UI 境界投影): 既知フィールドのみ採り、余剰 raw (command 等) を構造的に落とす。
 * - Panel 初期描画: lazy ゆえ未 load では一覧を出さず load ボタン + 端末全体である旨の文言を出す。
 *   i18n ja/en が反映され、ハードコード日本語が en に漏れない。
 * (populated 一覧の描画/失効操作は jsdom 不要の本テスト範囲外。NO-RAW は parse + backend/sidecar 投影で多重固定。)
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FixedLocaleProvider } from "../src/ui/LocaleProvider.js";
import { PersistedApprovalsPanel } from "../src/ui/PersistedApprovalsPanel.js";
import { parseAllowlist } from "../src/ui/use-allowlist.js";

function render(node: React.ReactNode, locale: "ja" | "en"): string {
  return renderToStaticMarkup(<FixedLocaleProvider locale={locale}>{node}</FixedLocaleProvider>);
}

describe("parseAllowlist (UI 境界 NO-RAW 投影)", () => {
  it("既知フィールドのみ採り、余剰 raw を落とす", () => {
    const v = parseAllowlist({
      enabled: true,
      entries: [
        {
          signature: "a".repeat(64),
          repo_scope: "scopeA",
          repo_label: "repoA",
          risk: "medium",
          created_at_ms: 1,
          expires_at_ms: 2,
          command: "rm -rf / AKIAIOSFODNN7EXAMPLE", // 余剰 raw
        },
      ],
    });
    expect(v).toBeDefined();
    expect(v!.enabled).toBe(true);
    expect(v!.entries).toHaveLength(1);
    const json = JSON.stringify(v!.entries);
    expect(json).not.toContain("rm -rf");
    expect(json).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(v!.entries[0]!.signature).toBe("a".repeat(64));
  });

  it("entries 非配列 / 非オブジェクトは undefined", () => {
    expect(parseAllowlist({ enabled: true })).toBeUndefined();
    expect(parseAllowlist(null)).toBeUndefined();
    expect(parseAllowlist("x")).toBeUndefined();
  });

  it("signature/repo_scope 欠落エントリは除外する", () => {
    const v = parseAllowlist({ enabled: false, entries: [{ risk: "medium" }, { signature: 1 }] });
    expect(v!.entries).toHaveLength(0);
  });
});

describe("PersistedApprovalsPanel 初期描画 (lazy・未 load)", () => {
  it("ja: タイトル / 端末全体の説明 / load ボタンを出し、一覧は出さない", () => {
    const html = render(<PersistedApprovalsPanel sessionId="s1" nowMs={1000} />, "ja");
    expect(html).toContain('data-testid="allowlist-panel"');
    expect(html).toContain("永続承認（この端末）");
    expect(html).toContain("この端末全体で共有");
    expect(html).toContain('data-testid="allowlist-load"');
    expect(html).toContain("永続承認を表示");
    // lazy: 未 load では一覧 / reload は描かれない。
    expect(html).not.toContain('data-testid="allowlist-list"');
    expect(html).not.toContain('data-testid="allowlist-reload"');
  });

  it("en: 英語ラベルが出てハードコード日本語が漏れない", () => {
    const html = render(<PersistedApprovalsPanel sessionId="s1" nowMs={1000} />, "en");
    expect(html).toContain("Persisted approvals (this machine)");
    expect(html).toContain("Show persisted approvals");
    expect(html).not.toContain("永続承認");
  });
});
