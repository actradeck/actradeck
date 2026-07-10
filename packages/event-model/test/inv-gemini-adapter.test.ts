/**
 * INV-GEMINI-ADAPTER-*: 外部アダプタ第2号 (Gemini CLI hook adapter) の契約不変条件
 * (ADR 019f426e-a783・REAL 捕獲 fixture 準拠).
 *
 * anti-drift by construction: 読者が設置する **実ファイル**
 * `docs/examples/gemini-adapter/adapter.mjs` を dynamic import し、**REAL 捕獲** fixture
 * (`fixtures/gemini-events.sample.jsonl` = 実 gemini 0.42.0 の全 8 hook・値はパス中立化のみ・
 * 構造/キー/型は REAL のまま) を写像して検証する。adapter の写像が壊れる / event-model schema が
 * 動くと、このテストが RED になる。
 *
 * INV 7 本 (ADR 契約7):
 *  - CONTRACT     : 全写像出力が parseEvent を通過し 3 次元規則 + UUIDv7 を満たす。
 *  - PAYLOAD      : payload.kind === event_type ∧ EventPayload discriminated union を通過。
 *  - MONOTONIC    : per-event process ゆえ floor は持てない。hook 入力 timestamp を pass-through
 *                   (fidelity) し、fixture 順で session 毎 非減少であることを固定する。
 *  - NEVER-DENY   : shipped script を subprocess 実行し、あらゆる入力で stdout `{}` / exit 0 /
 *                   decision 系キー不在。observe-only の by-construction 保証。
 *  - ENDED-ONLY-FROM-SESSIONEND : session.ended は **SessionEnd hook 由来のみ**。他 hook は産まない。
 *  - DEDUP        : 各 hook ≤1 event・event_id は全 distinct UUIDv7 (backend 冪等キー)・
 *                   run_shell_command の before/after が同一 request_id で相関 (別 event_id)。
 *  - MINIMIZED    : gemini に error 封筒は無い。等価な源流最小化として AfterTool の tool_response
 *                   (llmContent / returnDisplay / PGID / output 全文) が出力の値空間に一切現れない
 *                   (opencode ERROR-MINIMIZED と同一の positive key-allowlist + deep-walk 負照合)。
 *  - TURN-SUMMARY : (ADR 019f47c2 / SEC-1 019f47f0) turn.started/completed は依頼/応答の要約 (summarize で
 *                   1 行化) を prompt_summary/response_summary に載せる (CC パリティ・KPI「何をしているか」)。
 *                   **bounded-at-storage**: adapter は secret を分割しうる小 cap で truncate せず sanity 上限のみ
 *                   で送り (床が secret 全体を見て redact できる)、表示 ≤N 有界化は **床の後** (backend projection
 *                   deriveActionSubject が redacted 値を slice) で行う。よって adapter 出力は 200 で切詰めない
 *                   (200 小 cap 復活への退行で RED = INV-REDACTION-SUMMARY-STRADDLE の adapter 側 pin)。
 *  + SEC-1 回帰   : fixture 生テキストに OSS coupling / 先頭スラッシュ無し home-dir トークンが無い。
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  ALL_EVENT_TYPES,
  EventPayload,
  isKnownProvider,
  isMonotonicNonDecreasing,
  isUuidV7,
  PROVIDER_SLUG_RE,
  safeParseEvent,
} from "../src/index.js";

// ── 実 adapter (.mjs) と REAL fixture を自 dir から解決する ─────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
const ADAPTER_RELPATH = "../../../docs/examples/gemini-adapter/adapter.mjs";
const FIXTURE_RELPATH = "../../../docs/examples/gemini-adapter/fixtures/gemini-events.sample.jsonl";
const ADAPTER_PATH = resolve(HERE, ADAPTER_RELPATH);
const FIXTURE_PATH = resolve(HERE, FIXTURE_RELPATH);

type GeminiHook = Record<string, unknown> & { hook_event_name?: string };
type NormEvent = Record<string, unknown>;
type AdapterModule = {
  mapHookEvent: (hook: unknown, opts?: { now?: () => number }) => NormEvent[];
  uuidv7: () => string;
  summarize: (text: unknown, cap?: number) => string;
  SUMMARY_SANITY_CAP: number;
  resolveConfig: (env?: Record<string, string | undefined>) => {
    url: string;
    token: string;
    enabled: boolean;
  };
};

const mod = (await import(pathToFileURL(ADAPTER_PATH).href)) as AdapterModule;

const FIXTURE_RAW = readFileSync(FIXTURE_PATH, "utf8");

function loadFixture(): GeminiHook[] {
  return FIXTURE_RAW.split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as GeminiHook);
}

/** fixture 全 hook を **1 件ずつ独立に** 写像する (per-event process の現実に忠実・state 非共有)。 */
function mapAll(): NormEvent[] {
  const out: NormEvent[] = [];
  for (const hook of loadFixture()) {
    for (const ev of mod.mapHookEvent(hook)) out.push(ev);
  }
  return out;
}

