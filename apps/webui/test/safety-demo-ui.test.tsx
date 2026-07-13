/**
 * ADR 019f22a7 P1: first-run セーフティデモ UI の描画契約 + 起動応答パーサの NO-RAW 契約。
 *
 * - parseDemoLaunch: `demo-safety-` prefix の session_id のみ抽出し、それ以外 (別 prefix / 非文字列 /
 *   奇形) は null へ縮退する (生値を掴まない)。
 * - SafetyDemoPanel (SessionList 経由): CTA + capability 3 行を描画。phase で二度押し抑止 (disabled) /
 *   進行表示 / 失敗表示を切り替える。**静的✓を作らない** (readiness の ✓/✗ とは別・capability コピー)。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FixedLocaleProvider } from "../src/ui/LocaleProvider.js";
import { SessionList } from "../src/ui/SessionList.js";
import { parseDemoLaunch } from "../src/ui/use-safety-demo.js";

import type { SafetyDemoPhase } from "../src/ui/use-safety-demo.js";

function renderPanel(phase: SafetyDemoPhase): string {
  return renderToStaticMarkup(
    <FixedLocaleProvider locale="ja">
      <SessionList
        sessions={[]}
        selectedId={null}
        nowMs={0}
        onSelect={() => {}}
        readiness={{ daemonCount: 1 }}
        safety={{ phase, onLaunch: () => {} }}
      />
    </FixedLocaleProvider>,
  );
}

describe("parseDemoLaunch (NO-RAW: demo-safety prefix のみ)", () => {
  it("demo-safety- prefix の session_id を抽出する", () => {
    expect(parseDemoLaunch({ session_id: "demo-safety-abcd1234" })).toBe("demo-safety-abcd1234");
    expect(parseDemoLaunch({ session_id: "demo-safety-ff00", already_running: true })).toBe(
      "demo-safety-ff00",
    );
  });

  it("別 prefix / 非文字列 / 奇形は null へ縮退する (生値を掴まない)", () => {
    expect(parseDemoLaunch({ session_id: "sess-evil-1234" })).toBeNull();
    expect(parseDemoLaunch({ session_id: 42 })).toBeNull();
    expect(parseDemoLaunch({ session_id: null })).toBeNull();
    expect(parseDemoLaunch({})).toBeNull();
    expect(parseDemoLaunch(null)).toBeNull();
    expect(parseDemoLaunch("demo-safety-x")).toBeNull();
  });
});

describe("SafetyDemoPanel (空状態 CTA)", () => {
  it("readiness パネル下に CTA + capability 3 行を描画する", () => {
    const html = renderPanel("idle");
    expect(html).toContain('data-testid="safety-demo"');
    expect(html).toContain('data-testid="safety-demo-cta"');
    expect(html).toContain('data-phase="idle"');
    // capability コピー (止める・マスクする・証明できる) を capability として提示 (静的✓は使わない)。
    expect(html).toContain("止める");
    expect(html).toContain("マスクする");
    expect(html).toContain("証明できる");
    expect(html).not.toContain('data-testid="safety-demo-error"');
  });

  it("launching / running は CTA を disabled にし進行を表示する (二度押し抑止)", () => {
    const launching = renderPanel("launching");
    expect(launching).toContain('data-phase="launching"');
    expect(launching).toContain('data-testid="safety-demo-progress"');
    // CTA は disabled (mutating 起動の二度押しを塞ぐ)。
    expect(launching).toMatch(/data-testid="safety-demo-cta"[^>]*disabled/);

    const running = renderPanel("running");
    expect(running).toContain('data-phase="running"');
    expect(running).toMatch(/data-testid="safety-demo-cta"[^>]*disabled/);
  });

  it("error は固定リテラルのエラーを表示する (生値エコーしない)", () => {
    const html = renderPanel("error");
    expect(html).toContain('data-testid="safety-demo-error"');
    expect(html).toContain("デモを起動できませんでした");
    expect(html).not.toMatch(/data-testid="safety-demo-cta"[^>]*disabled/);
  });

  it("接続 daemon 0 (Docker 初期状態・daemonCount=0) でも CTA が出る (decision 019f387f)", () => {
    // Docker cockpit を開いた直後は host sidecar 未接続 (readiness.daemonCount=0) だが、CTA が
    // self-run セーフティデモの唯一の onramp。disconnected 文言と **同時に** CTA を必ず描画する
    // (connected gate で CTA を隠さない)。これを欠くと空 cockpit のまま導線ゼロに戻る回帰。
    const html = renderToStaticMarkup(
      <FixedLocaleProvider locale="ja">
        <SessionList
          sessions={[]}
          selectedId={null}
          nowMs={0}
          onSelect={() => {}}
          readiness={{ daemonCount: 0 }}
          safety={{ phase: "idle", onLaunch: () => {} }}
        />
      </FixedLocaleProvider>,
    );
    expect(html).toContain('data-testid="readiness"');
    expect(html).toContain('data-connected="false"'); // 未接続を正直に表示。
    expect(html).toContain('data-testid="readiness-disconnected"');
    // それでも CTA は描画される (zero-daemon でも self-run できる)。
    expect(html).toContain('data-testid="safety-demo"');
    expect(html).toContain('data-testid="safety-demo-cta"');
    expect(html).not.toMatch(/data-testid="safety-demo-cta"[^>]*disabled/); // idle は押せる。
  });

  it("safety 未指定なら CTA を描画しない (readiness のみ・後方互換)", () => {
    const html = renderToStaticMarkup(
      <FixedLocaleProvider locale="ja">
        <SessionList
          sessions={[]}
          selectedId={null}
          nowMs={0}
          onSelect={() => {}}
          readiness={{ daemonCount: 1 }}
        />
      </FixedLocaleProvider>,
    );
    expect(html).toContain('data-testid="readiness"');
    expect(html).not.toContain('data-testid="safety-demo"');
  });
});
