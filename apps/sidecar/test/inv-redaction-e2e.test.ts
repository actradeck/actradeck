/**
 * INV-REDACTION-E2E (強み(a)① 漏れゼロ E2E 実証 / DoD 019ec632 (a)① / 設計 019ec68c) —
 * 実 Sidecar を 1 本で貫通させる決定論的 E2E (REAL DATA ONLY・モック無し)。
 *
 * 契約 (証明したい強み):
 *   「実 hook 経路 (HTTP POST → hook receiver → normalize → redact → 実 SQLite → 実 WS sink) を
 *    end-to-end で貫通させたとき、**複数種類**の secret が SQLite 永続行 (event_json) にも
 *    WS 送信路にも **原文で一切出ず**、各々が `[REDACTED:<kind>]` に化ける」。
 *   これは INV-REDACTION の system-level 実証 (sink unit / redactor unit の上位ゲート)。
 *
 * 既存テストとの非重複 (重複回避・調査済):
 *   - inv-redaction.test.ts / redactor.test.ts: redactString/redactDeep の **unit**。
 *   - inv-diff-payload-redaction.test.ts: **sink unit** (EventSink 直叩き、diff payload 経路)。
 *   - inv-egress-e2e.test.ts: 実 backend WS/PG の貫通だが **secret は非対象** (認証/projection)。
 *   - run-hook-replay-e2e.mts: 実 HTTP→receiver→…→WS の貫通だが **スタンドアロン (tsx 手動) かつ
 *     単一種類** (AKIAIOSFODNN7EXAMPLE 1 種)。
 *   本テストは「**実 Sidecar (hook receiver + 実 SQLite + WS sink)** を vitest 常駐ゲートとして起動し、
 *   **複数種類** secret を実 hook payload 列で流して漏れゼロを CI 回帰固定する」未カバー部分を埋める。
 *
 * 起動構成 (run-hook-replay-e2e.mts のパターン流用・skipIf 不要 = CI 常時回帰):
 *   VerificationWsSink (実 ws) ← 実 Sidecar (実 hook HTTP receiver + redactor + 実 SQLite EventStore)。
 *   実 claude バイナリ spawn には依存しない (非決定性回避)。実バイナリの証明は補強スクリプト
 *   run-claude-e2e.mts が担う。本テストは「実形状 hook を実 HTTP で配送」して決定論的に貫通させる。
 *
 * テスト専用ダミー secret のみ (本物の鍵はコミットしない)。各値は redactor.ts の REDACTION_RULES の
 *   kind 語彙に合致する形に作ってある (probe で `[REDACTED:<kind>]` 化を確認済)。
 *
 * falsifiable (自己反証・SEC-1 監査反映で正確化):
 *   redactString (共有下層の redaction 関数) を no-op 化する mutation で「漏れゼロ」「マスク成立」
 *   assert が赤化する (timeline / over-redaction は直交で緑)。注: sink の redactDeepWithCount を
 *   bypass しても本テストは赤化しない — normalize の summarize が sink 到達前に redactString を
 *   適用する二重防御のため。**sink choke 単独**の固定は inv-diff-payload-redaction.test.ts が担う
 *   (本テストは redaction の system-level 到達を、sink unit はチョーク単一性を、と役割分担)。
 *   (mutation→test→git checkout 復元・共有 tree のみ・逐次)。it.fails / skip ではない実赤テスト。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Sidecar } from "../src/sidecar.js";
import { HOOK_TOKEN_HEADER } from "../src/settings-injection.js";
import { VerificationWsSink } from "../src/ws-sink.js";

const SESSION = "redaction_e2e_sess_1";

/**
 * テスト専用ダミー secret (実在しない)。kind ごとに 1 つ、redactor.ts の REDACTION_RULES に合致する形。
 *  - github-token       : ghp_ + 36 字 (rule 下限 20)。
 *  - aws-access-key-id   : AKIA + 16 字。
 *  - anthropic-key       : sk-ant- 形。
 *  - private-key         : BEGIN/END PRIVATE KEY ブロック (複数行)。
 *  - high-entropy-secret : 40+ 字・3 char-class (path/UUID でない)。
 *  - url-credential       : https://user:pass@host の pass 部 (user/host は温存される)。
 * raw 列 = 「漏れてはならない原文」、kind 列 = 化けるべき [REDACTED:<kind>]。
 */
interface SecretCase {
  readonly label: string;
  readonly kind: string;
  /** event_json / WS 送信路に絶対出てはならない原文 (の判別可能な核)。 */
  readonly raw: string;
}

