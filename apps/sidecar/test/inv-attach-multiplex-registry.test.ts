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
