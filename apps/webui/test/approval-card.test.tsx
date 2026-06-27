/**
 * ApprovalCard 段階2 の運用堅牢化 INV (ADR 019ead14 段階2) — react-dom/server で静的描画。
 *
 * SessionDetail と Approval Inbox が共有する単一カード (D2) の安全性契約を pin する:
 *  - INV-INBOX-HIGHRISK-DENY-DEFAULT: risk=high は視覚強調 + allow 系を明示確認でゲートし、
 *    確認なしの誤 allow を UI 構造で抑止する (deny/cancel は常に操作可能=安全側既定)。
 *  - INV-INBOX-DOUBLE-APPROVE-GUARD: 送信中/確定済み (共有 lastAck の ack) のカードは 4 ボタンとも
 *    無効。Inbox/Detail は同一 ApprovalCard + 共有 lastAck ゆえ、一方で押下→sending が立つと他方も
 *    無効化され二重承認を抑止 (first-wins)。
 *  - INV-INBOX-TIMEOUT-SAFE: timeout 表示は「安全側の推定」を明示し、確定済み行では締切非表示。
 *    不正な requested_at でも突然「タイムアウト」へ倒さない (満額=安全側)。
 *
 * REAL DATA: backend reducer の PendingApproval wire 形をそのまま食わせる。jsdom 不要。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ApprovalCard } from "../src/ui/ApprovalCard.js";

import type { AckState } from "../src/ui/approval-display.js";
import type { PendingApproval } from "../src/realtime/contract.js";

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

const NOOP = () => {};

function render(opts: {
  approval: PendingApproval;
  ack?: AckState | undefined;
  nowMs?: number;
  onApprove?: (requestId: string, decision: string) => void;
}): string {
  return renderToStaticMarkup(
    <ul>
      <ApprovalCard
        approval={opts.approval}
        ack={opts.ack}
        nowMs={opts.nowMs ?? Date.parse("2026-06-05T00:00:01.000Z")}
        onApprove={opts.onApprove ?? NOOP}
      />
    </ul>,
  );
}

function disabledCount(html: string): number {
  return (html.match(/disabled=""/g) ?? []).length;
}

describe("ApprovalCard INV-INBOX-HIGHRISK-DENY-DEFAULT (高リスク allow ゲート)", () => {
  it("high: 視覚強調 + 確認チェック表示 + allow 系のみ既定で無効 (deny/cancel は操作可能)", () => {
    const html = render({ approval: pending({ risk_level: "high" }) });
    // 視覚的に優先強調 (data 属性 + class)。
    expect(html).toContain('data-highrisk="true"');
    expect(html).toContain("ad-approval-card--highrisk");
    // 明示確認チェックが出る。
    expect(html).toContain('data-testid="approval-highrisk-ack"');
    // 確認前は allow / allow_for_session の 2 つだけ無効 (deny/cancel は操作可能=安全側既定)。
    expect(disabledCount(html)).toBe(2);
  });

  it("medium: ゲートなし (強調なし・確認チェックなし・4 ボタンとも操作可能)", () => {
    const html = render({ approval: pending({ risk_level: "medium" }) });
    expect(html).not.toContain('data-highrisk="true"');
    expect(html).not.toContain("approval-highrisk-ack");
    expect(disabledCount(html)).toBe(0);
  });

  it("undefined risk: ゲートなし", () => {
    const html = render({ approval: pending({ risk_level: undefined }) });
    expect(html).not.toContain("approval-highrisk-ack");
    expect(disabledCount(html)).toBe(0);
  });
});

describe("ApprovalCard INV-INBOX-DOUBLE-APPROVE-GUARD (共有 lastAck で二重承認抑止)", () => {
  it("sending (ack ok=undefined) の medium カードは 4 ボタンとも無効", () => {
    const ack: AckState = { decision: "allow", ok: undefined, error: undefined };
    const html = render({ approval: pending({ risk_level: "medium" }), ack });
    // 高リスクゲートではなく ack(sending) 由来で全無効 → 4。
    expect(disabledCount(html)).toBe(4);
    expect(html).toContain('data-ack-phase="sending"');
  });

  it("確定済み (ack ok=true) のカードは 4 ボタンとも無効 (first-wins・後発抑止)", () => {
    const ack: AckState = { decision: "allow_for_session", ok: true, error: undefined };
    const html = render({ approval: pending({ risk_level: "medium" }), ack });
    expect(disabledCount(html)).toBe(4);
  });

  it("高リスクでも resolved なら確認チェックは出ない (確定済みは操作対象外)", () => {
    const ack: AckState = { decision: "deny", ok: true, error: undefined };
    const html = render({ approval: pending({ risk_level: "high" }), ack });
    expect(html).not.toContain("approval-highrisk-ack");
    expect(disabledCount(html)).toBe(4);
  });
});

describe("ApprovalCard INV-INBOX-TIMEOUT-SAFE (推定明示・確定済みは締切非表示)", () => {
  const reqAt = "2026-06-05T00:00:00.000Z";
  const reqMs = Date.parse(reqAt);

  it("猶予あり: 『安全側の推定』を明示する", () => {
    const html = render({
      approval: pending({ requested_at: reqAt }),
      nowMs: reqMs + 1_000,
    });
    expect(html).toContain('data-testid="approval-timeout"');
    expect(html).toContain("安全側");
  });

  it("確定済み (ok ack): 締切 (approval-timeout) を表示しない", () => {
    const ack: AckState = { decision: "allow", ok: true, error: undefined };
    const html = render({ approval: pending({ requested_at: reqAt }), ack, nowMs: reqMs + 1_000 });
    expect(html).not.toContain('data-testid="approval-timeout"');
  });

  it("不正な requested_at でも突然『タイムアウト』へ倒さない (満額=安全側)", () => {
    const html = render({ approval: pending({ requested_at: "" }), nowMs: reqMs + 1_000 });
    expect(html).toContain('data-testid="approval-timeout"');
    expect(html).toContain("安全側");
    expect(html).not.toContain("タイムアウト（自動拒否）");
  });
});

/**
 * INV-PERSIST-CARD-BUTTON (ADR 019ee0c0): 「再起動後も許可」ボタンは **persistable===true のときのみ**
 * 提示する。sidecar が medium-bash 等の eligibility を最終判定し persistable を載せるため、UI は
 * フラグに一方向追従する (Hermes #41769 の UI/実体 不一致を回避)。
 */
