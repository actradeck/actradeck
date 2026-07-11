/**
 * INV-OPENCODE-ADAPTER-*: 外部アダプタ第1号 (opencode plugin adapter) の契約不変条件
 * (Triangle ADR 019f3c3b D8・R1 裁定 019f3c5e で SEC-1/QA-1/QA-2/L 群を強化)。
 *
 * anti-drift by construction: 読者が設置する **実ファイル** `docs/examples/opencode-adapter/adapter.js`
 * を dynamic import し (inv-contract-golden.test.ts の GOLDEN_DOC_RELPATH 流儀)、**REAL 捕獲**
 * fixture (`fixtures/opencode-events.sample.jsonl` = probe 実イベントの trim・**値のみ neutral 化**) を
 * 写像して検証する。adapter の写像が壊れる / event-model schema が動くと、このテストが RED になる。
 *
 * INV 6 本 (ADR D8) + R1 追加:
 *  - CONTRACT / PAYLOAD / MONOTONIC / NO-TERMINAL-FABRICATION / DEDUP / ERROR-MINIMIZED (INV)
 *  - SEC-1 回帰: fixture 生テキストに coupling/先頭スラッシュ無しの home-dir トークンが無い (公開ミラー汚染 pin)
 *  - QA-1: ERROR-MINIMIZED を positive key-allowlist + deep-walk 負照合へ二段強化 (KM6 falsify)
 *  - QA-2: fail-open 配送層 unit (有界リング最古 drop / retry 上限 drop / token 未設定無効 / 順序保存)
 *  - QA-3: 写像 histogram (event_type Set) の pin
 *  - QA-6: session 跨ぎ floor 独立性
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ALL_EVENT_TYPES,
  EventPayload,
  isKnownProvider,
  isMonotonicNonDecreasing,
  isUuidV7,
  PROVIDER_SLUG_RE,
  safeParseEvent,
  toEpochMs,
} from "../src/index.js";

// ── 実 adapter (.mjs) と REAL fixture を自 dir から解決する ─────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
const ADAPTER_RELPATH = "../../../docs/examples/opencode-adapter/adapter.js";
const FIXTURE_RELPATH =
  "../../../docs/examples/opencode-adapter/fixtures/opencode-events.sample.jsonl";
const ADAPTER_PATH = resolve(HERE, ADAPTER_RELPATH);
const FIXTURE_PATH = resolve(HERE, FIXTURE_RELPATH);

// dynamic import (absolute file URL) — inv-contract-golden.test.ts と同流儀 (docs/ 相対資産の読込)。
// E2E-1 (decision 019f3c99): opencode ローダは非関数 export でファイルを poison するため adapter は
//   **default 単独 export** で、pure helpers/定数は default 関数の**プロパティ**として公開される。
//   よってテストは module namespace `mod` (LOADER-SAFE 検証用) と、helper アクセス用の `mod.default`
//   (= `adapter`) の 2 つを保持する。
type AdapterFactory = ((ctx?: unknown) => Promise<Record<string, unknown>>) & {
  uuidv7: () => string;
  mapCaptureLine: (line: unknown, state: unknown) => Record<string, unknown>[];
  mapToolBefore: (input: unknown, output: unknown, state: unknown) => Record<string, unknown>[];
  mapToolAfter: (input: unknown, output: unknown, state: unknown) => Record<string, unknown>[];
  mapEvent: (event: unknown, state: unknown) => Record<string, unknown>[];
  createAdapterState: (opts?: { now?: () => number }) => unknown;
  resolveConfig: (env?: Record<string, string | undefined>) => {
    url: string;
    token: string;
    enabled: boolean;
  };
  createDelivery: (
    config: { url: string; token: string },
    opts?: {
      fetchImpl?: (url: string, init: { body: string }) => Promise<{ ok: boolean } | undefined>;
      sleepImpl?: (ms: number) => Promise<void>;
      autoDrain?: boolean;
      diag?: Diagnostics;
    },
  ) => {
    enqueue: (ev: Record<string, unknown>) => void;
    drain: () => Promise<void>;
    pending: () => Record<string, unknown>[];
    size: () => number;
    dropped: () => number;
  };
  createDiagnostics: (opts?: {
    env?: Record<string, string | undefined>;
    write?: (s: string) => void;
  }) => Diagnostics;
  safeMap: (
    hook: string,
    fn: () => Record<string, unknown>[],
    diag: Diagnostics,
  ) => Record<string, unknown>[];
  // issue #8: turn 稼働中 heartbeat (ADR 019f4cdb slice③)。
  makeHeartbeatEvent: (state: unknown, sessionId: string) => Record<string, unknown>;
  createHeartbeat: (opts?: {
    intervalMs?: number;
    setTimer?: (fn: () => void, ms: number) => { unref?: () => void } | number;
    clearTimer?: (h: unknown) => void;
    onTick?: (sessionId: string) => void;
  }) => {
    start: (sessionId: string) => void;
    stop: (sessionId: string) => void;
    observe: (events: Record<string, unknown>[]) => void;
    activeCount: () => number;
    running: () => boolean;
  };
  RING_CAP: number;
  MAX_RETRY: number;
  HEARTBEAT_INTERVAL_MS: number;
};

type Diagnostics = {
  noteDrop: (reason: string, n?: number) => void;
  noteMappingError: (hook: string) => void;
  drops: () => number;
  mappingErrors: () => number;
};
const mod = (await import(pathToFileURL(ADAPTER_PATH).href)) as { default: AdapterFactory };
const adapter = mod.default;

type CaptureLine = { kind: string; data: Record<string, unknown> };

const FIXTURE_RAW = readFileSync(FIXTURE_PATH, "utf8");

function loadFixture(): CaptureLine[] {
  return FIXTURE_RAW.split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as CaptureLine);
}

/** fixture 全行を capture 順に写像し、発行イベントを平坦化して返す。 */
function mapAll(state: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of loadFixture()) {
    for (const ev of adapter.mapCaptureLine(line, state)) out.push(ev);
  }
  return out;
}

