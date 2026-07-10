/**
 * SessionList の描画契約（Adaptive Clarity PR-C1: Carbon→kit 移行の回帰防衛）。
 *
 * react-dom/server で静的描画し、KPI（1 行で動/詰まり/介入要否）の data-testid 契約と
 * liveness suspected 表記・介入強調・table semantics を固定する（REAL DATA: SessionListItem の wire 形）。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SessionList } from "../src/ui/SessionList.js";
import { FixedLocaleProvider } from "../src/ui/LocaleProvider.js";

import type { SessionListItem } from "../src/realtime/contract.js";

function item(o: Partial<SessionListItem> = {}): SessionListItem {
  return {
    session_id: "sess-abcdef123456",
    provider: "claude_code",
    source: "hooks",
    agent_id: "agent-1",
    repo: "acme/app",
    branch: "main",
    cwd: "/repo",
    state: "running.command_executing",
    current_action: "npm test",
    last_event_at: "2026-06-07T00:00:00.000Z",
    needs_attention: false,
    liveness_state: "live",
    stalled_suspected: false,
    connected: true,
    ...o,
  };
}

describe("SessionList", () => {
  it("空なら empty-list を出す", () => {
    const html = renderToStaticMarkup(
      <SessionList sessions={[]} selectedId={null} nowMs={0} onSelect={() => {}} />,
    );
    expect(html).toContain('data-testid="empty-list"');
  });

  it("emptyAction 指定で空状態にアクションボタンを出す (履歴ゲート緩和: 履歴も含めて検索)", () => {
    const html = renderToStaticMarkup(
      <SessionList
        sessions={[]}
        selectedId={null}
        nowMs={0}
        onSelect={() => {}}
        emptyLabel="一致なし"
        emptyAction={{ label: "履歴も含めて検索", onClick: () => {} }}
      />,
    );
    expect(html).toContain('data-testid="empty-action"');
    expect(html).toContain("履歴も含めて検索");
    expect(html).toContain("一致なし");
  });

  it("emptyAction 未指定なら空状態にボタンを出さない", () => {
    const html = renderToStaticMarkup(
      <SessionList sessions={[]} selectedId={null} nowMs={0} onSelect={() => {}} />,
    );
    expect(html).not.toContain('data-testid="empty-action"');
  });

  it("readiness 指定 (daemon 接続あり) で接続済み readiness パネルを出す", () => {
    const html = renderToStaticMarkup(
      <SessionList
        sessions={[]}
        selectedId={null}
        nowMs={0}
        onSelect={() => {}}
        readiness={{ daemonCount: 2 }}
      />,
    );
    expect(html).toContain('data-testid="readiness"');
    expect(html).toContain('data-connected="true"');
    expect(html).toContain('data-testid="readiness-connected"');
    // 観測 daemon 数を埋め込む (実観測のみ)。
    expect(html).toContain("2");
    // doctor ヒントを併記する。
    expect(html).toContain("actradeck doctor");
    // 通常の空文言/未接続文言は出さない。
    expect(html).not.toContain('data-testid="empty-list"');
    expect(html).not.toContain('data-testid="readiness-disconnected"');
  });

  it("readiness 指定 (daemon 未接続) で未接続 readiness パネルを出す", () => {
    const html = renderToStaticMarkup(
      <SessionList
        sessions={[]}
        selectedId={null}
        nowMs={0}
        onSelect={() => {}}
        readiness={{ daemonCount: 0 }}
      />,
    );
    expect(html).toContain('data-testid="readiness"');
    expect(html).toContain('data-connected="false"');
    expect(html).toContain('data-testid="readiness-disconnected"');
    // セットアップ導線 (up / ad-attach) を示す。
    expect(html).toContain("scripts/actradeck up");
    expect(html).not.toContain('data-testid="readiness-connected"');
  });

  // ── ADR 019f1972 §2b: per-agent ✓/✗/— 行 ──────────────────────────────────────────
  it("readiness per-agent (Claude 配線済み / Codex 観測可能) で ✓ 行を出す", () => {
    const html = renderToStaticMarkup(
      <SessionList
        sessions={[]}
        selectedId={null}
        nowMs={0}
        onSelect={() => {}}
        readiness={{
          daemonCount: 1,
          claude: { binaryOnPath: true, anyHook: true },
          codex: { binaryOnPath: true, rolloutDirResolved: true },
        }}
      />,
    );
    expect(html).toContain('data-testid="readiness-agents"');
    expect(html).toContain('data-testid="readiness-agent-claude"');
    expect(html).toContain('data-state="wired"');
    expect(html).toContain('data-testid="readiness-agent-codex"');
    expect(html).toContain('data-state="observable"');
    expect(html).toContain("配線済み");
    expect(html).toContain("観測可能");
    // per-agent があるとき汎用 doctor ヒントは出さない (拡張・置換)。
    expect(html).not.toContain("検出済みだが");
  });

  it("readiness per-agent (検出のみ=未配線) で ✗ 行・doctor 導線を出す", () => {
    const html = renderToStaticMarkup(
      <SessionList
        sessions={[]}
        selectedId={null}
        nowMs={0}
        onSelect={() => {}}
        readiness={{
          daemonCount: 1,
          claude: { binaryOnPath: true, anyHook: false },
          codex: { binaryOnPath: true, rolloutDirResolved: false },
        }}
      />,
    );
    expect(html).toContain('data-testid="readiness-agent-claude"');
    expect(html).toContain('data-state="detected"');
    expect(html).toContain("actradeck doctor"); // Claude 未配線の導線。
    expect(html).toContain("rollout 未解決"); // Codex 未解決。
  });

  it("readiness per-agent (未検出) で — 行を出す", () => {
    const html = renderToStaticMarkup(
      <SessionList
        sessions={[]}
        selectedId={null}
        nowMs={0}
        onSelect={() => {}}
        readiness={{
          daemonCount: 1,
          claude: { binaryOnPath: false, anyHook: false },
          codex: { binaryOnPath: false, rolloutDirResolved: false },
        }}
      />,
    );
    expect(html).toContain('data-testid="readiness-agent-claude"');
    expect(html).toContain('data-state="missing"');
    expect(html).toContain("未検出");
  });

  // INV-READINESS-CODEX-MANAGED-HINT (ADR 019f3960 C): Managed 導線 hint は codex が
  // observable/detected の時のみ出す (missing は非表示)。command は runnable な共有リテラル
  // (./scripts/actradeck codex …)・locale 非依存。文言 (散文) は ja/en 両カタログに存在 (parity)。
  it("readiness codex observable で Managed 導線 hint を出す (runnable command + 検知のみ 開示)", () => {
    const html = renderToStaticMarkup(
      <SessionList
        sessions={[]}
        selectedId={null}
        nowMs={0}
        onSelect={() => {}}
        readiness={{
          daemonCount: 1,
          claude: { binaryOnPath: true, anyHook: true },
          codex: { binaryOnPath: true, rolloutDirResolved: true },
        }}
      />,
    );
    expect(html).toContain('data-testid="readiness-codex-managed-hint"');
    expect(html).toContain("./scripts/actradeck codex"); // PATH に依存しない runnable 表記。
    expect(html).toContain("Managed"); // 導線文言 (ja)。
  });

  it("readiness codex detected でも Managed 導線 hint を出す", () => {
    const html = renderToStaticMarkup(
      <SessionList
        sessions={[]}
        selectedId={null}
        nowMs={0}
        onSelect={() => {}}
        readiness={{
          daemonCount: 1,
          claude: { binaryOnPath: true, anyHook: false },
          codex: { binaryOnPath: true, rolloutDirResolved: false },
        }}
      />,
    );
    expect(html).toContain('data-testid="readiness-codex-managed-hint"');
    expect(html).toContain("./scripts/actradeck codex");
  });

  it("readiness codex missing では Managed 導線 hint を出さない (未検出は非表示)", () => {
    const html = renderToStaticMarkup(
      <SessionList
        sessions={[]}
        selectedId={null}
        nowMs={0}
        onSelect={() => {}}
        readiness={{
          daemonCount: 1,
          claude: { binaryOnPath: false, anyHook: false },
          codex: { binaryOnPath: false, rolloutDirResolved: false },
        }}
      />,
    );
    expect(html).not.toContain('data-testid="readiness-codex-managed-hint"');
    expect(html).not.toContain("./scripts/actradeck codex");
  });

  it("readiness codex managed hint は en カタログでも描画される (locale parity)", () => {
    const html = renderToStaticMarkup(
      <FixedLocaleProvider locale="en">
        <SessionList
          sessions={[]}
          selectedId={null}
          nowMs={0}
          onSelect={() => {}}
          readiness={{
            daemonCount: 1,
            claude: { binaryOnPath: true, anyHook: true },
            codex: { binaryOnPath: true, rolloutDirResolved: true },
          }}
        />
      </FixedLocaleProvider>,
    );
    expect(html).toContain('data-testid="readiness-codex-managed-hint"');
    expect(html).toContain("launch Managed"); // en 文言。
    expect(html).toContain("./scripts/actradeck codex"); // command は locale 非依存リテラル。
  });

  it("readiness per-agent 省略 (2a coarse 形・daemonCount のみ) は doctor ヒントへフォールバック (後方互換)", () => {
    const html = renderToStaticMarkup(
      <SessionList
        sessions={[]}
        selectedId={null}
        nowMs={0}
        onSelect={() => {}}
        readiness={{ daemonCount: 2 }}
      />,
    );
    expect(html).toContain('data-testid="readiness-connected"');
    expect(html).toContain("actradeck doctor"); // 2a の汎用ヒント。
    expect(html).not.toContain('data-testid="readiness-agents"'); // per-agent 行は出さない。
  });

  it("readiness per-agent でも未接続 (daemonCount 0) なら disconnected を優先 (per-agent 行は出さない)", () => {
    const html = renderToStaticMarkup(
      <SessionList
        sessions={[]}
        selectedId={null}
        nowMs={0}
        onSelect={() => {}}
        readiness={{
          daemonCount: 0,
          claude: { binaryOnPath: true, anyHook: true },
          codex: { binaryOnPath: false, rolloutDirResolved: false },
        }}
      />,
    );
    expect(html).toContain('data-testid="readiness-disconnected"');
    expect(html).not.toContain('data-testid="readiness-agents"');
  });

  it("readiness 未指定なら従来の empty-list にフォールバック (回帰防衛)", () => {
    const html = renderToStaticMarkup(
      <SessionList sessions={[]} selectedId={null} nowMs={0} onSelect={() => {}} />,
    );
    expect(html).toContain('data-testid="empty-list"');
    expect(html).not.toContain('data-testid="readiness"');
  });

  it("ネイティブ table + caption + 行ごとの KPI セルを描画", () => {
    const html = renderToStaticMarkup(
      <SessionList
        sessions={[item()]}
        selectedId={null}
        nowMs={Date.parse("2026-06-07T00:00:05.000Z")}
        onSelect={() => {}}
      />,
    );
    expect(html).toContain("<table");
    expect(html).toContain("<caption");
    expect(html).toContain('data-testid="session-row"');
    for (const id of ["liveness", "action", "attention", "repo", "last-event", "provider"]) {
      expect(html).toContain(`data-testid="${id}"`);
    }
    // liveness は live→success tone + LIVE ラベル。
    expect(html).toContain("LIVE");
    expect(html).toContain('data-tone="ok"');
    // repo@branch / provider。
    expect(html).toContain("acme/app@main");
    expect(html).toContain("claude_code");
    // age（5s）。
    expect(html).toContain("5s");
  });

  it("stalled は suspected 表記（断定しない）・選択行は aria-selected", () => {
    const html = renderToStaticMarkup(
      <SessionList
        sessions={[item({ liveness_state: "stalled", stalled_suspected: true })]}
        selectedId="sess-abcdef123456"
        nowMs={0}
        onSelect={() => {}}
      />,
    );
    expect(html).toContain("STALLED?");
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('data-selected="true"');
  });

  it("承認待ちは介入強調（waiting kind を表示・data-attention）", () => {
    const html = renderToStaticMarkup(
      <SessionList
        sessions={[item({ state: "waiting.approval", needs_attention: true })]}
        selectedId={null}
        nowMs={0}
        onSelect={() => {}}
      />,
    );
    expect(html).toContain('data-attention="true"');
    expect(html).toContain("approval");
  });

  // ── ADR 019f41ec-c549: capture_mode の一覧レベル正直表示 (非 managed のみバッジ) ──────────────
  // detail pill と同一意味論を維持: 「外部起動 ({mode})」・attach=warn / codex_rollout=muted・
  // observe-only とは呼ばない・欠落/managed=バッジ無し=既定。存在/不在の両方向を固定する。
  describe("capture_mode バッジ (行レベル正直表示)", () => {
    it("attach 行はバッジを出す (warn tone + data-capture-mode)", () => {
      const html = renderToStaticMarkup(
        <SessionList
          sessions={[item({ capture_mode: "attach" })]}
          selectedId={null}
          nowMs={0}
          onSelect={() => {}}
        />,
      );
      expect(html).toContain('data-testid="session-capture-mode"');
      expect(html).toContain('data-capture-mode="attach"');
      expect(html).toContain("ad-tag--warn");
      expect(html).toContain("外部起動");
      // observe-only とは呼ばない (意味論契約)。
      expect(html).not.toContain("observe-only");
    });

    it("codex_rollout 行はバッジを出す (muted tone)", () => {
      const html = renderToStaticMarkup(
        <SessionList
          sessions={[item({ capture_mode: "codex_rollout" })]}
          selectedId={null}
          nowMs={0}
          onSelect={() => {}}
        />,
      );
      expect(html).toContain('data-testid="session-capture-mode"');
      expect(html).toContain('data-capture-mode="codex_rollout"');
      expect(html).toContain("ad-tag--muted");
      expect(html).toContain("外部起動");
    });

    it("managed 行はバッジを出さない (既定・断定表示しない)", () => {
      const html = renderToStaticMarkup(
        <SessionList
          sessions={[item({ capture_mode: "managed" })]}
          selectedId={null}
          nowMs={0}
          onSelect={() => {}}
        />,
      );
      expect(html).not.toContain('data-testid="session-capture-mode"');
    });

    it("capture_mode 欠落 (legacy/unknown) 行はバッジを出さない (Managed と断定しない)", () => {
      const base = item();
      // 欠落を明示 (item() は capture_mode を持たないが、override で undefined を保証)。
      const html = renderToStaticMarkup(
        <SessionList
          sessions={[{ ...base, capture_mode: undefined }]}
          selectedId={null}
          nowMs={0}
          onSelect={() => {}}
        />,
      );
      expect(html).not.toContain('data-testid="session-capture-mode"');
      expect(html).not.toContain("外部起動");
    });

    // ADR 019f47c2: source=external (gemini/opencode 等) は capture_mode 欠落でも managed と
    //   誤表示せず external バッジ (observe-only) を出す。
    it("source=external 行は external バッジを出す (managed 誤表示しない)", () => {
      const html = renderToStaticMarkup(
        <SessionList
          sessions={[{ ...item(), capture_mode: undefined, source: "external" }]}
          selectedId={null}
          nowMs={0}
          onSelect={() => {}}
        />,
      );
      expect(html).toContain('data-testid="session-capture-mode"');
      expect(html).toContain('data-capture-mode="external"');
      expect(html).toContain("外部 (observe-only)");
      // managed と誤表示しない (誤導防止)。
      expect(html).not.toContain('data-capture-mode="managed"');
    });

    it("en カタログでもバッジ文言を描画する (locale parity)", () => {
      const html = renderToStaticMarkup(
        <FixedLocaleProvider locale="en">
          <SessionList
            sessions={[item({ capture_mode: "attach" })]}
            selectedId={null}
            nowMs={0}
            onSelect={() => {}}
          />
        </FixedLocaleProvider>,
      );
      expect(html).toContain('data-testid="session-capture-mode"');
      expect(html).toContain("External launch");
      expect(html).not.toContain("外部起動");
    });
  });
});
