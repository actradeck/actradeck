/**
 * 主要コンポーネントの en 描画ケース (設計裁定 019eb745)。
 *
 * FixedLocaleProvider(locale="en") 配下で react-dom/server 静的描画し、ハードコード日本語ではなく
 * カタログ en が描かれること + data-testid 等の構造契約が不変であることを固定する。
 * 既定 (Provider 無し / ja) の挙動は各コンポーネントの既存テストが担保 (本ファイルは en 差分のみ)。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ApprovalCard } from "../src/ui/ApprovalCard.js";
import { FixedLocaleProvider } from "../src/ui/LocaleProvider.js";
import { SessionList } from "../src/ui/SessionList.js";
import { LiveWall } from "../src/ui/LiveWall.js";
import { SessionDetailView } from "../src/ui/SessionDetail.js";

import type { PendingApproval, SessionListItem } from "../src/realtime/contract.js";

function en(node: React.ReactNode): string {
  return renderToStaticMarkup(<FixedLocaleProvider locale="en">{node}</FixedLocaleProvider>);
}

function ja(node: React.ReactNode): string {
  return renderToStaticMarkup(<FixedLocaleProvider locale="ja">{node}</FixedLocaleProvider>);
}

function pending(o: Partial<PendingApproval> = {}): PendingApproval {
  return {
    request_id: "req-1",
    tool_name: "Bash",
    command: "pnpm test",
    path: undefined,
    risk_level: "high",
    requested_at: "2026-06-05T00:00:00.000Z",
    session_id: "s1",
    trigger: undefined,
    secret_kinds: undefined,
    persistable: undefined,
    ...o,
  };
}

function listItem(o: Partial<SessionListItem> = {}): SessionListItem {
  return {
    session_id: "sess-abcdef012345",
    provider: "claude_code",
    connected: true,
    needs_attention: false,
    stalled_suspected: false,
    liveness_state: "live",
    state: "running.command_executing",
    current_action: undefined,
    repo: "actradeck",
    branch: "main",
    cwd: "/home/u/actradeck",
    last_event_at: "2026-06-05T00:00:00.000Z",
    agent_id: undefined,
    ...o,
  } as SessionListItem;
}

describe("ApprovalCard en render", () => {
  it("renders en action labels and high-risk ack, keeps testids", () => {
    const html = en(
      <ul>
        <ApprovalCard
          approval={pending()}
          ack={undefined}
          nowMs={Date.parse("2026-06-05T00:00:01.000Z")}
          onApprove={() => {}}
        />
      </ul>,
    );
    expect(html).toContain("Allow");
    expect(html).toContain("Deny");
    expect(html).toContain("Cancel");
    expect(html).toContain("Allow for session");
    expect(html).toContain("High-risk operation");
    // 構造契約は不変。
    expect(html).toContain('data-testid="approval-allow"');
    expect(html).toContain('data-highrisk="true"');
    // 日本語が混ざらない。
    expect(html).not.toContain("許可");
  });

  it("timeout hint is en (fail-safe estimate)", () => {
    const html = en(
      <ul>
        <ApprovalCard
          approval={pending({ risk_level: "low" })}
          ack={undefined}
          nowMs={Date.parse("2026-06-05T00:00:01.000Z")}
          onApprove={() => {}}
        />
      </ul>,
    );
    expect(html).toContain("fail-safe");
    expect(html).not.toContain("安全側");
  });
});

describe("SessionList en render", () => {
  it("renders en empty label and headers", () => {
    const empty = en(<SessionList sessions={[]} selectedId={null} nowMs={0} onSelect={() => {}} />);
    expect(empty).toContain("No sessions are being observed.");

    const html = en(
      <SessionList
        sessions={[listItem({ needs_attention: true, state: "waiting.approval" })]}
        selectedId={null}
        nowMs={Date.parse("2026-06-05T00:00:00.000Z")}
        onSelect={() => {}}
      />,
    );
    expect(html).toContain('data-attention="true"');
    expect(html).toContain("Needs attention");
    expect(html).not.toContain("介入");
  });
});

describe("LiveWall en render (empty + legend)", () => {
  it("renders en empty + legend labels", () => {
    const html = en(<LiveWall active nowMs={Date.parse("2026-06-05T00:00:00.000Z")} />);
    expect(html).toContain('data-testid="live-wall"');
    // フィードは pull (fetch) なので静的描画では空 → en の空文言/凡例が出る。
    expect(html).toContain("Bar color = action type:");
    expect(html).toContain("Command");
    expect(html).toContain("File / diff");
    expect(html).not.toContain("バーの色");
  });
});

describe("SessionDetailView en render (empty)", () => {
  it("renders en select prompt; ja control differs", () => {
    const enHtml = en(<SessionDetailView detail={null} loading={false} />);
    expect(enHtml).toContain("Select a session.");
    const jaHtml = ja(<SessionDetailView detail={null} loading={false} />);
    expect(jaHtml).toContain("session を選択してください。");
  });

  it("renders en loading prompt", () => {
    const enHtml = en(<SessionDetailView detail={null} loading={true} />);
    expect(enHtml).toContain("Loading details…");
  });
});

describe("locale parity: same component, different language", () => {
  it("ApprovalCard ja vs en allow button differs", () => {
    const card = (
      <ul>
        <ApprovalCard
          approval={pending({ risk_level: "low" })}
          ack={undefined}
          nowMs={Date.parse("2026-06-05T00:00:01.000Z")}
          onApprove={() => {}}
        />
      </ul>
    );
    expect(ja(card)).toContain("許可");
    expect(en(card)).toContain("Allow");
  });
});
