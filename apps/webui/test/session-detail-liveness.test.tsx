/**
 * SessionDetail の liveness 根拠分解 (INV-STALLED-UI) の **描画** 回帰 (decision 019f69ef)。
 *
 * 分解表示 (process/event/stdout/file/model-stream の heartbeat 別) と liveness_reason は、再設計で
 * `<details>` 折りたたみ配下へ移設されたが **削除でなく格納**である。折りたたみ既定は「live 以外
 * (stalled?/idle/offline/unknown) で展開・live で折畳」。この 2 つ (分解が描画され続けること + 既定開閉)
 * を CI で固定する (QA-1/SEC-1 の falsifiability 欠落を埋める)。分解 *データ* は liveness-display.test.ts、
 * badge 文言 "STALLED?"/"not asserting stopped" も同ファイルで pin 済 (本テストは描画統合を担う)。
 *
 * REAL DATA: backend の SessionDetail wire 形をそのまま食わせる。nowMs で鮮度補正を制御する。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { SessionDetailView } from "../src/ui/SessionDetail.js";

import type { SessionDetail } from "../src/realtime/contract.js";

const LAST_EVENT = "2026-07-16T00:00:00.000Z";
const FRESH_NOW = Date.parse(LAST_EVENT) + 1_000; // last_event の 1s 後 = 鮮度窓内 → live

function detail(o: Partial<SessionDetail> = {}): SessionDetail {
  return {
    session_id: "s1",
    provider: "claude_code",
    source: "hooks",
    agent_id: undefined,
    repo: undefined,
    branch: undefined,
    cwd: undefined,
    state: "running.tool",
    current_action: "Bash",
    last_event_at: LAST_EVENT,
    needs_attention: false,
    liveness_state: "live",
    stalled_suspected: false,
    connected: true,
    last_event_id: "e1",
    liveness_evidence: {
      process: { ageMs: 120_000, fresh: false, alive: true },
      event: { ageMs: 500, fresh: true },
      file: { ageMs: 240_000, fresh: false },
    },
    liveness_reason: "at least one fresh heartbeat — not stalled despite stale others",
    liveness_evaluated_at_ms: 1,
    invalid_transition_count: 0,
    pending_approvals: [],
    ...o,
  };
}

/** liveness-details の開始タグを取り出す (属性順に依存しない open 判定用)。 */
function livenessDetailsTag(html: string): string {
  return html.match(/<details[^>]*data-testid="liveness-details"[^>]*>/)?.[0] ?? "";
}

describe("SessionDetail liveness evidence 描画 (INV-STALLED-UI 折りたたみ)", () => {
  it("heartbeat 分解 (process/event/stdout/file/model-stream) と liveness_reason を常に描画する", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, { detail: detail(), loading: false, nowMs: FRESH_NOW }),
    );
    expect(html).toContain('data-testid="liveness-details"');
    // 分解 5 シグナルの行が全て描かれる (格納≠削除)。
    for (const kind of ["process", "event", "stdout", "file", "model-stream"]) {
      expect(html).toContain(`data-testid="hb-${kind}"`);
    }
    // liveness_reason (停止を断定しない根拠文) が描かれる。
    expect(html).toContain('data-testid="liveness-reason"');
    expect(html).toContain("not stalled despite stale others");
  });

  it("live のとき折りたたみ既定は閉 (密度を下げる・根拠は drill-down)", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        detail: detail({ liveness_state: "live", stalled_suspected: false }),
        loading: false,
        nowMs: FRESH_NOW,
      }),
    );
    // effectiveLivenessState: connected+live+fresh → "LIVE" → defaultOpen=false。
    expect(livenessDetailsTag(html)).not.toContain("open");
  });

  it("stalled? のとき折りたたみ既定は開 (根拠を関連時に前面化・stalled を隠さない)", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        detail: detail({ liveness_state: "stalled", stalled_suspected: true }),
        loading: false,
        nowMs: FRESH_NOW,
      }),
    );
    // badge.label "STALLED?" (≠ "LIVE") → defaultOpen=true → <details open>。
    expect(livenessDetailsTag(html)).toContain("open");
    // 展開時も分解 + reason は描かれる。
    expect(html).toContain('data-testid="hb-process"');
    expect(html).toContain('data-testid="liveness-reason"');
  });

  it("idle (鮮度切れ) でも折りたたみ既定は開 (live 以外は根拠を出す)", () => {
    const html = renderToStaticMarkup(
      createElement(SessionDetailView, {
        // live 保存だが last_event が古い → effectiveLivenessState は idle へ降格 → 非 "LIVE" → 展開。
        detail: detail({ liveness_state: "live" }),
        loading: false,
        nowMs: Date.parse(LAST_EVENT) + 10 * 60_000, // 10 分後 = 鮮度窓外
      }),
    );
    expect(livenessDetailsTag(html)).toContain("open");
  });
});
