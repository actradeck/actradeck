/**
 * ADR 019f4206 A段: daemon-addressed Codex spawn relay の INV (backend registry・FakeLink・DB/WS 非依存)。
 *
 * INV-SPAWN-RELAY: `requestCodexSpawnByDaemon(daemonId, params)` は **当該 daemon のみ**へ codex.spawn.request を
 *   送る (token/prompt/cwd/resolve_scope 付与)。`resolveCodexSpawn(frame)` が pending を解決し、失敗 error は
 *   **closed enum へ投影** (未知は spawn_failed)・prompt/cwd を frame に含まない (NO-RAW)。未知 daemonId / 切断は
 *   安全側 reject。
 * INV-SPAWN-CAPABILITY-GATE: `connectedDaemons()` は entry に spawn_capable boolean を併記する。
 * INV-REALTIME-RELAY-SCOPE: daemon-addressed relay は **policy と spawn のみ**。approve/interrupt は依然 session
 *   宛 (relayApproval/relayInterrupt は session_id 引数)・daemon 宛 method は存在しない (型/挙動で固定)。
 *
 * 🔴 mutation: relayCodexSpawnVia を byDaemon.get→先頭 conn すり替えで 2 daemon 構成が RED。
 * 🔴 mutation: resolveCodexSpawn の asCodexSpawnErrorCode を除去し raw error 素通しにすると enum 投影 assert が RED。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SidecarRegistry, type SidecarLink } from "../src/sidecar-registry.js";

class FakeLink implements SidecarLink {
  readonly sent: string[] = [];
  open = true;
  send(data: string): void {
    if (!this.open) throw new Error("closed");
    this.sent.push(data);
  }
}

function spawnReqsOn(link: FakeLink): Array<Record<string, unknown>> {
  return link.sent
    .filter((m) => m.includes('"type":"codex.spawn.request"'))
    .map((m) => JSON.parse(m) as Record<string, unknown>);
}

function helloWith(spawnCapable: boolean, token: string) {
  return {
    type: "hello" as const,
    control_token: token,
    session_ids: [],
    policy_capable: true,
    ...(spawnCapable ? { spawn_capable: true } : {}),
  };
}

describe("ADR 019f4206 daemon-addressed codex spawn relay", () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.useRealTimers());

  it("INV-SPAWN-CAPABILITY-GATE: connectedDaemons が spawn_capable を併記する", () => {
    const reg = new SidecarRegistry();
    const dOn = new FakeLink();
    const dOff = new FakeLink();
    reg.add(dOn);
    reg.add(dOff);
    reg.handleHello(dOn, helloWith(true, "ctl-on"));
    reg.handleHello(dOff, helloWith(false, "ctl-off"));
    const daemons = reg.connectedDaemons();
    expect(daemons).toHaveLength(2);
    const byCap = Object.fromEntries(daemons.map((d) => [d.id, d.spawn_capable]));
    // spawn_capable true/false が正しく反映される (spawn 非対応 daemon は false で UI が除外可能)。
    expect(Object.values(byCap).filter((v) => v === true)).toHaveLength(1);
    expect(Object.values(byCap).filter((v) => v === false)).toHaveLength(1);
  });

  it("INV-SPAWN-RELAY: 当該 daemon のみへ request (prompt/cwd/resolve_scope/token)・他 conn に触れない", async () => {
    const reg = new SidecarRegistry({ spawnTimeoutMs: 1000 });
    const d1 = new FakeLink();
    const d2 = new FakeLink();
    reg.add(d1);
    reg.add(d2);
    reg.handleHello(d1, helloWith(true, "ctl-d1"));
    reg.handleHello(d2, helloWith(true, "ctl-d2"));
    const [id1] = reg.connectedDaemons().map((d) => d.id);

    const p = reg.requestCodexSpawnByDaemon(id1!, {
      prompt: "do the thing",
      cwd: "/repo/a",
      resolveScope: ["/repo"],
    });
    // d1 のみ受信・d2 は無傷 (byDaemon addressing)。
    const reqs1 = spawnReqsOn(d1);
    expect(reqs1).toHaveLength(1);
    expect(spawnReqsOn(d2)).toHaveLength(0);
    const req = reqs1[0]!;
    expect(req.prompt).toBe("do the thing");
    expect(req.cwd).toBe("/repo/a");
    expect(req.resolve_scope).toEqual(["/repo"]);
    expect(req.token).toBe("ctl-d1"); // 当該 conn の controlToken を付与。
    expect(typeof req.request_id).toBe("string");

    // sidecar 応答で pending を解決 (ok + session_id)。
    reg.resolveCodexSpawn({
      request_id: req.request_id as string,
      ok: true,
      session_id: "thread_x",
    });
    await expect(p).resolves.toEqual({ ok: true, session_id: "thread_x" });
    expect(reg.pendingSpawnCount).toBe(0);
  });

  it("INV-SPAWN-RELAY: 失敗応答の error は closed enum へ投影 (未知は spawn_failed・NO-RAW)", async () => {
    const reg = new SidecarRegistry({ spawnTimeoutMs: 1000 });
    const d1 = new FakeLink();
    reg.add(d1);
    reg.handleHello(d1, helloWith(true, "ctl-d1"));
    const id1 = reg.connectedDaemons()[0]!.id;

    // (a) 既知 closed enum はそのまま。
    const p1 = reg.requestCodexSpawnByDaemon(id1, { prompt: "p", cwd: "/r" });
    const rid1 = spawnReqsOn(d1)[0]!.request_id as string;
    reg.resolveCodexSpawn({ request_id: rid1, ok: false, error: "cwd_out_of_scope" });
    await expect(p1).resolves.toEqual({ ok: false, error: "cwd_out_of_scope" });

    // (b) 敵対 daemon の未知 code → spawn_failed へ縮退。
    const p2 = reg.requestCodexSpawnByDaemon(id1, { prompt: "p", cwd: "/r" });
    const rid2 = spawnReqsOn(d1)[1]!.request_id as string;
    reg.resolveCodexSpawn({ request_id: rid2, ok: false, error: "rm -rf / injected" });
    await expect(p2).resolves.toEqual({ ok: false, error: "spawn_failed" });
  });

  it("INV-SPAWN-RELAY: 未知 daemonId / 切断は安全側 reject (任意 conn へ届かない)", async () => {
    const reg = new SidecarRegistry({ spawnTimeoutMs: 1000 });
    const d1 = new FakeLink();
    reg.add(d1);
    reg.handleHello(d1, helloWith(true, "ctl-d1"));
    const id1 = reg.connectedDaemons()[0]!.id;

    await expect(
      reg.requestCodexSpawnByDaemon("00000000-0000-0000-0000-000000000000", {
        prompt: "p",
        cwd: "/r",
      }),
    ).resolves.toEqual({ ok: false, error: "daemon not registered" });

    d1.open = false; // 切断。
    const res = await reg.requestCodexSpawnByDaemon(id1, { prompt: "p", cwd: "/r" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.transient).toBe(true); // transient=timeout/disconnect → HTTP 503。
  });

  it("INV-SPAWN-RELAY: timeout は transient reject し pending を破棄する", async () => {
    vi.useFakeTimers();
    const reg = new SidecarRegistry({ spawnTimeoutMs: 500 });
    const d1 = new FakeLink();
    reg.add(d1);
    reg.handleHello(d1, helloWith(true, "ctl-d1"));
    const id1 = reg.connectedDaemons()[0]!.id;

    const p = reg.requestCodexSpawnByDaemon(id1, { prompt: "p", cwd: "/r" });
    expect(reg.pendingSpawnCount).toBe(1);
    await vi.advanceTimersByTimeAsync(600);
    const res = await p;
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.transient).toBe(true);
    expect(reg.pendingSpawnCount).toBe(0);
  });

  it("INV-REALTIME-RELAY-SCOPE: approve/interrupt は依然 session 宛 (daemon 宛 spawn は独立面)", () => {
    const reg = new SidecarRegistry();
    const d1 = new FakeLink();
    reg.add(d1);
    reg.handleHello(d1, helloWith(true, "ctl-d1"));
    // session を一切登録していないので session-scoped relay は不能 (approve/interrupt は session 宛のまま)。
    expect(reg.relayApproval({ session_id: "s-x", request_id: "r", decision: "deny" }).ok).toBe(
      false,
    );
    expect(reg.relayInterrupt("s-x").ok).toBe(false);
    // 一方 daemon-addressed spawn は owned session ゼロでも relay 可能 (新実行サーフェスは daemon 宛)。
    const id1 = reg.connectedDaemons()[0]!.id;
    void reg.requestCodexSpawnByDaemon(id1, { prompt: "p", cwd: "/r" });
    expect(spawnReqsOn(d1)).toHaveLength(1);
  });
});
