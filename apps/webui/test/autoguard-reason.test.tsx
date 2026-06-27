/**
 * 自動ガード 段階1 webui スライス — 承認 pause 理由表示の INV (ADR 019ecc70 D3 / 下流 019ecc97)。
 *
 * react-dom/server で静的描画 (jsdom 不要)。ApprovalCard は SessionDetail の承認バナーと
 * Approval Inbox が共有する**単一カード** (ADR 019ead14 D2) なので、ここでカード単体 + Detail
 * バナー経由の双方を pin し、Detail / Inbox の表示一致 (共有純関数) を担保する。
 *
 * SEC (INV-REDACTION の表示版・PR#29 no-raw-display と同型):
 *  - 扱うのは trigger (閉じた enum) と secret_kinds (公開 enum 語彙名) のみ。原文・raw 値は
 *    テストにも持ち込まない (合成ダミーの「種類名」だけ)。
 *  - 既知 enum 以外の trigger / kind は raw を text にも data 属性にも出さず汎用ラベルへ畳む。
 *
 * INV:
 *  - INV-AUTOGUARD-UI-REASON: trigger=secret + secret_kinds=[github-token] を
 *    「秘匿情報を検出 / GitHub トークン を検出」相当で表示。mutation で赤化することを別途実証。
 *  - INV-AUTOGUARD-UI-NO-RAW: 未知 kind / XSS 形 kind / 未知 trigger が DOM にも data 属性にも
 *    出ず汎用ラベル + 固定 sentinel へ畳まれる。mutation (isKnownKind 防御外し) で赤化。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ApprovalCard } from "../src/ui/ApprovalCard.js";
import {
  approvalSecretKindViews,
  approvalTriggerReasonKey,
  isKnownApprovalTrigger,
} from "../src/ui/approval-display.js";
import { FixedLocaleProvider } from "../src/ui/LocaleProvider.js";
import { SessionDetailView } from "../src/ui/SessionDetail.js";

import type { Locale } from "../src/ui/i18n/messages.js";
import type { PendingApproval, SessionDetail } from "../src/realtime/contract.js";

const NOOP = () => {};
const NOW = Date.parse("2026-06-05T00:00:01.000Z");

function pending(o: Partial<PendingApproval> = {}): PendingApproval {
  return {
    request_id: "req-1",
    tool_name: "Bash",
    command: "deploy.sh",
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

/** ApprovalCard 単体を locale 付きで描画 (Inbox/Detail が共有する単一カード)。 */
function renderCard(approval: PendingApproval, locale: Locale = "ja"): string {
  return renderToStaticMarkup(
    <FixedLocaleProvider locale={locale}>
      <ul>
        <ApprovalCard approval={approval} ack={undefined} nowMs={NOW} onApprove={NOOP} />
      </ul>
    </FixedLocaleProvider>,
  );
}

function detail(pendingApprovals: readonly PendingApproval[]): SessionDetail {
  return {
    session_id: "s1",
    provider: "claude_code",
    source: "hooks",
    agent_id: undefined,
    repo: undefined,
    branch: undefined,
    cwd: undefined,
    state: "waiting.approval",
    current_action: "bash",
    last_event_at: "2026-06-05T00:00:00.000Z",
    needs_attention: true,
    liveness_state: "live",
    stalled_suspected: false,
    connected: true,
    last_event_id: "e1",
    liveness_evidence: {},
    liveness_reason: "",
    liveness_evaluated_at_ms: 1,
    invalid_transition_count: 0,
    pending_approvals: pendingApprovals,
  };
}

/** SessionDetail の承認バナー経由で同一 ApprovalCard を描画 (Detail/Inbox 表示一致の片側)。 */
function renderDetailBanner(approval: PendingApproval, locale: Locale = "ja"): string {
  return renderToStaticMarkup(
    <FixedLocaleProvider locale={locale}>
      <SessionDetailView detail={detail([approval])} loading={false} onApprove={NOOP} nowMs={NOW} />
    </FixedLocaleProvider>,
  );
}

