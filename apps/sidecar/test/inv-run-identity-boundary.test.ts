/**
 * ADR 0014 Phase 3b-1 — RunIdentity (SessionIdentity run-aware 化) 境界状態機械の in-process unit.
 * 純 in-process 判定 (PG/subprocess 不要・高速)。decision 019f819e の D2/D3/D4/D5 を falsifiable に固定。
 *
 * 対象不変条件:
 *  - INV-RUN-BOUNDARY: provider id 変化 or terminal-reopen ⇒ 新 run id / 同一 provider id+非 terminal ⇒ 同一 run。
 *  - INV-RUN-LINEAGE-EDGE: 境界で resumedFrom=親 run id (親観測時)。
 *  - INV-PROJECTION-NO-SPLIT: 同一 provider id の重複 hook は generation を進めず同一 run へ畳む。
 *  - INV-PROVIDER-SESSION-ID-POPULATED (unit): 監視 emit が canonical と provider raw id を渡す
 *      (synthetic mint 時のみ両者が乖離)。
 *  - INV-SEQ-RESET-PER-RUN (structural): 境界後の監視イベントは新 run id で emit され旧 run の順序空間へ混入しない。
 */
import { describe, expect, it } from "vitest";

import { SessionIdentity } from "../src/session-identity.js";

const P1 = "11111111-1111-7111-8111-111111111111";
const P2 = "22222222-2222-7222-8222-222222222222";

/** monitoring emit を捕捉するヘルパ (canonical, provider の pair を記録)。 */
function capture(id: SessionIdentity): Array<{ canonical: string; provider: string | undefined }> {
  const seen: Array<{ canonical: string; provider: string | undefined }> = [];
  id.emitMonitoring("heartbeat", (canonical, provider) => seen.push({ canonical, provider }));
  return seen;
}

describe("INV-RUN-BOUNDARY / INV-PROJECTION-NO-SPLIT (RunIdentity in-process)", () => {
  it("generation 0: 最初の hook で run を確定する (boundary=false・startKind=fresh・source=startup)", () => {
    const id = new SessionIdentity({ fallbackSessionId: "sess_fallback" });
    const r = id.onHookSession(P1, { isSessionStart: true, source: "startup" });
    expect(r.runId).toBe(P1);
    expect(r.boundary).toBe(false);
    expect(r.startKind).toBe("fresh");
    expect(r.resumedFrom).toBeUndefined();
    expect(id.currentRunId()).toBe(P1);
    expect(id.currentProviderSessionId()).toBe(P1);
    expect(id.currentGeneration()).toBe(0);
  });

  it("同一 provider id + 非 terminal ⇒ 同一 run (重複 SessionStart を idempotent に畳む・分裂しない)", () => {
    const id = new SessionIdentity({ fallbackSessionId: "f" });
    id.onHookSession(P1, { isSessionStart: true, source: "startup" });
    const dup = id.onHookSession(P1, { isSessionStart: true, source: "startup" });
    expect(dup.runId).toBe(P1);
    expect(dup.boundary).toBe(false);
    expect(dup.startKind).toBeUndefined();
    expect(dup.resumedFrom).toBeUndefined();
    // generation を進めない = 分裂しない (INV-PROJECTION-NO-SPLIT の要石)。
    expect(id.currentGeneration()).toBe(0);
  });

  it("provider id 変化 ⇒ 新 run・新 provider id を run id に採用・resumedFrom=親 (INV-RUN-LINEAGE-EDGE)", () => {
    const id = new SessionIdentity({ fallbackSessionId: "f" });
    id.onHookSession(P1, { isSessionStart: true, source: "startup" });
    const r = id.onHookSession(P2, { isSessionStart: true, source: "resume" });
    expect(r.runId).toBe(P2); // synthetic 不要 (新 provider id を採用)
    expect(r.boundary).toBe(true);
    expect(r.startKind).toBe("resume");
    expect(r.resumedFrom).toBe(P1); // 親を観測済み
    expect(id.currentRunId()).toBe(P2);
    expect(id.currentProviderSessionId()).toBe(P2);
    expect(id.currentGeneration()).toBe(1);
  });

  it("provider id 変化 + source 無し ⇒ startKind=resume (観測済 lineage は positive evidence)", () => {
    const id = new SessionIdentity({ fallbackSessionId: "f" });
    id.onHookSession(P1, {});
    const r = id.onHookSession(P2, {});
    expect(r.boundary).toBe(true);
    expect(r.startKind).toBe("resume");
    expect(r.resumedFrom).toBe(P1);
  });

  it("compact は negative guard: provider id が rotate しても run を切らない (D2#4)", () => {
    const id = new SessionIdentity({ fallbackSessionId: "f" });
    id.onHookSession(P1, { isSessionStart: true, source: "startup" });
    const r = id.onHookSession(P2, { isSessionStart: true, source: "compact" });
    expect(r.boundary).toBe(false);
    expect(r.runId).toBe(P1); // 同一 run 維持
    expect(r.resumedFrom).toBeUndefined();
    expect(id.currentGeneration()).toBe(0); // 世代を進めない
    // provider id だけ追従する (rotate した id を反映)。
    expect(id.currentProviderSessionId()).toBe(P2);
  });
});

