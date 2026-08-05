/**
 * INV-ATTACH-MULTIPLEX (registry 純ロジック) — ADR 019ea476 D6。
 *
 * AttachSessionRegistry は session_id ごとに独立した SessionIdentity / cwd / GitWatcher を持つ。
 * 2 つの異なる session_id の hook が来ても相互汚染しない (片方の cwd/git が他方に混ざらない)。
 * mutation: registry を単一 session 上書きにすると 2 番目で 1 番目が消え赤化する。
 */
import { describe, expect, it, vi } from "vitest";

import { AttachSessionRegistry } from "../src/attach-session-registry.js";
import type { GitWatcher } from "../src/git-watcher.js";
import type { SessionIdentity } from "../src/session-identity.js";

/** GitWatcher を spawn しない fake (per-session に生成されることだけ確認)。 */
function fakeGitWatcher(): GitWatcher {
  return {
    start: vi.fn(),
    stop: vi.fn(async () => undefined),
    captureAndEmit: vi.fn(async () => undefined),
  } as unknown as GitWatcher;
}

describe("INV-ATTACH-MULTIPLEX (registry)", () => {
  it("two session_ids → two independent identities + cwds (no cross-contamination)", async () => {
    const created: Array<{ repoRoot: string; identity: SessionIdentity }> = [];
    const reg = new AttachSessionRegistry({
      onGitEvent: () => undefined,
      resolveRepoRoot: async (cwd) => cwd, // cwd をそのまま repo root に。
      makeGitWatcher: (args) => {
        created.push({ repoRoot: args.repoRoot, identity: args.identity });
        return fakeGitWatcher();
      },
    });

    const a = reg.observeHook("sessA", "/repo/a");
    const b = reg.observeHook("sessB", "/repo/b");

    // 独立 entry (mutation: 単一上書きなら size=1 で赤化)。
    expect(reg.size).toBe(2);
    expect(a.identity).not.toBe(b.identity);
    expect(reg.get("sessA")?.cwd).toBe("/repo/a");
    expect(reg.get("sessB")?.cwd).toBe("/repo/b");
    // canonical は各自の session_id で即確定 (explicitSessionId, hold 最小)。
    expect(a.identity.currentSessionId()).toBe("sessA");
    expect(b.identity.currentSessionId()).toBe("sessB");

    // GitWatcher は repo root 解決後に per-session 生成される (非同期 microtask 待ち)。
    await Promise.resolve();
    await Promise.resolve();
    expect(created.map((c) => c.repoRoot).sort()).toEqual(["/repo/a", "/repo/b"]);

    expect(reg.sessionIds().sort()).toEqual(["sessA", "sessB"]);
    await reg.dispose();
  });

  it("re-observing the same session updates lastHookAt, not a new entry (idempotent)", () => {
    const reg = new AttachSessionRegistry({ onGitEvent: () => undefined });
    const first = reg.observeHook("sessA", "/repo/a");
    const t1 = first.lastHookAt;
    const second = reg.observeHook("sessA", "/repo/other");
    expect(reg.size).toBe(1);
    expect(second).toBe(first); // 同一 entry
    expect(second.cwd).toBe("/repo/a"); // 初出 cwd を保持 (上書きしない)
    expect(second.lastHookAt).toBeGreaterThanOrEqual(t1);
  });

  it("reap(SessionEnd) stops the GitWatcher, removes the session, fires onChange (INV-ATTACH-REAP)", async () => {
    let changes = 0;
    const watchers: GitWatcher[] = [];
    const reg = new AttachSessionRegistry({
      onGitEvent: () => undefined,
      onChange: () => {
        changes += 1;
      },
      reaperIntervalMs: 0, // 自動 sweep を切り手動制御。
      resolveRepoRoot: async (cwd) => cwd,
      makeGitWatcher: () => {
        const w = fakeGitWatcher();
        watchers.push(w);
        return w;
      },
    });
    reg.observeHook("sessA", "/repo/a");
    await Promise.resolve();
    await Promise.resolve();
    expect(reg.size).toBe(1);

    reg.reap("sessA");
    expect(reg.size).toBe(0);
    expect(reg.get("sessA")).toBeUndefined();
    expect(changes).toBe(1);
    expect(watchers[0]!.stop).toHaveBeenCalled();
    await reg.dispose();
  });

  it("reap of an unknown session is a no-op (no onChange)", () => {
    let changes = 0;
    const reg = new AttachSessionRegistry({
      onGitEvent: () => undefined,
      onChange: () => {
        changes += 1;
      },
      reaperIntervalMs: 0,
    });
    reg.reap("does-not-exist");
    expect(changes).toBe(0);
  });

  it("reapIdle reaps sessions past idleTtlMs, keeps fresh, fires onChange once (idle backstop)", async () => {
    let changes = 0;
    const stopped: string[] = [];
    const reg = new AttachSessionRegistry({
      onGitEvent: () => undefined,
      onChange: () => {
        changes += 1;
      },
      idleTtlMs: 1_000,
      reaperIntervalMs: 0,
      resolveRepoRoot: async (cwd) => cwd,
      makeGitWatcher: (args) => {
        const w = fakeGitWatcher();
        (w.stop as ReturnType<typeof vi.fn>).mockImplementation(async () => {
          stopped.push(args.repoRoot);
        });
        return w;
      },
    });
    reg.observeHook("sessOld", "/repo/old");
    reg.observeHook("sessNew", "/repo/new");
    await Promise.resolve();
    await Promise.resolve();
    // 決定論: lastHookAt を直接設定 (real clock の ms 揺れに依存しない)。
    reg.get("sessOld")!.lastHookAt = 1;
    reg.get("sessNew")!.lastHookAt = 1_000_000;

    reg.reapIdle(1_000_000); // now=1e6: sessOld は 1e6-1>1000 で stale、sessNew は 0<=1000 で fresh。
    expect(reg.sessionIds()).toEqual(["sessNew"]);
    expect(changes).toBe(1); // 変化 1 回ぶんだけ発火。
    expect(stopped).toEqual(["/repo/old"]); // 古い session の watcher のみ停止 (GitWatcher 幻 diff を止める)。
    await reg.dispose();
  });

  it("reapIdle keeps a session exactly at the idle-TTL boundary, reaps just past it (> not >=)", async () => {
    // QA-1 (ADR 019eb448): 判定は `nowMs - lastHookAt > idleTtlMs` の **厳密 >**。
    // ちょうど境界 (経過 === idleTtlMs) は reap しない、1ms 超で reap する、を pin する。
    // mutation: 実装の `>` を `>=` に変えると sessAt も reap され赤化する (境界の真ゲート)。
    const reg = new AttachSessionRegistry({
      onGitEvent: () => undefined,
      idleTtlMs: 1_000,
      reaperIntervalMs: 0,
      resolveRepoRoot: async (cwd) => cwd,
      makeGitWatcher: () => fakeGitWatcher(),
    });
    reg.observeHook("sessAt", "/repo/at");
    reg.observeHook("sessPast", "/repo/past");
    await Promise.resolve();
    await Promise.resolve();
    const now = 1_000_000;
    reg.get("sessAt")!.lastHookAt = now - 1_000; // 経過 === idleTtlMs ちょうど → reap しない。
    reg.get("sessPast")!.lastHookAt = now - 1_001; // 経過 > idleTtlMs → reap する。

    reg.reapIdle(now);
    expect(reg.sessionIds()).toEqual(["sessAt"]); // 境界等値は生存、超過のみ掃除。
    expect(reg.get("sessPast")).toBeUndefined();
    await reg.dispose();
  });

  it("reapIdle then re-observe self-heals: new entry + GitWatcher restart + re-announced (QA-2)", async () => {
    // QA-2 (ADR 019eb448): idle 誤 reap は次 hook で self-heal する。idle-TTL は backstop で
    // liveness 非依存ゆえ正常 long-idle を誤 reap しうるが、復帰経路が壊れていないことを pin する。
    let changes = 0;
    const watchers: GitWatcher[] = [];
    const reg = new AttachSessionRegistry({
      onGitEvent: () => undefined,
      onChange: () => {
        changes += 1;
      },
      idleTtlMs: 1_000,
      reaperIntervalMs: 0,
      resolveRepoRoot: async (cwd) => cwd,
      makeGitWatcher: () => {
        const w = fakeGitWatcher();
        watchers.push(w);
        return w;
      },
    });
    const first = reg.observeHook("sessA", "/repo/a");
    await Promise.resolve();
    await Promise.resolve();
    reg.get("sessA")!.lastHookAt = 1; // idle 超過を模す → 誤 reap。
    reg.reapIdle(1_000_000);
    expect(reg.size).toBe(0);
    expect(changes).toBe(1);

    // 次 hook で self-heal: 別 entry・別 identity・GitWatcher 再起動・sessionIds 復帰 (reannounce 対象)。
    const healed = reg.observeHook("sessA", "/repo/a");
    await Promise.resolve();
    await Promise.resolve();
    expect(reg.size).toBe(1);
    expect(healed).not.toBe(first);
    expect(healed.identity).not.toBe(first.identity);
    expect(reg.sessionIds()).toEqual(["sessA"]);
    expect(watchers.length).toBe(2); // 初回 + self-heal で 2 本生成。
    await reg.dispose();
  });

  it("reap twice is idempotent: second reap is a no-op and fires onChange once (QA-3)", async () => {
    let changes = 0;
    const reg = new AttachSessionRegistry({
      onGitEvent: () => undefined,
      onChange: () => {
        changes += 1;
      },
      reaperIntervalMs: 0,
      resolveRepoRoot: async (cwd) => cwd,
      makeGitWatcher: () => fakeGitWatcher(),
    });
    reg.observeHook("sessA", "/repo/a");
    await Promise.resolve();
    await Promise.resolve();
    reg.reap("sessA");
    reg.reap("sessA"); // 2 回目は未知 session = no-op (onChange 再発火しない)。
    expect(changes).toBe(1);
    expect(reg.size).toBe(0);
    await reg.dispose();
  });

  it("after dispose, a late hook is ephemeral (no entry) and reapIdle early-returns (QA-3)", async () => {
    let changes = 0;
    const reg = new AttachSessionRegistry({
      onGitEvent: () => undefined,
      onChange: () => {
        changes += 1;
      },
      reaperIntervalMs: 0,
    });
    await reg.dispose();
    const late = reg.observeHook("sessLate", "/repo/late");
    expect(late.identity.currentSessionId()).toBe("sessLate"); // ephemeral でも canonical は返す。
    expect(reg.size).toBe(0); // dispose 後は entry を作らない (副作用なし)。
    expect(reg.get("sessLate")).toBeUndefined();
    reg.reapIdle(Number.MAX_SAFE_INTEGER); // disposed なら早期 return。
    expect(changes).toBe(0); // onChange 一切発火しない。
  });

  it("dispose stops all watchers and clears sessions", async () => {
    const watchers: GitWatcher[] = [];
    const reg = new AttachSessionRegistry({
      onGitEvent: () => undefined,
      resolveRepoRoot: async (cwd) => cwd,
      makeGitWatcher: () => {
        const w = fakeGitWatcher();
        watchers.push(w);
        return w;
      },
    });
    reg.observeHook("sessA", "/repo/a");
    await Promise.resolve();
    await Promise.resolve();
    await reg.dispose();
    expect(reg.size).toBe(0);
    for (const w of watchers) expect(w.stop).toHaveBeenCalled();
  });
});