// ─── 純関数: trigger 理由キー / no-raw 防御 ─────────────────────────────────────

describe("approvalTriggerReasonKey (closed-enum・単一出所)", () => {
  it("既知 trigger を理由ラベルキーへ写像する", () => {
    expect(approvalTriggerReasonKey("secret")).toBe("approval.reason.secret");
    expect(approvalTriggerReasonKey("destructive")).toBe("approval.reason.destructive");
    expect(approvalTriggerReasonKey("both")).toBe("approval.reason.both");
  });

  it("未設定 / 未知 trigger は null へ畳む (raw を表示しない)", () => {
    expect(approvalTriggerReasonKey(undefined)).toBeNull();
    expect(approvalTriggerReasonKey("future-trigger")).toBeNull();
    expect(approvalTriggerReasonKey("<img src=x onerror=alert(1)>")).toBeNull();
  });

  it("isKnownApprovalTrigger は 3 値のみ true", () => {
    expect(isKnownApprovalTrigger("secret")).toBe(true);
    expect(isKnownApprovalTrigger("destructive")).toBe(true);
    expect(isKnownApprovalTrigger("both")).toBe(true);
    expect(isKnownApprovalTrigger("evil")).toBe(false);
    expect(isKnownApprovalTrigger(undefined)).toBe(false);
  });
});

describe("approvalSecretKindViews (no-raw-display 防御・redaction-display 再利用)", () => {
  it("既知 kind は i18n ラベル + 公開 enum 属性 (known=true)", () => {
    const v = approvalSecretKindViews(["github-token"], "ja");
    expect(v).toEqual([{ known: true, label: "GitHub トークン", attr: "github-token" }]);
  });

  it("未知 kind は汎用ラベル + sentinel 'unknown' へ畳む (raw kind を保持しない)", () => {
    const v = approvalSecretKindViews(["future-kind"], "ja");
    expect(v).toEqual([{ known: false, label: "その他の秘匿", attr: "unknown" }]);
    // raw kind 文字列はどのフィールドにも残らない。
    expect(JSON.stringify(v)).not.toContain("future-kind");
  });

  it("複数の未知 kind は 1 つの汎用エントリへ畳む (sentinel dedup)", () => {
    const v = approvalSecretKindViews(["future-kind", "<script>", "other-unknown"], "en");
    expect(v).toEqual([{ known: false, label: "Other secret", attr: "unknown" }]);
  });

  it("undefined / 空配列 → 空配列 (旧 pending・graceful)", () => {
    expect(approvalSecretKindViews(undefined)).toEqual([]);
    expect(approvalSecretKindViews([])).toEqual([]);
  });
});

// ─── INV-AUTOGUARD-UI-REASON ───────────────────────────────────────────────────