describe("INV-RUN-BOUNDARY: terminal-reopen synthetic mint (D2#2)", () => {
  it("同一 provider id が terminal run へ再来 ⇒ synthetic sess_ 新 run・resumedFrom=親", () => {
    const id = new SessionIdentity({ fallbackSessionId: "f" });
    id.onHookSession(P1, { isSessionStart: true, source: "startup" });
    id.markRunTerminal();
    const r = id.onHookSession(P1, { isSessionStart: true, source: "resume" });
    expect(r.boundary).toBe(true);
    expect(r.runId).not.toBe(P1); // provider id 衝突ゆえ採用不可 → synthetic
    expect(r.runId).toMatch(/^sess_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/); // sess_<uuidv7>
    expect(r.resumedFrom).toBe(P1);
    expect(r.startKind).toBe("resume");
    // synthetic 乖離: canonical=synthetic だが provider id は再利用された P1。
    expect(id.currentRunId()).toBe(r.runId);
    expect(id.currentProviderSessionId()).toBe(P1);
    expect(id.currentGeneration()).toBe(1);
    expect(id.isRunTerminal()).toBe(false); // 新 run は非 terminal
  });

  it("INV-IDEMPOTENCY: terminal-reopen mint 後の同一 provider id 再送は再 mint せず同一 run へ畳む", () => {
    const id = new SessionIdentity({ fallbackSessionId: "f" });
    id.onHookSession(P1, { source: "startup" });
    id.markRunTerminal();
    const first = id.onHookSession(P1, { source: "resume" }); // synthetic mint
    const resend = id.onHookSession(P1, { source: "resume" }); // 非 terminal ゆえ畳む
    expect(resend.boundary).toBe(false);
    expect(resend.runId).toBe(first.runId); // 同一 synthetic run
    expect(id.currentGeneration()).toBe(1); // 二重 mint しない
  });
});

describe("INV-PROVIDER-SESSION-ID-POPULATED / INV-SEQ-RESET-PER-RUN (monitoring follows canonical)", () => {
  it("監視 emit は canonical と provider raw id を渡す (common case は同値)", () => {
    const id = new SessionIdentity({ fallbackSessionId: "f" });
    id.onHookSession(P1, { source: "startup" });
    const seen = capture(id);
    expect(seen).toEqual([{ canonical: P1, provider: P1 }]);
  });

  it("synthetic mint 後の監視 emit は canonical=synthetic / provider=再利用 provider (乖離を正しく運ぶ)", () => {
    const id = new SessionIdentity({ fallbackSessionId: "f" });
    id.onHookSession(P1, { source: "startup" });
    id.markRunTerminal();
    const r = id.onHookSession(P1, { source: "resume" });
    const seen = capture(id);
    expect(seen).toEqual([{ canonical: r.runId, provider: P1 }]);
    expect(r.runId).not.toBe(P1);
  });

  it("境界後の監視イベントは新 run id で emit され旧 run の順序空間へ混入しない", () => {
    const id = new SessionIdentity({ fallbackSessionId: "f" });
    id.onHookSession(P1, { source: "startup" });
    const before = capture(id);
    id.onHookSession(P2, { source: "resume" }); // 境界
    const after = capture(id);
    expect(before[0]?.canonical).toBe(P1);
    expect(after[0]?.canonical).toBe(P2); // 新 run の順序空間 (per-session key が変わる)
    expect(after[0]?.canonical).not.toBe(before[0]?.canonical);
  });

  it("確定前の held 監視イベントは gen0 確定後に canonical+provider を載せて flush する (INV-EVENT-ORDER 保持)", () => {
    // fallbackSessionId は sess_ 形にせず短 id にし、確定は onHookSession で行う。
    const id = new SessionIdentity({ fallbackSessionId: "f" });
    const seen = capture(id); // 未確定: hold される (即時 push されない)
    expect(seen).toHaveLength(0);
    id.onHookSession(P1, { source: "startup" }); // 確定 → flush
    expect(seen).toEqual([{ canonical: P1, provider: P1 }]);
  });
});

