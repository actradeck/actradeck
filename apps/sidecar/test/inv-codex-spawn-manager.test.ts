/**
 * ADR 019f4206 A段: CodexSpawnManager の INV (値ベース deny・封じ込め・cap・NO-RAW・stop 例外)。
 *
 * INV-SPAWN-CWD-CONTAINMENT: 解決済 **物理 git root** が resolveScope 外 (scope-out/symlink/ancestor) → deny
 *   cwd_out_of_scope。git 解決不能 (resolver undefined) も deny。scope 空 (default-off) + 解決可 → allow。
 * INV-SPAWN-CAP: 同時数が cap 超過 → 値ベース spawn_cap_reached (throw しない)。
 * INV-SPAWN-DENY-VALUE-BASED: enabled=false → 値ベース spawn_disabled (start を呼ばない・throw しない)。
 * INV-SPAWN-NO-RAW: 返す CodexSpawnResult に prompt/cwd を構造的に含まない (成功・全 deny とも)。
 * INV-ATTACH-NO-KILL(例外): stop() は **spawn した managed session に限り** true・非所有 id は no-op(false)。
 *
 * REAL DATA ONLY 注記: 本 test は startManagedCodex を fake seam に差し替え、封じ込め/cap/値ベース deny の
 * **manager ロジック**を決定論的に固定する (実 codex 起動と argv 非接触は inv-codex-spawn-jsonrpc が REAL で覆う)。
 */
import { afterEach, describe, expect, it } from "vitest";

import type { ApprovalBridge, RepoScopeResolver } from "../src/approval-bridge.js";
import type { CodexManagedSession, CodexRunnerOptions } from "../src/codex-runner.js";
import { CodexSpawnManager, type CodexSpawnManagerOptions } from "../src/codex-spawn-manager.js";
import type { EventSink } from "../src/sink.js";

const SINK = {} as unknown as EventSink;
const BRIDGE = {} as unknown as ApprovalBridge;

const managers: CodexSpawnManager[] = [];
afterEach(() => {
  for (const m of managers.splice(0)) m.dispose();
});

/** fake startManagedCodex: runnerOpts を捕捉し、identity を learn して active に見せる。 */
function makeFakeStart(captured: CodexRunnerOptions[], opts: { pid?: number } = {}) {
  let n = 0;
  return (runnerOpts: CodexRunnerOptions): CodexManagedSession => {
    captured.push(runnerOpts);
    n += 1;
    // canonical (thread.id) を確定させ activeSessionIds / stop の宛先解決を成立させる。
    runnerOpts.identity.learn(`thread-${n}`);
    return {
      pid: opts.pid ?? 4242,
      exited: new Promise<number>(() => {}), // active に留める (exit しない)。
      threadId: () => `thread-${n}`,
      providerSessionId: () => undefined,
      interrupt: () => {},
      stop: () => {},
      dispose: () => {},
    };
  };
}

/** 常に同じ root を返す resolver (git 解決の代役・物理 root を注入して isPathWithinScope の再照合を試験)。 */
function resolverReturning(root: string | undefined): RepoScopeResolver {
  return async () => (root === undefined ? undefined : { scope: "abc123", label: "repo", root });
}

/**
 * 遅延 resolver: await 窓を作り cap TOCTOU (QA-1) を決定論的に露出させる。3 並行 spawn が全員この await に
 * 滞留する間に予約が効いていなければ全員が cap gate を通過する (旧コードの race)。
 */
function slowResolverReturning(root: string, delayMs: number): RepoScopeResolver {
  return async () => {
    await new Promise((r) => setTimeout(r, delayMs));
    return { scope: "abc123", label: "repo", root };
  };
}

function newManager(over: Partial<CodexSpawnManagerOptions> = {}) {
  const captured: CodexRunnerOptions[] = [];
  const mgr = new CodexSpawnManager({
    sink: SINK,
    approvalBridge: BRIDGE,
    resolveRepoScope: resolverReturning("/allowed/repo"),
    enabled: true,
    startCodex: makeFakeStart(captured),
    ...over,
  });
  managers.push(mgr);
  return { mgr, captured };
}

