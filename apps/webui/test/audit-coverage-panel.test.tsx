/**
 * ADR 019f4cdb 後続 UI: AuditCoveragePanel の静的描画 INV (renderToStaticMarkup・REAL wire 型)。
 *
 * 検証:
 *  - provider 行の描画 (slug / 稼働数 / 相対受信経過)。
 *  - gap severity の視覚符号: warn→amber+"delayed"・critical→red+"stalled?"・ok/idle→バッジなし。
 *  - null gap (非稼働/無受信) は **警告バッジを出さない** (誤警報しない)。
 *  - 無受信 (last_received null) は "no events"。
 *  - parse で落ちた非 slug row は **描画されない** (event-model 正準 parse を通した結果を描く)。
 *  - report null / provider ゼロは **何も描画しない** (架空の枠を作らない)。
 *
 * 手法: FixedLocaleProvider locale="en" で英語文言を固定し renderToStaticMarkup で静的描画する
 * (cockpit-hidden-history.test.tsx と同方式・jsdom 非依存)。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { parseAuditCoverageReportWire } from "@actradeck/event-model";

import { AuditCoveragePanel } from "../src/ui/AuditCoveragePanel.js";
import { FixedLocaleProvider } from "../src/ui/LocaleProvider.js";

const GEN = "2026-04-02T12:00:00.000Z";

function render(report: Parameters<typeof AuditCoveragePanel>[0]["report"]): string {
  return renderToStaticMarkup(
    <FixedLocaleProvider locale="en">
      <AuditCoveragePanel report={report} />
    </FixedLocaleProvider>,
  );
}

// endpoint 応答形の raw を正準 parse に通す (webui の実経路と同一)。非 slug row は drop される。
function report(rows: readonly unknown[]) {
  return parseAuditCoverageReportWire({ generated_at: GEN, providers: rows }) ?? null;
}

describe("AuditCoveragePanel — 静的描画", () => {
  it("report null / provider ゼロは何も描画しない (架空の枠を作らない)", () => {
    expect(render(null)).toBe("");
    expect(render(report([]))).toBe("");
  });

  it("provider 行を slug / 稼働数 / 相対受信経過つきで描画する", () => {
    const html = render(
      report([
        {
          provider: "claude_code",
          last_received_at: "2026-04-02T11:59:48.000Z", // 12s 前
          last_event_timestamp: "2026-04-02T11:59:48.000Z",
          active_session_count: 2,
          total_session_count: 3,
          gap_candidate_ms: 12_000,
        },
      ]),
    );
    expect(html).toContain('data-testid="audit-coverage"');
    expect(html).toContain('data-testid="coverage-row-claude_code"');
    expect(html).toContain("claude_code");
    expect(html).toContain("2 active");
    expect(html).toContain("12s ago");
    // gap 12s < 60s ⇒ ok ⇒ 警告バッジなし。
    expect(html).toContain('data-severity="ok"');
    expect(html).not.toContain('data-testid="coverage-status-claude_code"');
  });

  it("warn (≥60s) は amber + 'delayed' バッジ", () => {
    const html = render(
      report([
        {
          provider: "codex",
          last_received_at: "2026-04-02T11:58:30.000Z", // 90s 前
          last_event_timestamp: "2026-04-02T11:58:30.000Z",
          active_session_count: 1,
          total_session_count: 1,
          gap_candidate_ms: 90_000,
        },
      ]),
    );
    expect(html).toContain('data-severity="warn"');
    expect(html).toContain('data-testid="coverage-status-codex"');
    expect(html).toContain("delayed");
  });

  it("critical (≥300s) は red + 'stalled?' バッジ", () => {
    const html = render(
      report([
        {
          provider: "codex",
          last_received_at: "2026-04-02T11:50:00.000Z", // 600s 前
          last_event_timestamp: "2026-04-02T11:50:00.000Z",
          active_session_count: 1,
          total_session_count: 1,
          gap_candidate_ms: 600_000,
        },
      ]),
    );
    expect(html).toContain('data-severity="critical"');
    expect(html).toContain('data-testid="coverage-status-codex"');
    expect(html).toContain("stalled?");
  });

  it("null gap (非稼働) は idle・警告バッジを出さない (誤警報しない)", () => {
    const html = render(
      report([
        {
          provider: "gemini_cli",
          last_received_at: "2026-04-02T06:00:00.000Z", // 6h 前 (巨大 age) だが非稼働
          last_event_timestamp: "2026-04-02T06:00:00.000Z",
          active_session_count: 0,
          total_session_count: 4,
          gap_candidate_ms: null,
        },
      ]),
    );
    expect(html).toContain('data-severity="idle"');
    expect(html).not.toContain('data-testid="coverage-status-gemini_cli"');
    expect(html).not.toContain("stalled");
    expect(html).not.toContain("delayed");
    // 最終受信の相対経過自体は表示する (gap alarm のみ抑止)。
    expect(html).toContain("6h ago");
  });

  it("無受信 (last_received null) は 'no events'", () => {
    const html = render(
      report([
        {
          provider: "codex",
          last_received_at: null,
          last_event_timestamp: null,
          active_session_count: 1,
          total_session_count: 1,
          gap_candidate_ms: null,
        },
      ]),
    );
    expect(html).toContain("no events");
    expect(html).not.toContain('data-testid="coverage-status-codex"');
  });

  it("parse で落ちた非 slug row は描画されない (生パス row を drop)", () => {
    const html = render(
      report([
        {
          provider: "/etc/passwd", // 非 slug → parse で drop
          last_received_at: GEN,
          active_session_count: 1,
          gap_candidate_ms: 0,
        },
        {
          provider: "claude_code",
          last_received_at: "2026-04-02T11:59:50.000Z",
          last_event_timestamp: "2026-04-02T11:59:50.000Z",
          active_session_count: 1,
          total_session_count: 1,
          gap_candidate_ms: 10_000,
        },
      ]),
    );
    expect(html).toContain('data-testid="coverage-row-claude_code"');
    expect(html).not.toContain("/etc/passwd");
    expect(html).not.toContain("passwd");
  });

  // ── seq-drop chip (ADR 019f4cdb Phase2・silent-drop 下限検知) ────────────────
  describe("seq-drop chip", () => {
    function rowWithSeq(seqMissing: number | null, suppressed = 0): unknown {
      return {
        provider: "opencode",
        last_received_at: "2026-04-02T11:59:50.000Z",
        last_event_timestamp: "2026-04-02T11:59:50.000Z",
        active_session_count: 1,
        total_session_count: 1,
        gap_candidate_ms: 10_000,
        seq_missing_lower_bound: seqMissing,
        seq_tracked_session_count: seqMissing === null ? 0 : 2,
        seq_suppressed_session_count: suppressed,
      };
    }

    it("seq_missing_lower_bound > 0 は hedged chip ('≥N dropped?') を出す", () => {
      const html = render(report([rowWithSeq(3)]));
      expect(html).toContain('data-testid="coverage-seqdrop-opencode"');
      expect(html).toContain("≥3 dropped?"); // hedged (?・下限)
    });

    it("seq_missing_lower_bound === 0 (穴なし) は chip を出さない", () => {
      const html = render(report([rowWithSeq(0)]));
      expect(html).not.toContain('data-testid="coverage-seqdrop-opencode"');
      expect(html).not.toContain("dropped");
    });

    it("seq_missing_lower_bound === null (seq-bearing 無し) は chip を出さない", () => {
      const html = render(report([rowWithSeq(null)]));
      expect(html).not.toContain('data-testid="coverage-seqdrop-opencode"');
      expect(html).not.toContain("dropped");
    });

    it("seq_missing_lower_bound > 表示上限 は capped chip ('≥9999+ dropped?') を出す (SEC-1)", () => {
      const html = render(report([rowWithSeq(123456)]));
      expect(html).toContain('data-testid="coverage-seqdrop-opencode"');
      expect(html).toContain("≥9999+ dropped?"); // cap + hedged
      expect(html).not.toContain("123456"); // 生の巨大値は出さない
    });

    it("seq-drop chip は gap severity と独立 (idle gap でも穴があれば出る)", () => {
      const html = render(
        report([
          {
            provider: "opencode",
            last_received_at: "2026-04-02T06:00:00.000Z",
            last_event_timestamp: "2026-04-02T06:00:00.000Z",
            active_session_count: 0, // 非稼働 → gap null (idle)
            total_session_count: 1,
            gap_candidate_ms: null,
            seq_missing_lower_bound: 5,
            seq_tracked_session_count: 1,
          },
        ]),
      );
      // gap は idle (警告バッジなし) だが seq-drop chip は出る (独立信号)。
      expect(html).toContain('data-severity="idle"');
      expect(html).not.toContain('data-testid="coverage-status-opencode"');
      expect(html).toContain('data-testid="coverage-seqdrop-opencode"');
      expect(html).toContain("≥5 dropped?");
    });
  });

  // ── seq-suppressed 診断 (SEC-6・muted・severity 非連動) ──────────────────────
  describe("seq-suppressed diagnostic", () => {
    function rowWithSuppressed(suppressed: number, seqMissing: number | null = 0): unknown {
      return {
        provider: "opencode",
        last_received_at: "2026-04-02T11:59:50.000Z",
        last_event_timestamp: "2026-04-02T11:59:50.000Z",
        active_session_count: 1,
        total_session_count: 1,
        gap_candidate_ms: 10_000,
        seq_missing_lower_bound: seqMissing,
        seq_tracked_session_count: 3,
        seq_suppressed_session_count: suppressed,
      };
    }

    it("seq_suppressed_session_count > 0 は muted 診断 ('N seq-suppressed') を出す", () => {
      const html = render(report([rowWithSuppressed(2)]));
      expect(html).toContain('data-testid="coverage-seqsuppressed-opencode"');
      expect(html).toContain("2 seq-suppressed");
    });

    it("seq_suppressed_session_count === 0 は診断を出さない", () => {
      const html = render(report([rowWithSuppressed(0)]));
      expect(html).not.toContain('data-testid="coverage-seqsuppressed-opencode"');
      expect(html).not.toContain("seq-suppressed");
    });

    it("診断は欠落 chip と独立に出る (missing=0 で chip 非表示でも suppressed>0 なら診断あり)", () => {
      const html = render(report([rowWithSuppressed(3, 0)]));
      // 欠落 chip は 0 ゆえ非表示。
      expect(html).not.toContain('data-testid="coverage-seqdrop-opencode"');
      // 抑制診断は出る (severity 非連動・警告色でない muted 表示)。
      expect(html).toContain('data-testid="coverage-seqsuppressed-opencode"');
      expect(html).toContain("3 seq-suppressed");
    });
  });
});