/** JSON を deep-walk して全ての string leaf 値を集める (MINIMIZED 負照合用)。 */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value && typeof value === "object")
    for (const v of Object.values(value)) collectStrings(v, out);
  return out;
}

describe("INV-GEMINI-ADAPTER-*: Gemini CLI hook adapter (ADR 019f426e-a783)", () => {
  const fixture = loadFixture();

  it("fixture が REAL 捕獲を読める (8 hook・6 種の hook_event_name を含む)", () => {
    expect(fixture.length).toBe(8);
    const names = new Set(fixture.map((h) => h.hook_event_name));
    for (const n of [
      "SessionStart",
      "BeforeAgent",
      "BeforeTool",
      "AfterTool",
      "AfterAgent",
      "SessionEnd",
    ]) {
      expect(names.has(n), `fixture に ${n} がある`).toBe(true);
    }
    // 実捕獲の shell / read の両 tool が居ることを固定 (run_shell_command と read_file の振り分け対象)。
    const toolNames = new Set(
      fixture
        .filter((h) => h.hook_event_name === "BeforeTool")
        .map((h) => (h as { tool_name?: string }).tool_name),
    );
    expect(toolNames.has("run_shell_command")).toBe(true);
    expect(toolNames.has("read_file")).toBe(true);
  });

  it("写像が実際にイベントを産む (8 hook → 8 event・drop だけで空にならない)", () => {
    const events = mapAll();
    expect(events.length).toBe(8);
  });

  // ── INV-GEMINI-ADAPTER-CONTRACT ─────────────────────────────────────────
  describe("INV-GEMINI-ADAPTER-CONTRACT", () => {
    it("全写像出力が parseEvent を通過し 3 次元規則 (provider/source/event_type) と UUIDv7 を満たす", () => {
      const events = mapAll();
      expect(events.length).toBeGreaterThan(0);
      for (const ev of events) {
        const res = safeParseEvent(ev);
        if (!res.success) {
          throw new Error(
            `mapped event failed parseEvent (${String(ev.event_type)}): ${res.error.message}`,
          );
        }
        expect(ev.provider).toBe("gemini");
        expect(PROVIDER_SLUG_RE.test(String(ev.provider))).toBe(true);
        expect(isKnownProvider(String(ev.provider))).toBe(false);
        expect(ev.source).toBe("external");
        expect(ALL_EVENT_TYPES).toContain(ev.event_type);
        expect(isUuidV7(String(ev.event_id))).toBe(true);
        // capture_mode は観測モード enum に external を足さない設計 (ADR D4)。
        expect(ev.capture_mode).toBeUndefined();
        expect(ev.provider_session_id).toBe(ev.session_id);
      }
    });

    // 写像 histogram (8 event_type) の Set 一致 pin。写像表が増減すると RED。
    it("fixture が産む event_type 集合が既知の 8 種と一致 (run_shell_command→command.* / read_file→tool.*)", () => {
      const produced = new Set(mapAll().map((e) => String(e.event_type)));
      const expected = new Set([
        "session.started",
        "turn.started",
        "command.started",
        "tool.started",
        "tool.completed",
        "command.completed",
        "turn.completed",
        "session.ended",
      ]);
      expect([...produced].sort()).toEqual([...expected].sort());
    });

    // run_shell_command と read_file の振り分けを個別に固定 (REAL grounded)。
    it("run_shell_command は command.* / read_file は tool.* へ振り分けられる", () => {
      const beforeShell = fixture.find(
        (h) => h.hook_event_name === "BeforeTool" && h.tool_name === "run_shell_command",
      )!;
      const afterShell = fixture.find(
        (h) => h.hook_event_name === "AfterTool" && h.tool_name === "run_shell_command",
      )!;
      const beforeRead = fixture.find(
        (h) => h.hook_event_name === "BeforeTool" && h.tool_name === "read_file",
      )!;
      const afterRead = fixture.find(
        (h) => h.hook_event_name === "AfterTool" && h.tool_name === "read_file",
      )!;

      expect(mod.mapHookEvent(beforeShell)[0]!.event_type).toBe("command.started");
      expect(mod.mapHookEvent(beforeShell)[0]!.state).toBe("running.command_executing");
      expect(mod.mapHookEvent(afterShell)[0]!.event_type).toBe("command.completed");
      expect(mod.mapHookEvent(beforeRead)[0]!.event_type).toBe("tool.started");
      expect(mod.mapHookEvent(beforeRead)[0]!.state).toBe("running.tool_preparing");
      expect(mod.mapHookEvent(afterRead)[0]!.event_type).toBe("tool.completed");

      // tool.started は tool_input を verbatim 転送する (§ 開示・backend 床依存)。
      const startedPayload = mod.mapHookEvent(beforeRead)[0]!.payload as Record<string, unknown>;
      expect(startedPayload.tool_name).toBe("read_file");
      expect(startedPayload.input).toEqual((beforeRead as { tool_input?: unknown }).tool_input);
    });
  });

  // ── INV-GEMINI-ADAPTER-PAYLOAD ──────────────────────────────────────────
  describe("INV-GEMINI-ADAPTER-PAYLOAD", () => {
    it("payload.kind === event_type ∧ EventPayload discriminated union を通過", () => {
      let checked = 0;
      for (const ev of mapAll()) {
        const payload = ev.payload as Record<string, unknown> | undefined;
        expect(payload, `event ${String(ev.event_type)} は payload を持つ`).toBeTypeOf("object");
        expect(payload?.kind, "payload.kind === event_type").toBe(ev.event_type);
        const res = EventPayload.safeParse(payload);
        if (!res.success) {
          throw new Error(
            `payload failed EventPayload (${String(ev.event_type)}): ${res.error.message}`,
          );
        }
        checked += 1;
      }
      expect(checked).toBe(8);
    });
  });

  // ── INV-GEMINI-ADAPTER-MONOTONIC ────────────────────────────────────────
  // per-event process ゆえ floor は無い。hook 入力 timestamp を pass-through (fidelity) し、
  // fixture 順で session 毎 非減少であることを固定する (ADR 契約7: hook timestamp 単調性の範囲)。
  describe("INV-GEMINI-ADAPTER-MONOTONIC", () => {
    it("emitted timestamp は hook 入力 timestamp を pass-through する (fidelity・now 化への退行で RED)", () => {
      for (const hook of fixture) {
        const events = mod.mapHookEvent(hook);
        for (const ev of events) {
          expect(ev.timestamp).toBe(hook.timestamp);
        }
      }
    });

    it("fixture 順の発行 timestamp が session 毎 非減少", () => {
      const bySession = new Map<string, string[]>();
      for (const ev of mapAll()) {
        const sid = String(ev.session_id);
        const arr = bySession.get(sid) ?? [];
        arr.push(String(ev.timestamp));
        bySession.set(sid, arr);
      }
      expect(bySession.size).toBeGreaterThan(0);
      for (const [sid, timestamps] of bySession) {
        expect(
          isMonotonicNonDecreasing(timestamps),
          `session ${sid} timestamps not monotonic: ${timestamps.join(", ")}`,
        ).toBe(true);
      }
    });

    it("timestamp 欠落 hook は注入 now() へフォールバックし ISO8601 を保つ", () => {
      const events = mod.mapHookEvent(
        { session_id: "s_fallback", hook_event_name: "SessionStart" },
        { now: () => 1_783_420_950_000 },
      );
      expect(events.length).toBe(1);
      expect(events[0]!.timestamp).toBe(new Date(1_783_420_950_000).toISOString());
      expect(safeParseEvent(events[0]!).success).toBe(true);
    });
  });

  // ── INV-GEMINI-ADAPTER-ENDED-ONLY-FROM-SESSIONEND ───────────────────────
  describe("INV-GEMINI-ADAPTER-ENDED-ONLY-FROM-SESSIONEND", () => {
    it("session.ended は SessionEnd hook 由来のみ・他 hook は一切産まない", () => {
      // 各 hook を独立写像し、session.ended を出したものは必ず SessionEnd。
      for (const hook of fixture) {
        const events = mod.mapHookEvent(hook);
        for (const ev of events) {
          if (ev.event_type === "session.ended") {
            expect(hook.hook_event_name).toBe("SessionEnd");
          }
        }
      }
      // fixture 全体で session.ended はちょうど 1 (SessionEnd も 1)。
      const endedCount = mapAll().filter((e) => e.event_type === "session.ended").length;
      const sessionEndHooks = fixture.filter((h) => h.hook_event_name === "SessionEnd").length;
      expect(endedCount).toBe(1);
      expect(endedCount).toBe(sessionEndHooks);

      // 非 SessionEnd hook は決して session.ended を産まない (捏造禁止の反証)。
      for (const hook of fixture) {
        if (hook.hook_event_name === "SessionEnd") continue;
        const produced = mod.mapHookEvent(hook).map((e) => e.event_type);
        expect(produced).not.toContain("session.ended");
      }
    });

    it("SessionEnd は state:completed (終端) + reason を保つ", () => {
      const endHook = fixture.find((h) => h.hook_event_name === "SessionEnd")!;
      const ev = mod.mapHookEvent(endHook)[0]!;
      expect(ev.event_type).toBe("session.ended");
      expect(ev.state).toBe("completed");
      expect((ev.payload as Record<string, unknown>).reason).toBe(
        (endHook as { reason?: string }).reason,
      );
    });
  });

  // ── INV-GEMINI-ADAPTER-DEDUP ────────────────────────────────────────────
  describe("INV-GEMINI-ADAPTER-DEDUP", () => {
    it("各 hook ≤1 event・event_id は全 distinct UUIDv7 (backend 冪等キー)", () => {
      for (const hook of fixture) {
        expect(mod.mapHookEvent(hook).length).toBeLessThanOrEqual(1);
      }
      const events = mapAll();
      const ids = events.map((e) => String(e.event_id));
      for (const id of ids) expect(isUuidV7(id)).toBe(true);
      expect(new Set(ids).size).toBe(ids.length); // 全 distinct
    });

    it("run_shell_command の before/after が同一 request_id で相関 (別 event_id・tu: 名前空間)", () => {
      const beforeShell = fixture.find(
        (h) => h.hook_event_name === "BeforeTool" && h.tool_name === "run_shell_command",
      )!;
      const afterShell = fixture.find(
        (h) => h.hook_event_name === "AfterTool" && h.tool_name === "run_shell_command",
      )!;
      const started = mod.mapHookEvent(beforeShell)[0]!;
      const completed = mod.mapHookEvent(afterShell)[0]!;
      const sp = started.payload as Record<string, unknown>;
      const cp = completed.payload as Record<string, unknown>;
      expect(String(sp.request_id)).toMatch(/^tu:/);
      expect(cp.request_id).toBe(sp.request_id); // 決定的相関 (callID 不在でも Before↔After 一致)
      expect(started.event_id).not.toBe(completed.event_id); // event_id は各々 distinct
    });
  });

  // ── INV-GEMINI-ADAPTER-UNKNOWN-DROP (未知 hook の safe-side drop・QA-2/TDA-3) ──
  // adapter の switch default (Notification / PreCompress / 未知 hook_event_name) は空配列を返し
  // イベントを一切発行しない。この safe-side drop を合成 hook で直接 pin する (fixture 非汚染・
  // 実捕獲 8 event は不変)。default を `return [someEvent]` 等へ変異させると RED になる。
  describe("INV-GEMINI-ADAPTER-UNKNOWN-DROP", () => {
    it("Notification hook (写像対象外) は空配列 (イベント非発行)", () => {
      const out = mod.mapHookEvent({
        session_id: "s_drop",
        hook_event_name: "Notification",
        timestamp: "2026-07-09T13:14:00.000Z",
        cwd: "/tmp/x",
      });
      expect(out).toEqual([]);
    });

    it("PreCompress hook (写像対象外) は空配列 (イベント非発行)", () => {
      const out = mod.mapHookEvent({
        session_id: "s_drop",
        hook_event_name: "PreCompress",
        timestamp: "2026-07-09T13:14:01.000Z",
      });
      expect(out).toEqual([]);
    });

    it("未知の hook_event_name (__unknown__) は空配列 (default 分岐の safe-side drop)", () => {
      const out = mod.mapHookEvent({
        session_id: "s_drop",
        hook_event_name: "__unknown__",
        timestamp: "2026-07-09T13:14:02.000Z",
      });
      expect(out).toEqual([]);
    });
  });

  // ── INV-GEMINI-ADAPTER-MINIMIZED (源流最小化・opencode ERROR-MINIMIZED 等価) ──
  // gemini に error 封筒は無い。等価な最小化対象は AfterTool の tool_response
  // (run_shell_command の llmContent = <untrusted_context> ラップの output 全文 + PGID /
  //  returnDisplay)。これらが出力の値空間に **一切現れない** ことを二段で固定する。
  describe("INV-GEMINI-ADAPTER-MINIMIZED", () => {
    it("run_shell_command AfterTool → command.completed は key-allowlist ⊆ {kind,command,request_id}・tool_response 非漏洩", () => {
      const afterShell = fixture.find(
        (h) => h.hook_event_name === "AfterTool" && h.tool_name === "run_shell_command",
      )!;
      // 捨てるべき tool_response 値を実 fixture から動的に取る (hardcode ドリフト回避)。
      const toolResponse = (afterShell as { tool_response?: Record<string, unknown> })
        .tool_response!;
      const droppedLlm = String(toolResponse.llmContent);
      // llmContent は <untrusted_context> ラップの output + PGID を含む (実捕獲)。これが最小化対象。
      //   注: returnDisplay は shell の echo 出力そのもの (= command が正当に含む substring と一致し
      //   うる) ため負照合対象にしない。load-bearing なのは <untrusted_context>/PGID を含む llmContent。
      expect(droppedLlm).toContain("untrusted_context");
      expect(droppedLlm).toContain("PGID");
      const pgid = droppedLlm.match(/PGID:\s*(\d+)/)?.[1];
      const droppedValues = [droppedLlm, "untrusted_context", "PGID", pgid].filter(
        (v): v is string => typeof v === "string" && v.length > 0,
      );

      const out = mod.mapHookEvent(afterShell)[0]!;
      expect(out.event_type).toBe("command.completed");

      // (a) positive key-allowlist: payload キー集合 ⊆ {kind, command, request_id}。余剰キーで RED。
      const payload = out.payload as Record<string, unknown>;
      const ALLOWED = new Set(["kind", "command", "request_id"]);
      for (const k of Object.keys(payload)) {
        expect(ALLOWED.has(k), `payload に許可外キー: ${k}`).toBe(true);
      }
      expect(payload.kind).toBe("command.completed");

      // (b) deep-walk 負照合: 出力の全 string 値のどれにも tool_response 値 (部分文字列含む) が無い。
      const strings = collectStrings(JSON.parse(JSON.stringify(out)));
      for (const s of strings) {
        for (const dv of droppedValues) {
          expect(
            s.includes(dv),
            `tool_response 値が出力の値空間に leak: ${dv} in ${JSON.stringify(s)}`,
          ).toBe(false);
        }
      }
      expect(JSON.stringify(out).includes("llmContent")).toBe(false);
      expect(JSON.stringify(out).includes("returnDisplay")).toBe(false);
    });

    it("read_file AfterTool → tool.completed は {kind,tool_name} のみ・tool_response 非漏洩", () => {
      const afterRead = fixture.find(
        (h) => h.hook_event_name === "AfterTool" && h.tool_name === "read_file",
      )!;
      const toolResponse = (afterRead as { tool_response?: Record<string, unknown> })
        .tool_response!;
      const droppedLlm = String(toolResponse.llmContent);

      const out = mod.mapHookEvent(afterRead)[0]!;
      expect(out.event_type).toBe("tool.completed");
      const payload = out.payload as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual(["kind", "tool_name"]);

      const strings = collectStrings(JSON.parse(JSON.stringify(out)));
      for (const s of strings) {
        expect(s.includes(droppedLlm)).toBe(false);
      }
    });
  });

  // ── INV-GEMINI-ADAPTER-TURN-SUMMARY (依頼/応答の要約搭載・ADR 019f47c2 / SEC-1 019f47f0) ──
  // turn.started は BeforeAgent.prompt を、turn.completed は AfterAgent.prompt_response を summarize で
  // 1 行化して payload.prompt_summary / response_summary へ載せる (CC パリティ)。これにより projection
  // deriveActionSubject が subject を引けて timeline/wall が「依頼:…」「応答:…」になる (KPI 回復)。
  //
  // **bounded-at-storage (SEC-1 改訂)**: truncate-before-redact straddle leak を避けるため adapter は
  // secret を分割しうる小 cap で raw を切詰めない (sanity 上限のみ)。床が secret 全体を見て redact し、
  // 表示 ≤N 有界化は **床の後** (backend projection・INV-REDACTION-SUMMARY-STRADDLE) で行う。よって
  // 本 unit は「adapter が 200 で truncate しない (= 200 小 cap 復活で RED)」を pin する。
  describe("INV-GEMINI-ADAPTER-TURN-SUMMARY", () => {
    const SMALL_CAP = 200; // 旧 (leaky) 小 cap。復活したら RED になることを保証する退行 tripwire。

    it("BeforeAgent → turn.started が prompt_summary を summarize(sanity) で載せる (secret 分割しない・単一出所)", () => {
      const before = fixture.find((h) => h.hook_event_name === "BeforeAgent")!;
      const rawPrompt = String((before as { prompt?: unknown }).prompt);
      expect(rawPrompt.length).toBeGreaterThan(0);

      const ev = mod.mapHookEvent(before)[0]!;
      expect(ev.event_type).toBe("turn.started");
      const payload = ev.payload as Record<string, unknown>;
      // (a) 搭載: prompt_summary が存在し summarize(rawPrompt, SANITY) と一致 (単一出所・小 cap 非使用)。
      const expected = mod.summarize(rawPrompt, mod.SUMMARY_SANITY_CAP);
      expect(payload.prompt_summary).toBe(expected);
      // (c) summary (公開ラベル) は「依頼: <summary>」。
      expect(ev.summary).toBe(`依頼: ${expected}`);
      // (d) payload キー ⊆ {kind, prompt_summary} (余剰キーで RED)。
      const ALLOWED = new Set(["kind", "prompt_summary"]);
      for (const k of Object.keys(payload)) {
        expect(ALLOWED.has(k), `turn.started payload に許可外キー: ${k}`).toBe(true);
      }
    });

    it("AfterAgent → turn.completed が response_summary を **200 で truncate せず** 全文 1 行化して載せる (小 cap 復活で RED)", () => {
      const after = fixture.find((h) => h.hook_event_name === "AfterAgent")!;
      const rawResponse = String((after as { prompt_response?: unknown }).prompt_response);
      // 実 fixture の prompt_response は 200 字超 (旧 200-cap の truncation 経路を実データで通す)。
      expect(rawResponse.length).toBeGreaterThan(SMALL_CAP);

      const ev = mod.mapHookEvent(after)[0]!;
      expect(ev.event_type).toBe("turn.completed");
      const payload = ev.payload as Record<string, unknown>;
      const expected = mod.summarize(rawResponse, mod.SUMMARY_SANITY_CAP);
      expect(payload.response_summary).toBe(expected);
      expect(ev.summary).toBe(`応答: ${expected}`);

      // SEC-1 pin: adapter は 200 で切詰めない。よって
      //   (i) 末尾は ellipsis で終わらない (200 truncation の痕跡が無い)、
      //   (ii) 200-cap なら **捨てられていた末尾側** が payload に **現れる** (200 小 cap 復活で RED)。
      const oneLine = rawResponse.replace(/\s+/g, " ").trim();
      expect(String(payload.response_summary)).toBe(oneLine); // 全文 1 行化 (ellipsis なし)
      expect(String(payload.response_summary).endsWith("…")).toBe(false);
      const droppedByOldCap = oneLine.slice(SMALL_CAP + 20); // 旧 200-cap が捨てた確実な末尾
      expect(droppedByOldCap.length).toBeGreaterThan(0);
      const strings = collectStrings(JSON.parse(JSON.stringify(ev)));
      expect(
        strings.some((s) => s.includes(droppedByOldCap)),
        `旧 200-cap が捨てた末尾が adapter 出力に現れない = 200 小 cap へ退行 (straddle leak 再導入)`,
      ).toBe(true);

      const ALLOWED = new Set(["kind", "response_summary"]);
      for (const k of Object.keys(payload)) {
        expect(ALLOWED.has(k), `turn.completed payload に許可外キー: ${k}`).toBe(true);
      }
    });

    it("subject 導出契約: turn.started/completed の summary は projection allowlist キーに一致", () => {
      // adapter が載せる payload キー名 (prompt_summary/response_summary) は projection
      // deriveActionSubject の turn.* 分岐が引くキーと一致していなければ subject が出ない。
      // ここでは adapter 側キー名を pin し、キー rename での silent 破綻を防ぐ (backend inv-gemini-
      // lifecycle が実 projection 経路で subject 導出を検証する)。
      const before = fixture.find((h) => h.hook_event_name === "BeforeAgent")!;
      const after = fixture.find((h) => h.hook_event_name === "AfterAgent")!;
      expect(
        Object.keys(mod.mapHookEvent(before)[0]!.payload as Record<string, unknown>),
      ).toContain("prompt_summary");
      expect(Object.keys(mod.mapHookEvent(after)[0]!.payload as Record<string, unknown>)).toContain(
        "response_summary",
      );
    });
  });

  // ── summarize 純関数 (畳み / cap 境界・ADR 019f47c2) ──
  describe("summarize (依存ゼロ純関数)", () => {
    it("改行/連続空白を単一空白へ畳む", () => {
      expect(mod.summarize("a\n\n  b\t c")).toBe("a b c");
    });
    it("前後空白を trim する", () => {
      expect(mod.summarize("   hello   ")).toBe("hello");
    });
    it("cap 以下はそのまま (ellipsis なし)", () => {
      expect(mod.summarize("abc", 10)).toBe("abc");
      expect(mod.summarize("abcdefghij", 10)).toBe("abcdefghij");
    });
    it("cap 超過は cap 字で切詰め + ellipsis (mutation: cap 無効化で RED)", () => {
      const out = mod.summarize("abcdefghijk", 10);
      expect(out).toBe("abcdefghij…");
      // 本体は正確に cap 字 (ellipsis を除く)。cap を無視して全文載せへ退行すると RED。
      expect(out.slice(0, -1).length).toBe(10);
    });
    it("非文字列は空文字 (fail-open)", () => {
      expect(mod.summarize(undefined)).toBe("");
      expect(mod.summarize(null)).toBe("");
      expect(mod.summarize(42)).toBe("");
    });

    // ── TDA-2: default cap footgun tripwire ──
    // summarize の cap 省略呼出 `summarize(x)` は **安全側 default (SUMMARY_SANITY_CAP)** を使い、
    // 200 で truncate してはならない (dead だった `cap=200` default の復活で straddle leak 再発)。
    // default を 200 へ戻すと (i)(ii) が両方 RED になる退行 tripwire。
    it("cap 省略呼出の default は 200 でなく SUMMARY_SANITY_CAP 相当 (200 default 復活で RED・TDA-2)", () => {
      const OLD_CAP = 200; // 旧 (leaky) 小 cap default。
      const long = "x".repeat(OLD_CAP + 500); // 200 超の単一行 (空白畳み後も長さ不変)。
      const out = mod.summarize(long); // ← cap 省略 = default 適用。
      // (i) 安全側 default では全文素通し (200 default なら 200 字 + ellipsis に切られ RED)。
      expect(out.length).toBe(long.length);
      expect(out.endsWith("…")).toBe(false);
      // (ii) default 省略呼出 === 明示 SUMMARY_SANITY_CAP 呼出 (default が SANITY 相当であることの直接 pin)。
      expect(out).toBe(mod.summarize(long, mod.SUMMARY_SANITY_CAP));
    });
  });

  // ── QA-2: 空/空白/欠落/非 string の prompt・prompt_response ガードの反証 (falsifiability pin) ──
  // mapHookEvent は `promptSummary ? {...} : {}` で空要約時にキーを載せない。always-emit 変異
  //   (要約が空でも prompt_summary/response_summary を載せる) でも従来 suite は GREEN のままだった
  //   (32/32)。ここで「空要約 → summary 無し・payload に prompt_summary/response_summary キー無し」を
  //   明示 assert し、ガード削除/always-emit 変異を RED 化する。
  describe("QA-2: 空要約ガード (falsifiability)", () => {
    const EMPTY_PROMPT_CASES: Array<[string, unknown]> = [
      ["空文字列", ""],
      ["空白のみ (畳むと空)", "   \n\t  "],
      ["欠落 (prompt キー無し)", undefined],
      ["非 string (数値)", 42],
      ["非 string (object)", { nested: "x" }],
    ];

    for (const [label, promptVal] of EMPTY_PROMPT_CASES) {
      it(`BeforeAgent.prompt = ${label} → turn.started に prompt_summary キー無し・summary 無し`, () => {
        const hook: Record<string, unknown> = {
          session_id: "qa2_sess",
          hook_event_name: "BeforeAgent",
          timestamp: "2026-07-10T00:00:00.000Z",
        };
        if (promptVal !== undefined) hook.prompt = promptVal;
        const ev = mod.mapHookEvent(hook)[0]!;
        expect(ev.event_type).toBe("turn.started");
        const payload = ev.payload as Record<string, unknown>;
        expect(Object.keys(payload)).toEqual(["kind"]); // prompt_summary キー無し
        expect("prompt_summary" in payload).toBe(false);
        expect(ev.summary).toBeUndefined(); // 「依頼:」ラベルも載せない
      });

      it(`AfterAgent.prompt_response = ${label} → turn.completed に response_summary キー無し・summary 無し`, () => {
        const hook: Record<string, unknown> = {
          session_id: "qa2_sess",
          hook_event_name: "AfterAgent",
          timestamp: "2026-07-10T00:00:00.000Z",
        };
        if (promptVal !== undefined) hook.prompt_response = promptVal;
        const ev = mod.mapHookEvent(hook)[0]!;
        expect(ev.event_type).toBe("turn.completed");
        const payload = ev.payload as Record<string, unknown>;
        expect(Object.keys(payload)).toEqual(["kind"]); // response_summary キー無し
        expect("response_summary" in payload).toBe(false);
        expect(ev.summary).toBeUndefined();
      });
    }
  });

  // ── INV-GEMINI-ADAPTER-NEVER-DENY (observe-only・shipped script を subprocess 実行) ──
  // 出荷 script を実 node で走らせ、あらゆる入力で stdout `{}` / exit 0 / decision 系キー不在を
  // 固定する。observe-only の by-construction 保証 (ADR 契約2)。
  describe("INV-GEMINI-ADAPTER-NEVER-DENY", () => {
    function run(
      input: string,
      env: Record<string, string> = {},
    ): { stdout: string; code: number } {
      const res = spawnSync(process.execPath, [ADAPTER_PATH], {
        input,
        encoding: "utf8",
        env: { ...process.env, ...env },
        timeout: 10_000,
      });
      return { stdout: res.stdout ?? "", code: res.status ?? -1 };
    }

    const DENY_KEYS = /decision|continue|stopReason|hookSpecificOutput|block|deny/;

    it("(a) 有効な hook・token 未設定 → stdout `{}` / exit 0", () => {
      const line = JSON.stringify({
        session_id: "s1",
        hook_event_name: "SessionStart",
        cwd: "/tmp/x",
        timestamp: "2026-07-09T13:12:56.967Z",
        source: "startup",
      });
      const { stdout, code } = run(line);
      expect(stdout.trim()).toBe("{}");
      expect(code).toBe(0);
      expect(DENY_KEYS.test(stdout)).toBe(false);
    });

    it("(b) 不正 JSON + token 設定 + 到達不能 backend → `{}` / exit 0 (fail-open)", () => {
      const { stdout, code } = run("not-json{", {
        INGEST_TOKEN: "t",
        ACTRADECK_INGEST_URL: "http://127.0.0.1:1",
      });
      expect(stdout.trim()).toBe("{}");
      expect(code).toBe(0);
      expect(DENY_KEYS.test(stdout)).toBe(false);
    });

    it("(c) 空 stdin → `{}` / exit 0", () => {
      const { stdout, code } = run("");
      expect(stdout.trim()).toBe("{}");
      expect(code).toBe(0);
    });

    it("(d) 危険コマンドの BeforeTool でも block しない (純観測) + 到達不能 backend で bounded", () => {
      const line = JSON.stringify({
        session_id: "s1",
        hook_event_name: "BeforeTool",
        timestamp: "2026-07-09T13:13:01.693Z",
        tool_name: "run_shell_command",
        tool_input: { command: "rm -rf /", description: "danger" },
      });
      const { stdout, code } = run(line, {
        INGEST_TOKEN: "t",
        ACTRADECK_INGEST_URL: "http://127.0.0.1:1",
      });
      expect(stdout.trim()).toBe("{}");
      expect(code).toBe(0);
      expect(DENY_KEYS.test(stdout)).toBe(false);
    });
  });

  // ── SEC-1 回帰: fixture 生テキストに公開ミラー汚染トークンが無い ───────────
  // 値のみ neutral 化・構造 REAL の方針 (opencode SEC-1 系譜) の at-rest 保証。
  describe("SEC-1 回帰: fixture が OSS coupling / 先頭スラッシュ無し home-dir トークンを含まない", () => {
    // scripts/lib/oss-patterns.sh の OSS_COUPLING_RE の gate-parity 手動コピー (bash を JS から
    //   import 不可)。各トークンは分割リテラルで構築し、この test ファイル自身が OSS coupling gate
    //   に at-rest でマッチしないようにする (opencode inv-opencode-adapter.test.ts と同 precedent)。
    const COUPLING_RE = new RegExp(
      [
        "/home" + "/owner",
        "019e" + "8e09",
        "takateru" + "hamada",
        "[Tt][Kk][Mm][Dd]",
        "[Hh]ydlogger",
        "[Rr]eftrix",
      ].join("|"),
    );
    const SLASH_LESS_HOME_RE = /(^|[^/])home\/owner/m;

    it("OSS_COUPLING_RE (gate-parity 手動コピー) のトークンが 0 件", () => {
      const hits = FIXTURE_RAW.split("\n").filter((l) => COUPLING_RE.test(l));
      expect(hits, `coupling token leaked in fixture:\n${hits.join("\n")}`).toEqual([]);
    });

    it("先頭スラッシュ無しの home-dir トークンが 0 件 (leading-slash anchor すり抜け形)", () => {
      const hits = FIXTURE_RAW.split("\n").filter((l) => SLASH_LESS_HOME_RE.test(l));
      expect(hits, `slash-less home-dir token leaked in fixture:\n${hits.join("\n")}`).toEqual([]);
    });
  });
});
