/**
 * INV-GEMINI-LIFECYCLE: Gemini CLI adapter の正規化イベント列を backend の projection reducer
 * + liveness 合成へ通し、期待 state 遷移を pin する統合テスト (ADR 019f426e-a783・契約7)。
 *
 * opencode (session 終端イベント無し・idle 収束) と違い、**gemini は SessionEnd という実終端
 * シグナルを持つ**。adapter は SessionEnd → `session.ended(state:completed)` へ写像するため、
 * 下流 reducer では **終端 (completed) に確定収束する** ことを本テストが縛る:
 *
 *  1. reducer: adapter 出力を畳むと最終 state は `completed` (終端) になる。SessionEnd 由来以外で
 *     session.ended は現れない。全遷移が T1 許可表内 (invalid_transition_count === 0)。
 *  2. liveness: gemini adapter は heartbeat (process_alive) を出さないため process 死は **未確定**。
 *     最終イベント直後は live、十分後も stalled と誤断定せず idle (over-assertion 回避・INV-STALLED)。
 *     session.ended(terminal) と liveness (process 死活) は直交 — 停止を単一シグナルで断定しない。
 *
 * これは純ロジックテスト (PG 不要): adapter(docs/examples の実ファイル) → event-model parse →
 * @actradeck/projection reduce → liveness の一連を検証する。
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
import { deriveActionSubject, reduceEvents } from "@actradeck/projection";

import { observeFromEvents, synthesizeLiveness } from "../src/liveness.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADAPTER_PATH = resolve(HERE, "../../../docs/examples/gemini-adapter/adapter.mjs");
const FIXTURE_PATH = resolve(
  HERE,
  "../../../docs/examples/gemini-adapter/fixtures/gemini-events.sample.jsonl",
);

type AdapterModule = {
  mapHookEvent: (hook: unknown, opts?: { now?: () => number }) => Record<string, unknown>[];
};
const mod = (await import(pathToFileURL(ADAPTER_PATH).href)) as AdapterModule;

// fixture の主 session (実捕獲・単一 session)。
const MAIN_SESSION = "0b4dcedb-616e-4526-80b4-552bfe19b03c";

type GeminiHook = Record<string, unknown>;
function loadFixture(): GeminiHook[] {
  return readFileSync(FIXTURE_PATH, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as GeminiHook);
}

/** fixture を **1 hook ずつ** 写像し (per-event process の現実に忠実)、parseEvent を通す。 */
function mapNormalized(): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  for (const hook of loadFixture()) {
    for (const raw of mod.mapHookEvent(hook)) {
      const res = safeParseEvent(raw);
      expect(res.success, `mapped event failed parseEvent: ${JSON.stringify(raw)}`).toBe(true);
      if (res.success) out.push(res.data);
    }
  }
  return out;
}

