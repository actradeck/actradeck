/**
 * INV-AUTOGUARD (ADR 019ecc70 段階1): secret-in-input を既存承認ゲートへ昇格する。
 *
 * 狙い (放牧シナリオの差別化): destructive でなくても tool_input に secret が混ざれば
 * UI 承認なしに実行させない。検出は redactor の単一述語 (redactString(x)!==x) を再利用し、
 * 新正規表現を作らない。理由 (trigger / secret_kinds) は kind 名のみで原文を一切残さない。
 *
 * 各 INV は falsifiable: 実装の該当ガードを外す mutation で赤化することを実証する
 * (本ファイル末尾コメントに mutation→赤の対応を記載)。secret は合成ダミーのみ (実 key 禁止)。
 */
import { describe, expect, it, vi } from "vitest";

import { REDACTION_KINDS_SET } from "@actradeck/event-model";

import { ApprovalBridge } from "../src/approval-bridge.js";
import { normalizeHook } from "../src/normalize.js";
import type { HookCommonInput } from "../src/normalize.js";
import { redactDeep } from "../src/redactor.js";

// --- 合成ダミー secret (テスト専用・実 key ではない) ---------------------------
// GitHub token 形 (ghp_ + 36 字 base62)。redactor の github-token ルールが拾う。
const DUMMY_GH_TOKEN = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
// 高エントロピー credential 代入 (任意 secret 値)。これ自体は destructive でない。
const SECRET_BASH_COMMAND = `export GITHUB_TOKEN=${DUMMY_GH_TOKEN}`;
// 裸 token を含む非 destructive コマンド (github-token ルールが直接当たる: credential-assignment より
// 特異な kind を出すため no-raw の kind 検証で使う)。
const BARE_TOKEN_COMMAND = `echo ${DUMMY_GH_TOKEN}`;

function preToolUse(
  toolName: string,
  toolInput: Record<string, unknown>,
  extra: Partial<HookCommonInput> = {},
): HookCommonInput {
  return {
    session_id: "s1",
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    ...extra,
  };
}

describe("INV-AUTOGUARD-SECRET-GATE: secret-in-input は destructive でなくても承認ゲート対象", () => {
  it("secret 入り Bash.command (非 destructive) は emitRequest され timeout で deny (auto-allow されない)", async () => {
    const bridge = new ApprovalBridge({ timeoutMs: 30 });
    const emit = vi.fn();
    const r = await bridge.requestApproval(
      preToolUse("Bash", { command: SECRET_BASH_COMMAND }),
      emit,
    );
    // 承認カードが 1 回出る (= UI 承認なしに通過しない)。
    expect(emit, "secret command must emit an approval request").toHaveBeenCalledTimes(1);
    // UI 応答なし → 安全側 deny (force-allow / defer ではない)。
    expect(r.behavior, "secret command must not auto-defer").not.toBe("defer");
    expect(r.behavior).toBe("deny");
  });

  it("trigger=secret が emitRequest reason で渡る (destructive を伴わない)", async () => {
    const bridge = new ApprovalBridge({ timeoutMs: 20 });
    let capturedTrigger: string | undefined;
    let capturedKinds: readonly string[] = [];
    const p = bridge.requestApproval(
      preToolUse("Bash", { command: SECRET_BASH_COMMAND }),
      (_id, reason) => {
        capturedTrigger = reason.trigger;
        capturedKinds = reason.secretKinds;
      },
    );
    await p;
    expect(capturedTrigger).toBe("secret");
    expect(capturedKinds.length, "secret kinds must be reported").toBeGreaterThan(0);
  });

  it("secret 無し・非 destructive な Bash は従来どおり defer (over-gate しない)", async () => {
    const bridge = new ApprovalBridge({ timeoutMs: 30 });
    const emit = vi.fn();
    const r = await bridge.requestApproval(preToolUse("Bash", { command: "ls -la" }), emit);
    expect(r.behavior).toBe("defer");
    expect(emit).not.toHaveBeenCalled();
  });

  it("Write の content に secret があれば file_path が無害でも gated (D2: content スキャン)", async () => {
    const bridge = new ApprovalBridge({ timeoutMs: 30 });
    const emit = vi.fn();
    const r = await bridge.requestApproval(
      preToolUse("Write", { file_path: "/repo/notes.txt", content: `token=${DUMMY_GH_TOKEN}` }),
      emit,
    );
    expect(emit, "secret in Write content must gate").toHaveBeenCalledTimes(1);
    expect(r.behavior).toBe("deny");
  });

  it("Edit の new_string に secret があれば gated (D2: new_string スキャン・QA-2)", async () => {
    const bridge = new ApprovalBridge({ timeoutMs: 30 });
    const emit = vi.fn();
    const r = await bridge.requestApproval(
      preToolUse("Edit", {
        file_path: "/repo/a.ts",
        old_string: "x",
        new_string: `const t = "${DUMMY_GH_TOKEN}";`,
      }),
      emit,
    );
    expect(emit, "secret in Edit new_string must gate").toHaveBeenCalledTimes(1);
    expect(r.behavior).toBe("deny");
  });

  it("edit 系の new_str に secret があれば gated (D2: new_str スキャン・QA-2)", async () => {
    const bridge = new ApprovalBridge({ timeoutMs: 30 });
    const emit = vi.fn();
    const r = await bridge.requestApproval(
      preToolUse("Edit", { file_path: "/repo/a.ts", new_str: `secret=${DUMMY_GH_TOKEN}` }),
      emit,
    );
    expect(emit, "secret in new_str must gate").toHaveBeenCalledTimes(1);
    expect(r.behavior).toBe("deny");
  });

  it("MCP payload に secret があっても gated・trigger=both (D2: MCP payload スキャン)", async () => {
    const bridge = new ApprovalBridge({ timeoutMs: 30 });
    const emit = vi.fn();
    let trigger: string | undefined;
    const r = await bridge.requestApproval(
      preToolUse("mcp__store__put", { value: DUMMY_GH_TOKEN }),
      (id, reason) => {
        emit(id);
        trigger = reason.trigger;
      },
    );
    expect(emit, "MCP must emit an approval request").toHaveBeenCalledTimes(1);
    // MCP は destructive ゲートでも gated。secret も検出されるため trigger=both。
    expect(r.behavior).toBe("deny");
    expect(trigger, "MCP with secret must be both (destructive ∧ secret)").toBe("both");
  });
});

