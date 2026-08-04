/**
 * WorkItemsPanel の DOM 契約 (ADR 0015 §D8・差別化ゲート UI).
 *
 * react-dom/server の静的描画で固定する (既定 locale=ja / en 両方):
 *  - 4 badge が client-side fold の結果から出る (deriveWorkItemBadge 単一出所)。
 *  - 観測証拠 (method/fidelity/check/exit) と run_dirty / stale 理由の注記。
 *  - evidence-ref (claim/check/diff) が data-event-id 付きで出る (timeline ジャンプ先)。
 *  - NO-RAW: work_item_id は hash 表示・生 provider_task_id は DOM に出さない。
 *  - 空状態 / claimed-unverified 件数バッジ。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FixedLocaleProvider } from "../src/ui/LocaleProvider.js";
import { WorkItemsPanel } from "../src/ui/WorkItemsPanel.js";

import type { ReplayEventDTO } from "../src/realtime/contract.js";

let seq = 0;
function dto(o: Partial<ReplayEventDTO> = {}): ReplayEventDTO {
  seq += 1;
  return {
    event_id: `00000000-0000-7000-8000-${String(seq).padStart(12, "0")}`,
    provider: "claude_code",
    source: "hooks",
    session_id: "s1",
    event_type: "work.item.updated",
    kind: "other",
    timestamp: new Date(Date.UTC(2026, 7, 4, 0, 0, seq)).toISOString(),
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

function render(events: readonly ReplayEventDTO[], locale: "ja" | "en" = "ja"): string {
  return renderToStaticMarkup(
    <FixedLocaleProvider locale={locale}>
      <WorkItemsPanel sessionId="s1" events={events} onJumpToEvent={() => {}} />
    </FixedLocaleProvider>,
  );
}

describe("WorkItemsPanel (SSR DOM 契約)", () => {
  it("イベント無しは空状態を出す (架空の状態を出さない)", () => {
    const html = render([]);
    expect(html).toContain('data-testid="work-items-empty"');
    expect(html).not.toContain('data-testid="work-items-list"');
  });

  it("self_claimed バッジ (completed + unverified) を fold から出す", () => {
    const html = render([
      dto({ provider_task_id: "1", work_item_status: "completed", work_item_subject: "wire it" }),
    ]);
    expect(html).toContain('data-badge="self_claimed"');
    expect(html).toContain("自己申告完了");
    expect(html).toContain("wire it"); // subject (redacted+bounded) 表示。
    // claimed-unverified 件数バッジ (panel header・Wall と同一意味論)。
    expect(html).toContain('data-testid="work-items-claimed-unverified-count"');
  });

  it("verified バッジ + check/exit の証拠注記", () => {
    const html = render([
      dto({ event_type: "diff.updated", head_sha: "h1", diff_hash: "d1" }),
      dto({
        provider_task_id: "1",
        work_item_status: "completed",
        observation_method: "official_hook",
        observation_fidelity: "observed",
      }),
      dto({
        event_type: "command.completed",
        check_kind: "test",
        check_match: "program",
        exit_code: 0,
        request_id: "r1",
      }),
    ]);
    expect(html).toContain('data-badge="verified"');
    expect(html).toContain('data-testid="work-item-method"');
    expect(html).toContain('data-testid="work-item-fidelity"');
    expect(html).toContain('data-testid="work-item-check"');
    expect(html).toContain('data-testid="work-item-exit"');
    // evidence-ref: claim + check の event_id へジャンプできる。
    expect(html).toContain('data-testid="work-item-ref-claim"');
    expect(html).toContain('data-testid="work-item-ref-check"');
  });

  it("changed_after_verification バッジ + stale 理由 + diff 参照", () => {
    const html = render([
      dto({ event_type: "diff.updated", head_sha: "h1", diff_hash: "d1" }),
      dto({ provider_task_id: "1", work_item_status: "completed" }),
      dto({ event_type: "command.completed", check_kind: "test", exit_code: 0, request_id: "r1" }),
      dto({ event_type: "diff.updated", head_sha: "h2", diff_hash: "d2" }),
    ]);
    expect(html).toContain('data-badge="changed_after_verification"');
    expect(html).toContain('data-testid="work-item-stale-reason"');
    expect(html).toContain('data-testid="work-item-ref-diff"');
  });

  it("verification_failed バッジ + run_dirty 注記", () => {
    const html = render([
      dto({ provider_task_id: "1", work_item_status: "completed" }),
      dto({ event_type: "command.started", check_kind: "test", request_id: "r1" }),
      dto({ event_type: "diff.updated", head_sha: "h1", diff_hash: "d1" }),
      dto({ event_type: "command.completed", check_kind: "test", exit_code: 1, request_id: "r1" }),
    ]);
    expect(html).toContain('data-badge="verification_failed"');
    expect(html).toContain('data-testid="work-item-run-dirty"');
  });

  it("非 completed は plain status を出しバッジは出さない", () => {
    const html = render([dto({ provider_task_id: "1", work_item_status: "in_progress" })]);
    expect(html).toContain('data-testid="work-item-status"');
    expect(html).not.toContain('data-testid="work-item-badge"');
    // 非 completed のみなら claimed-unverified バッジは出ない。
    expect(html).not.toContain('data-testid="work-items-claimed-unverified-count"');
  });

  it("NO-RAW: work_item_id は hash 表示・生 provider_task_id を DOM に出さない", () => {
    const html = render([
      dto({ provider_task_id: "SECRETTASKID42", work_item_status: "completed" }),
    ]);
    expect(html).toContain('data-testid="work-item-id"');
    expect(html).toContain("task:"); // 短縮 hash 表示。
    expect(html).not.toContain("SECRETTASKID42"); // 生 provider task id は描かない。
  });

  it("en ロケールでも各文言が英語で出る (ja 焼き込みが漏れない)", () => {
    const html = render([dto({ provider_task_id: "1", work_item_status: "completed" })], "en");
    expect(html).toContain("Self-claimed");
    expect(html).not.toContain("自己申告完了");
  });
});
