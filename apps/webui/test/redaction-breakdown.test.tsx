/**
 * 強み(a)③ redaction 可視化 (UI フェーズ) — RiskPane の kind 別内訳タグ + i18n + helper の契約。
 *
 * SEC (INV-REDACTION 隣接): 表示は **件数 (int) + kind ラベル (公開 enum)** のみ。
 *  - 秘匿値・原文は一切 component に渡さない (テストでも秘匿値文字列を持ち込まない)。
 *  - 欠落/空/不正値で内訳は非表示・クラッシュしない (graceful)。既存合計表示 (secret_detected)
 *    は本変更で壊さない (無改変緑は session-detail-body.test.tsx が担保)。
 *
 * 表示変換 (kind→ラベル) は UI 層のみ・データ層は kind 文字列を raw 保持 (ユーザー確定方針)。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { REDACTION_KINDS } from "@actradeck/event-model";

import { CATALOGS_FOR_TEST, LOCALES } from "../src/ui/i18n/messages.js";
import {
  REDACTION_KIND_LABEL_KEYS,
  redactionEntries,
  redactionEntriesTotal,
  redactionKindLabelKey,
} from "../src/ui/redaction-display.js";
import { FixedLocaleProvider } from "../src/ui/LocaleProvider.js";
import { SessionDetailView } from "../src/ui/SessionDetail.js";

import type { Locale } from "../src/ui/i18n/messages.js";
import type { SessionDetail } from "../src/realtime/contract.js";

function detail(o: Partial<SessionDetail> = {}): SessionDetail {
  return {
    session_id: "s1",
    provider: "claude_code",
    source: "hooks",
    agent_id: undefined,
    repo: undefined,
    branch: undefined,
    cwd: undefined,
    state: "running.command_executing",
    current_action: "bash",
    last_event_at: "2026-06-05T00:00:00.000Z",
    needs_attention: false,
    liveness_state: "live",
    stalled_suspected: false,
    connected: true,
    last_event_id: "e1",
    liveness_evidence: {},
    liveness_reason: "",
    liveness_evaluated_at_ms: 1,
    invalid_transition_count: 0,
    pending_approvals: [],
    ...o,
  };
}

/** RiskPane を含めるには events を渡して 4 ペイン拡張を有効化する。 */
function renderDetail(d: SessionDetail, locale: Locale = "ja"): string {
  return renderToStaticMarkup(
    <FixedLocaleProvider locale={locale}>
      <SessionDetailView detail={d} loading={false} events={[]} />
    </FixedLocaleProvider>,
  );
}

// ─── helper: redactionEntries (正規化 + 安定順 + graceful) ─────────────────────

describe("redactionEntries (normalize + stable order + graceful)", () => {
  it("件数 desc → 同数は kind 名 asc の安定順で返す", () => {
    const e = redactionEntries({
      "github-token": 2,
      "aws-access-key-id": 5,
      cookie: 2,
    });
    expect(e.map((x) => x.kind)).toEqual(["aws-access-key-id", "cookie", "github-token"]);
    expect(redactionEntriesTotal(e)).toBe(9);
  });

  it("undefined / 空オブジェクト → 空配列 (旧 session・graceful)", () => {
    expect(redactionEntries(undefined)).toEqual([]);
    expect(redactionEntries({})).toEqual([]);
  });

  it("0 / 負 / 非整数 / 非有限 のエントリは除外する (件数 0 を検出と誤表示しない)", () => {
    const e = redactionEntries({
      cookie: 0,
      jwt: -1,
      "github-token": 1.5,
      "aws-access-key-id": Number.NaN,
      "slack-token": Number.POSITIVE_INFINITY,
      "openai-key": 3,
    });
    expect(e).toEqual([{ kind: "openai-key", count: 3 }]);
  });

  it("未知 kind (新 sidecar) も件数が正なら保持する (forward-compat・raw 保持)", () => {
    const e = redactionEntries({ "future-kind": 4, "github-token": 1 });
    expect(e.map((x) => x.kind)).toEqual(["future-kind", "github-token"]);
  });

  it("__proto__ を own data property に持つ DTO (JSON 由来) を graceful に扱う (QA-2 proto 汚染)", () => {
    // REAL DATA ONLY: 実 DTO 形状 = JSON.parse 由来の own enumerable property で書く。
    const byKind = JSON.parse('{"__proto__":5,"github-token":1}') as Record<string, number>;
    // (a) throw しない。
    const e = redactionEntries(byKind);
    // (b) 結果配列の prototype が汚染されていない (通常の Array.prototype)。
    expect(Object.getPrototypeOf(e)).toBe(Array.prototype);
    // グローバル汚染も無い。
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // (c) github-token entry が含まれる (有効 kind は落とさない)。
    expect(e.some((x) => x.kind === "github-token" && x.count === 1)).toBe(true);
  });
});

