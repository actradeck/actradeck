/**
 * INV-REDACTION-WORKITEM (ADR 0015 §D10・受入 13・LEVEL 0 必須リグレッション)。
 *
 * 契約: CC の task 観測 (`TaskCreated`/`TaskCompleted` hook の task_subject/task_description、
 *   PostToolUse(TaskCreate) の tool_input.subject/description) は **ユーザー自由文** = secret 混入面。
 *   これらが `work.item.updated` へ載って **実 SQLite (at-rest) と WS 送信路** に届くとき、原文が
 *   一切出ず `[REDACTED:<kind>]` に化けていること。redaction 前データを保存・送信路に残さない。
 *
 * 実 Sidecar を 1 本貫通 (hook receiver HTTP → normalize → redact → 実 SQLite → 実 WS sink)。
 * inv-redaction-e2e.test.ts (B1) と同一パターン。本テストは work.item.updated 経路 (subject/description)
 * を対象にする未カバー部分を埋める (受入 13)。
 *
 * falsifiable (自己反証・実赤テスト): 共有下層 `redactString` を no-op 化する mutation で「漏れゼロ」
 *   「マスク成立」assert が赤化する (workItemText の summarize も sink の redactDeep も同 redactString に
 *   依存する二重防御ゆえ・memory redaction-redos-and-real-test-gates)。復元で緑。skip / it.fails ではない。
 *   RED 実証手順は本 slice の decision に記録。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Sidecar } from "../src/sidecar.js";
import { HOOK_TOKEN_HEADER } from "../src/settings-injection.js";
import { VerificationWsSink } from "../src/ws-sink.js";

const SESSION = "redaction_workitem_e2e_1";

// テスト専用ダミー secret (実在しない)。kind ごとに 1 つ・redactor.ts の REDACTION_RULES に合致する形。
const GH_TOKEN = `ghp_${"R3alFakeT0ken".padEnd(36, "x")}`; // github-token
const ANTHROPIC_KEY = "sk-ant-api03-FAKEonlyNOTaREALkey0123456789"; // anthropic-key
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE"; // aws-access-key-id
const HIGH_ENTROPY = "Xk9Pq3mZ7vT2wL5nB8rJ4cY6dF1gH0sA3eU2iO4ZZ"; // high-entropy-secret

interface SecretCase {
  readonly label: string;
  readonly kind: string;
  readonly raw: string;
}
const SECRET_CASES: readonly SecretCase[] = [
  { label: "hook task_subject (github-token)", kind: "github-token", raw: GH_TOKEN },
  { label: "hook task_description (anthropic-key)", kind: "anthropic-key", raw: ANTHROPIC_KEY },
  {
    label: "PostToolUse tool_input.subject (aws-access-key-id)",
    kind: "aws-access-key-id",
    raw: AWS_KEY,
  },
  {
    label: "PostToolUse tool_input.description (high-entropy-secret)",
    kind: "high-entropy-secret",
    raw: HIGH_ENTROPY,
  },
];

/**
 * 実 hook 列。secret を **work.item.updated へ carry される field** に分散して混入する:
 *  - TaskCreated.task_subject / task_description → payload.subject / description (workItemText=redact→bound)。
 *  - PostToolUse(TaskCreate).tool_input.subject / description → 同 (fidelity=parsed 経路)。
 */
