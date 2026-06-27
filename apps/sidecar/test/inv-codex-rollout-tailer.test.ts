import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { NormalizedEvent } from "@actradeck/event-model";

import { CodexRolloutTailer } from "../src/codex-rollout-tailer.js";

/**
 * INV-CODEX-ROLLOUT-TAILER: tailer のエッジ耐性 (QA-2) + bounded read (SEC-1)。
 * 実 FS (mkdtemp + 実ファイル + 実 scanOnce) で固定。falsifiable: 各挙動を外すと赤化。
 */

const SESSION_A = "019ed895-6f24-70d2-b4b4-35bdcafb06ad";
const SESSION_B = "019ed896-1111-70d2-b4b4-35bdcafb06ad";

function metaLine(session: string): string {
  return JSON.stringify({
    type: "session_meta",
    timestamp: "2026-06-18T03:00:00.000Z",
    payload: { id: session, cwd: "/repo", source: "tui" },
  });
}

function agentLine(text: string, ts = "2026-06-18T03:00:01.000Z"): string {
  return JSON.stringify({
    type: "event_msg",
    timestamp: ts,
    payload: { type: "agent_message", message: text },
  });
}

describe("INV-CODEX-ROLLOUT-TAILER", () => {
  let tmp: string | undefined;

  afterEach(() => {
    if (tmp !== undefined) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  function setup(): { codexHome: string; sessionDir: string; statePath: string } {
    tmp = mkdtempSync(join(tmpdir(), "actradeck-codex-tailer-"));
    const codexHome = join(tmp, "codex");
    const sessionDir = join(codexHome, "sessions", "2026", "06", "18");
    mkdirSync(sessionDir, { recursive: true });
    return { codexHome, sessionDir, statePath: join(tmp, "offsets.json") };
  }

  function rolloutPath(sessionDir: string, session: string): string {
    return join(sessionDir, `rollout-2026-06-18T11-35-32-${session}.jsonl`);
  }

  function makeTailer(
    codexHome: string,
    statePath: string,
    sink: { events: NormalizedEvent[]; warnings: string[] },
    extra: { maxTailChunk?: number } = {},
  ): CodexRolloutTailer {
    return new CodexRolloutTailer({
      codexHome,
      statePath,
      backfill: true,
      pollIntervalMs: 10_000,
      ...(extra.maxTailChunk !== undefined ? { maxTailChunk: extra.maxTailChunk } : {}),
      onEvents: (events) => sink.events.push(...events),
      onWarning: (w) => sink.warnings.push(w),
    });
  }

  it("drops a broken JSON line and continues with subsequent lines [QA-2]", async () => {
    const { codexHome, sessionDir, statePath } = setup();
    writeFileSync(
      rolloutPath(sessionDir, SESSION_A),
      `${[metaLine(SESSION_A), "{not valid json", agentLine("after broken")].join("\n")}\n`,
    );
    const sink = { events: [] as NormalizedEvent[], warnings: [] as string[] };
    await makeTailer(codexHome, statePath, sink).scanOnce({ initial: true });

    const types = sink.events.map((e) => e.event_type);
    expect(types).toContain("session.started");
    expect(types).toContain("agent.message.delta"); // 壊れ行の後の行も処理される
    expect(sink.warnings.some((w) => w.includes("invalid JSON"))).toBe(true);
  });

  it("persisted offset prevents re-ingest on a second scan / fresh tailer [QA-2]", async () => {
    const { codexHome, sessionDir, statePath } = setup();
    writeFileSync(
      rolloutPath(sessionDir, SESSION_A),
      `${[metaLine(SESSION_A), agentLine("one")].join("\n")}\n`,
    );
    const sink = { events: [] as NormalizedEvent[], warnings: [] as string[] };
    const t1 = makeTailer(codexHome, statePath, sink);
    await t1.scanOnce({ initial: true });
    const first = sink.events.length;
    expect(first).toBeGreaterThan(0);

    await t1.scanOnce({ initial: false }); // 追記なし → 0 新規
    expect(sink.events.length).toBe(first);

    // 別インスタンス (同一 state ファイル) でも offset 永続で再取り込みしない。
    const sink2 = { events: [] as NormalizedEvent[], warnings: [] as string[] };
    await makeTailer(codexHome, statePath, sink2).scanOnce({ initial: false });
    expect(sink2.events.length).toBe(0);
  });

  it("separates events from concurrent rollout files by session [QA-2]", async () => {
    const { codexHome, sessionDir, statePath } = setup();
    writeFileSync(
      rolloutPath(sessionDir, SESSION_A),
      `${[metaLine(SESSION_A), agentLine("from A")].join("\n")}\n`,
    );
    writeFileSync(
      rolloutPath(sessionDir, SESSION_B),
      `${[metaLine(SESSION_B), agentLine("from B")].join("\n")}\n`,
    );
    const sink = { events: [] as NormalizedEvent[], warnings: [] as string[] };
    await makeTailer(codexHome, statePath, sink).scanOnce({ initial: true });

    const aCount = sink.events.filter((e) => e.session_id === SESSION_A).length;
    const bCount = sink.events.filter((e) => e.session_id === SESSION_B).length;
    expect(aCount).toBeGreaterThan(0);
    expect(bCount).toBeGreaterThan(0);
    // クロス汚染なし: 全イベントが2 session のいずれか。
    expect(sink.events.every((e) => e.session_id === SESSION_A || e.session_id === SESSION_B)).toBe(
      true,
    );
  });

  it("processes all lines across multiple capped reads without loss [SEC-1 bounded read]", async () => {
    const { codexHome, sessionDir, statePath } = setup();
    // 各行は cap(256) 未満だが合計は cap を超える → 複数 read に跨って全行を処理する。
    const lines = [metaLine(SESSION_A)];
    for (let i = 0; i < 8; i++) lines.push(agentLine(`msg ${i}`));
    const bytes = Buffer.byteLength(`${lines.join("\n")}\n`);
    expect(bytes).toBeGreaterThan(256); // 一括 alloc なら 256 超を一度に確保していた
    writeFileSync(rolloutPath(sessionDir, SESSION_A), `${lines.join("\n")}\n`);

    const sink = { events: [] as NormalizedEvent[], warnings: [] as string[] };
    await makeTailer(codexHome, statePath, sink, { maxTailChunk: 256 }).scanOnce({ initial: true });

    const msgs = sink.events.filter((e) => e.event_type === "agent.message.delta");
    expect(msgs.length).toBe(8); // 分割読みでも欠落なし
    expect(sink.warnings.filter((w) => w.includes("oversized")).length).toBe(0);
  });

  it("skips a single oversized line (> cap) with a warning and continues [SEC-1]", async () => {
    const { codexHome, sessionDir, statePath } = setup();
    const huge = agentLine("X".repeat(4000)); // > cap(256) の単一行
    writeFileSync(
      rolloutPath(sessionDir, SESSION_A),
      `${[metaLine(SESSION_A), huge, agentLine("after huge")].join("\n")}\n`,
    );
    const sink = { events: [] as NormalizedEvent[], warnings: [] as string[] };
    await makeTailer(codexHome, statePath, sink, { maxTailChunk: 256 }).scanOnce({ initial: true });

    expect(sink.warnings.some((w) => w.includes("oversized line skipped"))).toBe(true);
    // 前後の正常行は流れる: session.started + 後続 agent_message (巨大行は drop)。
    expect(sink.events.map((e) => e.event_type)).toContain("session.started");
    const msgs = sink.events.filter((e) => e.event_type === "agent.message.delta");
    expect(msgs.length).toBe(1); // 巨大行は drop され "after huge" の1件のみ
  });

  // Phase A.1: daemon 起動時 (initial・非 backfill) に既走 (最近書込) ファイルの先頭 session_meta
  //   だけ読み presence を即登録する。古いファイル (死んだセッション) は登録しない (flood 防止)。
  interface PresenceCtx {
    sessionId: string;
    cwd?: string | undefined;
    file: string;
  }
  function makePresenceTailer(
    codexHome: string,
    statePath: string,
    extra: { presenceRecencyMs?: number } = {},
  ): {
    tailer: CodexRolloutTailer;
    events: NormalizedEvent[];
    contexts: PresenceCtx[];
    warnings: string[];
  } {
    const events: NormalizedEvent[] = [];
    const contexts: PresenceCtx[] = [];
    const warnings: string[] = [];
    const tailer = new CodexRolloutTailer({
      codexHome,
      statePath,
      // backfill 省略 = false (tail-from-end・Phase A.1 が効く本番モード)。
      pollIntervalMs: 10_000,
      ...(extra.presenceRecencyMs !== undefined
        ? { presenceRecencyMs: extra.presenceRecencyMs }
        : {}),
      onEvents: (e) => events.push(...e),
      onSessionContext: (c) => contexts.push(c),
      onWarning: (w) => warnings.push(w),
    });
    return { tailer, events, contexts, warnings };
  }

  it("primes presence for a recently-modified file at initial scan, no events emitted [Phase A.1]", async () => {
    const { codexHome, sessionDir, statePath } = setup();
    const file = rolloutPath(sessionDir, SESSION_A);
    writeFileSync(file, `${[metaLine(SESSION_A), agentLine("hi")].join("\n")}\n`);
    utimesSync(file, new Date(), new Date()); // 直近更新 = 既走扱い。

    const h = makePresenceTailer(codexHome, statePath);
    await h.tailer.scanOnce({ initial: true });

    // presence は登録される (session_meta の id + cwd)。
    expect(h.contexts.length).toBe(1);
    expect(h.contexts[0]!.sessionId).toBe(SESSION_A);
    expect(h.contexts[0]!.cwd).toBe("/repo");
    // events は emit しない (履歴 backfill しない)・offset は tail-from-end (ファイル末尾)。
    expect(h.events.length).toBe(0);
    expect(h.tailer.offsets[file]!.offset).toBe(
      Buffer.byteLength(`${[metaLine(SESSION_A), agentLine("hi")].join("\n")}\n`),
    );
  });

  it("does NOT prime presence for an old file beyond recency window [Phase A.1]", async () => {
    const { codexHome, sessionDir, statePath } = setup();
    const file = rolloutPath(sessionDir, SESSION_A);
    writeFileSync(file, `${[metaLine(SESSION_A), agentLine("hi")].join("\n")}\n`);
    const old = new Date(Date.now() - 10 * 60_000); // 10 分前 > 既定 5 分窓。
    utimesSync(file, old, old);

    const h = makePresenceTailer(codexHome, statePath); // 既定 5 分。
    await h.tailer.scanOnce({ initial: true });

    expect(h.contexts.length).toBe(0); // 死んだセッションは presence 登録しない (flood 防止)。
    expect(h.events.length).toBe(0);
  });

  it("presenceRecencyMs=0 disables priming even for a fresh file (legacy behavior) [Phase A.1]", async () => {
    const { codexHome, sessionDir, statePath } = setup();
    const file = rolloutPath(sessionDir, SESSION_A);
    writeFileSync(file, `${[metaLine(SESSION_A), agentLine("hi")].join("\n")}\n`);
    utimesSync(file, new Date(), new Date());

    const h = makePresenceTailer(codexHome, statePath, { presenceRecencyMs: 0 });
    await h.tailer.scanOnce({ initial: true });

    expect(h.contexts.length).toBe(0); // 無効化 → 従来挙動 (新行が来るまで presence なし)。
  });

  it("broken first line: no presence prime, but subsequent appended lines still register via tail [Phase A.1]", async () => {
    const { codexHome, sessionDir, statePath } = setup();
    const file = rolloutPath(sessionDir, SESSION_A);
    writeFileSync(file, `${["{not valid json", agentLine("x")].join("\n")}\n`);
    utimesSync(file, new Date(), new Date());

    const h = makePresenceTailer(codexHome, statePath);
    await h.tailer.scanOnce({ initial: true });
    expect(h.contexts.length).toBe(0); // 壊れた先頭行は prime しない。

    // 以降の追記 (cwd を持つ turn_context) は通常 tail で presence 登録される。
    const turnCtx = JSON.stringify({
      type: "turn_context",
      timestamp: "2026-06-18T03:05:00.000Z",
      payload: { cwd: "/repo2" },
    });
    writeFileSync(file, `${["{not valid json", agentLine("x"), turnCtx].join("\n")}\n`);
    await h.tailer.scanOnce({ initial: false });
    expect(h.contexts.some((c) => c.cwd === "/repo2")).toBe(true);
  });

  // QA-2: flood 防止の本丸 — listRolloutFiles は $CODEX_HOME 全履歴を列挙するため、多数の古い
  //   (死んだ) セッションの中で **最近書込の 1 つだけ** が presence 登録されることを pin する。
  it("primes ONLY the recently-modified file among many old ones (flood prevention) [Phase A.1]", async () => {
    const { codexHome, sessionDir, statePath } = setup();
    const oldSessions = [
      "019ed8a0-0000-70d2-b4b4-35bdcafb0001",
      "019ed8a0-0000-70d2-b4b4-35bdcafb0002",
      "019ed8a0-0000-70d2-b4b4-35bdcafb0003",
      "019ed8a0-0000-70d2-b4b4-35bdcafb0004",
    ];
    const old = new Date(Date.now() - 10 * 60_000); // 10 分前 > 5 分窓 = 死んだ扱い。
    for (const s of oldSessions) {
      const f = rolloutPath(sessionDir, s);
      writeFileSync(f, `${[metaLine(s), agentLine("old")].join("\n")}\n`);
      utimesSync(f, old, old);
    }
    const fresh = rolloutPath(sessionDir, SESSION_B);
    writeFileSync(fresh, `${[metaLine(SESSION_B), agentLine("fresh")].join("\n")}\n`);
    utimesSync(fresh, new Date(), new Date());

    const h = makePresenceTailer(codexHome, statePath);
    await h.tailer.scanOnce({ initial: true });

    // 5 ファイル中、最近書込の 1 つだけ presence 登録 (死んだ 4 つは Wall に出さない)。
    expect(h.contexts.length).toBe(1);
    expect(h.contexts[0]!.sessionId).toBe(SESSION_B);
    expect(h.events.length).toBe(0); // 履歴 backfill しない。
  });

  // QA-3 (L270): 先頭行が session_meta でも id も cwd も無ければ presence 登録しない (誤 presence 防止)。
  it("does NOT prime when the first line lacks both session id and cwd [Phase A.1]", async () => {
    const { codexHome, sessionDir, statePath } = setup();
    const file = rolloutPath(sessionDir, SESSION_A);
    const noHints = JSON.stringify({
      type: "session_meta",
      timestamp: "2026-06-18T03:00:00.000Z",
      payload: { source: "tui" }, // id も cwd も無い。
    });
    writeFileSync(file, `${[noHints, agentLine("x")].join("\n")}\n`);
    utimesSync(file, new Date(), new Date());

    const h = makePresenceTailer(codexHome, statePath);
    await h.tailer.scanOnce({ initial: true });

    expect(h.contexts.length).toBe(0); // 手がかり無し → prime しない (誤 presence 防止)。
  });

  // TDA-1 (H) / QA-4: shutdown race — setInterval が撃った in-flight scan を stop() が確実に
  // drain する。修正前は scanOnce が scan 中に早期 return(undefined)し、stop() の `await scanOnce`
  // が in-flight を待たず即 resolve → 直後の store.close 後に in-flight scan が emit→閉じた DB へ
  // append→rollout daemon は unhandledRejection handler を持たずクラッシュ。
  // falsifiable: scanOnce の `if (this.scanning) return this.currentScan ...` を `return;` に戻すと
  // stop() が in-flight を待たず即 resolve し `expect(stopResolved).toBe(false)` が赤になる。
  it("stop() drains an in-flight interval scan before returning (no emit-after-stop) [TDA-1]", async () => {
    const { codexHome, sessionDir, statePath } = setup();
    writeFileSync(
      rolloutPath(sessionDir, SESSION_A),
      `${[metaLine(SESSION_A), agentLine("inflight")].join("\n")}\n`,
    );
    const sink = { events: [] as NormalizedEvent[], warnings: [] as string[] };
    const tailer = makeTailer(codexHome, statePath, sink);

    // processFile を gate して scan を mid-flight で停める (setInterval 由来の in-flight scan 再現)。
    type PF = { processFile: (file: string, initial: boolean) => Promise<void> };
    const patched = tailer as unknown as PF;
    const orig = patched.processFile.bind(tailer);
    let entered = false;
    let gated = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    patched.processFile = async (file: string, initial: boolean): Promise<void> => {
      if (!gated) {
        gated = true;
        entered = true;
        await gate;
      }
      return orig(file, initial);
    };

    // in-flight scan を await せず開始 (setInterval が撃つ scan 相当)。
    const inflight = tailer.scanOnce({ initial: false });
    const deadline = Date.now() + 5000;
    while (!entered && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1));
    expect(entered).toBe(true);

    // shutdown: stop() は in-flight scan を drain してから返らねばならない。
    let stopResolved = false;
    const stopP = tailer.stop().then(() => {
      stopResolved = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(stopResolved).toBe(false); // 修正前は in-flight を待たず即 resolve → true で赤。

    release();
    await inflight;
    await stopP;
    expect(stopResolved).toBe(true);
    // in-flight scan の emit は stop 完了前に届いている (drain・取りこぼし無し)。
    expect(sink.events.length).toBeGreaterThan(0);
  });
});
