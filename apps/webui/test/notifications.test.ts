/**
 * 通知エンジン/純ロジックの不変条件 (強み(a)・webui 完結).
 *
 * 純ロジック (computeNotifications) + 発火エンジン (createNotificationEngine) を fake notifier で
 * 検証する。React 層 (gesture) は notifications.gesture.test.tsx (jsdom) で別途。
 *
 * INV:
 *  - INV-NOTIFY-ON-TRANSITION   : 各エッジ(false→true / →failed) で発火する。
 *  - INV-NOTIFY-EDGE-ONLY       : true→true / 同値 では発火しない (再通知なし)。
 *  - INV-NOTIFY-SUPPRESS-VISIBLE: document.hidden=false 相当 (ctx.documentHidden=false) で発火しない。
 *  - INV-NOTIFY-NO-PERMISSION-SILENT: permission!=="granted" / notifier 不在で throw せず発火もしない。
 *  - INV-NOTIFY-NO-LEAK         : secret 形 current_action を持つ遷移でも raw secret/command が出ない。
 */
import { describe, expect, it, vi } from "vitest";

import { t } from "../src/ui/i18n/messages.js";
import {
  computeNotifications,
  createNotificationEngine,
  FAILED_STATES,
  type NotificationCategory,
  type Notifier,
  type NotifyContext,
} from "../src/ui/notifications.js";

import type { SessionListItem } from "../src/realtime/contract.js";

// ── fixtures ────────────────────────────────────────────────────────────────

const ALL_CATS: Record<NotificationCategory, boolean> = {
  approval: true,
  stalled: true,
  failed: true,
};

function item(over: Partial<SessionListItem> = {}): SessionListItem {
  return {
    session_id: "sess-abcdef-0123456789",
    provider: "claude_code",
    source: "hook",
    agent_id: undefined,
    repo: "acme/widgets",
    branch: "main",
    cwd: "/home/dev/widgets",
    state: "running.command_executing",
    current_action: "running a command",
    last_event_at: "2026-06-15T00:00:00.000Z",
    needs_attention: false,
    liveness_state: "live",
    stalled_suspected: false,
    connected: true,
    ...over,
  };
}

interface ShownCall {
  readonly title: string;
  readonly body: string;
  readonly tag: string;
}

function fakeNotifier(permission: NotificationPermission): {
  notifier: Notifier;
  shown: ShownCall[];
  requestSpy: ReturnType<typeof vi.fn>;
} {
  const shown: ShownCall[] = [];
  const requestSpy = vi.fn(async () => permission);
  const notifier: Notifier = {
    permission,
    show(title, options) {
      shown.push({ title, body: options.body, tag: options.tag });
    },
    requestPermission: requestSpy,
  };
  return { notifier, shown, requestSpy };
}

function ctx(over: Partial<NotifyContext> = {}): NotifyContext {
  return {
    enabled: true,
    categories: ALL_CATS,
    documentHidden: true,
    nowMs: 1_000,
    ...over,
  };
}

// ── computeNotifications (純) ────────────────────────────────────────────────