describe("INV-SPAWN-CWD-CONTAINMENT", () => {
  it("scope-out: 解決済 root が resolveScope 外 → cwd_out_of_scope", async () => {
    const { mgr } = newManager({ resolveRepoScope: resolverReturning("/other/repo") });
    const res = await mgr.handleSpawn({
      prompt: "p",
      cwd: "/other/repo/sub",
      resolveScope: ["/allowed"],
    });
    expect(res).toEqual({ ok: false, error: "cwd_out_of_scope" });
  });

  it("ancestor: 解決済 root が scope の上位 → cwd_out_of_scope", async () => {
    // scope はサブディレクトリ限定だが git root は親 monorepo (ancestor-root が scope を抜ける)。
    const { mgr } = newManager({ resolveRepoScope: resolverReturning("/repo") });
    const res = await mgr.handleSpawn({
      prompt: "p",
      cwd: "/repo/sub",
      resolveScope: ["/repo/sub"],
    });
    expect(res).toEqual({ ok: false, error: "cwd_out_of_scope" });
  });

  it("symlink 脱出: 物理 root が scope 外 → cwd_out_of_scope", async () => {
    // 入力 cwd は scope 内 (lexical) だが symlink 物理解決した root が scope 外 (二段封じ込めの第二段)。
    const { mgr } = newManager({ resolveRepoScope: resolverReturning("/real/elsewhere") });
    const res = await mgr.handleSpawn({
      prompt: "p",
      cwd: "/allowed/link",
      resolveScope: ["/allowed"],
    });
    expect(res).toEqual({ ok: false, error: "cwd_out_of_scope" });
  });

  it("git 解決不能 (非 git) → cwd_out_of_scope (封じ込め不能ゆえ deny)", async () => {
    const { mgr } = newManager({ resolveRepoScope: resolverReturning(undefined) });
    const res = await mgr.handleSpawn({ prompt: "p", cwd: "/tmp/plain", resolveScope: ["/tmp"] });
    expect(res).toEqual({ ok: false, error: "cwd_out_of_scope" });
  });

  it("scope 内 root → 起動 ok (封じ込め通過)", async () => {
    const { mgr, captured } = newManager({ resolveRepoScope: resolverReturning("/allowed/repo") });
    const res = await mgr.handleSpawn({
      prompt: "p",
      cwd: "/allowed/repo",
      resolveScope: ["/allowed"],
    });
    expect(res.ok).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.cwd).toBe("/allowed/repo");
  });

  it("scope 空 (default-off) + 解決可 → 起動 ok (per-repo resolve と同一意味論)", async () => {
    const { mgr } = newManager({ resolveRepoScope: resolverReturning("/any/repo") });
    const res = await mgr.handleSpawn({ prompt: "p", cwd: "/any/repo", resolveScope: [] });
    expect(res.ok).toBe(true);
  });
});

describe("INV-SPAWN-CAP", () => {
  it("cap 超過は値ベース spawn_cap_reached (throw しない)", async () => {
    const { mgr, captured } = newManager({ spawnMax: 1 });
    const first = await mgr.handleSpawn({
      prompt: "p1",
      cwd: "/allowed/a",
      resolveScope: ["/allowed"],
    });
    expect(first.ok).toBe(true);
    const second = await mgr.handleSpawn({
      prompt: "p2",
      cwd: "/allowed/b",
      resolveScope: ["/allowed"],
    });
    expect(second).toEqual({ ok: false, error: "spawn_cap_reached" });
    expect(captured).toHaveLength(1); // 2 本目は start に到達しない。
    expect(mgr.activeCount).toBe(1);
  });
});