describe("INV-RUN-LINEAGE-EDGE: terminal tombstone (reap 跨ぎ親相関・decision 019fd2ac ①)", () => {
  /** terminal 化した session を作って reap するヘルパ。 */
  function observeTerminalAndReap(reg: AttachSessionRegistry, sid: string): string {
    const s = reg.observeHook(sid, undefined, true);
    s.identity.onHookSession(sid, { isSessionStart: true, source: "startup" });
    s.identity.markRunTerminal();
    const runId = s.identity.currentRunId();
    reg.reap(sid);
    return runId;
  }

  it("SessionEnd reap → 同一 id の SessionStart 再来は terminal-reopen (synthetic run + resumed_from=旧 run)", () => {
    const reg = new AttachSessionRegistry({ onGitEvent: () => undefined, reaperIntervalMs: 0 });
    const priorRunId = observeTerminalAndReap(reg, "sessA");
    expect(reg.terminalTombstoneCount).toBe(1);

    const revived = reg.observeHook("sessA", undefined, true);
    const r = revived.identity.onHookSession("sessA", { isSessionStart: true, source: "resume" });
    expect(r.boundary).toBe(true);
    expect(r.runId).toMatch(/^sess_/);
    expect(r.runId).not.toBe(priorRunId);
    expect(r.startKind).toBe("resume");
    expect(r.resumedFrom).toBe(priorRunId);
    // consume-once: tombstone は消費済み。
    expect(reg.terminalTombstoneCount).toBe(0);
    // hello は新 run id を広告する (旧 terminal run id を再広告しない)。
    expect(reg.sessionIds()).toEqual([r.runId]);
  });

  it("非 SessionStart の straggler hook は tombstone を consume せず従来どおり同一 id へ fold する", () => {
    const reg = new AttachSessionRegistry({ onGitEvent: () => undefined, reaperIntervalMs: 0 });
    observeTerminalAndReap(reg, "sessA");

    // straggler (PostToolUse 等): isSessionStart=false → 通常の explicit gen0 (同一 id fold・sanction 済)。
    const straggler = reg.observeHook("sessA", undefined, false);
    const r = straggler.identity.onHookSession("sessA", {});
    expect(r.boundary).toBe(false);
    expect(r.runId).toBe("sessA");
    expect(r.resumedFrom).toBeUndefined();
    // tombstone は温存 (consume していない)。
    expect(reg.terminalTombstoneCount).toBe(1);
  });

  it("idle reap (非 terminal) は tombstone を記録しない (self-heal 意味論を不変に保つ)", () => {
    const reg = new AttachSessionRegistry({
      onGitEvent: () => undefined,
      reaperIntervalMs: 0,
      idleTtlMs: 10,
    });
    const s = reg.observeHook("sessA", undefined, true);
    s.identity.onHookSession("sessA", { isSessionStart: true, source: "startup" });
    reg.reapIdle(Date.now() + 60_000);
    expect(reg.size).toBe(0);
    expect(reg.terminalTombstoneCount).toBe(0);

    // 再来は self-heal: 同一 id で同一 run 継続 (lineage を主張しない)。
    const healed = reg.observeHook("sessA", undefined, true);
    const r = healed.identity.onHookSession("sessA", { isSessionStart: true, source: "startup" });
    expect(r.boundary).toBe(false);
    expect(r.runId).toBe("sessA");
    expect(r.resumedFrom).toBeUndefined();
  });

  it("tombstone は bounded LRU (上限超過で最古を evict・無界に積まない)", async () => {
    const { TERMINAL_TOMBSTONE_MAX_ENTRIES } = await import("../src/attach-session-registry.js");
    const reg = new AttachSessionRegistry({ onGitEvent: () => undefined, reaperIntervalMs: 0 });
    for (let i = 0; i < TERMINAL_TOMBSTONE_MAX_ENTRIES + 10; i++) {
      observeTerminalAndReap(reg, `sess-${i}`);
    }
    expect(reg.terminalTombstoneCount).toBe(TERMINAL_TOMBSTONE_MAX_ENTRIES);
    // 最古 (sess-0) は evict 済み → 再来しても lineage を主張しない (gen0 fold)。
    const oldest = reg.observeHook("sess-0", undefined, true);
    const r = oldest.identity.onHookSession("sess-0", { isSessionStart: true, source: "resume" });
    expect(r.resumedFrom).toBeUndefined();
  });

  it("多重 reopen はチェーンを張る (run1 → run2 → run3・tombstone は最新 run を指す)", () => {
    const reg = new AttachSessionRegistry({ onGitEvent: () => undefined, reaperIntervalMs: 0 });
    const run1 = observeTerminalAndReap(reg, "sessA");

    // 1 回目の reopen: run2 (synthetic) が run1 を親に持つ。
    const second = reg.observeHook("sessA", undefined, true);
    const r2 = second.identity.onHookSession("sessA", { isSessionStart: true, source: "resume" });
    expect(r2.resumedFrom).toBe(run1);
    second.identity.markRunTerminal();
    reg.reap("sessA");

    // 2 回目の reopen: run3 は run2 (最新) を親に持つ (run1 でなく)。
    const third = reg.observeHook("sessA", undefined, true);
    const r3 = third.identity.onHookSession("sessA", { isSessionStart: true, source: "resume" });
    expect(r3.resumedFrom).toBe(r2.runId);
    expect(r3.runId).not.toBe(r2.runId);
  });
});