// ─── RiskPane: kind 別タグの render/behavior ───────────────────────────────────

describe("RiskPane redaction breakdown", () => {
  it("複数 kind を内訳タグ + 合計で出す (件数のみ・原文なし)", () => {
    const html = renderDetail(
      detail({
        secret_detected: true,
        secret_redaction_count: 3,
        secret_redaction_count_by_kind: { "github-token": 2, "aws-access-key-id": 1 },
      }),
    );
    expect(html).toContain('data-testid="redaction-breakdown"');
    expect(html).toContain('data-kind-count="2"');
    expect(html).toContain('data-redaction-kind="github-token"');
    expect(html).toContain('data-redaction-kind-count="2"');
    expect(html).toContain('data-redaction-kind="aws-access-key-id"');
    expect(html).toContain('data-testid="redaction-breakdown-total"');
    // 内訳合計 (by-kind の和)。
    expect(html).toContain("計 3 件");
  });

  it("単一 kind でも内訳を出す", () => {
    const html = renderDetail(
      detail({ secret_detected: true, secret_redaction_count_by_kind: { cookie: 4 } }),
    );
    expect(html).toContain('data-testid="redaction-breakdown"');
    expect(html).toContain('data-redaction-kind="cookie"');
    expect(html).toContain('data-kind-count="1"');
  });

  it("空オブジェクトでは内訳を出さない (既存 secret 表示は別途維持)", () => {
    const html = renderDetail(
      detail({
        secret_detected: true,
        secret_redaction_count: 2,
        secret_redaction_count_by_kind: {},
      }),
    );
    expect(html).not.toContain('data-testid="redaction-breakdown"');
    // 既存の session 単位 secret バッジは維持される (壊さない)。
    expect(html).toContain('data-testid="risk-secret-detected"');
  });

  it("undefined (旧 session) では内訳を出さない", () => {
    const html = renderDetail(detail({ secret_detected: true, secret_redaction_count: 1 }));
    expect(html).not.toContain('data-testid="redaction-breakdown"');
    expect(html).toContain('data-testid="risk-secret-detected"');
  });

  it("未知 kind は raw kind 文字列を画面にも属性にも出さず汎用ラベルへ畳む (QA-1 H / no-raw-display)", () => {
    const html = renderDetail(
      detail({
        secret_detected: true,
        secret_redaction_count_by_kind: { "future-kind": 2 },
      }),
      "ja",
    );
    // (a) 汎用ラベルが出る (raw kind は表示しない)。
    expect(html).toContain("その他の秘匿 ×2");
    // (b) 「未知である事実」は known=false で保持。属性は固定 sentinel。
    expect(html).toContain('data-redaction-kind-known="false"');
    expect(html).toContain('data-redaction-kind="unknown"');
    // (c) raw kind 文字列は text にも属性にも一切混入しない。
    expect(html).not.toContain("future-kind");
  });

  it("XSS 形 kind 名でも生タグ/raw 文字列を出さず汎用ラベルへ畳む (SEC-1 defense-in-depth)", () => {
    // 実 secret ではない合成文字列。projection gate 突破 or deploy skew 由来の敵対 kind を想定。
    const xssKind = "<img src=x onerror=alert(1)>";
    const html = renderDetail(
      detail({
        secret_detected: true,
        secret_redaction_count_by_kind: { [xssKind]: 2 },
      }),
      "en",
    );
    // (a) 生タグが混入しない (React エスケープに加え、そもそも raw を出さない二重防御)。
    expect(html).not.toContain("<img src=x");
    // (b) 汎用ラベルが出る。
    expect(html).toContain("Other secret ×2");
    // (c) 当該文字列は data-redaction-kind 属性にも出ない (固定 sentinel)。
    expect(html).not.toContain(xssKind);
    expect(html).not.toContain("onerror");
    expect(html).toContain('data-redaction-kind="unknown"');
  });

  it("既知 kind は i18n ラベルで表示する (known=true・raw kind は表示文字列に出ない)", () => {
    const html = renderDetail(
      detail({ secret_detected: true, secret_redaction_count_by_kind: { "github-token": 2 } }),
      "en",
    );
    expect(html).toContain('data-redaction-kind-known="true"');
    expect(html).toContain("GitHub token ×2");
  });

  it("__proto__ own property を render しても raw '__proto__' を画面/属性に出さない (QA-2 proto・描画)", () => {
    const byKind = JSON.parse('{"__proto__":5,"github-token":1}') as Record<string, number>;
    const html = renderDetail(
      detail({ secret_detected: true, secret_redaction_count_by_kind: byKind }),
    );
    // __proto__ は未知 kind 扱いで汎用ラベルへ畳まれ、raw 文字列は出ない。
    expect(html).not.toContain("__proto__");
    expect(html).toContain("その他の秘匿 ×5");
    // 有効 kind は通常表示される。
    expect(html).toContain('data-redaction-kind="github-token"');
  });

  it("内訳合計 (by-kind 和) と scalar (secret_redaction_count) は別軸で共存する (QA-3 scalar≠sum)", () => {
    // 契約: sum(by_kind) <= scalar count。by-kind は既知 kind 部分集合、scalar は全マーカー数。
    const html = renderDetail(
      detail({
        secret_detected: true,
        secret_redaction_count: 10,
        secret_redaction_count_by_kind: { "github-token": 2 },
      }),
    );
    // (a) redaction-breakdown-total は by-kind 和 = 2。
    expect(html).toContain('data-testid="redaction-breakdown-total"');
    expect(html).toContain("計 2 件");
    // (b) 既存 session 単位 secret バッジ (scalar=10 由来) が別の数で共存する。
    expect(html).toContain('data-testid="risk-secret-detected"');
    expect(html).toContain('data-redaction-count="10"');
    // by-kind 和 (2) を scalar (10) と取り違えていない。
    expect(html).not.toContain("計 10 件");
  });
});

// ─── i18n: 全 REDACTION_KINDS に ja/en ラベルが存在する (取りこぼし pin) ──────────

describe("redaction kind i18n labels", () => {
  it("REDACTION_KINDS 全 kind に ja/en ラベルが存在する", () => {
    for (const kind of REDACTION_KINDS) {
      const key = redactionKindLabelKey(kind);
      for (const locale of LOCALES) {
        const v = CATALOGS_FOR_TEST[locale][key];
        expect(v, `${locale}:${key}`).toBeTruthy();
      }
    }
  });

  it("REDACTION_KIND_LABEL_KEYS が REDACTION_KINDS と 1:1 で対応する", () => {
    expect(REDACTION_KIND_LABEL_KEYS).toHaveLength(REDACTION_KINDS.length);
    expect(REDACTION_KIND_LABEL_KEYS).toEqual(REDACTION_KINDS.map((k) => `redaction.kind.${k}`));
  });
});
