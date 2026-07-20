/**
 * ADR 0014 Phase 3b-1 — hook-receiver 経由の run lineage end-to-end (in-process HTTP + SQLite).
 *
 * 対象不変条件:
 *  - INV-PROVIDER-SESSION-ID-POPULATED: run 内全 hook イベントに provider_session_id が載る (従来 NULL)。
 *  - INV-PROJECTION-NO-SPLIT: 同一 provider id の重複 SessionStart は単一 run (session_id 一意)。
 *  - INV-RUN-LINEAGE-EDGE: provider id 変化 / terminal-reopen で新 run が resumed_from=親を持つ。
 *  - end_kind/recoverability: SessionEnd reason→EndKind gate + terminalContinuation 再利用。
 *  - INV-ATTACH-CANONICAL-ADVERTISED: registry.sessionIds() は canonical run id (Map key=provider id でなく)。
 */
import { describe, expect, it } from "vitest";

import { ApprovalBridge } from "../src/approval-bridge.js";
import { AttachSessionRegistry } from "../src/attach-session-registry.js";
import { HookReceiver } from "../src/hook-receiver.js";
import { SessionIdentity } from "../src/session-identity.js";
import { EventSink } from "../src/sink.js";
import { EventStore } from "../src/store.js";
import type { WsClient } from "../src/ws-client.js";

const noopWs = { notifyAppended: () => {} } as unknown as WsClient;
const P1 = "aaaaaaaa-1111-7111-8111-aaaaaaaaaaaa";
const P2 = "bbbbbbbb-2222-7222-8222-bbbbbbbbbbbb";

interface Row {
  event_type: string;
  session_id: string | undefined;
  provider_session_id: string | undefined;
  start_kind: string | undefined;
  resumed_from_session_id: string | undefined;
  end_kind: string | undefined;
  recoverability: string | undefined;
}

