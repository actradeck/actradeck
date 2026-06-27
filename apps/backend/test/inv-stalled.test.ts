/**
 * INV-STALLED (P0, testing.md / plan.md §5 / §17 / §18)。
 *
 * Server-side liveness 合成の不変条件 (純関数・決定論):
 *  1. **単一シグナルが古いだけでは stalled を断定しない**。process が古くても他シグナルが
 *     新しければ live (作業継続中)。
 *  2. stalled 候補は「観測できた全シグナルが古い」**かつ** process 消滅確定 (alive=false) のみ。
 *  3. 観測シグナル 0 件なら unknown (証拠なしに停止断定しない)。
 *  4. 根拠 (各 age と fresh) を evidence に分解保持する (plan.md §17: process/stdout/event/model
 *     stream を分けて表示)。
 *  5. plan.md §17: 60s で stalled 候補 (DEFAULT_STALE_MS)。
 *
 * memory `redaction-redos-and-real-test-gates` 教訓2: 延期 (it.fails/skip 偽装) でなく
 * 通常の it() で赤→緑をゲートし、**誤実装 (単一シグナル断定) を注入したら赤になる**ことを実証。
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_STALE_MS, observeFromEvents, synthesizeLiveness } from "../src/liveness.js";
import { iso, makeEvent } from "./helpers.js";

const NOW = 1_900_000_000_000; // 固定基準時刻 (epoch ms)。

describe("INV-STALLED: single stale signal must NOT assert stalled", () => {
  it("(a) process stale but stdout fresh ⇒ live (single signal does not decide)", () => {
    const r = synthesizeLiveness(
      {
        process: { alive: true, atMs: NOW - 90_000 }, // process heartbeat 古い
        stdout: { atMs: NOW - 500 }, // しかし stdout は新しい
      },
      { nowMs: NOW },
    );
    expect(r.state).not.toBe("stalled");
    expect(r.state).toBe("live");
  });

  it("(b) all signals stale AND process confirmed dead ⇒ stalled candidate", () => {
    const r = synthesizeLiveness(
      {
        process: { alive: false, atMs: NOW - 120_000 },
        event: { atMs: NOW - 120_000 },
        stdout: { atMs: NOW - 120_000 },
        modelStream: { atMs: NOW - 120_000 },
      },
      { nowMs: NOW },
    );
    expect(r.state).toBe("stalled");
    expect(r.stalledSuspected).toBe(true);
    expect(r.reason).toMatch(/not alive|stale|dead/i);
  });

  it("(b') all signals stale but process NOT confirmed dead ⇒ idle, not stalled (no over-assertion)", () => {
    const r = synthesizeLiveness(
      {
        process: { alive: true, atMs: NOW - 120_000 },
        event: { atMs: NOW - 120_000 },
        stdout: { atMs: NOW - 120_000 },
      },
      { nowMs: NOW },
    );
    expect(r.state).not.toBe("stalled"); // 停止と言い切らない
    expect(r.state).toBe("idle");
  });

  it("(c) evidence decomposes each signal's age (explainable)", () => {
    const r = synthesizeLiveness(
      {
        process: { alive: true, atMs: NOW - 9_000 },
        stdout: { atMs: NOW - 500 },
        modelStream: { atMs: NOW - 3_000 },
      },
      { nowMs: NOW },
    );
    expect(r.evidence.process?.ageMs).toBe(9_000);
    expect(r.evidence.stdout?.ageMs).toBe(500);
    expect(r.evidence.modelStream?.ageMs).toBe(3_000);
    expect(r.evidence.process?.alive).toBe(true);
  });

  it("no observed signals ⇒ unknown (never asserts stopped without evidence)", () => {
    const r = synthesizeLiveness({}, { nowMs: NOW });
    expect(r.state).toBe("unknown");
  });

  it("plan §17: 60s staleness threshold gates stalled vs live (activity freshness)", () => {
    expect(DEFAULT_STALE_MS).toBe(60_000);
    // process は消滅確定 (alive=false)。stdout の鮮度が 60s 閾値の境界。
    // 59s: stdout はまだ fresh → 単一の dead process では断定せず live。
    const justUnder = synthesizeLiveness(
      { process: { alive: false, atMs: NOW - 90_000 }, stdout: { atMs: NOW - 59_000 } },
      { nowMs: NOW },
    );
    expect(justUnder.state).not.toBe("stalled"); // stdout fresh → live
    expect(justUnder.state).toBe("live");
    // 61s: stdout も stale + process dead → stalled 候補。
    const over = synthesizeLiveness(
      { process: { alive: false, atMs: NOW - 90_000 }, stdout: { atMs: NOW - 61_000 } },
      { nowMs: NOW },
    );
    expect(over.state).toBe("stalled");
  });

  it("a dead process with no other signals is stalled regardless of age (confirmed dead)", () => {
    // 消滅確定の process は唯一のシグナルでも stalled。これは「単一シグナル断定」ではなく
    // 「観測できた全 (=1) シグナルが活動なし + 消滅確定」のケース (over-assertion ではない)。
    const r = synthesizeLiveness({ process: { alive: false, atMs: NOW - 1_000 } }, { nowMs: NOW });
    expect(r.state).toBe("stalled");
  });
});

describe("INV-STALLED: injected naive single-signal synthesizer is REJECTED", () => {
  it("naive 'process old ⇒ stalled' misimpl fails the invariant; correct impl passes", () => {
    // 単一シグナル (process age) だけで停止断定する誤実装 (検証者が注入する反例)。
    const naive = (s: {
      process?: { ageMs: number };
      stdout?: { ageMs: number };
    }): { state: string } => {
      if (s.process && s.process.ageMs > 5_000) return { state: "stalled" }; // ← 誤り
      return { state: "live" };
    };
    const naiveInput = { process: { ageMs: 90_000 }, stdout: { ageMs: 500 } };
    expect(naive(naiveInput).state).toBe("stalled"); // naive はこう誤断定する

    // 同じ不変条件アサーション (state !== "stalled") を naive にかけると赤になる:
    expect(() => {
      if (naive(naiveInput).state === "stalled") {
        throw new Error("single-signal stalled assertion must be rejected");
      }
    }).toThrow();

    // 正しい合成器は同条件 (process 古い + stdout 新しい) で stalled を断定しない。
    const correct = synthesizeLiveness(
      { process: { alive: true, atMs: NOW - 90_000 }, stdout: { atMs: NOW - 500 } },
      { nowMs: NOW },
    );
    expect(correct.state).not.toBe("stalled");
  });
});

describe("INV-STALLED: observeFromEvents derives per-kind last-seen from event stream", () => {
  it("maps event types to their liveness signals (stdout/model/file/process/event)", () => {
    const SID = "sess_stalled_obs";
    const events = [
      makeEvent({
        session_id: SID,
        event_type: "command.output.delta",
        timestamp: iso(NOW, -10_000),
        payload: { kind: "command.output.delta", stream: "stdout", delta: "x" },
      }),
      makeEvent({
        session_id: SID,
        event_type: "agent.message.delta",
        timestamp: iso(NOW, -2_000),
        payload: { kind: "agent.message.delta", delta: "y" },
      }),
      makeEvent({
        session_id: SID,
        event_type: "diff.updated",
        timestamp: iso(NOW, -5_000),
        payload: { kind: "diff.updated" },
      }),
      makeEvent({
        session_id: SID,
        event_type: "heartbeat",
        timestamp: iso(NOW, -1_000),
        payload: { kind: "heartbeat", process_alive: true },
      }),
    ];
    const obs = observeFromEvents(events);
    expect(obs.stdout?.atMs).toBe(NOW - 10_000);
    expect(obs.modelStream?.atMs).toBe(NOW - 2_000);
    expect(obs.file?.atMs).toBe(NOW - 5_000);
    expect(obs.process).toEqual({ alive: true, atMs: NOW - 1_000 });
    // event = 全イベントの最新 (= heartbeat -1_000)。
    expect(obs.event?.atMs).toBe(NOW - 1_000);
  });

  it("picks the latest heartbeat's process_alive even when events are out of order", () => {
    const SID = "sess_stalled_ooo";
    const events = [
      makeEvent({
        session_id: SID,
        event_type: "heartbeat",
        timestamp: iso(NOW, -1_000),
        payload: { kind: "heartbeat", process_alive: false },
      }),
      makeEvent({
        session_id: SID,
        event_type: "heartbeat",
        timestamp: iso(NOW, -5_000),
        payload: { kind: "heartbeat", process_alive: true },
      }),
    ];
    const obs = observeFromEvents(events);
    // 最新 (= -1_000) の process_alive=false を採用 (順序が逆に届いても時刻で決める)。
    expect(obs.process).toEqual({ alive: false, atMs: NOW - 1_000 });
  });

  it("QA-1: a RECENT dead-process heartbeat must NOT be reported as live via observeFromEvents", () => {
    // 死活誤判定の現実経路: 直近 (-2s) に process_alive:false の heartbeat が届いた。
    // 旧実装は heartbeat を generic event シグナルとしても積み、event が fresh のため
    // synthesizeLiveness が processDead 判定の前に anyFresh で "live" と自己矛盾断定した
    // (evidence.process.alive=false なのに state="live")。
    // 修正後: 死亡通知 heartbeat は event 鮮度へ寄与せず、live にならない (stalled)。
    const SID = "sess_qa1_recent_dead";
    const events = [
      makeEvent({
        session_id: SID,
        event_type: "command.started",
        state: "running.command_executing",
        timestamp: iso(NOW, -90_000),
        payload: { kind: "command.started", command: "npm test" },
      }),
      makeEvent({
        session_id: SID,
        event_type: "heartbeat",
        timestamp: iso(NOW, -2_000), // 直近の死亡通知 (fresh)
        payload: { kind: "heartbeat", process_alive: false },
      }),
    ];
    const obs = observeFromEvents(events);
    // 死亡 heartbeat は活動 (event) に寄与しない。最後の活動は command.started (-90s, stale)。
    expect(obs.event?.atMs).toBe(NOW - 90_000);
    expect(obs.process).toEqual({ alive: false, atMs: NOW - 2_000 });

    const r = synthesizeLiveness(obs, { nowMs: NOW });
    // 必須: "live" を返さない (death を live と誤判定しない)。
    expect(r.state).not.toBe("live");
    expect(r.state).toBe("stalled");
    expect(r.evidence.process?.alive).toBe(false); // 自己矛盾しない (live でない)
    expect(r.stalledSuspected).toBe(true);
  });

  it("QA-1: a RECENT alive heartbeat still counts as activity ⇒ live (no over-correction)", () => {
    // 過剰修正防止: process_alive:true の直近 heartbeat は依然 event 活動として数え live。
    const SID = "sess_qa1_recent_alive";
    const events = [
      makeEvent({
        session_id: SID,
        event_type: "command.started",
        state: "running.command_executing",
        timestamp: iso(NOW, -90_000),
        payload: { kind: "command.started", command: "npm test" },
      }),
      makeEvent({
        session_id: SID,
        event_type: "heartbeat",
        timestamp: iso(NOW, -2_000),
        payload: { kind: "heartbeat", process_alive: true },
      }),
    ];
    const obs = observeFromEvents(events);
    expect(obs.event?.atMs).toBe(NOW - 2_000); // alive heartbeat は活動として数える
    const r = synthesizeLiveness(obs, { nowMs: NOW });
    expect(r.state).toBe("live");
  });

  it("end-to-end: a session that went quiet 90s ago with a dead process ⇒ stalled", () => {
    const SID = "sess_stalled_e2e";
    const events = [
      makeEvent({
        session_id: SID,
        event_type: "command.started",
        state: "running.command_executing",
        timestamp: iso(NOW, -90_000),
        payload: { kind: "command.started", command: "npm test" },
      }),
      makeEvent({
        session_id: SID,
        event_type: "heartbeat",
        timestamp: iso(NOW, -90_000),
        payload: { kind: "heartbeat", process_alive: false },
      }),
    ];
    const r = synthesizeLiveness(observeFromEvents(events), { nowMs: NOW });
    expect(r.state).toBe("stalled");
    expect(r.evidence.process?.alive).toBe(false);
    expect(r.evidence.stdout).toBeUndefined(); // stdout は観測されていない
  });
});