describe("INV-AUTOGUARD-UI-REASON (承認カードが pause 理由を表示)", () => {
  it("trigger=secret + secret_kinds=[github-token] を理由 + kind ラベルで表示 (ja)", () => {
    const html = renderCard(pending({ trigger: "secret", secret_kinds: ["github-token"] }), "ja");
    expect(html).toContain('data-testid="approval-guard-reason"');
    // trigger 理由。
    expect(html).toContain('data-testid="approval-trigger"');
    expect(html).toContain('data-trigger="secret"');
    expect(html).toContain("秘匿情報を検出");
    // secret_kinds を redaction-display の kind ラベルで再利用表示。
    expect(html).toContain('data-testid="approval-secret-kind"');
    expect(html).toContain('data-secret-kind="github-token"');
    expect(html).toContain('data-secret-kind-known="true"');
    expect(html).toContain("GitHub トークン を検出");
  });

  it("英語ロケールでも理由 + kind を表示する (en)", () => {
    const html = renderCard(pending({ trigger: "secret", secret_kinds: ["github-token"] }), "en");
    expect(html).toContain("Secret detected");
    expect(html).toContain("GitHub token detected");
  });

  it("trigger=destructive は破壊的操作の理由のみ (secret_kinds 無し→kind 行なし)", () => {
    const html = renderCard(pending({ trigger: "destructive" }), "ja");
    expect(html).toContain('data-trigger="destructive"');
    expect(html).toContain("破壊的操作");
    expect(html).not.toContain('data-testid="approval-secret-kinds"');
  });

  it("trigger=both は両方の理由を出す", () => {
    const html = renderCard(
      pending({ trigger: "both", secret_kinds: ["aws-access-key-id"] }),
      "ja",
    );
    expect(html).toContain('data-trigger="both"');
    expect(html).toContain("破壊的操作 + 秘匿情報を検出");
    expect(html).toContain("AWS アクセスキー を検出");
  });

  it("trigger 無し (旧 pending) は理由ブロックを出さない (後方互換・非退行)", () => {
    const html = renderCard(pending(), "ja");
    expect(html).not.toContain('data-testid="approval-guard-reason"');
    // 既存の承認 UI (ツール/プライマリ/ボタン) は維持。
    expect(html).toContain('data-testid="approval-primary"');
    expect(html).toContain('data-testid="approval-allow"');
  });

  it("Detail バナーと単体カードが同一の理由表示を出す (Detail/Inbox 単一出所)", () => {
    const a = pending({ trigger: "secret", secret_kinds: ["github-token"] });
    const card = renderCard(a, "ja");
    const banner = renderDetailBanner(a, "ja");
    // 両経路とも同じ理由 / kind ラベル / data 属性を含む (共有 ApprovalCard ゆえ一致)。
    for (const needle of [
      "秘匿情報を検出",
      "GitHub トークン を検出",
      'data-secret-kind="github-token"',
      'data-trigger="secret"',
    ]) {
      expect(card, `card: ${needle}`).toContain(needle);
      expect(banner, `banner: ${needle}`).toContain(needle);
    }
  });
});

// ─── INV-AUTOGUARD-UI-NO-RAW ───────────────────────────────────────────────────

describe("INV-AUTOGUARD-UI-NO-RAW (raw kind / trigger を DOM・属性に出さない)", () => {
  it("未知 kind は raw 文字列を text にも属性にも出さず汎用ラベルへ畳む (ja)", () => {
    const html = renderCard(pending({ trigger: "secret", secret_kinds: ["future-kind"] }), "ja");
    // (a) 汎用ラベルが出る。
    expect(html).toContain("その他の秘匿 を検出");
    // (b) known=false + 固定 sentinel。
    expect(html).toContain('data-secret-kind-known="false"');
    expect(html).toContain('data-secret-kind="unknown"');
    // (c) raw kind 文字列は一切混入しない。
    expect(html).not.toContain("future-kind");
  });

  it("XSS 形 kind 名でも生タグ / raw を出さず汎用ラベルへ畳む (defense-in-depth)", () => {
    // 実 secret ではない合成文字列。projection gate 突破 / deploy skew 由来の敵対 kind を想定。
    const xssKind = "<img src=x onerror=alert(1)>";
    const html = renderCard(pending({ trigger: "secret", secret_kinds: [xssKind] }), "en");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain(xssKind);
    expect(html).toContain("Other secret detected");
    expect(html).toContain('data-secret-kind="unknown"');
  });

  it("未知 trigger は raw を text / data 属性に出さず理由バッジ自体を出さない", () => {
    const html = renderCard(
      pending({ trigger: "<script>alert(1)</script>", secret_kinds: undefined }),
      "ja",
    );
    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toContain('data-testid="approval-trigger"');
    // secret_kinds も無いので理由ブロックごと出ない。
    expect(html).not.toContain('data-testid="approval-guard-reason"');
  });

  it("Detail バナー経由でも未知 kind の raw は漏れない (最終 sink 防御の一貫性)", () => {
    const html = renderDetailBanner(
      pending({ trigger: "secret", secret_kinds: ["future-kind"] }),
      "ja",
    );
    expect(html).not.toContain("future-kind");
    expect(html).toContain('data-secret-kind="unknown"');
    expect(html).toContain("その他の秘匿 を検出");
  });
});