describe("start_kind 導出 (D4・source→細別)", () => {
  it("source=clear → clear", () => {
    const id = new SessionIdentity({ fallbackSessionId: "f" });
    expect(id.onHookSession(P1, { source: "clear" }).startKind).toBe("clear");
  });
  it("gen0 + source 無し → unknown (over-claim しない)", () => {
    const id = new SessionIdentity({ fallbackSessionId: "f" });
    expect(id.onHookSession(P1, {}).startKind).toBe("unknown");
  });
  it("explicit 即確定 (Attach) の最初の観測 hook は best-effort start_kind を surface する (source=resume→resume)", () => {
    const id = new SessionIdentity({ fallbackSessionId: P1, explicitSessionId: P1 });
    const first = id.onHookSession(P1, { source: "resume" });
    expect(first.boundary).toBe(false);
    expect(first.runId).toBe(P1);
    expect(first.startKind).toBe("resume"); // 明示確定でも初回に start_kind を出す
    // 以降の同一 provider id 再送は畳む (start_kind を繰り返さない)。
    const second = id.onHookSession(P1, { source: "resume" });
    expect(second.startKind).toBeUndefined();
  });

  it("explicit 即確定 (Attach) の最初の観測 hook で source 無しなら start_kind=unknown (evidence 無ければ unknown)", () => {
    const id = new SessionIdentity({ fallbackSessionId: P1, explicitSessionId: P1 });
    expect(id.onHookSession(P1, {}).startKind).toBe("unknown");
  });

  it("不正な provider id は境界を切らず現在値を返す (副作用なし)", () => {
    const id = new SessionIdentity({ fallbackSessionId: "f" });
    id.onHookSession(P1, { source: "startup" });
    const r = id.onHookSession("", {});
    expect(r.boundary).toBe(false);
    expect(r.runId).toBe(P1);
    expect(id.currentGeneration()).toBe(0);
  });
});