describe("computeNotifications — edges", () => {
  it("INV-NOTIFY-ON-TRANSITION: needs_attention false→true で approval spec", () => {
    const specs = computeNotifications(item(), item({ needs_attention: true }), {
      categories: ALL_CATS,
    });
    expect(specs.map((s) => s.category)).toEqual(["approval"]);
  });

  it("INV-NOTIFY-ON-TRANSITION: stalled_suspected false→true で stalled spec", () => {
    const specs = computeNotifications(item(), item({ stalled_suspected: true }), {
      categories: ALL_CATS,
    });
    expect(specs.map((s) => s.category)).toEqual(["stalled"]);
  });

  it("INV-NOTIFY-ON-TRANSITION: state→failed/interrupted で failed spec", () => {
    for (const st of FAILED_STATES) {
      const specs = computeNotifications(
        item({ state: "running.command_executing" }),
        item({ state: st }),
        { categories: ALL_CATS },
      );
      expect(specs.map((s) => s.category)).toEqual(["failed"]);
    }
  });

  it("completed(正常終了) は failed 通知を出さない", () => {
    const specs = computeNotifications(
      item({ state: "running.command_executing" }),
      item({ state: "completed" }),
      { categories: ALL_CATS },
    );
    expect(specs).toEqual([]);
  });

  it("prev=undefined(初回) でも true なら立ち上がりとして検出 (snapshot 抑止は呼び出し側)", () => {
    const specs = computeNotifications(undefined, item({ needs_attention: true }), {
      categories: ALL_CATS,
    });
    expect(specs.map((s) => s.category)).toEqual(["approval"]);
  });

  it("INV-NOTIFY-EDGE-ONLY: true→true は発火しない", () => {
    const specs = computeNotifications(
      item({ needs_attention: true }),
      item({ needs_attention: true }),
      { categories: ALL_CATS },
    );
    expect(specs).toEqual([]);
  });

  it("INV-NOTIFY-EDGE-ONLY: failed→failed (終端維持) は再発火しない", () => {
    const specs = computeNotifications(item({ state: "failed" }), item({ state: "failed" }), {
      categories: ALL_CATS,
    });
    expect(specs).toEqual([]);
  });

  it("カテゴリ無効化でそのカテゴリは出さない", () => {
    const specs = computeNotifications(item(), item({ needs_attention: true }), {
      categories: { approval: false, stalled: true, failed: true },
    });
    expect(specs).toEqual([]);
  });
});

// ── engine 発火条件 ──────────────────────────────────────────────────────────

describe("createNotificationEngine — gating", () => {
  it("INV-NOTIFY-ON-TRANSITION: enabled+granted+hidden で show が呼ばれる", () => {
    const { notifier, shown } = fakeNotifier("granted");
    const engine = createNotificationEngine({ notifier, translate: (k, p) => t("en", k, p) });
    const fired = engine.handleListDelta(item(), item({ needs_attention: true }), ctx());
    expect(fired.map((s) => s.category)).toEqual(["approval"]);
    expect(shown).toHaveLength(1);
    expect(shown[0]!.tag).toBe("sess-abcdef-0123456789:approval");
  });

  it("INV-NOTIFY-SUPPRESS-VISIBLE: documentHidden=false では発火しない", () => {
    const { notifier, shown } = fakeNotifier("granted");
    const engine = createNotificationEngine({ notifier, translate: (k, p) => t("en", k, p) });
    const fired = engine.handleListDelta(
      item(),
      item({ needs_attention: true }),
      ctx({ documentHidden: false }),
    );
    expect(fired).toEqual([]);
    expect(shown).toHaveLength(0);
  });

  it("enabled=false では発火しない", () => {
    const { notifier, shown } = fakeNotifier("granted");
    const engine = createNotificationEngine({ notifier, translate: (k, p) => t("en", k, p) });
    engine.handleListDelta(item(), item({ needs_attention: true }), ctx({ enabled: false }));
    expect(shown).toHaveLength(0);
  });

  it("INV-NOTIFY-NO-PERMISSION-SILENT: permission!=='granted' は throw せず発火しない", () => {
    for (const perm of ["default", "denied"] as NotificationPermission[]) {
      const { notifier, shown, requestSpy } = fakeNotifier(perm);
      const engine = createNotificationEngine({ notifier, translate: (k, p) => t("en", k, p) });
      expect(() =>
        engine.handleListDelta(item(), item({ needs_attention: true }), ctx()),
      ).not.toThrow();
      expect(shown).toHaveLength(0);
      // prompt(requestPermission) も呼ばない。
      expect(requestSpy).not.toHaveBeenCalled();
    }
  });

  it("INV-NOTIFY-NO-PERMISSION-SILENT: notifier 不在は throw せず発火しない", () => {
    const engine = createNotificationEngine({
      notifier: undefined,
      translate: (k, p) => t("en", k, p),
    });
    expect(() =>
      engine.handleListDelta(item(), item({ needs_attention: true }), ctx()),
    ).not.toThrow();
  });

  it("dedup/cooldown: 同一キーは cooldown 内で 1 回だけ", () => {
    const { notifier, shown } = fakeNotifier("granted");
    const engine = createNotificationEngine({
      notifier,
      translate: (k, p) => t("en", k, p),
      cooldownMs: 10_000,
    });
    // 1 回目: 立ち上がり → 発火。
    engine.handleListDelta(item(), item({ needs_attention: true }), ctx({ nowMs: 1_000 }));
    // standing true→true は computeNotifications 段でそもそも出ない (再通知なし)。
    engine.handleListDelta(
      item({ needs_attention: true }),
      item({ needs_attention: true }),
      ctx({ nowMs: 2_000 }),
    );
    expect(shown).toHaveLength(1);
  });

  it("cooldown: いったん下がって再び立ち上がっても cooldown 内なら抑制", () => {
    const { notifier, shown } = fakeNotifier("granted");
    const engine = createNotificationEngine({
      notifier,
      translate: (k, p) => t("en", k, p),
      cooldownMs: 10_000,
    });
    engine.handleListDelta(item(), item({ needs_attention: true }), ctx({ nowMs: 1_000 }));
    // false へ戻る (delta) → 再び true (cooldown 内) は抑制。
    engine.handleListDelta(
      item({ needs_attention: true }),
      item({ needs_attention: false }),
      ctx({ nowMs: 2_000 }),
    );
    engine.handleListDelta(
      item({ needs_attention: false }),
      item({ needs_attention: true }),
      ctx({ nowMs: 3_000 }),
    );
    expect(shown).toHaveLength(1);
    // cooldown 経過後の立ち上がりは発火。
    engine.handleListDelta(
      item({ needs_attention: false }),
      item({ needs_attention: true }),
      ctx({ nowMs: 20_000 }),
    );
    expect(shown).toHaveLength(2);
  });
});

