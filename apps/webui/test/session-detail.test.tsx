/**
 * SessionDetailView 承認カードのレンダリング契約 — ADR 019e9999 段階②.
 *
 * react-dom/server で静的描画し、pending_approvals → 承認カード群への展開を検証する
 * (jsdom 不要・REAL DATA: backend reducer.ts PendingApproval の wire 形を直接食わせる)。
 *
 * 検証:
 *  - pending あり → 各 request_id のカードが出る (tool / primary(redacted) / risk badge / 許可・拒否)。
 *  - 複数 pending の ack を request_id 独立で突合 (一方 allowed / 他方 failed)。
 *  - ack ok / error の表示。
 *  - pending 空 + waiting state → 従来の簡易バナーへフォールバック (D2: detail 内拡張)。
 *  - SEC: 生 tool_input を独自描画しない (DTO の redaction 済み値のみ render)。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createElement } from "react";

import { SessionDetailView } from "../src/ui/SessionDetail.js";

import type { AckState } from "../src/ui/approval-display.js";
import type { PendingApproval, ReplayEventDTO, SessionDetail } from "../src/realtime/contract.js";

function repEvent(o: Partial<ReplayEventDTO> = {}): ReplayEventDTO {
  return {
    event_id: "e1",
    provider: "claude_code",
    source: "hooks",
    session_id: "s1",
    event_type: "command.started",
    kind: "command",
    timestamp: "2026-06-05T00:00:01.000Z",
    state: undefined,
    cwd: undefined,
    summary: undefined,
    display_text: "x",
    subject: undefined,
    request_id: undefined,
    tool_name: undefined,
    command: undefined,
    path: undefined,
    risk_level: undefined,
    decision: undefined,
    auto_allowed: undefined,
    exit_code: undefined,
    elapsed_ms: undefined,
    ...o,
  };
}

function pending(o: Partial<PendingApproval> = {}): PendingApproval {
  return {
    request_id: "req-1",
    tool_name: "Bash",
    command: "pnpm test",
    path: undefined,
    risk_level: "medium",
    requested_at: "2026-06-05T00:00:00.000Z",
    session_id: "s1",
    trigger: undefined,
    secret_kinds: undefined,
    persistable: undefined,
    ...o,
  };
}

function detail(pendingApprovals: PendingApproval[], state = "running.tool"): SessionDetail {
  return {
    session_id: "s1",
    provider: "claude_code",
    source: "hooks",
    agent_id: undefined,
    repo: undefined,
    branch: undefined,
    cwd: undefined,
    state,
    current_action: "Bash",
    last_event_at: "2026-06-05T00:00:00.000Z",
    needs_attention: true,
    liveness_state: "live",
    stalled_suspected: false,
    connected: true,
    last_event_id: "e1",
    liveness_evidence: { event: { ageMs: 10, fresh: true } },
    liveness_reason: "fresh",
    liveness_evaluated_at_ms: 1,
    invalid_transition_count: 0,
    pending_approvals: pendingApprovals,
  };
}

describe("SessionDetailView approval cards", () => {
  it("renders one card per pending approval with tool / primary(redacted) / risk / buttons", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, { detail: detail([pending()]), loading: false }),
    );
    expect(html).toContain('data-testid="approval-banner"');
    expect(html).toContain('data-testid="approval-card-req-1"');
    expect(html).toContain("pnpm test"); // command(redacted) を primary に
    expect(html).toContain('data-testid="approval-risk"');
    expect(html).toContain("risk: medium");
    expect(html).toContain('data-testid="approval-allow"');
    expect(html).toContain('data-testid="approval-deny"');
  });

  it("uses path when command is absent (no raw tool_input)", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        detail: detail([pending({ command: undefined, path: "/home/user/x", tool_name: "Edit" })]),
        loading: false,
      }),
    );
    expect(html).toContain("/home/user/x");
    expect(html).toContain("Edit");
  });

  it("matches ack per request_id independently (one allowed, one failed)", () => {
    const lastAck = new Map<string, AckState>([
      ["req-A", { decision: "allow", ok: true, error: undefined }],
      ["req-B", { decision: "deny", ok: false, error: "relay closed" }],
    ]);
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        detail: detail([pending({ request_id: "req-A" }), pending({ request_id: "req-B" })]),
        loading: false,
        lastAck,
      }),
    );
    // 独立突合: A は allowed フェーズ、B は failed フェーズ。
    expect(html).toContain('data-testid="approval-card-req-A"');
    expect(html).toContain('data-testid="approval-card-req-B"');
    expect(html).toMatch(/data-request-id="req-A"[\s\S]*?data-ack-phase="allowed"/);
    expect(html).toMatch(/data-request-id="req-B"[\s\S]*?data-ack-phase="failed"/);
    expect(html).toContain("許可を送信しました");
    expect(html).toContain("中継に失敗");
    expect(html).toContain("relay closed"); // backend が返した error 表示
  });

  it("shows sending phase while ack is pending (D3: not optimistically allowed)", () => {
    const lastAck = new Map<string, AckState>([
      ["req-1", { decision: "allow", ok: undefined, error: undefined }],
    ]);
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, { detail: detail([pending()]), loading: false, lastAck }),
    );
    expect(html).toContain('data-ack-phase="sending"');
    expect(html).toContain("送信中");
    // まだ "許可を送信しました" には倒さない。
    expect(html).not.toContain("許可を送信しました");
  });

  it("falls back to simple waiting banner when no pending approvals", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, { detail: detail([], "waiting.approval"), loading: false }),
    );
    expect(html).not.toContain('data-testid="approval-banner"');
    expect(html).toContain('data-testid="waiting-banner"');
    expect(html).toContain("承認待ち");
  });

  it("renders neither banner when no pending and no waiting state", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, { detail: detail([], "running.tool"), loading: false }),
    );
    expect(html).not.toContain('data-testid="approval-banner"');
    expect(html).not.toContain('data-testid="waiting-banner"');
  });
});

describe("SessionDetailView 段階③: 承認カード 4 値ボタン", () => {
  it("allow / allow_for_session / deny / cancel の 4 ボタンを描く", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, { detail: detail([pending()]), loading: false }),
    );
    expect(html).toContain('data-testid="approval-allow"');
    expect(html).toContain('data-testid="approval-allow-for-session"');
    expect(html).toContain('data-testid="approval-deny"');
    expect(html).toContain('data-testid="approval-cancel"');
  });

  it("allow_for_session ボタンは『同一署名のみ自動許可』を文言/tooltip で明示 (過剰 allow 防止)", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, { detail: detail([pending()]), loading: false }),
    );
    // ラベルは「セッション中は許可」、tooltip は同一ツール/リスク/コマンド・パスのみを明示。
    expect(html).toContain("セッション中は許可");
    expect(html).toMatch(/title="[^"]*同一ツール[^"]*同一コマンド\/パス[^"]*"/);
  });

  it("ok ack 確定後は 4 ボタンとも disabled (二重送信防止)", () => {
    const lastAck = new Map<string, AckState>([
      ["req-1", { decision: "allow_for_session", ok: true, error: undefined }],
    ]);
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, { detail: detail([pending()]), loading: false, lastAck }),
    );
    expect(html).toContain("セッション中は許可を送信しました");
    // 4 つすべて disabled。
    const disabledCount = (html.match(/disabled=""/g) ?? []).length;
    expect(disabledCount).toBeGreaterThanOrEqual(4);
  });
});

describe("SessionDetailView 段階③: 承認 timeout UX (推定値)", () => {
  // requested_at から nowMs を進めて残り時間表示を検証する。実 timeout は UI 非保持の推定。
  const reqAt = "2026-06-05T00:00:00.000Z";
  const reqMs = Date.parse(reqAt);

  it("十分な猶予があれば『自動拒否まで 約Ns（安全側）』を表示", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        detail: detail([pending({ requested_at: reqAt })]),
        loading: false,
        nowMs: reqMs + 10_000, // 残り ~20s
      }),
    );
    expect(html).toContain('data-testid="approval-timeout"');
    expect(html).toMatch(/data-tone="ok"/);
    expect(html).toContain("自動拒否まで");
    expect(html).toContain("約20秒");
  });

  it("閾値内は data-tone=soon で『まもなくタイムアウト』を強調", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        detail: detail([pending({ requested_at: reqAt })]),
        loading: false,
        nowMs: reqMs + 27_000, // 残り 3s (< 5s 閾値)
      }),
    );
    expect(html).toContain('data-tone="soon"');
    expect(html).toContain("まもなくタイムアウト");
  });

  it("経過後 (残り 0) は data-tone=expired で『タイムアウト（自動拒否）』", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        detail: detail([pending({ requested_at: reqAt })]),
        loading: false,
        nowMs: reqMs + 31_000,
      }),
    );
    expect(html).toContain('data-tone="expired"');
    expect(html).toContain("タイムアウト（自動拒否）");
  });

  it("ok ack 確定後は締め切り表示を出さない (意味を持たないため)", () => {
    const lastAck = new Map<string, AckState>([
      ["req-1", { decision: "allow", ok: true, error: undefined }],
    ]);
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        detail: detail([pending({ requested_at: reqAt })]),
        loading: false,
        nowMs: reqMs + 10_000,
        lastAck,
      }),
    );
    expect(html).not.toContain('data-testid="approval-timeout"');
  });
});

describe("SessionDetailView 段階③: interrupt ボタン配線 (D5)", () => {
  const onInterrupt = () => {};

  it("非 terminal + onInterrupt 指定で『中断 (SIGINT)』ボタンを描く", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        detail: detail([], "running.tool"),
        loading: false,
        onInterrupt,
      }),
    );
    expect(html).toContain('data-testid="interrupt-button"');
    expect(html).toContain("中断 (SIGINT)");
    // D5: 巻き戻しでないことを tooltip で明示。
    expect(html).toMatch(/title="[^"]*SIGINT[^"]*巻き戻しではありません[^"]*"/);
  });

  it("waiting.approval (非 terminal) でも出す (sidecar が安全に処理)", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        detail: detail([], "waiting.approval"),
        loading: false,
        onInterrupt,
      }),
    );
    expect(html).toContain('data-testid="interrupt-button"');
  });

  it("terminal (completed/failed/interrupted) では interrupt ボタンを出さない", () => {
    for (const s of ["completed", "failed", "interrupted"]) {
      const html = renderToStaticMarkup(
        createElement(SessionDetailView, { detail: detail([], s), loading: false, onInterrupt }),
      );
      expect(html).not.toContain('data-testid="interrupt-button"');
    }
  });

  it("onInterrupt 未指定なら出さない (操作不可)", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, { detail: detail([], "running.tool"), loading: false }),
    );
    expect(html).not.toContain('data-testid="interrupt-button"');
  });
});

describe("SessionDetailView 4ペイン段階1 (ADR 019ea4ba): events 拡張", () => {
  it("events 未指定 (既存呼び出し) では 4 ペイン拡張部を描かない (後方互換)", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        detail: detail([], "running.command_executing"),
        loading: false,
      }),
    );
    expect(html).not.toContain('data-testid="detail-panes"');
    expect(html).not.toContain('data-testid="action-timeline"');
  });

  it("events 指定で 中央=現在作業 / 左=タイムライン / 右=risk の 3 ペインを描く", () => {
    const events = [
      repEvent({
        event_id: "a",
        kind: "command",
        command: "pnpm test",
        display_text: "pnpm test",
        timestamp: "2026-06-05T00:00:01.000Z",
      }),
      repEvent({
        event_id: "b",
        kind: "file",
        path: "/x.ts",
        display_text: "/x.ts",
        risk_level: "high",
        timestamp: "2026-06-05T00:00:02.000Z",
      }),
    ];
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        detail: detail([], "running.command_executing"),
        loading: false,
        events,
      }),
    );
    expect(html).toContain('data-testid="detail-panes"');
    expect(html).toContain('data-testid="current-action"');
    expect(html).toContain('data-view="command"');
    // 左ペインはアクション単位タイムライン (設計裁定 019eb981)。
    expect(html).toContain('data-testid="action-timeline"');
    expect(html).toContain('data-testid="risk-pane"');
    // 対象全文が出る (command と path・切詰めない)。
    expect(html).toContain("pnpm test");
    expect(html).toContain("/x.ts");
  });

  it("タイムラインは role=log + aria-live=polite (a11y: 追記系シーケンシャル更新)", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        detail: detail([], "running.command_executing"),
        loading: false,
        events: [repEvent()],
      }),
    );
    expect(html).toMatch(/data-testid="action-timeline"[\s\S]*?role="log"/);
    expect(html).toMatch(/data-testid="action-timeline"[\s\S]*?aria-live="polite"/);
    expect(html).toMatch(/data-testid="action-timeline"[\s\S]*?aria-label=/);
  });

  it("タイムライン行は events の昇順で描かれる (INV-DETAIL-TIMELINE-ORDER 表示版)", () => {
    const events = [
      repEvent({
        event_id: "first",
        command: "AAA",
        display_text: "AAA",
        timestamp: "2026-06-05T00:00:01.000Z",
      }),
      repEvent({
        event_id: "second",
        command: "BBB",
        display_text: "BBB",
        timestamp: "2026-06-05T00:00:02.000Z",
      }),
    ];
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        detail: detail([], "running.tool"),
        loading: false,
        events,
      }),
    );
    // 相関キー無しの独立行は ev:<event_id> としてアクション単位化され、入力昇順を保つ。
    expect(html.indexOf("action-row-ev:first")).toBeLessThan(html.indexOf("action-row-ev:second"));
  });

  it("中央ペイン: command ビューで kill (停止) ボタンを出す (既存 interrupt 再利用)", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        detail: detail([], "running.command_executing"),
        loading: false,
        events: [repEvent()],
        onInterrupt: () => {},
      }),
    );
    expect(html).toContain('data-testid="current-action-kill"');
    expect(html).toMatch(
      /data-testid="current-action-kill"[\s\S]*?title="[^"]*SIGINT[^"]*巻き戻しではありません/,
    );
  });
});

describe("SessionDetailView capture_mode バッジ (INV-DETAIL-CAPTURE-BADGE / TDA-1)", () => {
  function detailCm(
    captureMode: "managed" | "attach" | "codex_rollout" | undefined,
  ): SessionDetail {
    const d = detail([], "running.tool");
    return captureMode === undefined ? d : { ...d, capture_mode: captureMode };
  }

  it("capture_mode=attach の status-bar に外部起動バッジを描く", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, { detail: detailCm("attach"), loading: false }),
    );
    expect(html).toContain('data-testid="detail-capture-mode"');
    expect(html).toContain('data-capture-mode="attach"');
    expect(html).toContain("外部起動");
    expect(html).not.toContain("観測専用");
  });

  it("capture_mode=codex_rollout の status-bar は実 mode 属性で外部起動バッジを描く", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, { detail: detailCm("codex_rollout"), loading: false }),
    );
    expect(html).toContain('data-testid="detail-capture-mode"');
    expect(html).toContain('data-capture-mode="codex_rollout"');
    expect(html).toContain("外部起動");
  });

  it("capture_mode=managed では バッジを描かない", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, { detail: detailCm("managed"), loading: false }),
    );
    expect(html).not.toContain('data-testid="detail-capture-mode"');
  });

  it("capture_mode 欠落 (既存 DTO) でも黙殺せず managed 扱いで非表示 (寛容性)", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, { detail: detailCm(undefined), loading: false }),
    );
    expect(html).not.toContain('data-testid="detail-capture-mode"');
  });

  it("右 risk ペインの取得バッジに capture_mode を反映 (attach)", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        detail: detailCm("attach"),
        loading: false,
        events: [repEvent()],
      }),
    );
    expect(html).toMatch(/data-testid="risk-capture-mode"[\s\S]*?data-capture-mode="attach"/);
  });
});