describe("INV-RUN-LINEAGE-EDGE: priorTerminalRun seed (attach reap 跨ぎ親相関・decision 019fd2ac ①)", () => {
  it("seed した同一 provider id の初回 hook は case (B) terminal-reopen を踏む (synthetic mint + resumedFrom=旧 runId)", () => {
    const id = new SessionIdentity({
      fallbackSessionId: P1,
      priorTerminalRun: { runId: "sess_prior-run", providerSessionId: P1 },
    });
    // seed 状態: canonical=旧 runId・terminal=true (旧 run を復元)。
    expect(id.currentRunId()).toBe("sess_prior-run");
    expect(id.isRunTerminal()).toBe(true);
    const r = id.onHookSession(P1, { isSessionStart: true, source: "resume" });
    expect(r.boundary).toBe(true);
    expect(r.runId).toMatch(/^sess_/); // synthetic mint (provider id は terminal 旧 run と衝突し採用不可)
    expect(r.runId).not.toBe("sess_prior-run");
    expect(r.runId).not.toBe(P1);
    expect(r.startKind).toBe("resume");
    expect(r.resumedFrom).toBe("sess_prior-run"); // 親 = 旧 run の canonical
    expect(id.currentRunId()).toBe(r.runId);
    expect(id.currentProviderSessionId()).toBe(P1);
    expect(id.isRunTerminal()).toBe(false); // 新 run は非 terminal
  });

  it("seed 後 source 無しでも startKind=resume (観測済 lineage は positive evidence)", () => {
    const id = new SessionIdentity({
      fallbackSessionId: P1,
      priorTerminalRun: { runId: "sess_prior-run", providerSessionId: P1 },
    });
    const r = id.onHookSession(P1, {});
    expect(r.boundary).toBe(true);
    expect(r.startKind).toBe("resume");
    expect(r.resumedFrom).toBe("sess_prior-run");
  });

  it("mint 後の監視 emit は新 run id で行われ、旧 terminal run id へは載らない", () => {
    const id = new SessionIdentity({
      fallbackSessionId: P1,
      priorTerminalRun: { runId: "sess_prior-run", providerSessionId: P1 },
    });
    const r = id.onHookSession(P1, { isSessionStart: true, source: "resume" });
    const seen = capture(id);
    expect(seen).toEqual([{ canonical: r.runId, provider: P1 }]);
  });

  it("空値 priorTerminalRun は無視され通常 gen0 挙動 (fail-safe)", () => {
    const id = new SessionIdentity({
      fallbackSessionId: "f",
      priorTerminalRun: { runId: "", providerSessionId: P1 },
    });
    const r = id.onHookSession(P1, { isSessionStart: true, source: "startup" });
    expect(r.boundary).toBe(false);
    expect(r.runId).toBe(P1);
    expect(r.startKind).toBe("fresh");
    expect(r.resumedFrom).toBeUndefined();
  });
});

describe("launchLineage: managed argv 権威 override (gen0 限定・decision 019fd2ac ②)", () => {
  it("gen0: launch startKind=resume は hook source (startup) より優先される", () => {
    const id = new SessionIdentity({
      fallbackSessionId: "f",
      launchLineage: { startKind: "resume" },
    });
    const r = id.onHookSession(P1, { isSessionStart: true, source: "startup" });
    expect(r.boundary).toBe(false);
    expect(r.startKind).toBe("resume");
    expect(r.resumedFrom).toBeUndefined(); // 明示 id 無し
  });

  it("gen0: launch resumedFrom (別 id) は宣言参照として載る", () => {
    const id = new SessionIdentity({
      fallbackSessionId: "f",
      launchLineage: { startKind: "resume", resumedFrom: P2 },
    });
    const r = id.onHookSession(P1, { isSessionStart: true, source: "resume" });
    expect(r.startKind).toBe("resume");
    expect(r.resumedFrom).toBe(P2);
  });

  it("gen0: self-loop guard — resumedFrom === 自 run id なら edge を落とす (startKind は保持)", () => {
    const id = new SessionIdentity({
      fallbackSessionId: "f",
      launchLineage: { startKind: "resume", resumedFrom: P1 },
    });
    const r = id.onHookSession(P1, { isSessionStart: true, source: "resume" });
    expect(r.startKind).toBe("resume");
    expect(r.resumedFrom).toBeUndefined();
  });

  it("gen0 以降の run 境界 (provider id 変化) には launchLineage を適用しない", () => {
    const id = new SessionIdentity({
      fallbackSessionId: "f",
      launchLineage: { startKind: "resume", resumedFrom: "99999999-9999-7999-8999-999999999999" },
    });
    id.onHookSession(P1, { isSessionStart: true, source: "resume" });
    const r = id.onHookSession(P2, { isSessionStart: true, source: "clear" });
    expect(r.boundary).toBe(true);
    expect(r.startKind).toBe("clear"); // launch でなく境界 source 由来
    expect(r.resumedFrom).toBe(P1); // launch の宣言 id でなく観測済み親
  });

  it("launchLineage 無し (非検出) は従来どおり hook source 由来 (回帰なし)", () => {
    const id = new SessionIdentity({ fallbackSessionId: "f" });
    const r = id.onHookSession(P1, { isSessionStart: true, source: "startup" });
    expect(r.startKind).toBe("fresh");
  });
});