async function harness(): Promise<{
  post: (body: Record<string, unknown>) => Promise<void>;
  rows: () => Row[];
  close: () => Promise<void>;
}> {
  const store = new EventStore(":memory:");
  const sink = new EventSink({ store, wsClient: noopWs });
  const bridge = new ApprovalBridge({ timeoutMs: 500 });
  // 静的 identity (managed 相当・auto-resolve モード)。onHookSession が run 境界を駆動する。
  const identity = new SessionIdentity({ fallbackSessionId: "sess_fallback" });
  const receiver = new HookReceiver({ sink, approvalBridge: bridge, identity });
  const port = await receiver.listen();
  return {
    post: async (body) => {
      await fetch(`http://127.0.0.1:${port}/hook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    rows: () =>
      store.allRows().map((r) => {
        const ev = JSON.parse(r.event_json) as Record<string, unknown>;
        return {
          event_type: r.event_type,
          session_id: ev.session_id as string | undefined,
          provider_session_id: ev.provider_session_id as string | undefined,
          start_kind: ev.start_kind as string | undefined,
          resumed_from_session_id: ev.resumed_from_session_id as string | undefined,
          end_kind: ev.end_kind as string | undefined,
          recoverability: ev.recoverability as string | undefined,
        };
      }),
    close: async () => {
      await receiver.close();
      store.close();
    },
  };
}

describe("INV-PROVIDER-SESSION-ID-POPULATED / INV-PROJECTION-NO-SPLIT (hook e2e)", () => {
  it("run 内全 hook イベントに provider_session_id が載り、単一 canonical run へ属す", async () => {
    const h = await harness();
    await h.post({ session_id: P1, hook_event_name: "SessionStart", source: "startup" });
    await h.post({ session_id: P1, hook_event_name: "UserPromptSubmit", prompt: "hi" });
    await h.post({
      session_id: P1,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "ls" },
    });
    const rows = h.rows();
    expect(rows.length).toBeGreaterThanOrEqual(3);
    // 全イベントに provider_session_id が載る (従来 NULL からの populate)。
    for (const r of rows) expect(r.provider_session_id).toBe(P1);
    // 全イベントが単一 canonical run (session_id 一意・分裂しない)。
    expect(new Set(rows.map((r) => r.session_id))).toEqual(new Set([P1]));
    // start_kind は run 起点 (session.started) にのみ載る (generation 0 = fresh)。
    const started = rows.find((r) => r.event_type === "session.started");
    expect(started?.start_kind).toBe("fresh");
    await h.close();
  });

  it("重複 SessionStart (at-least-once 再送) は分裂せず単一 run へ畳む", async () => {
    const h = await harness();
    await h.post({ session_id: P1, hook_event_name: "SessionStart", source: "startup" });
    await h.post({ session_id: P1, hook_event_name: "SessionStart", source: "startup" });
    const started = h.rows().filter((r) => r.event_type === "session.started");
    expect(started).toHaveLength(2); // イベントは 2 件だが…
    expect(new Set(started.map((r) => r.session_id))).toEqual(new Set([P1])); // …同一 run。
    await h.close();
  });
});

describe("INV-RUN-LINEAGE-EDGE / end_kind (hook e2e・managed 静的 identity)", () => {
  it("provider id 変化 (resume) で新 run が resumed_from=親・start_kind=resume を持つ", async () => {
    const h = await harness();
    await h.post({ session_id: P1, hook_event_name: "SessionStart", source: "startup" });
    await h.post({ session_id: P1, hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
    // 別 provider id (resume) → 新 run。
    await h.post({ session_id: P2, hook_event_name: "SessionStart", source: "resume" });
    const rows = h.rows();
    const ended = rows.find((r) => r.event_type === "session.ended");
    expect(ended?.session_id).toBe(P1);
    expect(ended?.end_kind).toBe("completed"); // prompt_input_exit → completed
    expect(ended?.recoverability).toBe("not_resumable"); // terminalContinuation("completed")
    // 子 run。
    const childStart = rows.find((r) => r.event_type === "session.started" && r.session_id === P2);
    expect(childStart).toBeDefined();
    expect(childStart?.start_kind).toBe("resume");
    expect(childStart?.resumed_from_session_id).toBe(P1); // lineage エッジ (親観測済)
    // 親 run の session.started は resumed_from を持たない (over-claim しない)。
    const parentStart = rows.find((r) => r.event_type === "session.started" && r.session_id === P1);
    expect(parentStart?.resumed_from_session_id).toBeUndefined();
    await h.close();
  });

  it("SessionEnd reason=clear → end_kind=cleared / reason=logout → logout", async () => {
    const h = await harness();
    await h.post({ session_id: P1, hook_event_name: "SessionStart", source: "startup" });
    await h.post({ session_id: P1, hook_event_name: "SessionEnd", reason: "clear" });
    const ended = h.rows().find((r) => r.event_type === "session.ended");
    expect(ended?.end_kind).toBe("cleared");
    await h.close();

    const h2 = await harness();
    await h2.post({ session_id: P2, hook_event_name: "SessionStart", source: "startup" });
    await h2.post({ session_id: P2, hook_event_name: "SessionEnd", reason: "logout" });
    const ended2 = h2.rows().find((r) => r.event_type === "session.ended");
    expect(ended2?.end_kind).toBe("logout");
    await h2.close();
  });

  it("SessionEnd 未知 reason → end_kind=other (≠completed・default 分岐を弁別)", async () => {
    // QA-2 (M): endKindForSessionEndReason の default→"other" 分岐を弁別的に pin する。
    //   変異 `default: return "completed"` は clear/logout/prompt_input_exit の 3 分岐 assert を
    //   素通りする — 未マップ reason を実際に流し、"other" かつ ≠"completed" を要求して塞ぐ。
    const h = await harness();
    await h.post({ session_id: P1, hook_event_name: "SessionStart", source: "startup" });
    // clear/logout/prompt_input_exit いずれでもない未マップ値 → switch default 経路。
    await h.post({ session_id: P1, hook_event_name: "SessionEnd", reason: "window_closed" });
    const ended = h.rows().find((r) => r.event_type === "session.ended");
    expect(ended?.end_kind).toBe("other");
    expect(ended?.end_kind).not.toBe("completed"); // 変異 default→"completed" を弁別的に殺す
    await h.close();
  });

  it("terminal-reopen: 同一 provider id が SessionEnd 後に再来 ⇒ synthetic run + resumed_from=親", async () => {
    const h = await harness();
    await h.post({ session_id: P1, hook_event_name: "SessionStart", source: "startup" });
    await h.post({ session_id: P1, hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
    // 同一 provider id が再来 (resume が id を再利用)。
    await h.post({ session_id: P1, hook_event_name: "SessionStart", source: "resume" });
    const rows = h.rows();
    const starts = rows.filter((r) => r.event_type === "session.started");
    expect(starts).toHaveLength(2);
    const child = starts.find((r) => r.session_id !== P1);
    expect(child).toBeDefined();
    expect(child?.session_id).toMatch(/^sess_/); // synthetic (provider id 衝突ゆえ採用不可)
    expect(child?.provider_session_id).toBe(P1); // 再利用された provider id
    expect(child?.resumed_from_session_id).toBe(P1);
    expect(child?.start_kind).toBe("resume");
    // 親 terminal 行は不変 (session.ended は P1 のまま・再オープンしない)。
    const ended = rows.filter((r) => r.event_type === "session.ended");
    expect(ended).toHaveLength(1);
    expect(ended[0]?.session_id).toBe(P1);
    await h.close();
  });
});

describe("INV-ATTACH-CANONICAL-ADVERTISED", () => {
  it("registry.sessionIds() は各 entry の canonical run id を返す (Map key=provider id でなく identity 由来)", async () => {
    const registry = new AttachSessionRegistry({
      onGitEvent: () => {},
      resolveRepoRoot: async () => undefined, // git 起動しない
      reaperIntervalMs: 0,
    });
    const e1 = registry.observeHook(P1);
    registry.observeHook(P2);
    // 初期は canonical === provider id === Map key。
    expect(new Set(registry.sessionIds())).toEqual(new Set([P1, P2]));
    // terminal-reopen で entry の canonical を rotate すると、hello は **canonical (synthetic)** を広告する
    //   (Map key P1 でなく)。sessionIds が Map.keys を返していたら P1 のままで赤化する = falsifiable。
    e1.identity.markRunTerminal();
    const boundary = e1.identity.onHookSession(P1, { source: "resume" });
    expect(boundary.runId).toMatch(/^sess_/);
    expect(new Set(registry.sessionIds())).toEqual(new Set([boundary.runId, P2]));
    expect(registry.sessionIds()).not.toContain(P1); // canonical rotate 後は provider id を広告しない
    await registry.dispose();
  });
});
