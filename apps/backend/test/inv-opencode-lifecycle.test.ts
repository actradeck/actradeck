/**
 * INV-OPENCODE-LIFECYCLE (QA-7): opencode adapter の正規化イベント列を backend の
 * projection reducer + liveness 合成へ通し、期待 state 遷移を pin する統合テスト。
 *
 * opencode は **session 終端イベントを発行しない** (Claude Code の session.ended 相当が無い・
 * ADR D8)。adapter は session.idle を `turn.completed(state:idle)` へ写像し `session.ended` を
 * **捏造しない**。本テストはその設計が下流 (reducer / liveness) で正しく機能することを縛る:
 *
 *  1. reducer: adapter 出力を畳むと最終 state は `idle` に収束し、終端 (completed/failed/
 *     interrupted) にならない。session.ended は列に一切現れない (never-ending / 終端捏造なし)。
 *  2. liveness: session.ended が無くても、liveness 合成は「停止 (stalled)」を **誤断定しない**。
 *     - 最終イベント直後 (fresh) は live。
 *     - 十分に時間が経ち全シグナルが stale でも、opencode adapter は heartbeat
 *       (process_alive:false) を出さないため process 死が **未確定** → stalled ではなく idle
 *       (over-assertion 回避・INV-STALLED)。
 *
 * これは純ロジックテスト (PG 不要): adapter(docs/examples の実ファイル) → event-model parse →
 * @actradeck/projection reduce → liveness の一連を検証する。liveness が「全シグナル stale なら
 * stalled」に退行すると (2) の +120s assert が RED になる (falsifiable)。
 */
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  isTerminalState,
  safeParseEvent,
  toEpochMs,
  type NormalizedEvent,
} from "@actradeck/event-model";
import { reduceEvents } from "@actradeck/projection";

import { observeFromEvents, synthesizeLiveness } from "../src/liveness.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADAPTER_PATH = resolve(HERE, "../../../docs/examples/opencode-adapter/adapter.js");
const FIXTURE_PATH = resolve(
  HERE,
  "../../../docs/examples/opencode-adapter/fixtures/opencode-events.sample.jsonl",
);

type AdapterFactory = {
  createAdapterState: (opts?: { now?: () => number }) => unknown;
  mapCaptureLine: (line: unknown, state: unknown) => Record<string, unknown>[];
};
const mod = (await import(pathToFileURL(ADAPTER_PATH).href)) as { default: AdapterFactory };
const adapter = mod.default;

type CaptureLine = { kind: string; data: Record<string, unknown> };

// 決定論のため adapter の now を固定 (sourceMs 無しイベントの timestamp を安定させる)。
// fixture の session.created/turn.started は sourceMs (~1783420945.9k = 2026-07-07) を持つため
// floor がそれ以上になるよう、少し後の固定時刻を使う。
const FIXED_NOW = 1_783_420_950_000; // 2026-07-07T10:42:30Z 付近
const MAIN_SESSION = "ses_0c3d3fa12ffeJaaqMOZunsK58h";

function loadFixture(): CaptureLine[] {
  return readFileSync(FIXTURE_PATH, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as CaptureLine);
}

/** fixture を写像し、parseEvent を通した NormalizedEvent 列を session ごとに返す。 */
function mapNormalized(): NormalizedEvent[] {
  const state = adapter.createAdapterState({ now: () => FIXED_NOW });
  const out: NormalizedEvent[] = [];
  for (const line of loadFixture()) {
    for (const raw of adapter.mapCaptureLine(line, state)) {
      const res = safeParseEvent(raw);
      expect(res.success, `mapped event failed parseEvent: ${JSON.stringify(raw)}`).toBe(true);
      if (res.success) out.push(res.data);
    }
  }
  return out;
}

describe("INV-OPENCODE-LIFECYCLE (QA-7): adapter → reducer/liveness 統合", () => {
  const all = mapNormalized();
  const main = all.filter((e) => e.session_id === MAIN_SESSION);

  it("fixture の主 session が完全ライフサイクル (starting … idle) を含む", () => {
    expect(main.length).toBeGreaterThan(0);
    const types = main.map((e) => e.event_type);
    expect(types).toContain("session.started");
    expect(types).toContain("turn.started");
    expect(types).toContain("turn.completed");
  });

  it("(1) reducer: 最終 state は idle に収束し終端にならない・session.ended は列に無い", () => {
    // session.ended は adapter が **一切捏造しない** (全 session 横断で 0 件)。
    expect(all.some((e) => e.event_type === "session.ended")).toBe(false);

    const proj = reduceEvents(MAIN_SESSION, main);
    expect(proj.state).toBe("idle");
    // idle は終端ではない (completed/failed/interrupted のいずれでもない)。
    expect(proj.state !== undefined && isTerminalState(proj.state)).toBe(false);
    // 全遷移が T1 許可表内 (正規化イベント列が不正遷移を生まない)。
    expect(proj.invalid_transition_count).toBe(0);
    // turn.completed(idle) 収束ゆえ承認待ち等の attention は無い。
    expect(proj.needs_attention).toBe(false);
  });

  it("(2) liveness: 直後は live / 十分後も stalled と誤断定せず idle (session.ended 無し由来)", () => {
    const obs = observeFromEvents(main);
    // adapter は heartbeat を出さないため process シグナルは観測されない (=死活未確定)。
    expect(obs.process).toBeUndefined();

    // 最終イベント時刻を基準に評価する。
    const lastMs = Math.max(...main.map((e) => toEpochMs(e.timestamp)));

    // 直後 (fresh): 少なくとも 1 シグナルが新しい → live。
    const fresh = synthesizeLiveness(obs, { nowMs: lastMs + 1_000 });
    expect(fresh.state).toBe("live");
    expect(fresh.stalledSuspected).toBe(false);

    // 十分後 (全シグナル stale): opencode は session 終端を出さず process 死も未確定なので、
    //   停止を断定せず idle。**stalled にはならない** (INV-STALLED・never-ending 誤判定の禁止)。
    const later = synthesizeLiveness(obs, { nowMs: lastMs + 120_000 });
    expect(later.state).not.toBe("stalled");
    expect(later.state).toBe("idle");
    expect(later.stalledSuspected).toBe(false);
    // 根拠: process 未観測 (evidence に process 無し) ゆえ死活未確定として idle に倒す。
    expect(later.evidence.process).toBeUndefined();
  });
});