/** JSON を deep-walk して全ての string leaf 値を集める (QA-1 負照合用)。 */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value && typeof value === "object")
    for (const v of Object.values(value)) collectStrings(v, out);
  return out;
}

/** 述語が真になるまで macrotask を回して待つ (fire-and-forget な drain の完了検知・QA-R1)。 */
async function waitFor(pred: () => boolean, budgetMs = 1000): Promise<boolean> {
  const start = Date.now();
  while (!pred() && Date.now() - start < budgetMs) {
    await new Promise((r) => setTimeout(r, 5));
  }
  return pred();
}

describe("INV-OPENCODE-ADAPTER-*: opencode plugin adapter (ADR 019f3c3b D8 / R1 019f3c5e)", () => {
  const fixture = loadFixture();

  it("fixture が REAL 捕獲を読める (行数 > 0・event/tool.* を含む)", () => {
    expect(fixture.length).toBeGreaterThan(0);
    const kinds = new Set(fixture.map((l) => l.kind));
    expect(kinds.has("event")).toBe(true);
    expect(kinds.has("tool.before")).toBe(true);
    expect(kinds.has("tool.after")).toBe(true);
  });

  it("写像が実際にイベントを産む (drop だけで空にならない)", () => {
    const events = mapAll(adapter.createAdapterState());
    expect(events.length).toBeGreaterThan(0);
  });

  // ── INV-OPENCODE-ADAPTER-LOADER-SAFE (E2E-1・decision 019f3c99) ──────────
  // opencode 1.17.14 の plugin ローダは module の **全 export を factory として呼び**、
  //   **非関数 export が 1 つでもあるとモジュール全体を silent reject** する。よって plugin は
  //   default 単独 export でなければならない (helpers/定数は default 関数のプロパティ)。
  //   named export (関数でも) を 1 つ足すと factory 誤呼出し、非関数を足すと poison ゆえ、
  //   ここで「namespace === {default} ∧ typeof default === function」を回帰固定する。
  describe("INV-OPENCODE-ADAPTER-LOADER-SAFE", () => {
    it("module namespace は default 単独・かつ関数 (named/非関数 export 再混入で RED)", () => {
      expect(Object.keys(mod)).toEqual(["default"]);
      expect(typeof mod.default).toBe("function");
      // 実 opencode が呼ぶのは default のみ。helpers は default のプロパティとして存在する。
      expect(typeof adapter.mapEvent).toBe("function");
      expect(typeof adapter.createDelivery).toBe("function");
      // TDA-R3-3: uuidv7 も default のプロパティ (event_id 生成器・型定義の 10 プロパティ整合)。
      expect(typeof adapter.uuidv7).toBe("function");
    });
  });

  // ── SEC-1 回帰: fixture 生テキストに公開ミラー汚染トークンが無い ───────────
  // 値のみ neutral 化・構造 REAL の方針 (R1 裁定) の at-rest 保証。gate seam 非依存で
  // clean-by-construction を pin する。fixture に汚染が再混入すると RED。
  describe("SEC-1 回帰: fixture が OSS coupling / 先頭スラッシュ無し home-dir トークンを含まない", () => {
    // SEC-R2-1: scripts/lib/oss-patterns.sh:86 の OSS_COUPLING_RE の **手動コピー** (bash の
    //   ゲート定義を JS から import できないため)。**変更時は両者を同期すること**。実ゲートと同強度
    //   (PROJECT_ID は full-uuid でなく 8-char prefix・maintainer handle の char-class alternative
    //   を含む)。**各トークンは分割リテラルで構築**し、この test ファイル自身が OSS coupling gate
    //   (fixtures/tests も除外しない厳格スキャン・prepare-oss.sh Phase4) に **at-rest でマッチしない**
    //   ようにする (redaction fixture の split-literal と同 precedent・E2E-1b 後の gate FAIL 修正)。
    //   runtime の regex 機能は従来と不変 (SEC-R2-1 mutation で回帰固定)。
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
    // SEC-1 の核: 先頭スラッシュ無しの home-dir 結合トークン (sanitizer/COUPLING_RE の leading-`/` anchor をすり抜けた形)。
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

  // ── INV-OPENCODE-ADAPTER-CONTRACT ───────────────────────────────────────
  describe("INV-OPENCODE-ADAPTER-CONTRACT", () => {
    it("全写像出力が parseEvent を通過し 3 次元規則 (provider/source/event_type) と UUIDv7 を満たす", () => {
      const events = mapAll(adapter.createAdapterState());
      for (const ev of events) {
        const res = safeParseEvent(ev);
        if (!res.success) {
          throw new Error(
            `mapped event failed parseEvent (${String(ev.event_type)}): ${res.error.message}`,
          );
        }
        expect(ev.provider).toBe("opencode");
        expect(PROVIDER_SLUG_RE.test(String(ev.provider))).toBe(true);
        expect(isKnownProvider(String(ev.provider))).toBe(false);
        expect(ev.source).toBe("external");
        expect(ALL_EVENT_TYPES).toContain(ev.event_type);
        expect(isUuidV7(String(ev.event_id))).toBe(true);
        expect(ev.capture_mode).toBeUndefined();
      }
    });

    // QA-3: 写像 histogram (10 event_type) の Set 一致 pin。写像表が増減すると RED。
    it("QA-3: fixture が産む event_type 集合が既知の 10 種と一致", () => {
      const produced = new Set(
        mapAll(adapter.createAdapterState()).map((e) => String(e.event_type)),
      );
      const expected = new Set([
        "session.started",
        "turn.started",
        "agent.message.delta",
        "command.started",
        "command.completed",
        "tool.started",
        "tool.completed",
        "diff.updated",
        "error",
        "turn.completed",
      ]);
      expect([...produced].sort()).toEqual([...expected].sort());
    });
  });

  // ── QA-5: write / edit / webfetch tool の実 grounding 写像 ───────────────
  // REAL captured (opencode 1.17.14 · ollama llama3.1:8b-16k・値のみ neutral 化) の
  //   write/edit/webfetch tool.execute.before/after を mapToolBefore/mapToolAfter が
  //   tool.started / tool.completed へ正しく写像することを固定する。
  // - before(非bash) → tool.started(running.tool_preparing)・args を payload.input へ verbatim 転送。
  // - after(非bash)  → tool.completed(running.model_wait)・tool 出力は **載せない** (NO-RAW/最小化)。
  describe("QA-5: write/edit/webfetch tool 写像 (REAL grounded)", () => {
    function findTool(kind: "tool.before" | "tool.after", tool: string): CaptureLine {
      const found = fixture.find(
        (l) => l.kind === kind && (l.data.input as { tool?: string })?.tool === tool,
      );
      expect(found, `fixture に ${tool} の ${kind} がある`).toBeTruthy();
      return found!;
    }

    for (const tool of ["write", "edit", "webfetch"]) {
      it(`${tool}: before → tool.started(args 転送) / after → tool.completed(出力非載)`, () => {
        const state = adapter.createAdapterState();
        const before = findTool("tool.before", tool);
        const startedEvents = adapter.mapCaptureLine(before, state);
        expect(startedEvents.length).toBe(1);
        const started = startedEvents[0]!;
        expect(started.event_type).toBe("tool.started");
        expect(started.state).toBe("running.tool_preparing");
        expect(safeParseEvent(started).success).toBe(true);
        const sp = started.payload as Record<string, unknown>;
        expect(sp.kind).toBe("tool.started");
        expect(sp.tool_name).toBe(tool);
        // args (before.output.args) が payload.input へ verbatim 転送される (QA-5 の grounding 対象)。
        const expectedArgs = (before.data.output as { args?: unknown })?.args;
        expect(sp.input).toEqual(expectedArgs);

        const after = findTool("tool.after", tool);
        const completedEvents = adapter.mapCaptureLine(after, state);
        expect(completedEvents.length).toBe(1);
        const completed = completedEvents[0]!;
        expect(completed.event_type).toBe("tool.completed");
        expect(completed.state).toBe("running.model_wait");
        expect(safeParseEvent(completed).success).toBe(true);
        const cp = completed.payload as Record<string, unknown>;
        expect(cp.kind).toBe("tool.completed");
        expect(cp.tool_name).toBe(tool);
        // NO-RAW/源流最小化: tool 出力 (after.output) は payload へ一切載せない (tool_name のみ)。
        expect(Object.keys(cp).sort()).toEqual(["kind", "tool_name"]);
      });
    }
  });

  // ── INV-OPENCODE-ADAPTER-PAYLOAD ────────────────────────────────────────
  describe("INV-OPENCODE-ADAPTER-PAYLOAD", () => {
    it("payload.kind === event_type ∧ EventPayload discriminated union を通過", () => {
      const events = mapAll(adapter.createAdapterState());
      let checked = 0;
      for (const ev of events) {
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
      expect(checked).toBeGreaterThan(0);
    });
  });

  // ── INV-OPENCODE-ADAPTER-MONOTONIC ──────────────────────────────────────
  describe("INV-OPENCODE-ADAPTER-MONOTONIC", () => {
    function assertPerSessionMonotonic(events: Record<string, unknown>[]) {
      const bySession = new Map<string, string[]>();
      for (const ev of events) {
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
    }

    it("既定 now で capture 順の発行 timestamp が session 毎 非減少", () => {
      assertPerSessionMonotonic(mapAll(adapter.createAdapterState()));
    });

    it("時刻源が巻き戻っても floor が session 毎 非減少を保つ (floor 依存・falsifiable)", () => {
      const events = mapAll(adapter.createAdapterState({ now: () => 1000 }));
      assertPerSessionMonotonic(events);
    });

    // QA-6: floor は **session 毎に独立**。高 sourceMs の session A が低 sourceMs の session B を
    //   引きずり上げない (global floor だと B が A の値に汚染され RED)。
    it("QA-6: session 跨ぎで floor が独立 (A の高 floor が B の低 timestamp を汚染しない)", () => {
      const state = adapter.createAdapterState();
      const a = adapter.mapEvent(
        {
          type: "session.created",
          properties: { sessionID: "ses_A", info: { id: "ses_A", time: { created: 2_000_000 } } },
        },
        state,
      );
      const b = adapter.mapEvent(
        {
          type: "session.created",
          properties: { sessionID: "ses_B", info: { id: "ses_B", time: { created: 1_000 } } },
        },
        state,
      );
      expect(toEpochMs(String(a[0]!.timestamp))).toBe(2_000_000);
      // B は自分の 1_000 を保持 (A の floor 2_000_000 に引きずられない)。
      expect(toEpochMs(String(b[0]!.timestamp))).toBe(1_000);
    });
  });

  // ── INV-OPENCODE-ADAPTER-NO-TERMINAL-FABRICATION ────────────────────────
  describe("INV-OPENCODE-ADAPTER-NO-TERMINAL-FABRICATION", () => {
    it("session.idle は turn.completed(state:idle) を産み、session.ended を捏造しない", () => {
      const events = mapAll(adapter.createAdapterState());
      expect(events.some((e) => e.event_type === "session.ended")).toBe(false);
      const idleLine = fixture.find(
        (l) => l.kind === "event" && (l.data as { type?: string }).type === "session.idle",
      );
      expect(idleLine, "fixture に session.idle が含まれる").toBeTruthy();
      const completed = events.filter(
        (e) => e.event_type === "turn.completed" && e.state === "idle",
      );
      expect(completed.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── INV-OPENCODE-ADAPTER-DEDUP ──────────────────────────────────────────
  describe("INV-OPENCODE-ADAPTER-DEDUP", () => {
    it("同一 callID の hook 二重 + message.part.updated(tool) 二重入力でも started/完了 各1", () => {
      const before = fixture.find((l) => l.kind === "tool.before")!;
      const after = fixture.find((l) => l.kind === "tool.after")!;
      const toolParts = fixture.filter(
        (l) =>
          l.kind === "event" &&
          (l.data as { type?: string }).type === "message.part.updated" &&
          (l.data as { properties?: { part?: { type?: string } } }).properties?.part?.type ===
            "tool",
      );
      expect(before && after, "fixture に bash の before/after がある").toBeTruthy();
      expect(toolParts.length).toBeGreaterThanOrEqual(1);

      const state = adapter.createAdapterState();
      const emitted: Record<string, unknown>[] = [];
      // QA-4 注記: message.part.updated(tool) は現状 mapEvent が drop する (hook authoritative) ため
      //   **本注入は inert** (0 event)。ここに混ぜるのは、将来 cross-source 写像 (tool part も
      //   command lifecycle へ寄与させる変更) が入った際に「同 callID で二重採番しない」回帰を
      //   固定するため。dedup の load-bearing な falsify は **hook の二重投入** (下記 before/after ×2)
      //   が担う (guard 除去で started/completed が 2 になり RED)。
      for (const line of [before, before, ...toolParts, ...toolParts, after, after]) {
        for (const ev of adapter.mapCaptureLine(line, state)) emitted.push(ev);
      }
      const started = emitted.filter((e) => e.event_type === "command.started");
      const completed = emitted.filter((e) => e.event_type === "command.completed");
      expect(started.length, "command.started はちょうど 1").toBe(1);
      expect(completed.length, "command.completed はちょうど 1").toBe(1);
      const p = started[0]!.payload as Record<string, unknown>;
      expect(String(p.request_id)).toMatch(/^tu:/);
    });
  });

  // ── INV-OPENCODE-ADAPTER-ERROR-MINIMIZED (QA-1 二段強化) ─────────────────
  describe("INV-OPENCODE-ADAPTER-ERROR-MINIMIZED", () => {
    it("error 写像出力は positive key-allowlist ⊆ {kind,message,retryable} かつ封筒値が値空間に現れない", () => {
      const errLine = fixture.find(
        (l) => l.kind === "event" && (l.data as { type?: string }).type === "session.error",
      );
      expect(errLine, "fixture に session.error がある").toBeTruthy();

      // 捨てるべき封筒値を実 fixture から動的に取る (hardcode ドリフト回避)。
      const props = (errLine!.data as { properties: Record<string, unknown> }).properties;
      const data = (props.error as { data: Record<string, unknown> }).data;
      const droppedUrl = (data.metadata as { url: string }).url;
      const droppedBody = data.responseBody as string;
      const droppedHeaders = data.responseHeaders as Record<string, string>;
      const droppedValues = [droppedUrl, droppedBody, ...Object.values(droppedHeaders)];
      expect(droppedUrl && droppedBody).toBeTruthy();

      const state = adapter.createAdapterState();
      const events = adapter.mapEvent(errLine!.data, state);
      expect(events.length).toBe(1);
      const out = events[0]!;
      expect(out.event_type).toBe("error");

      // (a) positive key-allowlist: payload キー集合 ⊆ {kind, message, retryable}。余剰キーで RED。
      const payload = out.payload as Record<string, unknown>;
      const ALLOWED = new Set(["kind", "message", "retryable"]);
      for (const k of Object.keys(payload)) {
        expect(ALLOWED.has(k), `payload に許可外キー: ${k}`).toBe(true);
      }
      expect(payload.kind).toBe("error");
      expect(typeof payload.message).toBe("string");
      expect(payload.retryable).toBe(false);

      // QA-R2: 厳密一致 anchor。message/summary が入力から **byte 等価**であることを固定する。
      //   substring leak (責 responseBody prefix を message へ連結する等の V3/V4 変種) は
      //   append/slice で厳密一致が壊れるため RED になる。
      const inputMessage = data.message as string;
      const errName = (props.error as { name?: string }).name;
      expect(payload.message).toBe(inputMessage);
      expect(out.summary).toBe(errName ? `${errName}: ${inputMessage}` : inputMessage);

      // (b) エスケープ正規化した負照合: 出力を JSON.parse → deep-walk した全 string 値のどれにも
      //     封筒値 (部分文字列含む) が現れない。JSON.stringify の \" エスケープ非対称を回避する。
      const reparsed = JSON.parse(JSON.stringify(out));
      const strings = collectStrings(reparsed);
      for (const s of strings) {
        for (const dv of droppedValues) {
          expect(
            s.includes(dv),
            `dropped 封筒値が出力の値空間に leak: ${dv} in ${JSON.stringify(s)}`,
          ).toBe(false);
        }
      }
      // フィールド名自体も現れない (念押し)。
      expect(JSON.stringify(out).includes("responseHeaders")).toBe(false);
      expect(JSON.stringify(out).includes("responseBody")).toBe(false);
      expect(safeParseEvent(out).success).toBe(true);
    });
  });

  // ── QA-2: fail-open 配送層 unit (adapter.js の default factory プロパティを直接駆動) ───
  describe("QA-2: fail-open 配送層", () => {
    it("(a) 有界リング cap 超過で最古を drop", () => {
      const d = adapter.createDelivery(
        { url: "http://127.0.0.1:1/x", token: "t" },
        { autoDrain: false },
      );
      for (let i = 0; i < adapter.RING_CAP + 1; i++) d.enqueue({ event_id: `e${i}` });
      expect(d.size()).toBe(adapter.RING_CAP);
      // 最古 (e0) が落ち、先頭は e1。
      expect(d.pending()[0]!.event_id).toBe("e1");
      expect(d.pending()[adapter.RING_CAP - 1]!.event_id).toBe(`e${adapter.RING_CAP}`);
    });

    it("(b) fetch 失敗が retry 上限に達したら drop (MAX_RETRY+1 回試行・throw しない)", async () => {
      let calls = 0;
      const d = adapter.createDelivery(
        { url: "http://127.0.0.1:1/x", token: "t" },
        {
          autoDrain: false,
          sleepImpl: async () => {},
          fetchImpl: async () => {
            calls += 1;
            throw new Error("network down");
          },
        },
      );
      d.enqueue({ event_id: "e0" });
      await d.drain(); // fail-open: throw しない
      expect(calls).toBe(adapter.MAX_RETRY + 1); // attempt 0..MAX_RETRY
      expect(d.size()).toBe(0); // drop 済み
    });

    it("(c) INGEST_TOKEN 未設定で enabled:false かつ plugin は no-op (state/hook 不生成)", async () => {
      expect(adapter.resolveConfig({}).enabled).toBe(false);
      expect(adapter.resolveConfig({ INGEST_TOKEN: "x" }).enabled).toBe(true);

      const saved = process.env.INGEST_TOKEN;
      try {
        delete process.env.INGEST_TOKEN;
        const hooks = await adapter({});
        // 静かに無効: フックを一切持たない ({}) ため opencode は何も蓄積しない。
        expect(Object.keys(hooks)).toEqual([]);
        expect(hooks.event).toBeUndefined();
      } finally {
        if (saved === undefined) delete process.env.INGEST_TOKEN;
        else process.env.INGEST_TOKEN = saved;
      }
    });

    it("(d) 配送は投入順を保存する (per-messageID 統合せず FIFO batch)", async () => {
      const batches: string[][] = [];
      const d = adapter.createDelivery(
        { url: "http://127.0.0.1:1/x", token: "t" },
        {
          autoDrain: false,
          sleepImpl: async () => {},
          fetchImpl: async (_url, init) => {
            const arr = JSON.parse(init.body) as { event_id: string }[];
            batches.push(arr.map((e) => e.event_id));
            return { ok: true };
          },
        },
      );
      const order = ["d0", "d1", "d2", "d3", "d4"];
      for (const id of order) d.enqueue({ event_id: id });
      await d.drain();
      expect(batches.flat()).toEqual(order);
    });
  });

  // ── TDA-4b: fail-open 可観測性 (drop / mapping-error カウンタ + ACTRADECK_ADAPTER_DEBUG stderr) ──
  // fail-open の silent 握り潰し (ring 溢れ / retry 上限 drop / 写像 throw) を **原文非依存の件数**で
  // 可観測にする。ACTRADECK_ADAPTER_DEBUG (非空) のときのみ enum+件数のみ stderr へ出す (NO-RAW)。
  // カウンタ除去 (mutation) で各 assert が RED になる (falsifiable)。
  describe("TDA-4b: fail-open 可観測性", () => {
    it("(a) ring 溢れ drop が dropped() に計上される (autoDrain:false)", () => {
      const d = adapter.createDelivery(
        { url: "http://127.0.0.1:1/x", token: "t" },
        { autoDrain: false },
      );
      expect(d.dropped()).toBe(0);
      for (let i = 0; i < adapter.RING_CAP + 3; i++) d.enqueue({ event_id: `e${i}` });
      expect(d.size()).toBe(adapter.RING_CAP);
      // 3 件溢れ → dropped() が 3 (最古 e0,e1,e2 が落ちた)。
      expect(d.dropped()).toBe(3);
    });

    it("(b) retry 上限 drop が dropped() に計上される", async () => {
      const d = adapter.createDelivery(
        { url: "http://127.0.0.1:1/x", token: "t" },
        {
          autoDrain: false,
          sleepImpl: async () => {},
          fetchImpl: async () => {
            throw new Error("network down");
          },
        },
      );
      d.enqueue({ event_id: "e0" });
      d.enqueue({ event_id: "e1" });
      await d.drain(); // fail-open: throw しない。batch(2 件) が retry 上限で drop。
      expect(d.size()).toBe(0);
      expect(d.dropped()).toBe(2); // batch.length 分計上
    });

    it("(c) mapping-error は safeMap 経由で計上され fail-open (空配列) に縮退する", () => {
      const diag = adapter.createDiagnostics();
      const state = adapter.createAdapterState();
      // getter が throw する壊れた event を mapEvent へ通す (defensive: 通常 mapEvent は throw しない)。
      const broken: Record<string, unknown> = { type: "session.created" };
      Object.defineProperty(broken, "properties", {
        get() {
          throw new Error("boom");
        },
        enumerable: true,
      });
      const out = adapter.safeMap("event", () => adapter.mapEvent(broken, state), diag);
      expect(out).toEqual([]); // fail-open: 空配列に縮退
      expect(diag.mappingErrors()).toBe(1);
      // 正常写像は counter を増やさない。
      const ok = adapter.safeMap(
        "event",
        () =>
          adapter.mapEvent(
            {
              type: "session.created",
              properties: { sessionID: "ses_x", info: { id: "ses_x" } },
            },
            state,
          ),
        diag,
      );
      expect(ok.length).toBe(1);
      expect(diag.mappingErrors()).toBe(1);
    });

    it("(d) ACTRADECK_ADAPTER_DEBUG 有効時のみ stderr へ書く・enum+件数のみ (NO-RAW)", () => {
      // 無効 (env 未設定): 一切書かない。
      const linesOff: string[] = [];
      const diagOff = adapter.createDiagnostics({ env: {}, write: (s) => linesOff.push(s) });
      diagOff.noteDrop("ring-overflow", 2);
      diagOff.noteMappingError("event");
      expect(linesOff).toEqual([]);

      // 有効: enum + 非負整数のみの診断を書く。
      const linesOn: string[] = [];
      const diagOn = adapter.createDiagnostics({
        env: { ACTRADECK_ADAPTER_DEBUG: "1" },
        write: (s) => linesOn.push(s),
      });
      diagOn.noteDrop("ring-overflow", 2);
      diagOn.noteDrop("retry-cap", 1);
      diagOn.noteMappingError("tool.before");
      expect(linesOn.length).toBe(3);
      for (const l of linesOn) {
        expect(l.startsWith("[actradeck-adapter] ")).toBe(true);
        // NO-RAW: 行に許可された enum / count 語彙以外の英字トークンが無いことを確認する。
        // 許容: adapter ラベル / drop kind / hook enum / count=N の非負整数。
        expect(l).toMatch(
          /^\[actradeck-adapter\] (drop (ring-overflow|retry-cap) count=\d+|mapping-error hook=(event|tool\.before|tool\.after) count=\d+)\n$/,
        );
      }
      // 累計が単調増加している (drops 2→3, mappingErrors 1)。
      expect(diagOn.drops()).toBe(3);
      expect(diagOn.mappingErrors()).toBe(1);
    });

    // SEC-1 回帰 (裁定後 unblock): 診断 stderr write が throw (EPIPE 等) しても
    //   enqueue/hook へ throw を戻さない = fail-open を維持する。writeDebug の try/catch を外すと
    //   RED (enqueue が overflow 時に throw する)。debug 診断が **まさに drop 時に host を壊す**
    //   回帰を構造固定する。
    it("(e) SEC-1: 診断 write が throw しても enqueue は fail-open (throw を opencode へ戻さない)", () => {
      const throwingWrite = () => {
        throw new Error("EPIPE: broken pipe (daemon 化 opencode の閉じた stderr)");
      };
      const diag = adapter.createDiagnostics({
        env: { ACTRADECK_ADAPTER_DEBUG: "1" }, // debug 有効 → writeDebug が write を呼ぶ
        write: throwingWrite,
      });
      const d = adapter.createDelivery(
        { url: "http://127.0.0.1:1/x", token: "t" },
        { autoDrain: false, diag },
      );
      // ring を溢れさせる → noteDrop("ring-overflow") → writeDebug → throwingWrite。
      // writeDebug が guard していれば enqueue は throw しない (fail-open)。guard を外すと throw。
      expect(() => {
        for (let i = 0; i < adapter.RING_CAP + 2; i++) d.enqueue({ event_id: `e${i}` });
      }).not.toThrow();
      // 診断 write が失敗しても drop 計数は保たれる (best-effort write・カウンタは先に更新)。
      expect(d.dropped()).toBe(2);
    });
  });

  // ── issue #8: turn 稼働中 heartbeat (ADR 019f4cdb slice③) ─────────────────
  // turn 実行中のみ周期 heartbeat(process_alive:true) を発行する。event 形状 (makeHeartbeatEvent) と
  // スケジューリング (createHeartbeat・turn.started で開始 / turn.completed・error で停止・単一 timer・
  // unref・fail-open) を fixture 駆動 + 注入 timer で決定的に検証する。heartbeat は timer 駆動ゆえ
  // mapCaptureLine の写像 histogram (既知 10 種) には現れない (QA-3 は不変・純 additive)。
  const MAIN_SESSION = "ses_0c3d3fa12ffeJaaqMOZunsK58h";

  describe("issue #8: turn 稼働中 heartbeat", () => {
    it("HEARTBEAT_INTERVAL_MS は 20s で cockpit GAP_WARN_MS(60s) を確実に下回る", () => {
      expect(adapter.HEARTBEAT_INTERVAL_MS).toBe(20_000);
      // 60_000 は webui GAP_WARN_MS の **意図的 mirror** — import で機械強制せず (dep 逆流回避)、
      // 変更時は apps/webui/src/ui/audit-coverage-display.ts:26 と同期すること (双方向 mirror)。
      expect(adapter.HEARTBEAT_INTERVAL_MS).toBeLessThan(60_000);
    });

    it("makeHeartbeatEvent が heartbeat/process_alive:true の正規化イベントを産む (contract+payload 通過・state 省略)", () => {
      const state = adapter.createAdapterState();
      const hb = adapter.makeHeartbeatEvent(state, "ses_hb_probe");
      expect(hb.event_type).toBe("heartbeat");
      expect(hb.provider).toBe("opencode");
      expect(hb.source).toBe("external");
      expect(hb.session_id).toBe("ses_hb_probe");
      expect(isUuidV7(String(hb.event_id))).toBe(true);
      // 契約: heartbeat 等の状態を持たないイベントは state 省略可 (event.ts:109)。
      expect(hb.state).toBeUndefined();
      const payload = hb.payload as Record<string, unknown>;
      expect(payload.kind).toBe("heartbeat");
      expect(payload.process_alive).toBe(true);
      // QA-1: exact-key pin (tool/error payload の precedent と対称)。動的 field 混入を falsifiable に。
      expect(Object.keys(payload).sort()).toEqual(["kind", "process_alive"]);
      expect(EventPayload.safeParse(payload).success).toBe(true);
      const res = safeParseEvent(hb);
      if (!res.success) throw new Error(`heartbeat failed parseEvent: ${res.error.message}`);
      // 3 次元規則 (provider=opencode / source=external / event_type=heartbeat) を満たす。
      expect(isKnownProvider(String(hb.provider))).toBe(false);
      expect(ALL_EVENT_TYPES).toContain(hb.event_type);
    });

    it("fixture 駆動: turn 開始→heartbeat N 発→turn 終了→heartbeat 停止 (注入 timer・単一・unref)", () => {
      // 注入 timer: tick 関数を捕捉し fake handle(unref 記録) を返す。手動で tick を撃つ (決定的)。
      let capturedTick: (() => void) | null = null;
      let setCount = 0;
      let clearCount = 0;
      let unrefCount = 0;
      const emitted: Record<string, unknown>[] = [];
      const emitState = adapter.createAdapterState();
      const hbm = adapter.createHeartbeat({
        setTimer: (fn) => {
          capturedTick = fn;
          setCount += 1;
          return {
            unref: () => {
              unrefCount += 1;
            },
          };
        },
        clearTimer: () => {
          clearCount += 1;
          capturedTick = null; // clear 後は tick が発火しないことを模す。
        },
        onTick: (sessionId) => {
          emitted.push(adapter.makeHeartbeatEvent(emitState, sessionId));
        },
      });

      // 初期: 停止中 (turn 稼働中でないので heartbeat は出ない)。
      expect(hbm.running()).toBe(false);
      expect(hbm.activeCount()).toBe(0);

      // REAL fixture を capture 順に写像し MAIN_SESSION の turn ライフサイクルを取り出す。
      const mapState = adapter.createAdapterState();
      const mainEvents: Record<string, unknown>[] = [];
      for (const line of loadFixture()) {
        for (const ev of adapter.mapCaptureLine(line, mapState)) {
          if (ev.session_id === MAIN_SESSION) mainEvents.push(ev);
        }
      }
      const turnStarted = mainEvents.find((e) => e.event_type === "turn.started");
      const turnCompleted = mainEvents.find((e) => e.event_type === "turn.completed");
      expect(turnStarted, "fixture に MAIN の turn.started がある").toBeTruthy();
      expect(turnCompleted, "fixture に MAIN の turn.completed がある").toBeTruthy();

      // turn.started を観測 → 単一 timer 起動・unref・active 1。
      hbm.observe([turnStarted!]);
      expect(hbm.running()).toBe(true);
      expect(hbm.activeCount()).toBe(1);
      expect(setCount).toBe(1);
      expect(unrefCount).toBe(1);
      expect(capturedTick).toBeTypeOf("function");

      // turn 稼働中: tick を N 発撃つ → MAIN へ heartbeat N 発 (全て契約通過)。
      const N = 3;
      for (let i = 0; i < N; i++) capturedTick!();
      expect(emitted.length).toBe(N);
      for (const hb of emitted) {
        expect(hb.event_type).toBe("heartbeat");
        expect(hb.session_id).toBe(MAIN_SESSION);
        expect((hb.payload as Record<string, unknown>).process_alive).toBe(true);
        expect(safeParseEvent(hb).success).toBe(true);
      }

      // 割込みで turn.started が重なっても timer は再張されない (二重化防止)。
      hbm.observe([turnStarted!]);
      expect(setCount).toBe(1);
      expect(hbm.activeCount()).toBe(1);

      // turn.completed を観測 → 停止・timer clear・active 0。
      hbm.observe([turnCompleted!]);
      expect(hbm.running()).toBe(false);
      expect(hbm.activeCount()).toBe(0);
      expect(clearCount).toBe(1);

      // 停止後: これ以上 heartbeat は増えない (active 空)。
      const before = emitted.length;
      hbm.observe([turnCompleted!]); // 冪等 (既に stop 済み)
      expect(emitted.length).toBe(before);
      expect(hbm.running()).toBe(false);
    });

    it("error 観測で heartbeat が停止する (turn 終了/セッション終了/エラーで停止)", () => {
      let clearCount = 0;
      const hbm = adapter.createHeartbeat({
        setTimer: () => ({ unref() {} }),
        clearTimer: () => {
          clearCount += 1;
        },
        onTick: () => {},
      });
      hbm.start("ses_err");
      expect(hbm.running()).toBe(true);
      hbm.observe([{ event_type: "error", session_id: "ses_err" }]);
      expect(hbm.running()).toBe(false);
      expect(clearCount).toBe(1);
    });

    it("多重 session turn: timer は単一・tick で各 active session へ 1 発ずつ・片方完了で他方継続", () => {
      let captured: (() => void) | null = null;
      let setCount = 0;
      const ticks: string[] = [];
      const hbm = adapter.createHeartbeat({
        setTimer: (fn) => {
          captured = fn;
          setCount += 1;
          return { unref() {} };
        },
        clearTimer: () => {
          captured = null;
        },
        onTick: (sid) => ticks.push(sid),
      });
      hbm.observe([
        { event_type: "turn.started", session_id: "ses_A" },
        { event_type: "turn.started", session_id: "ses_B" },
      ]);
      expect(setCount).toBe(1); // 単一 timer (二重化防止)
      expect(hbm.activeCount()).toBe(2);
      captured!();
      expect(ticks.slice().sort()).toEqual(["ses_A", "ses_B"]);
      // A だけ完了 → B は継続 (timer 生存)。
      hbm.observe([{ event_type: "turn.completed", session_id: "ses_A" }]);
      expect(hbm.running()).toBe(true);
      expect(hbm.activeCount()).toBe(1);
      ticks.length = 0;
      captured!();
      expect(ticks).toEqual(["ses_B"]);
    });

    it("fail-open: onTick が throw しても tick は throw しない (opencode を壊さない)", () => {
      let captured: (() => void) | null = null;
      const hbm = adapter.createHeartbeat({
        setTimer: (fn) => {
          captured = fn;
          return { unref() {} };
        },
        clearTimer: () => {},
        onTick: () => {
          throw new Error("emit boom (閉じた delivery を模す)");
        },
      });
      hbm.start("ses_x");
      expect(captured).toBeTypeOf("function");
      // tick 内 try/catch が onTick の throw を握る → timer callback は throw しない (fail-open)。
      expect(() => captured!()).not.toThrow();
    });

    it("heartbeat は写像 histogram を汚さない (mapCaptureLine は heartbeat を産まない・QA-3 不変)", () => {
      const produced = new Set(
        mapAll(adapter.createAdapterState()).map((e) => String(e.event_type)),
      );
      // heartbeat は timer 駆動で写像経路に載らないため、fixture 写像には決して現れない。
      expect(produced.has("heartbeat")).toBe(false);
    });
  });

  // ── QA-R1: 配送層の本番既定値を pin (opts 省略時の autoDrain ON + fetchImpl=globalThis.fetch) ─
  // R1 の QA-2 テストは opts を注入するため、既定値そのものの退行 (autoDrain 既定 false 化 /
  //   fetchImpl 既定 no-op 化) を捕えられない。本テストは **opts なしの本番形**で delivery を
  //   構成し、既定配線が生きていること (enqueue が自動 drain し globalThis.fetch を叩く) を pin する。
  describe("QA-R1: 配送層の本番既定値", () => {
    let origFetch: typeof globalThis.fetch;
    let origToken: string | undefined;

    beforeEach(() => {
      origFetch = globalThis.fetch;
      origToken = process.env.INGEST_TOKEN;
    });
    afterEach(() => {
      // env/global の汚染を必ず復元。
      globalThis.fetch = origFetch;
      if (origToken === undefined) delete process.env.INGEST_TOKEN;
      else process.env.INGEST_TOKEN = origToken;
    });

    it("opts なし createDelivery は autoDrain 既定 ON + fetchImpl 既定 globalThis.fetch で POST する", async () => {
      const calls: { url: string }[] = [];
      // globalThis.fetch を stub (createDelivery 生成前に差し替える — 既定は生成時に束縛される)。
      globalThis.fetch = (async (url: string) => {
        calls.push({ url: String(url) });
        return { ok: true } as Response;
      }) as typeof globalThis.fetch;
      process.env.INGEST_TOKEN = "tok-prod-default";

      const cfg = adapter.resolveConfig(); // process.env 由来 (enabled true・既定 URL)
      expect(cfg.enabled).toBe(true);
      const d = adapter.createDelivery(cfg); // ★ opts なし = 本番既定

      d.enqueue({ event_id: "e0" }); // enqueue のみ (await しない = fail-open)。既定 autoDrain が drain。

      const fired = await waitFor(() => calls.length > 0);
      expect(fired, "本番既定 (autoDrain ON + globalThis.fetch) で fetch が呼ばれる").toBe(true);
      expect(calls[0]!.url).toContain("/ingest");
    });
  });
});
