/**
 * TDA-3: 全 sink.emit 経路が event-factory (buildEvent) のデフォルトと一致する。
 *
 * 監査所見: hook-receiver が tool.permission.resolved を手組み NormalizedEvent リテラルで
 * 生成しており (provider/source/timestamp/metrics の重複・drift リスク + cryptoRandomEventId
 * ラッパの再発明)、event-factory を迂回していた。buildEvent に統一したことを固定する。
 *
 * 検証: hook-receiver が emit する resolved イベントが buildEvent と同一の既定
 * (provider=claude_code / source=hooks / metrics={} / UUIDv7 event_id / ISO timestamp) を
 * 持つこと。normalizeHook 由来の全イベントも同様 (buildEvent 経由)。
 */
import { describe, expect, it } from "vitest";

import { isUuidV7 } from "@actradeck/event-model";

import { ApprovalBridge } from "../src/approval-bridge.js";
import { buildEvent } from "../src/event-factory.js";
import { HookReceiver } from "../src/hook-receiver.js";
import { normalizeHook } from "../src/normalize.js";
import { EventSink } from "../src/sink.js";
import { EventStore } from "../src/store.js";
import type { WsClient } from "../src/ws-client.js";

const noopWs = { notifyAppended: () => {} } as unknown as WsClient;

/** buildEvent が全イベントに付与する不変デフォルトの形。 */
function assertFactoryDefaults(ev: Record<string, unknown>): void {
  expect(ev.provider).toBe("claude_code");
  expect(ev.source).toBe("hooks");
  expect(typeof ev.event_id).toBe("string");
  expect(isUuidV7(ev.event_id as string)).toBe(true);
  expect(typeof ev.timestamp).toBe("string");
  expect(new Date(ev.timestamp as string).toISOString()).toBe(ev.timestamp);
  expect(ev.metrics).toBeTypeOf("object");
}

describe("TDA-3: event-factory defaults are consistent across all sink.emit paths", () => {
  it("normalizeHook events all carry buildEvent defaults", () => {
    const inputs = [
      { session_id: "s1", hook_event_name: "SessionStart", source: "startup" },
      { session_id: "s1", hook_event_name: "UserPromptSubmit", prompt: "hi" },
      {
        session_id: "s1",
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      },
      { session_id: "s1", hook_event_name: "Stop" },
    ];
    for (const input of inputs) {
      for (const ev of normalizeHook(input)) {
        assertFactoryDefaults(ev as unknown as Record<string, unknown>);
      }
    }
  });

  it("hook-receiver resolved event matches buildEvent defaults (no hand-built literal drift)", async () => {
    const store = new EventStore(":memory:");
    const sink = new EventSink({ store, wsClient: noopWs });
    const bridge = new ApprovalBridge({ timeoutMs: 1000 });
    const receiver = new HookReceiver({ sink, approvalBridge: bridge });
    const port = await receiver.listen();

    // PermissionRequest を投げ、別経路で UI allow を resolve する。
    const reqPromise = fetch(`http://127.0.0.1:${port}/hook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        session_id: "s1",
        hook_event_name: "PermissionRequest",
        tool_name: "Bash",
        tool_input: { command: "npm install" },
      }),
    });

    // 承認カードが emit されるまで待ち、その request_id を resolve。
    for (let i = 0; i < 50 && bridge.pendingCount === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    // pending の request_id を引き当てる: requested イベントの payload.request_id。
    const requestedRow = store.allRows().find((r) => r.event_type === "tool.permission.requested");
    expect(requestedRow).toBeDefined();
    const reqId = (JSON.parse(requestedRow!.event_json).payload as { request_id: string })
      .request_id;
    expect(bridge.resolve(reqId, "allow", "approved")).toBe(true);

    await reqPromise;
    await receiver.close();

    const resolvedRow = store.allRows().find((r) => r.event_type === "tool.permission.resolved");
    expect(resolvedRow, "resolved event must be persisted").toBeDefined();
    const resolved = JSON.parse(resolvedRow!.event_json) as Record<string, unknown>;
    assertFactoryDefaults(resolved);

    // buildEvent で同じ入力を作ったときの shape と既定キーが一致する (event_id/timestamp 除く)。
    const reference = buildEvent({
      session_id: "s1",
      event_type: "tool.permission.resolved",
      state: "running.tool_preparing",
      summary: "承認 許可",
      payload: { kind: "tool.permission.resolved", decision: "allow" },
    }) as unknown as Record<string, unknown>;
    // `redaction_count` / `redaction_count_by_kind` は buildEvent の構築デフォルトではなく
    // **sink (choke point) が redactDeep 後に付与する観測フィールド** (INV-SECRET-DETECTED-NO-VALUE
    // / 強み(a)③)。よって persist 行 (sink 経由) には載るが buildEvent reference には載らない。
    // キー集合比較からは除外する (buildEvent 統一の不変条件は他の全キーで担保される)。
    const persistedKeys = Object.keys(resolved)
      .filter((k) => k !== "redaction_count" && k !== "redaction_count_by_kind")
      .sort();
    expect(persistedKeys).toEqual(Object.keys(reference).sort());
    expect(resolved.event_type).toBe("tool.permission.resolved");
    expect(resolved.metrics).toEqual({});
    store.close();
  });
});

// --- 再#TDA-4: provider/source は enum 経由で引数化 (codex 前方互換) -----------
describe("再#TDA-4: buildEvent provider/source are enum-parameterized (default claude_code/hooks)", () => {
  it("defaults to claude_code / hooks when not specified (Phase 2 既定)", () => {
    const ev = buildEvent({
      session_id: "s1",
      event_type: "heartbeat",
      payload: { kind: "heartbeat" },
    });
    expect(ev.provider).toBe("claude_code");
    expect(ev.source).toBe("hooks");
  });

  it("accepts codex / app_server via Provider/Source enum (forward-compat)", () => {
    const ev = buildEvent({
      session_id: "s1",
      event_type: "heartbeat",
      provider: "codex",
      source: "app_server",
      payload: { kind: "heartbeat" },
    });
    expect(ev.provider).toBe("codex");
    expect(ev.source).toBe("app_server");
  });
});