// ── QA-3: document.hidden 動的遷移 ───────────────────────────────────────────

describe("INV-NOTIFY-VISIBILITY-EDGE (QA-3)", () => {
  it("前面で立ち上がり(抑止)→背面化→同値 delta(true→true) では再発火しない", () => {
    const { notifier, shown } = fakeNotifier("granted");
    const engine = createNotificationEngine({ notifier, translate: (k, p) => t("en", k, p) });

    // 1) 前面 (hidden=false) で false→true の立ち上がり。発火は抑止される。
    engine.handleListDelta(
      item({ needs_attention: false }),
      item({ needs_attention: true }),
      ctx({ documentHidden: false, nowMs: 1_000 }),
    );
    expect(shown).toHaveLength(0);

    // 2) 背面化 (hidden=true) するが、delta は同値 (true→true) = エッジでない。再発火しない。
    engine.handleListDelta(
      item({ needs_attention: true }),
      item({ needs_attention: true }),
      ctx({ documentHidden: true, nowMs: 2_000 }),
    );
    expect(shown).toHaveLength(0);
  });

  it("背面で新たな立ち上がり(別 session)は発火する (visibility 抑止は前面時のみ)", () => {
    const { notifier, shown } = fakeNotifier("granted");
    const engine = createNotificationEngine({ notifier, translate: (k, p) => t("en", k, p) });
    engine.handleListDelta(
      item({ session_id: "fg", needs_attention: false }),
      item({ session_id: "fg", needs_attention: true }),
      ctx({ documentHidden: false, nowMs: 1_000 }),
    );
    expect(shown).toHaveLength(0);
    // 別 session が背面化後に立ち上がる → エッジ ∧ hidden ∧ granted で発火。
    engine.handleListDelta(
      item({ session_id: "bg", needs_attention: false }),
      item({ session_id: "bg", needs_attention: true }),
      ctx({ documentHidden: true, nowMs: 2_000 }),
    );
    expect(shown).toHaveLength(1);
  });
});

// ── QA-2: purge→復活の再発火 (cooldown 任せで許容・decision に明記) ──────────────