describe("INV-AUTOGUARD-NO-RAW: 承認 payload に raw secret が出ず secret_kinds は語彙のみ", () => {
  it("生成される tool.permission.requested payload に raw secret が含まれない", async () => {
    // 実 sidecar 経路を模す: bridge の detector が算出する reason を取得し、
    // hook-receiver と同じく normalizeHook(approvalRequestId, guardTrigger, guardSecretKinds) へ渡す。
    const bridge = new ApprovalBridge({ timeoutMs: 20 });
    let kinds: readonly string[] = [];
    let trigger: "destructive" | "secret" | "both" | undefined;
    await bridge.requestApproval(
      preToolUse("Bash", { command: BARE_TOKEN_COMMAND }),
      (_id, reason) => {
        kinds = reason.secretKinds;
        trigger = reason.trigger;
      },
    );

    const events = normalizeHook(preToolUse("Bash", { command: BARE_TOKEN_COMMAND }), {
      approvalRequestId: "s1:apr-test",
      guardTrigger: trigger,
      guardSecretKinds: kinds,
    });
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    const serialized = JSON.stringify(ev);

    // raw secret (ダミー token そのもの) が payload 全体のどこにも出ない。
    expect(serialized).not.toContain(DUMMY_GH_TOKEN);
    expect(serialized).not.toContain("ghp_A1b2");

    // secret_kinds は REDACTION_KINDS 語彙のみ。
    const payload = (ev as { payload: { secret_kinds?: unknown } }).payload;
    expect(Array.isArray(payload.secret_kinds)).toBe(true);
    for (const k of payload.secret_kinds as string[]) {
      expect(REDACTION_KINDS_SET.has(k), `secret_kind "${k}" must be in REDACTION_KINDS`).toBe(
        true,
      );
    }
    // github-token が含まれること (裸 ghp_ ダミーを検出した証跡)。
    expect((payload.secret_kinds as string[]).includes("github-token")).toBe(true);
  });

  it("command フィールドも redaction 済みで raw secret を含まない", () => {
    const events = normalizeHook(preToolUse("Bash", { command: SECRET_BASH_COMMAND }), {
      approvalRequestId: "s1:apr-test",
      guardTrigger: "secret",
      guardSecretKinds: ["github-token"],
    });
    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain(DUMMY_GH_TOKEN);
    // マスクされたマーカーが出る (redaction が効いた証跡)。
    expect(serialized).toContain("[REDACTED:");
  });
});

