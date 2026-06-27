/**
 * INV-CODEX-E2E — 実 codex app-server を spawn して handshake → notification → 正規化 →
 * sink (実 EventStore) を貫通させる (REAL DATA ONLY, ADR 019ea31b (g))。
 *
 * mock 無し: 実 `codex app-server` 子プロセスを startManagedCodex で起動し、
 * initialize → initialized → thread/start → (turn/start) → 実 notification (thread/started 等) を
 * 受信 → normalize-codex → EventSink(redactDeep) → SQLite を実走で固定する。
 *
 * 偽緑防止: codex 未到達は describe.skipIf で skip するが、CI では実走必須
 * (process.env.CI === "true" かつ未到達なら hard-fail)。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { ApprovalBridge } from "../src/approval-bridge.js";
import { startManagedCodex } from "../src/codex-runner.js";
import { SessionIdentity } from "../src/session-identity.js";
import { EventSink } from "../src/sink.js";
import { EventStore } from "../src/store.js";
import type { WsClient } from "../src/ws-client.js";

const CODEX_BIN = process.env.ACTRADECK_CODEX_BIN ?? "codex";

/** codex バイナリが実在し app-server を持つか (skipIf 用)。 */
function codexReachable(): boolean {
  try {
    const out = execFileSync(CODEX_BIN, ["--version"], { encoding: "utf8", timeout: 10_000 });
    return /codex/i.test(out);
  } catch {
    return false;
  }
}

const reachable = codexReachable();

// 偽緑防止: CI では実 codex 必須。未到達で無音 skip すると Codex 連携 (load-bearing) を
// 検証しないまま緑になる。ただし PUBLIC OSS CI は codex バイナリ + 認証を供給できないため
// ACTRADECK_SKIP_REAL_BIN_E2E=1 を明示設定して graceful skip にオプトアウトする (ci.yml で明示)。
// バイナリを持つ private/fork CI は既定どおり fail-loud のまま。
if (process.env.CI === "true" && !reachable && process.env.ACTRADECK_SKIP_REAL_BIN_E2E !== "1") {
  throw new Error(
    `CI requires a reachable codex binary for INV-CODEX-E2E (ACTRADECK_CODEX_BIN=${CODEX_BIN}). ` +
      "Install codex-cli or set ACTRADECK_CODEX_BIN (or set ACTRADECK_SKIP_REAL_BIN_E2E=1 to skip).",
  );
}

describe.skipIf(!reachable)("INV-CODEX-E2E: real codex app-server handshake → sink", () => {
  let store: EventStore;
  let sink: EventSink;
  let identity: SessionIdentity;
  const cleanups: Array<() => Promise<void> | void> = [];

  beforeAll(() => {
    // no-op (per-test rig).
  });

  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  function makeRig(initialPrompt?: string) {
    const dir = mkdtempSync(join(tmpdir(), "codex-e2e-"));
    store = new EventStore(join(dir, "sidecar.db"));
    const wsClient = { notifyAppended: () => {} } as unknown as WsClient;
    sink = new EventSink({ store, wsClient });
    identity = new SessionIdentity({ fallbackSessionId: "sess_e2e", flushTimeoutMs: 0 });
    const approvalBridge = new ApprovalBridge({ timeoutMs: 1000 });
    const diagnostics: string[] = [];
    const session = startManagedCodex({
      sink,
      approvalBridge,
      identity,
      codexBin: CODEX_BIN,
      heartbeatMs: 2000,
      ...(initialPrompt !== undefined ? { initialPrompt } : {}),
      onDiagnostic: (m) => diagnostics.push(m),
    });
    cleanups.push(async () => {
      session.stop("SIGTERM");
      await session.exited.catch(() => 0);
      session.dispose();
      store.close();
    });
    return { session, diagnostics };
  }

  // 実プロセス spawn は並列テスト負荷下で起動が遅延しうる。E2E は寛容な待機にする
  // (codex 起動 + mcpServer 初期化が full-suite 並列で 15s を超えうるため 25s)。
  async function waitFor(pred: () => boolean, ms = 25_000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (pred()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return pred();
  }

  it("initialize → thread/start resolves canonical=thread.id (UUID) and emits session.started", async () => {
    const rig = makeRig();

    // 権威シグナルは session.threadId() (thread/start Response 成功でのみ set)。
    // identity.isResolved() のタイミングに依存せず handshake 完了を待つ (並列負荷耐性)。
    const gotThread = await waitFor(() => rig.session.threadId() !== undefined);
    expect(gotThread).toBe(true);
    const canonical = rig.session.threadId();
    expect(canonical).toBeDefined();
    // 実 codex の thread.id は UUIDv7 形。
    expect(canonical).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    // canonical=thread.id が SessionIdentity に learn-once で確定している。
    expect(identity.resolvedSessionId()).toBe(canonical);
    expect(rig.session.providerSessionId()).toBeDefined();

    // thread/started notification → session.started が persist されるまで待つ。
    const gotStarted = await waitFor(() =>
      store.allRows().some((r) => r.event_type === "session.started"),
    );
    expect(gotStarted).toBe(true);

    // 全 persist 行が provider=codex / source=app_server / canonical session_id。
    const rows = store.allRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const ev = JSON.parse(row.event_json) as {
        provider: string;
        source: string;
        session_id: string;
        provider_session_id?: string;
      };
      expect(ev.provider).toBe("codex");
      expect(ev.source).toBe("app_server");
      expect(ev.session_id).toBe(canonical);
      expect(row.session_id).toBe(canonical);
    }
  }, 40_000);

  it("MVP-excluded notifications (mcpServer/* etc.) are dropped (no spurious events)", async () => {
    const rig = makeRig();
    await waitFor(() => rig.session.threadId() !== undefined);
    // 実 codex は起動時に mcpServer/startupStatus/updated 等を流す (probe 確認済)。
    // これらが drop され、未対応 method が event 化していないことを確認する。
    // session.started が persist されるまで待ってから走査する (固定 sleep の flake を避ける)。
    await waitFor(() => store.allRows().some((r) => r.event_type === "session.started"));
    await new Promise((r) => setTimeout(r, 800)); // mcpServer 通知が流れる猶予 (drop 確認用)。
    const types = new Set(store.allRows().map((r) => r.event_type));
    // 既知の正規化済み type のみ (mcpServer/remoteControl 由来の偽イベントは無い)。
    for (const t of types) {
      expect(t).not.toContain("mcpServer");
      expect(t).not.toContain("remoteControl");
      expect(t).not.toContain("startupStatus");
    }
    // session.started は出ている (handshake が成立した証跡)。
    expect(types.has("session.started")).toBe(true);
  }, 40_000);

  it("AGG-2: real codex SIGTERM exit emits session.ended (child OS exit is terminal source)", async () => {
    const rig = makeRig();
    await waitFor(() => rig.session.threadId() !== undefined);
    await waitFor(() => store.allRows().some((r) => r.event_type === "session.started"));
    // 実 probe 確認: codex は SIGTERM 時 thread/closed も process/exited も emit しない。
    // child OS exit が唯一の終端源 → session.ended が出ること (AGG-2)。
    rig.session.stop("SIGTERM");
    await rig.session.exited.catch(() => 0);
    const got = await waitFor(
      () => store.allRows().some((r) => r.event_type === "session.ended"),
      10_000,
    );
    expect(got).toBe(true);
    const ended = store.allRows().filter((r) => r.event_type === "session.ended");
    expect(ended.length).toBe(1); // idempotent (二重に出ない)
  }, 40_000);
});