describe("INV-NOTIFY-PURGE-REVIVAL (QA-2)", () => {
  // 設計判断: purge は disconnected かつ長時間 idle の session のみ落とす (purge 窓 >> cooldown)。
  //   engine の lastFiredAt は listState とは独立に保持されるため、purge されても消えない。
  //   復活時の delta は prev=undefined(list から消えている)で立ち上がりエッジになるが、
  //   cooldown 経過後なら「実際に再び要対応へ入った新規アクション」として **再発火を許容**する。
  //   cooldown 内の即時 flapping は引き続き抑制される。
  it("purge 相当(prev=undefined)の復活は cooldown 経過後なら再発火する", () => {
    const { notifier, shown } = fakeNotifier("granted");
    const engine = createNotificationEngine({
      notifier,
      translate: (k, p) => t("en", k, p),
      cooldownMs: 10_000,
    });
    const sid = "revive-me";
    // 初回立ち上がり → 発火。
    engine.handleListDelta(
      item({ session_id: sid, needs_attention: false }),
      item({ session_id: sid, needs_attention: true }),
      ctx({ nowMs: 1_000 }),
    );
    expect(shown).toHaveLength(1);
    // (purge: list から消える) → 復活 delta は prev=undefined。cooldown 経過後 (>10s) なら再発火。
    engine.handleListDelta(
      undefined,
      item({ session_id: sid, needs_attention: true }),
      ctx({ nowMs: 30_000 }),
    );
    expect(shown).toHaveLength(2);
  });

  it("purge 即復活 (cooldown 内・prev=undefined) は抑制される (flapping ガード)", () => {
    const { notifier, shown } = fakeNotifier("granted");
    const engine = createNotificationEngine({
      notifier,
      translate: (k, p) => t("en", k, p),
      cooldownMs: 10_000,
    });
    const sid = "flap";
    engine.handleListDelta(
      item({ session_id: sid, needs_attention: false }),
      item({ session_id: sid, needs_attention: true }),
      ctx({ nowMs: 1_000 }),
    );
    expect(shown).toHaveLength(1);
    // cooldown 内 (5s 後) の prev=undefined 復活 → 抑制。
    engine.handleListDelta(
      undefined,
      item({ session_id: sid, needs_attention: true }),
      ctx({ nowMs: 6_000 }),
    );
    expect(shown).toHaveLength(1);
  });
});

// ── no-leak ─────────────────────────────────────────────────────────────────

describe("INV-NOTIFY-NO-LEAK", () => {
  const SECRET = "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const SECRET_ACTION = `export GH_TOKEN=${SECRET}`;

  it("secret 形 current_action を持つ遷移でも title/body に raw secret/command が出ない", () => {
    const { notifier, shown } = fakeNotifier("granted");
    const engine = createNotificationEngine({ notifier, translate: (k, p) => t("en", k, p) });
    for (const locale of ["en", "ja"] as const) {
      const eng = createNotificationEngine({ notifier, translate: (k, p) => t(locale, k, p) });
      eng.handleListDelta(
        item({ current_action: SECRET_ACTION }),
        item({ needs_attention: true, current_action: SECRET_ACTION }),
        ctx(),
      );
    }
    // また既定 engine でも 1 件発火させ shown を埋める。
    engine.handleListDelta(
      item({ current_action: SECRET_ACTION }),
      item({ stalled_suspected: true, current_action: SECRET_ACTION }),
      ctx(),
    );
    expect(shown.length).toBeGreaterThan(0);
    for (const call of shown) {
      const blob = `${call.title}\n${call.body}\n${call.tag}`;
      expect(blob).not.toContain(SECRET);
      expect(blob).not.toContain("ghp_");
      expect(blob).not.toContain("export ");
      expect(blob).not.toContain(SECRET_ACTION);
    }
  });

  it("spec.params に current_action / command を入れない (キー集合の固定)", () => {
    const specs = computeNotifications(
      item({ current_action: SECRET_ACTION }),
      item({ needs_attention: true, current_action: SECRET_ACTION }),
      { categories: ALL_CATS },
    );
    expect(specs).toHaveLength(1);
    expect(Object.keys(specs[0]!.params).sort()).toEqual(["location", "session", "state"]);
    expect(JSON.stringify(specs[0]!.params)).not.toContain("ghp_");
  });
});