describe("INV-AUTOGUARD-BYPASS: bypassPermissions では secret 入りでも非ゲート (早期 defer)", () => {
  it("bypassPermissions + secret 入り command は defer・emitRequest 非呼出・pending 0", async () => {
    const bridge = new ApprovalBridge();
    const emit = vi.fn();
    const r = await bridge.requestApproval(
      preToolUse(
        "Bash",
        { command: SECRET_BASH_COMMAND },
        { permission_mode: "bypassPermissions" },
      ),
      emit,
    );
    expect(r.behavior, "bypass は secret でも defer").toBe("defer");
    expect(emit, "bypass では承認カードを出さない").not.toHaveBeenCalled();
    expect(bridge.pendingCount, "保留を作らない").toBe(0);
  });
});

describe("INV-AUTOGUARD-DESTRUCTIVE-REUSE: 既存 destructive ゲート非退行 (trigger=destructive)", () => {
  it("rm -rf (secret 無し) は従来どおり gated で trigger=destructive", async () => {
    const bridge = new ApprovalBridge({ timeoutMs: 30 });
    let trigger: string | undefined;
    let kinds: readonly string[] = [];
    const r = await bridge.requestApproval(
      preToolUse("Bash", { command: "rm -rf /tmp/x" }),
      (_id, reason) => {
        trigger = reason.trigger;
        kinds = reason.secretKinds;
      },
    );
    expect(r.behavior).toBe("deny");
    expect(trigger, "destructive のみ (secret なし) は trigger=destructive").toBe("destructive");
    expect(kinds, "destructive-only は secret_kinds 空").toEqual([]);
  });

  it("rm -rf に secret も混じれば trigger=both (OR 統合)", async () => {
    const bridge = new ApprovalBridge({ timeoutMs: 30 });
    let trigger: string | undefined;
    await bridge.requestApproval(
      preToolUse("Bash", { command: `rm -rf /tmp/x; export T=${DUMMY_GH_TOKEN}` }),
      (_id, reason) => {
        trigger = reason.trigger;
      },
    );
    expect(trigger).toBe("both");
  });
});

describe("INV-AUTOGUARD-SECRET-NO-AUTOALLOW: secret-trigger は allow_for_session で auto-allow されない (D5)", () => {
  it("secret command を allow_for_session しても同型 secret は 2 回目も emitRequest される", async () => {
    const bridge = new ApprovalBridge({ timeoutMs: 40 });
    let id1 = "";
    const p1 = bridge.requestApproval(
      preToolUse("Bash", { command: SECRET_BASH_COMMAND }),
      (id) => {
        id1 = id;
      },
    );
    expect(id1).not.toBe("");
    // 人間が allow_for_session を選んでも secret-trigger は署名キャッシュへ登録しない。
    expect(bridge.resolve(id1, "allow_for_session")).toBe(true);
    const r1 = await p1;
    expect(r1.behavior).toBe("allow");

    // 2 回目: 同型 secret command は (同一 bridge の cache スコープでも) auto-allow されず再 emitRequest。
    const emit2 = vi.fn();
    const r2 = await bridge.requestApproval(
      preToolUse("Bash", { command: SECRET_BASH_COMMAND }),
      emit2,
    );
    expect(emit2, "secret は auto-allow されず再ゲート").toHaveBeenCalledTimes(1);
    expect(r2.behavior).toBe("deny");
    expect(r2.autoAllowed, "secret は autoAllowed にならない").toBeUndefined();
  });

  it("回帰: destructive-only は従来どおり allow_for_session で auto-allow される", async () => {
    const bridge = new ApprovalBridge({ timeoutMs: 1000 });
    let id1 = "";
    const p1 = bridge.requestApproval(preToolUse("Bash", { command: "rm -rf /tmp/x" }), (id) => {
      id1 = id;
    });
    bridge.resolve(id1, "allow_for_session");
    await p1;

    // 2 回目: destructive-only の同一署名は auto-allow (emit されない)。
    const emit2 = vi.fn();
    const r2 = await bridge.requestApproval(
      preToolUse("Bash", { command: "rm -rf /tmp/x" }),
      emit2,
    );
    expect(emit2, "destructive-only は従来どおり auto-allow").not.toHaveBeenCalled();
    expect(r2.behavior).toBe("allow");
    expect(r2.autoAllowed).toBe(true);
  });
});

