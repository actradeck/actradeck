/**
 * INV-DIFF-PAYLOAD-REDACTION (INV-REDACTION 隣接・最優先 / SEC-4 / task 019e8e6a) — 実 SQLite で検証。
 *
 * 契約 (SEC-4 ADR 019ec666): payload に raw diff/本文を載せられる経路があっても、sink.emit の
 * redactDeep choke が **唯一の観測点**として end-to-end で secret をマスクする。
 * persisted (SQLite) / transmitted (WS) のどちらにも raw secret は出ない。
 *
 * 背景 — スキーマ形状 vs 設計意図の乖離 (本 INV が埋める falsifiability gap):
 *  - payload variant は `looseObject` (packages/event-model/src/payload.ts:29-31) ゆえ
 *    raw diff を payload に載せられる:
 *      · `file.change.proposed` の明示フィールド `diff` (payload.ts:137・現 producer 未使用の forward-compat)。
 *      · `diff.updated` の loose 追加キー `diff` (Codex `turn/diff/updated` → normalize-codex.ts:275 が **実際に載せる**)。
 *  - GitWatcher (CC 経路) は metrics-only で本文を payload に載せない → 別 INV (git-watcher.test.ts の本文非埋込ケース)。
 *  - diff 本文の能動取得は diff-provider の **gated / redacted pull-only** 経路 → 別 INV (inv-detail-diff-provider.test.ts)。
 *  - 「raw を素直に載せてよい、sink.redactDeep が担保」という前提 (normalize-codex.ts:16) を本 INV で
 *    falsifiable 化する。raw を payload に埋める経路の redaction 退行を CI で赤化させる唯一のゲート。
 *
 * mutation 赤化の設計 (自己反証):
 *  - sink.ts の `redactDeepWithCount` を bypass (raw をそのまま載せる) 改変で `not.toContain(SECRET)` が赤化。
 *  - これにより「diff/file-change payload 経路でも sink choke が効く」契約が CI で守られる
 *    (既存 INV-SECRET-DETECTED-NO-VALUE は agent.message.delta 1 経路のみ・本 INV は diff 系 payload を明示固定)。
 */
import { newEventId } from "@actradeck/event-model";
import { describe, expect, it } from "vitest";

import { EventSink } from "../src/sink.js";
import { EventStore } from "../src/store.js";
import type { WsClient } from "../src/ws-client.js";

// テスト専用ダミー秘匿値 (実在しない)。github-token / AWS access-key ルールに合致する形。
const GH_SECRET = "ghp_REALFAKE0123456789abcdefABCDEF0123456789";
const AWS_KEY = "AKIA1234567890ABCDEF";

function makeSink(): { sink: EventSink; store: EventStore; sent: string[] } {
  const store = new EventStore(":memory:");
  const sent: string[] = [];
  const wsClient = {
    notifyAppended: () => {
      for (const row of store.pendingUnsent()) sent.push(row.event_json);
    },
  } as unknown as WsClient;
  return { sink: new EventSink({ store, wsClient }), store, sent };
}

/** secret を 1 行に埋め込んだ実 diff 形の本文を作る (ファイル名などのメタは温存される想定)。 */
function diffBodyWith(secret: string): string {
  return [
    "diff --git a/config.env b/config.env",
    "index 0000000..1111111 100644",
    "--- a/config.env",
    "+++ b/config.env",
    "@@ -1,2 +1,3 @@",
    " existing line",
    `+TOKEN=${secret}`,
  ].join("\n");
}

describe("INV-DIFF-PAYLOAD-REDACTION: raw diff を載せる payload 経路でも sink が end-to-end マスク", () => {
  it("diff.updated の loose diff (Codex 実経路) に混入した secret は persist/送信路に出ず [REDACTED] 化する", () => {
    const { sink, store, sent } = makeSink();
    const ev = sink.emit({
      event_id: newEventId(),
      provider: "codex",
      source: "app_server",
      session_id: "s-diff-1",
      event_type: "diff.updated",
      timestamp: new Date().toISOString(),
      summary: "差分更新",
      // looseObject ゆえ DiffUpdated に diff (raw 本文) を載せられる (normalize-codex.ts:275 の実経路)。
      payload: { kind: "diff.updated", diff: diffBodyWith(GH_SECRET) },
      metrics: {},
    });
    expect(ev).toBeDefined();

    // redacted event に件数が立ち、原文は出ない (件数のみ)。
    expect(ev!.redaction_count).toBeGreaterThan(0);
    expect(JSON.stringify(ev)).not.toContain(GH_SECRET);

    // (1) persist (SQLite): 原文無し・redaction マーカー有り。
    const rows = store.allRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.event_json, "raw secret persisted to SQLite (diff payload)").not.toContain(
        GH_SECRET,
      );
      expect(row.event_json).toContain("[REDACTED:");
    }
    // (1) 送信路 (WS): 原文無し。
    expect(sent.join(""), "raw secret sent over WS (diff payload)").not.toContain(GH_SECRET);

    // diff のメタ (ファイル名) は温存され、可視化価値を壊さない (over-redaction 防止)。
    expect(rows[0]!.event_json).toContain("config.env");

    store.close();
  });

  it("file.change.proposed.diff フィールド (forward-compat) に混入した secret も end-to-end マスク", () => {
    const { sink, store, sent } = makeSink();
    const ev = sink.emit({
      event_id: newEventId(),
      provider: "codex",
      source: "app_server",
      session_id: "s-diff-2",
      event_type: "file.change.proposed",
      timestamp: new Date().toISOString(),
      summary: "ファイル変更提案",
      // FileChangeProposed.diff はスキーマ上の明示フィールド (現 producer 未使用の forward-compat)。
      // 将来 producer が raw diff を載せても sink が担保することを今のうちに固定する。
      payload: { kind: "file.change.proposed", path: "config.env", diff: diffBodyWith(AWS_KEY) },
      metrics: {},
    });
    expect(ev).toBeDefined();
    expect(ev!.redaction_count).toBeGreaterThan(0);
    expect(JSON.stringify(ev)).not.toContain(AWS_KEY);

    const rows = store.allRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.event_json, "raw secret persisted (file.change.proposed.diff)").not.toContain(
        AWS_KEY,
      );
      expect(row.event_json).toContain("[REDACTED:");
    }
    expect(sent.join(""), "raw secret sent (file.change.proposed.diff)").not.toContain(AWS_KEY);
    // path (メタ) は温存。
    expect(rows[0]!.event_json).toContain("config.env");

    store.close();
  });

  it("secret を含まない diff payload は redaction を発火させない (over-redaction しない・本文温存)", () => {
    const { sink, store } = makeSink();
    const ev = sink.emit({
      event_id: newEventId(),
      provider: "codex",
      source: "app_server",
      session_id: "s-diff-3",
      event_type: "diff.updated",
      timestamp: "2026-06-14T00:00:00.000Z",
      payload: {
        kind: "diff.updated",
        diff: "diff --git a/a.txt b/a.txt\n@@ -1 +1,2 @@\n hello\n+world plain change",
      },
      metrics: {},
    });
    expect(ev).toBeDefined();
    expect(ev!.redaction_count ?? 0).toBe(0);
    const rows = store.allRows();
    expect(rows[0]!.event_json).toContain("world plain change");
    store.close();
  });
});