describe("ApprovalCard INV-PERSIST-CARD-BUTTON (永続ボタンは persistable のみ提示)", () => {
  it("persistable=true: 永続ボタンを提示 (正直ラベル)", () => {
    const html = render({ approval: pending({ risk_level: "medium", persistable: true }) });
    expect(html).toContain('data-testid="approval-allow-persist"');
    expect(html).toContain("再起動後も許可");
  });

  it("persistable=undefined: 永続ボタンを出さない (既存 4 ボタンのみ)", () => {
    const html = render({ approval: pending({ risk_level: "medium", persistable: undefined }) });
    expect(html).not.toContain('data-testid="approval-allow-persist"');
  });

  it("persistable=false: 永続ボタンを出さない", () => {
    const html = render({ approval: pending({ risk_level: "medium", persistable: false }) });
    expect(html).not.toContain('data-testid="approval-allow-persist"');
  });

  it("persistable=true + 送信中 ack: 永続ボタンも含め allow 系が無効 (二重承認抑止)", () => {
    const ack: AckState = { decision: "allow_for_session", ok: undefined, error: undefined };
    const html = render({ approval: pending({ risk_level: "medium", persistable: true }), ack });
    // allow / allow_for_session / persist / deny / cancel = 5 ボタンとも sending で無効。
    expect(disabledCount(html)).toBe(5);
  });
});