const GH_TOKEN = `ghp_${"R3alFakeT0ken".padEnd(36, "x")}`; // ghp_ + 36 字
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const ANTHROPIC_KEY = "sk-ant-api03-FAKEonlyNOTaREALkey0123456789";
const HIGH_ENTROPY = "Xk9Pq3mZ7vT2wL5nB8rJ4cY6dF1gH0sA3eU2iO4ZZ"; // 42 字・mixed-case+digit
const URL_PASSWORD = "Zx9PwQ7sTopSecretPass"; // url-credential の pass 部 (核)
const URL_CRED = `https://svcuser:${URL_PASSWORD}@db.internal.example.com/path`;
const PRIVATE_KEY_BODY = "MIIBFAKEbase64privatekeymaterial00000000notreal";
const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----\n${PRIVATE_KEY_BODY}\n-----END PRIVATE KEY-----`;

const SECRET_CASES: readonly SecretCase[] = [
  { label: "github-token", kind: "github-token", raw: GH_TOKEN },
  { label: "aws-access-key-id", kind: "aws-access-key-id", raw: AWS_KEY },
  { label: "anthropic-key", kind: "anthropic-key", raw: ANTHROPIC_KEY },
  { label: "private-key", kind: "private-key", raw: PRIVATE_KEY_BODY },
  { label: "high-entropy-secret", kind: "high-entropy-secret", raw: HIGH_ENTROPY },
  { label: "url-credential", kind: "url-credential", raw: URL_PASSWORD },
];

/**
 * 実 claude が送る hook JSON 形状 (run-hook-replay-e2e.mts と同型・probe 採取)。
 * 複数種類の secret を、**normalizer が payload に carry する hook フィールド**に分散して混入する:
 *  - UserPromptSubmit.prompt  → payload.prompt_summary (summarize = redact→1行→slice。redact-first)。
 *  - PreToolUse.tool_input.command → payload.command (summarize(…, MAX_COMMAND_LEN)。redact-first)。
 * 注意 (probe 2026-06 確認): PostToolUse の tool_response は normalizer が payload に carry しない
 *   (= 落ちる) ため、tool_response 経由だと「redaction された」のか「単に欠落した」のか区別できず
 *   漏れゼロ assert が trivially 通る (false positive)。よって全 secret は **carry される field**
 *   (prompt / command) に置き、redaction 経路を確実に貫通させる。
 * 1 セッションのライフサイクル全体 (SessionStart→…→SessionEnd) を通す。
 */
function hookSequence(cwd: string): Array<Record<string, unknown>> {
  return [
    {
      session_id: SESSION,
      hook_event_name: "SessionStart",
      cwd,
      source: "startup",
      model: "claude-sonnet-4-6",
    },
    {
      session_id: SESSION,
      hook_event_name: "UserPromptSubmit",
      cwd,
      // prompt → payload.prompt_summary に carry。github-token / anthropic-key を混入。
      prompt: `deploy with ${GH_TOKEN} and ${ANTHROPIC_KEY}`,
    },
    {
      session_id: SESSION,
      hook_event_name: "PreToolUse",
      cwd,
      tool_name: "Bash",
      // tool_input.command → payload.command に carry。残り 4 種を 1 command に混入。
      // private-key は複数行ブロックだが summarize が redact→1行化するため [REDACTED:private-key] で残る。
      tool_input: {
        command: `aws configure set ${AWS_KEY}; curl ${URL_CRED}; echo '${PRIVATE_KEY}'; echo ${HIGH_ENTROPY}`,
      },
    },
    {
      session_id: SESSION,
      hook_event_name: "PostToolUse",
      cwd,
      tool_name: "Bash",
      tool_input: { command: `aws configure set ${AWS_KEY}` },
      tool_response: { stdout: "", stderr: "", exit_code: 0 },
    },
    { session_id: SESSION, hook_event_name: "Stop", cwd },
    { session_id: SESSION, hook_event_name: "SessionEnd", cwd, reason: "other" },
  ];
}

async function postHook(
  endpoint: string,
  body: Record<string, unknown>,
  token: string,
): Promise<void> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", [HOOK_TOKEN_HEADER]: token },
    body: JSON.stringify(body),
  });
  // hook receiver は 2xx を返す (本文は検証に不要)。
  await res.text();
}

async function waitFor(
  predicate: () => boolean,
  { timeoutMs = 5_000, stepMs = 20 }: { timeoutMs?: number; stepMs?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

describe("INV-REDACTION-E2E: 実 Sidecar 貫通で複数種類 secret が漏れない (CI 常時回帰)", () => {
  let sink: VerificationWsSink;
  let sidecar: Sidecar;
  let dbDir: string;
  /** WS 送信路に届いた全フレームの raw 文字列を連結したもの。 */
  let sentJoined: string;
  /** SQLite に永続された全行 (event_json)。 */
  let storedRows: { event_type: string; event_json: string }[];

  beforeAll(async () => {
    sink = new VerificationWsSink();
    await sink.listen();
    dbDir = mkdtempSync(join(tmpdir(), "actradeck-redaction-e2e-"));
    sidecar = new Sidecar({
      sessionId: SESSION,
      wsUrl: sink.url,
      dbPath: join(dbDir, "sidecar.db"),
      cwd: process.cwd(),
      // 自動ガード (ADR 019ecc70): secret 入り PreToolUse command は承認ゲート対象になる。
      // UI 未接続なので短縮タイムアウトで deny に倒し、postHook がゲート待ちでハングしないようにする。
      // 承認要求イベント (tool.permission.requested) の payload.command は redaction choke を通り、
      // 本テストの各 kind マスク検証 (SQLite / WS) は gated event 上でも成立する。
      approvalTimeoutMs: 50,
    });
    const { hookEndpoint } = await sidecar.start();

    for (const h of hookSequence(process.cwd())) {
      await postHook(hookEndpoint, h, sidecar.hookAuthToken);
    }

    // session.started 〜 session.ended の最小タイムラインが sink に到達するまで待つ
    // (固定 sleep に頼らず到達を poll = flaky 回避)。
    await waitFor(() => {
      const types = sink.received.map((r) => String(r.event.event_type));
      return types.includes("session.started") && types.includes("session.ended");
    });

    // SQLite 行は shutdown が store を close する前に採取する。
    storedRows = sidecar.store
      .allRows()
      .map((r) => ({ event_type: r.event_type, event_json: r.event_json }));

    await sidecar.shutdown();

    sentJoined = sink.received.map((r) => r.raw).join("\n");
  }, 30_000);

  afterAll(async () => {
    await sink.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  it("最小タイムライン (session.started 〜 session.ended) が WS sink に到達する", () => {
    const types = sink.received.map((r) => String(r.event.event_type));
    const required = [
      "session.started",
      "turn.started",
      // 自動ガード (ADR 019ecc70): secret 入り PreToolUse command は承認ゲート対象になり、
      // command.started ではなく tool.permission.requested (waiting.approval) が emit される。
      "tool.permission.requested",
      "command.completed",
      "turn.completed",
      "session.ended",
    ];
    for (const r of required) {
      expect(types, `missing timeline event: ${r}`).toContain(r);
    }
  });

  it("SQLite / WS sink の双方に各種類の secret 原文が一切出ない (漏れゼロ)", () => {
    // 前提: 実際に複数行 (= 複数 hook) が永続・送信されていること。
    expect(storedRows.length).toBeGreaterThan(0);
    expect(sentJoined.length).toBeGreaterThan(0);

    for (const c of SECRET_CASES) {
      // (1) SQLite 永続行 (event_json) に原文が無い。
      for (const row of storedRows) {
        expect(
          row.event_json.includes(c.raw),
          `LEAK to SQLite (${c.label}) in event_type=${row.event_type}`,
        ).toBe(false);
      }
      // (1) WS 送信路に原文が無い。
      expect(sentJoined.includes(c.raw), `LEAK to WS sink (${c.label})`).toBe(false);
    }
  });

  it("各種類の secret が [REDACTED:<kind>] に化けている (マスク成立)", () => {
    // SQLite と WS 送信路の双方で、各 kind のマーカーが少なくとも 1 回出現する。
    const sqlJoined = storedRows.map((r) => r.event_json).join("\n");
    for (const c of SECRET_CASES) {
      const marker = `[REDACTED:${c.kind}]`;
      expect(sqlJoined.includes(marker), `missing ${marker} in SQLite`).toBe(true);
      expect(sentJoined.includes(marker), `missing ${marker} in WS sink`).toBe(true);
    }
  });

  it("over-redaction 防止: secret でないメタ (URL の user/host) は温存される", () => {
    // url-credential ルールは pass 部のみマスクし user/host は残す (可視化価値を壊さない)。
    const sqlJoined = storedRows.map((r) => r.event_json).join("\n");
    expect(sqlJoined).toContain("svcuser");
    expect(sqlJoined).toContain("db.internal.example.com");
  });
});