function hookSequence(cwd: string): Array<Record<string, unknown>> {
  return [
    { session_id: SESSION, hook_event_name: "SessionStart", cwd, source: "startup" },
    {
      session_id: SESSION,
      hook_event_name: "TaskCreated",
      cwd,
      prompt_id: "p1",
      task_id: "1",
      task_subject: `deploy using ${GH_TOKEN}`,
      task_description: `auth with ${ANTHROPIC_KEY}`,
    },
    {
      session_id: SESSION,
      hook_event_name: "PostToolUse",
      cwd,
      tool_name: "TaskCreate",
      tool_input: {
        subject: `configure ${AWS_KEY}`,
        // "token"/"key" 等の語は bearer-token 等の別 kind ルールを誘発するため中立語 "blob" を使い、
        // high-entropy-secret ルールで確実に化けさせる (kind まで固定するため)。
        description: `blob ${HIGH_ENTROPY}`,
        activeForm: "Configuring",
      },
      tool_response: { task: { id: "2", subject: "configure" } },
      tool_use_id: "toolu_wi",
    },
    {
      session_id: SESSION,
      hook_event_name: "TaskCompleted",
      cwd,
      prompt_id: "p1",
      task_id: "1",
      task_subject: "done",
    },
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

describe("INV-REDACTION-WORKITEM: work.item.updated subject/description が漏れない (受入 13)", () => {
  let sink: VerificationWsSink;
  let sidecar: Sidecar;
  let dbDir: string;
  let sentJoined: string;
  let storedRows: { event_type: string; event_json: string }[];

  beforeAll(async () => {
    sink = new VerificationWsSink();
    await sink.listen();
    dbDir = mkdtempSync(join(tmpdir(), "actradeck-redaction-workitem-"));
    sidecar = new Sidecar({
      sessionId: SESSION,
      wsUrl: sink.url,
      dbPath: join(dbDir, "sidecar.db"),
      cwd: process.cwd(),
      approvalTimeoutMs: 50,
    });
    const { hookEndpoint } = await sidecar.start();

    for (const h of hookSequence(process.cwd())) {
      await postHook(hookEndpoint, h, sidecar.hookAuthToken);
    }

    await waitFor(() => {
      const types = sink.received.map((r) => String(r.event.event_type));
      return (
        types.includes("session.started") &&
        types.includes("session.ended") &&
        types.filter((t) => t === "work.item.updated").length >= 3
      );
    });

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

  it("work.item.updated が実際に永続・送信されている (trivial-pass 防止)", () => {
    const wi = storedRows.filter((r) => r.event_type === "work.item.updated");
    // TaskCreated(1) + PostToolUse(TaskCreate)(1) + TaskCompleted(1) = 3 件以上。
    expect(wi.length).toBeGreaterThanOrEqual(3);
    expect(sentJoined).toContain("work.item.updated");
  });

  it("SQLite / WS 送信路の双方に subject/description の secret 原文が一切出ない (漏れゼロ)", () => {
    expect(storedRows.length).toBeGreaterThan(0);
    expect(sentJoined.length).toBeGreaterThan(0);
    for (const c of SECRET_CASES) {
      for (const row of storedRows) {
        expect(
          row.event_json.includes(c.raw),
          `LEAK to SQLite (${c.label}) in event_type=${row.event_type}`,
        ).toBe(false);
      }
      expect(sentJoined.includes(c.raw), `LEAK to WS sink (${c.label})`).toBe(false);
    }
  });

  it("各 secret が [REDACTED:<kind>] に化けている (マスク成立)", () => {
    const sqlJoined = storedRows.map((r) => r.event_json).join("\n");
    for (const c of SECRET_CASES) {
      const marker = `[REDACTED:${c.kind}]`;
      expect(sqlJoined.includes(marker), `missing ${marker} in SQLite`).toBe(true);
      expect(sentJoined.includes(marker), `missing ${marker} in WS sink`).toBe(true);
    }
  });

  it("provider_task_id (非 secret serial) は温存され fold が id を導出できる", () => {
    const sqlJoined = storedRows.map((r) => r.event_json).join("\n");
    // serial "1"/"2" は secret でない (task-scoped 連番) → 温存 (fold の deriveWorkItemId 入力)。
    expect(sqlJoined).toContain("provider_task_id");
  });
});

// ── SEC-B2-1 (裁定 019fca13 unblock 2・redaction 隣接) ──────────────────────────────────────────
// provider_task_id / summary(`${subject ?? providerTaskId}`) / TaskUpdate 経路 (taskId / status) は
// subject/description と違い **redact-first されず sink choke (redactDeep) のみに依存**する。SEC が
// probe で安全性を実証済みだが secret 形の回帰ベクタで pin されていなかった。以下を追加する:
//   (a) secret 形 provider_task_id (TaskCreated task_id が secret 様)  → at-rest/WS masked
//   (b) TaskUpdate の secret 形 taskId                                 → masked
//   (c) secret 形 status                                              → closed-enum gate で "unknown"
//   (d) 非文字列 subject                                              → drop (workItemText が undefined)
// (a)(b) は redactString no-op で RED (sink choke 依存)。(c)(d) は構造 gate/drop ゆえ redactString 非依存。
const SEC_CREATE_ID = "Aa1Bb2Cc3Dd4Ee5Ff6Gg7Hh8Ii9Jj0Kk1Ll2Mm3Nn"; // high-entropy-secret
const SEC_UPDATE_ID = "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9Oo8Nn7Mm"; // high-entropy-secret
const SEC_STATUS = "Ss5Ta7Tu9Sv1Sw3Sx5Sy7Sz9Sa1Sb3Sc5Sd7Se9Sf"; // high-entropy-secret
const SEC_SUBJECT = "Su8Bj7Ec6Tt5Se4Cr3Et2Va1Lu0Ee9Xy8Zw7Vu6Ts"; // high-entropy-secret (非文字列内)
const SECFORM_SESSION = "redaction_workitem_secform_1";
const SECFORM_SECRETS = [SEC_CREATE_ID, SEC_UPDATE_ID, SEC_STATUS, SEC_SUBJECT];

/**
 * 実 hook 列。secret を **redact-first されない経路** へ混入する:
 *  - TaskCreated.task_id = secret 様 (provider_task_id + summary へ載る・subject 無しゆえ summary=providerTaskId)。
 *  - TaskCreated.task_subject = 非文字列 (配列に secret) → drop されるべき (別 task_id は benign)。
 *  - PostToolUse(TaskUpdate).tool_input.taskId = secret 様 / status = secret 様。
 */
function secformHookSequence(cwd: string): Array<Record<string, unknown>> {
  return [
    { session_id: SECFORM_SESSION, hook_event_name: "SessionStart", cwd, source: "startup" },
    // (a): secret 形 provider_task_id (subject 無し → summary が providerTaskId を carry)。
    { session_id: SECFORM_SESSION, hook_event_name: "TaskCreated", cwd, task_id: SEC_CREATE_ID },
    // (d): 非文字列 subject (配列に secret) は drop されるべき (task_id は benign)。
    {
      session_id: SECFORM_SESSION,
      hook_event_name: "TaskCreated",
      cwd,
      task_id: "nsub1",
      task_subject: [SEC_SUBJECT],
    },
    // (b)+(c): secret 形 taskId + secret 形 status。
    {
      session_id: SECFORM_SESSION,
      hook_event_name: "PostToolUse",
      cwd,
      tool_name: "TaskUpdate",
      tool_input: { taskId: SEC_UPDATE_ID, status: SEC_STATUS },
      tool_use_id: "toolu_sec",
    },
    { session_id: SECFORM_SESSION, hook_event_name: "SessionEnd", cwd, reason: "other" },
  ];
}

interface WorkItemPayloadJson {
  provider_task_id?: string;
  status?: string;
  subject?: string;
}

describe("INV-REDACTION-WORKITEM SEC-B2-1: provider_task_id/summary/taskId/status/非文字列 subject の secret 形", () => {
  let sink: VerificationWsSink;
  let sidecar: Sidecar;
  let dbDir: string;
  let sentJoined: string;
  let storedRows: { event_type: string; event_json: string }[];

  beforeAll(async () => {
    sink = new VerificationWsSink();
    await sink.listen();
    dbDir = mkdtempSync(join(tmpdir(), "actradeck-redaction-secform-"));
    sidecar = new Sidecar({
      sessionId: SECFORM_SESSION,
      wsUrl: sink.url,
      dbPath: join(dbDir, "sidecar.db"),
      cwd: process.cwd(),
      approvalTimeoutMs: 50,
    });
    const { hookEndpoint } = await sidecar.start();
    for (const h of secformHookSequence(process.cwd())) {
      await postHook(hookEndpoint, h, sidecar.hookAuthToken);
    }
    await waitFor(() => {
      const types = sink.received.map((r) => String(r.event.event_type));
      return (
        types.includes("session.ended") &&
        types.filter((t) => t === "work.item.updated").length >= 3
      );
    });
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

  /** 全 work.item.updated 行の payload を parse して返す。 */
  function workItemPayloads(): WorkItemPayloadJson[] {
    return storedRows
      .filter((r) => r.event_type === "work.item.updated")
      .map((r) => (JSON.parse(r.event_json).payload ?? {}) as WorkItemPayloadJson);
  }

  it("work.item.updated が 3 件以上永続 (trivial-pass 防止)", () => {
    expect(workItemPayloads().length).toBeGreaterThanOrEqual(3);
  });

  it("(a)(b) secret 形 provider_task_id / taskId / summary が SQLite・WS に原文で出ない (漏れゼロ)", () => {
    for (const raw of SECFORM_SECRETS) {
      for (const row of storedRows) {
        expect(row.event_json.includes(raw), `LEAK to SQLite (${raw.slice(0, 6)}…)`).toBe(false);
      }
      expect(sentJoined.includes(raw), `LEAK to WS (${raw.slice(0, 6)}…)`).toBe(false);
    }
  });

  it("(a)(b) secret 形 id は [REDACTED:high-entropy-secret] へ化ける (sink choke で masked)", () => {
    const sqlJoined = storedRows.map((r) => r.event_json).join("\n");
    const marker = "[REDACTED:high-entropy-secret]";
    expect(sqlJoined.includes(marker), "missing marker in SQLite").toBe(true);
    expect(sentJoined.includes(marker), "missing marker in WS").toBe(true);
    // provider_task_id フィールド自体が masked marker を持つ (raw serial でない)。
    const masked = workItemPayloads().filter((p) => p.provider_task_id === marker);
    expect(masked.length).toBeGreaterThanOrEqual(2); // TaskCreated(a) + TaskUpdate(b)。
  });

  it("(c) secret 形 status は closed-enum gate で 'unknown' へ (原文は payload に入らない・構造 drop)", () => {
    const statuses = workItemPayloads().map((p) => p.status);
    expect(statuses).not.toContain(SEC_STATUS);
    expect(statuses).toContain("unknown"); // TaskUpdate の secret status が gate された結果。
  });

  it("(d) 非文字列 subject は drop される (benign task の item に subject 無し・secret 非到達)", () => {
    const nsub = workItemPayloads().find((p) => p.provider_task_id === "nsub1");
    expect(nsub).toBeDefined();
    expect(nsub!.subject).toBeUndefined(); // 配列は workItemText で undefined → 載らない。
  });
});