describe("INV-AUTOGUARD-KINDS-FIELD-KEEP: secret_kinds は公開 enum を保持しつつ leak-safe", () => {
  // `secret_kinds` キー名は credential ヒューリスティック (`secret` を含む) に当たるため、
  // value-shape gate (isKnownRedactionKind) が無いと配下が無条件マスクされ closed-enum schema を
  // 満たさず event が drop する (over-redaction による機能破壊)。以下を falsifiable に固定する。
  it("既知 kind (REDACTION_KINDS) は redactDeep で保持される (over-redaction による drop 防止)", () => {
    const ev = {
      event_type: "tool.permission.requested",
      payload: {
        kind: "tool.permission.requested",
        secret_kinds: ["github-token", "aws-access-key-id"],
      },
    };
    const r = redactDeep(ev) as { payload: { secret_kinds: string[] } };
    expect(r.payload.secret_kinds).toEqual(["github-token", "aws-access-key-id"]);
  });

  it("secret_kinds に紛れた raw secret 形は依然マスクされる (leak-safe・value-gate が唯一の許可条件)", () => {
    const ev = {
      payload: {
        kind: "tool.permission.requested",
        // 攻撃者が closed-enum を騙って raw secret を載せても value-gate で弾かれる。
        secret_kinds: [DUMMY_GH_TOKEN, "github-token"],
      },
    };
    const r = redactDeep(ev) as { payload: { secret_kinds: string[] } };
    const serialized = JSON.stringify(r);
    expect(serialized, "raw secret must not survive in secret_kinds").not.toContain(DUMMY_GH_TOKEN);
    // 既知 kind は keep、未知 (raw) はマスク。
    expect(r.payload.secret_kinds).toContain("github-token");
    for (const v of r.payload.secret_kinds) {
      // keep されたのは既知 kind のみ。raw 由来は [REDACTED:*] になっている。
      expect(REDACTION_KINDS_SET.has(v) || v.startsWith("[REDACTED:")).toBe(true);
    }
  });
});

/**
 * mutation → 赤化の対応 (実装側を一時改変して本ファイルが赤くなることを実証する):
 * - INV-AUTOGUARD-SECRET-GATE:
 *     requiresHumanApproval の `!destructive && !secret` を `!destructive` にする (secret OR を外す)
 *     → secret command が gated=false になり emit されず defer → 1本目が赤。
 * - INV-AUTOGUARD-NO-RAW:
 *     detectSecretInInput の kind 算出を redacted ではなく raw field 由来にする / isKnownRedactionKind
 *     allowlist filter を外す → raw 由来文字列が secret_kinds に混入し allowlist assert が赤。
 * - INV-AUTOGUARD-BYPASS:
 *     bypassPermissions 早期 return より後ろに secret 検出を置く (早期 return を削る) → emit/pending が立ち赤。
 * - INV-AUTOGUARD-DESTRUCTIVE-REUSE:
 *     trigger 統合の OR を AND にする (destructive && secret のみ gated) → secret 無し rm -rf が
 *     gated=false になり deny を返さず赤。
 * - INV-AUTOGUARD-SECRET-NO-AUTOALLOW:
 *     load-bearing ゲートは requestApproval の **read-side** `!secretTriggered` (cache バイパス)。
 *     これを外すと secret が 2 回目に auto-allow され emit2 非呼出で赤化する (本テストの真ゲート)。
 *     resolve の **write-side** `cacheable` ガード (secret 署名を cache に登録しない) は
 *     belt-and-suspenders で、**単独除去では本テストを赤化しない** (QA-1): 同一署名 ⟺ 同一入力
 *     ⟺ 同一 secret 検出のため secret 署名は非 secret 経路で再来し得ず、read-side が確定的に D5 を
 *     保持する。write-side は signature 導出を将来変更した際の回帰保険として意図的に温存する。
 * - INV-AUTOGUARD-KINDS-FIELD-KEEP (redactor secret_kinds keep):
 *     redactor の SECRET_KIND_FIELDS keep を外す → 既知 kind が credential 文脈マスクされ
 *     ["[REDACTED:credential-assignment]"] になり keep test が赤 (= event-model schema drop 再現)。
 *     value-gate `isKnownRedactionKind` を外し全要素 keep にする → raw secret 形が素通りし leak-safe test が赤。
 */