describe("INV-GEMINI-LIFECYCLE: adapter → reducer/liveness 統合 (ADR 019f426e)", () => {
  const all = mapNormalized();
  const main = all.filter((e) => e.session_id === MAIN_SESSION);

  it("fixture の主 session が完全ライフサイクル (starting … completed) を含む", () => {
    expect(main.length).toBe(8);
    const types = main.map((e) => e.event_type);
    expect(types).toContain("session.started");
    expect(types).toContain("turn.started");
    expect(types).toContain("command.started");
    expect(types).toContain("command.completed");
    expect(types).toContain("turn.completed");
    expect(types).toContain("session.ended");
  });

  it("(1) reducer: 最終 state は completed (終端) に確定・session.ended は SessionEnd 由来のみ・不正遷移 0", () => {
    // session.ended はちょうど 1 (SessionEnd 由来)。
    expect(all.filter((e) => e.event_type === "session.ended").length).toBe(1);

    const proj = reduceEvents(MAIN_SESSION, main);
    // gemini は実終端を持つため completed に収束する (opencode の idle と異なる)。
    expect(proj.state).toBe("completed");
    expect(proj.state !== undefined && isTerminalState(proj.state)).toBe(true);
    // 全遷移 (starting→model_wait→command_executing→tool_preparing→model_wait→…→idle→completed) が
    //   T1 許可表内 (正規化イベント列が不正遷移を生まない)。
    expect(proj.invalid_transition_count).toBe(0);
    // 終端収束ゆえ承認待ち等の attention は無い。
    expect(proj.needs_attention).toBe(false);
  });

  it("(3) subject surface: turn.started→依頼要約 / turn.completed→応答要約 が projection 導出で出る (ADR 019f47c2)", () => {
    // projection の共有 deriveActionSubject (current_action_subject / replay subject の単一出所) が
    // gemini の turn.* から subject を引けることを実 adapter 出力 + 実 projection 経路で pin する。
    // これが空だと LiveWall/詳細が「ターン (対象なし)」になり KPI「何をしているか」を失う (ユーザー実指摘)。
    const turnStarted = main.find((e) => e.event_type === "turn.started")!;
    const turnCompleted = main.find((e) => e.event_type === "turn.completed")!;

    const startedSubject = deriveActionSubject(turnStarted.event_type, turnStarted.payload);
    const completedSubject = deriveActionSubject(turnCompleted.event_type, turnCompleted.payload);

    // SEC-1 (bounded-at-storage): adapter は secret 分割回避のため小 cap を捨て payload 要約は
    //   uncapped (床が redact 後 at-rest)。表示 subject の有界化は projection deriveActionSubject が
    //   **床の後** に行う。よって subject は payload 要約を ≤200 で slice した bounded 形と一致する
    //   (allowlist 由来・単一出所)。raw 全文素通しへ退行すると (D) INV-REDACTION-SUMMARY-STRADDLE が RED。
    const bound = (s: string): string => (s.length > 200 ? s.slice(0, 200) + "…" : s);
    const promptSummary = (turnStarted.payload as Record<string, unknown>).prompt_summary as string;
    const responseSummary = (turnCompleted.payload as Record<string, unknown>)
      .response_summary as string;
    expect(startedSubject).toBeTruthy();
    expect(startedSubject).toBe(bound(promptSummary));
    expect(completedSubject).toBeTruthy();
    expect(completedSubject).toBe(bound(responseSummary));
    // 有界 (≤200 + ellipsis)。subject の有界化を撤去すると RED。
    expect(String(startedSubject).length).toBeLessThanOrEqual(201);
    expect(String(completedSubject).length).toBeLessThanOrEqual(201);
    // 実 fixture の response は 200 字超ゆえ subject は truncated (bounded-at-storage の実証)。
    expect(String(completedSubject).endsWith("…")).toBe(true);
  });

  it("(2) liveness: 直後は live / 十分後も stalled と誤断定せず idle (heartbeat 非発行由来)", () => {
    const obs = observeFromEvents(main);
    // adapter は heartbeat を出さないため process シグナルは観測されない (=死活未確定)。
    expect(obs.process).toBeUndefined();

    const lastMs = Math.max(...main.map((e) => toEpochMs(e.timestamp)));

    // 直後 (fresh): 少なくとも 1 シグナルが新しい → live。
    const fresh = synthesizeLiveness(obs, { nowMs: lastMs + 1_000 });
    expect(fresh.state).toBe("live");
    expect(fresh.stalledSuspected).toBe(false);

    // 十分後 (全シグナル stale): gemini adapter は process 死を出さないので停止を断定せず idle。
    //   **stalled にはならない** (INV-STALLED・over-assertion 禁止)。session.ended(terminal) と
    //   liveness (process 死活) は直交する — reducer は completed でも liveness は idle に倒す。
    const later = synthesizeLiveness(obs, { nowMs: lastMs + 120_000 });
    expect(later.state).not.toBe("stalled");
    expect(later.state).toBe("idle");
    expect(later.stalledSuspected).toBe(false);
    expect(later.evidence.process).toBeUndefined();
  });
});