describe("INV-SPAWN-CAP (concurrent hard-cap・QA-1)", () => {
  it("並行 spawn は cap を突破しない (spawnMax=1 + slow resolver + 3 並行 → ok は 1 のみ・active=1)", async () => {
    // 旧コードは cap 判定を await 前・active.add を await 後に置いたため、slow resolver で await 窓を作ると
    // 3 並行 spawn が全員 cap gate (active.size=0) を通過し 3 起動していた (この test が RED で暴く)。修正後は
    // 予約を await 前に置き「active + 予約中」で判定するため 1 本のみ通過する。
    const { mgr, captured } = newManager({
      spawnMax: 1,
      resolveRepoScope: slowResolverReturning("/allowed/repo", 20),
    });
    const results = await Promise.all([
      mgr.handleSpawn({ prompt: "p1", cwd: "/allowed/a", resolveScope: ["/allowed"] }),
      mgr.handleSpawn({ prompt: "p2", cwd: "/allowed/b", resolveScope: ["/allowed"] }),
      mgr.handleSpawn({ prompt: "p3", cwd: "/allowed/c", resolveScope: ["/allowed"] }),
    ]);
    const ok = results.filter((r) => r.ok);
    expect(ok).toHaveLength(1); // 並行でも 1 本のみ起動 (cap hard-cap)。
    for (const r of results) {
      if (!r.ok) expect(r.error).toBe("spawn_cap_reached"); // 残りは値ベース deny (throw しない)。
    }
    expect(captured).toHaveLength(1); // start に到達したのは 1 本のみ。
    expect(mgr.activeCount).toBe(1);
  });

  it("deny 経路で予約スロットが解放される (deny 後に cap で詰まらず再 spawn 可能)", async () => {
    // spawnMax=1・resolver は scope 外 root を返す。1 回目は cwd_out_of_scope deny。予約が finally で解放され
    // なければ reserved が 1 のまま残り、2 回目が spawn_cap_reached で詰まる (この test が回帰を固定する)。
    const { mgr } = newManager({ spawnMax: 1, resolveRepoScope: resolverReturning("/other/repo") });
    const denied = await mgr.handleSpawn({
      prompt: "p",
      cwd: "/other/repo",
      resolveScope: ["/allowed"],
    });
    expect(denied).toEqual({ ok: false, error: "cwd_out_of_scope" });
    expect(mgr.activeCount).toBe(0);
    // 2 回目: 予約解放済ゆえ cap に達さず、scope 空 (default-off) で封じ込め通過 → ok。
    const ok = await mgr.handleSpawn({ prompt: "p2", cwd: "/other/repo", resolveScope: [] });
    expect(ok.ok).toBe(true);
    expect(mgr.activeCount).toBe(1);
  });
});

describe("INV-SPAWN-DENY-VALUE-BASED (disabled)", () => {
  it("enabled=false → spawn_disabled・start を呼ばない・throw しない", async () => {
    const captured: CodexRunnerOptions[] = [];
    const mgr = new CodexSpawnManager({
      sink: SINK,
      approvalBridge: BRIDGE,
      resolveRepoScope: resolverReturning("/allowed/repo"),
      enabled: false,
      startCodex: makeFakeStart(captured),
    });
    managers.push(mgr);
    const res = await mgr.handleSpawn({
      prompt: "p",
      cwd: "/allowed/repo",
      resolveScope: ["/allowed"],
    });
    expect(res).toEqual({ ok: false, error: "spawn_disabled" });
    expect(captured).toHaveLength(0);
  });
});

describe("INV-SPAWN-NO-RAW (result)", () => {
  it("成功・全 deny の CodexSpawnResult に prompt/cwd を含まない", async () => {
    const secretPrompt = "SPAWN_SENTINEL_PROMPT_zzz";
    const secretCwd = "/allowed/SPAWN_SENTINEL_CWD_zzz";
    const cases = [
      // 成功。
      await newManager().mgr.handleSpawn({
        prompt: secretPrompt,
        cwd: secretCwd,
        resolveScope: ["/allowed"],
      }),
      // scope-out deny。
      await newManager({ resolveRepoScope: resolverReturning("/x") }).mgr.handleSpawn({
        prompt: secretPrompt,
        cwd: secretCwd,
        resolveScope: ["/allowed"],
      }),
      // disabled deny。
      await new CodexSpawnManager({
        sink: SINK,
        approvalBridge: BRIDGE,
        resolveRepoScope: resolverReturning("/allowed/repo"),
        enabled: false,
      }).handleSpawn({ prompt: secretPrompt, cwd: secretCwd, resolveScope: ["/allowed"] }),
    ];
    for (const res of cases) {
      const json = JSON.stringify(res);
      expect(json).not.toContain("SPAWN_SENTINEL_PROMPT");
      expect(json).not.toContain("SPAWN_SENTINEL_CWD");
    }
  });
});

describe("INV-ATTACH-NO-KILL (spawn 例外)", () => {
  it("stop() は spawn した managed session のみ true・非所有 id は no-op(false)", async () => {
    const { mgr } = newManager();
    await mgr.handleSpawn({ prompt: "p", cwd: "/allowed/repo", resolveScope: ["/allowed"] });
    expect(mgr.activeSessionIds()).toEqual(["thread-1"]);
    expect(mgr.stop("thread-1")).toBe(true); // 所有する spawned session → stop 可。
    expect(mgr.stop("some-attach-session")).toBe(false); // 非所有 → no-op (kill しない)。
  });
});
