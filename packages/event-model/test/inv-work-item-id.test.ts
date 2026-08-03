/**
 * INV-WORKITEM-ID (ADR 0015・受入1): work-item id / tree fingerprint / 契約 enum の T1 固定。
 *
 * 契約 (T1・単一正典):
 * - `sha256Hex` は FIPS 180-4 準拠 (NIST 既知応答ベクタで固定・自前 isomorphic 実装の正当性)。
 * - `deriveWorkItemId` は決定的・冪等で、id に **raw provider テキストを一切含まない** (hash 形のみ・§D3)。
 * - `treeFingerprint` は head+diff から 64-hex を導出し、head 欠落で diff_hash-only へ縮退する (§D5)。
 * - work-item 契約 enum は closed (未知値は parse 境界で構造的に落ちる・§D2/§D7)。
 */
import { describe, expect, it } from "vitest";

import {
  CheckKind,
  CheckMatch,
  EventPayload,
  ObservationAvailability,
  ObservationFidelity,
  ObservationMethod,
  ObservedCapability,
  VerificationState,
  WorkItemStatus,
  deriveWorkItemId,
  sha256Hex,
  treeFingerprint,
} from "../src/index.js";

describe("INV-WORKITEM-ID: sha256Hex は FIPS 180-4 既知応答ベクタに一致 (isomorphic 実装の正当性)", () => {
  it("NIST ベクタ", () => {
    // 標準の既知応答 (空文字列 / "abc" / >1 block 入力)。
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    // 448-bit メッセージ (2 ブロック境界を跨ぐ・padding 分岐の網羅)。
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("hex 64 桁・空白/NUL 連結入力も安全に処理する (fingerprint の \\0 連結)", () => {
    expect(sha256Hex("head diff")).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex("a b")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("UTF-8 マルチバイト (2/3/4 byte + surrogate pair) を正しくエンコードする", () => {
    // 自前 UTF-8 encoder の全 byte-length 分岐を既知応答で固定 (誤エンコード = 全 id サイレント破壊)。
    expect(sha256Hex("é")).toBe("4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c"); // 2-byte
    expect(sha256Hex("€")).toBe("c4cc90ed3d26f12d4b08a75140970a7904035c31cbb4515a83f19b9003c00d1d"); // 3-byte
    expect(sha256Hex("🎉")).toBe(
      "6146299cd54818a0e659eb6ac88e80f6f8f70536bbbd962d36973f2d2323f26c",
    ); // 4-byte (surrogate pair)
    expect(sha256Hex("aé€🎉z")).toBe(
      "d76f99c1e6319800f40c87090b94630ed881ef99f4ab03c02ba4479f7748b379",
    ); // 混在
  });

  it("lone surrogate は U+FFFD 置換で決定的に処理する (crash しない)", () => {
    // 不正 UTF-16 (対を欠く surrogate) でも例外を投げず 64-hex を返す (堅牢性)。
    expect(sha256Hex("\ud800")).toMatch(/^[0-9a-f]{64}$/); // lone high
    expect(sha256Hex("\udc00")).toMatch(/^[0-9a-f]{64}$/); // lone low
    expect(sha256Hex("\ud800x")).toMatch(/^[0-9a-f]{64}$/); // high + 非 low
  });
});

describe("INV-WORKITEM-ID: deriveWorkItemId は決定的・冪等・NO-RAW (受入1)", () => {
  it("同一 (scheme, text) → 同一 id (決定的・冪等)", () => {
    expect(deriveWorkItemId("task", "1")).toBe(deriveWorkItemId("task", "1"));
    expect(deriveWorkItemId("plan", "write tests")).toBe(deriveWorkItemId("plan", "write tests"));
  });

  it("id は `<scheme>:<16-hex>` 形のみ (raw provider テキスト非含・DOM/testid/URL safe)", () => {
    const secretish = "ghp_TOTALLYSECRETvalue1234567890";
    const id = deriveWorkItemId("task", secretish);
    expect(id).toMatch(/^task:[0-9a-f]{16}$/);
    // raw 入力の断片が id へ漏れない。
    expect(id.includes(secretish)).toBe(false);
    expect(id.includes("ghp_")).toBe(false);
  });

  it("plan scheme は trim してから hash (前後空白の揺れで別 item 化しない)", () => {
    expect(deriveWorkItemId("plan", "  write tests  ")).toBe(
      deriveWorkItemId("plan", "write tests"),
    );
  });

  it("task scheme は無加工 hash (provider id を勝手に正規化しない)", () => {
    expect(deriveWorkItemId("task", " 1 ")).not.toBe(deriveWorkItemId("task", "1"));
  });

  it("scheme prefix が id を分離する (同一テキストでも task/plan は別 id)", () => {
    expect(deriveWorkItemId("task", "x")).not.toBe(deriveWorkItemId("plan", "x"));
  });
});

describe("INV-WORKITEM-ID: treeFingerprint (§D5)", () => {
  it("head + diff → 64-hex; head の変化で fingerprint が変わる", () => {
    const a = treeFingerprint("deadbeef", "diffhashA");
    const b = treeFingerprint("cafebabe", "diffhashA");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    // 決定的。
    expect(treeFingerprint("deadbeef", "diffhashA")).toBe(a);
  });

  it("head 欠落 → diff_hash-only へ縮退", () => {
    expect(treeFingerprint(undefined, "diffhashA")).toBe("diffhashA");
    expect(treeFingerprint("", "diffhashA")).toBe("diffhashA");
  });

  it("両方欠落 → undefined", () => {
    expect(treeFingerprint(undefined, undefined)).toBeUndefined();
    expect(treeFingerprint(undefined, "")).toBeUndefined();
  });
});

describe("INV-WORKITEM-ID: 契約 enum は closed (§D2/§D5/§D7)", () => {
  it("WorkItemStatus / VerificationState / CheckKind / CheckMatch の値集合", () => {
    expect(WorkItemStatus.options).toEqual([
      "pending",
      "in_progress",
      "completed",
      "cancelled",
      "removed",
      "unknown",
    ]);
    expect(VerificationState.options).toEqual([
      "unverified",
      "passed",
      "failed",
      "stale",
      "waived",
    ]);
    expect(CheckKind.options).toEqual(["test", "lint", "typecheck", "build", "format"]);
    expect(CheckMatch.options).toEqual(["program", "script"]);
  });

  it("observation 3 軸 + ObservedCapability の値集合", () => {
    expect(ObservationAvailability.options).toEqual([
      "available",
      "unsupported",
      "permission_denied",
      "unavailable",
    ]);
    expect(ObservationMethod.options).toEqual([
      "official_hook",
      "official_api",
      "provider_jsonl",
      "local_file",
      "log_parse",
      "heuristic",
    ]);
    expect(ObservationFidelity.options).toEqual([
      "authoritative",
      "observed",
      "parsed",
      "inferred",
      "unknown",
    ]);
    expect(ObservedCapability.options).toEqual([
      "work_items",
      "completion_claims",
      "verification_checks",
      "tree_fingerprint",
    ]);
  });

  it("未知 status/method は reject する (enum 外は parse 境界で構造的に落ちる)", () => {
    expect(WorkItemStatus.safeParse("done").success).toBe(false);
    expect(ObservationFidelity.safeParse("official").success).toBe(false); // official≠authoritative
  });
});

describe("INV-WORKITEM-ID: payload variant 契約 (discriminated union で未知値を落とす)", () => {
  it("work.item.updated variant を受理する (subject/observation optional)", () => {
    const parsed = EventPayload.safeParse({
      kind: "work.item.updated",
      provider_task_id: "1",
      status: "completed",
      subject: "[REDACTED:github-token] を実装",
      observation: { method: "official_hook", fidelity: "observed" },
    });
    expect(parsed.success).toBe(true);
  });

  it("work.item.updated の未知 status は variant parse で reject", () => {
    const parsed = EventPayload.safeParse({
      kind: "work.item.updated",
      provider_task_id: "1",
      status: "done",
    });
    expect(parsed.success).toBe(false);
  });

  it("turn.plan.updated の typed items を受理し legacy steps と併存できる", () => {
    const parsed = EventPayload.safeParse({
      kind: "turn.plan.updated",
      steps: ["a", "b"],
      items: [
        { step: "a", status: "completed" },
        { step: "b", status: "in_progress" },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("session.started の observation_evidence (capability snapshot) を受理する", () => {
    const parsed = EventPayload.safeParse({
      kind: "session.started",
      observation_evidence: {
        work_items: { availability: "available", method: "official_hook", fidelity: "observed" },
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("command.completed の check_kind/check_match を受理する", () => {
    const parsed = EventPayload.safeParse({
      kind: "command.completed",
      exit_code: 0,
      check_kind: "test",
      check_match: "script",
    });
    expect(parsed.success).toBe(true);
  });

  it("diff.updated の head_sha を受理する", () => {
    const parsed = EventPayload.safeParse({
      kind: "diff.updated",
      diff_hash: "abc",
      head_sha: "deadbeef",
    });
    expect(parsed.success).toBe(true);
  });
});
