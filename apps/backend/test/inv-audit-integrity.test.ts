/**
 * INV-AUDIT-INTEGRITY: tamper-evident audit export (ADR 6点強化 #1・保証モデル A・SEC-1 rework).
 *
 * 検証:
 *  - manifest は **表示投影全体** (summary メタ / redaction 件数 / approvals tally / high_risk /
 *    per-event 可視 command 列 / diff) を binding する。
 *  - **INV-AUDIT-INTEGRITY-BODY**: 表示のどれか一つでも書換えると verify ok=false (SEC-1)。
 *  - 単射 canonical (JSON.stringify・SEC-3): フィールド境界 injection で hash 衝突しない。
 *  - 署名 + **fingerprint pin 必須** (SEC-2): 未 pin 署名は ok=false・自鍵 forge も ok=false。
 *  - malformed (events:[null] 等) は throw せず ok=false 値返し (SEC-4)。
 *  - NO-RAW: manifest は redaction 済み表示値のみ。
 */
import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";

import { APPROVAL_DECISIONS } from "@actradeck/event-model";

import {
  buildAuditManifest,
  verifyAuditManifest,
  canonicalizeEventFields,
  fingerprintOfPublicKey,
  normalizeEventForManifest,
  normalizeSummaryForManifest,
  resolveAuditSignerFromEnv,
  decodeManifestBase64,
  encodeManifestBase64,
  AUDIT_MANIFEST_VERSION,
  AUDIT_MANIFEST_MARKER,
  type AuditManifest,
  type DecodedAuditManifest,
} from "../src/audit-integrity.js";
import { sessionReportToHtml, sessionReportToMarkdown } from "../src/audit-report.js";
import type { AuditSessionReport, AuditSessionReportDiff } from "../src/audit-report.js";
import { AUDIT_DECISIONS, emptyDecisionTally } from "../src/audit-contract.js";
import type { AuditSessionSummary } from "../src/audit-contract.js";
import type { ReplayEventDTO } from "../src/replay-contract.js";

function extractManifestB64FromHtml(html: string): string | undefined {
  return html.match(
    new RegExp(`<!-- ${AUDIT_MANIFEST_MARKER}\\+base64:([A-Za-z0-9+/=]+):end-`),
  )?.[1];
}
function extractManifestB64FromMarkdown(md: string): string | undefined {
  return md.match(new RegExp("```" + AUDIT_MANIFEST_MARKER + "\\n([A-Za-z0-9+/=]+)\\n```"))?.[1];
}

function ev(partial: Partial<ReplayEventDTO> & { event_id: string }): ReplayEventDTO {
  return {
    provider: "claude_code",
    source: "hooks",
    session_id: "demo-safety-x",
    event_type: "session.started",
    kind: "session",
    timestamp: "2026-07-03T12:00:00.000Z",
    state: undefined,
    cwd: undefined,
    summary: undefined,
    display_text: "-",
    subject: undefined,
    request_id: undefined,
    tool_name: undefined,
    command: undefined,
    path: undefined,
    risk_level: undefined,
    decision: undefined,
    auto_allowed: undefined,
    exit_code: undefined,
    elapsed_ms: undefined,
    ...partial,
  } as ReplayEventDTO;
}

function sampleSummary(): AuditSessionSummary {
  return {
    session_id: "demo-safety-x",
    provider: "claude_code",
    source: "hooks",
    agent_id: undefined,
    repo: "/tmp/actradeck-demo",
    branch: undefined,
    cwd: "/tmp/actradeck-demo",
    capture_mode: undefined,
    permission_mode: undefined,
    state: "completed",
    started_at: "2026-07-03T12:00:00.000Z",
    ended_at: undefined,
    last_event_at: "2026-07-03T12:00:09.000Z",
    secret_detected: true,
    secret_redaction_count: 2,
    secret_redaction_count_by_kind: { "aws-access-key-id": 1, "github-token": 1 },
    approvals: {
      total: 1,
      by_decision: { ...emptyDecisionTally(), deny: 1 },
      synthetic_retired: 0,
      pending: 0,
    },
    high_risk_op_count: 1,
    auto_allowed_count: 0,
  };
}

function report(events: ReplayEventDTO[], diff?: AuditSessionReportDiff): AuditSessionReport {
  return {
    generated_at: "2026-07-03T12:00:10.000Z",
    summary: sampleSummary(),
    events,
    events_truncated: false,
    ...(diff !== undefined ? { diff } : {}),
  };
}

const SAMPLE = report([
  ev({ event_id: "e1", event_type: "session.started", kind: "session" }),
  ev({
    event_id: "e2",
    event_type: "tool.permission.requested",
    kind: "approval",
    risk_level: "high",
    command: "rm -rf /tmp/actradeck-demo/build",
  }),
  ev({
    event_id: "e3",
    event_type: "tool.permission.resolved",
    kind: "approval",
    decision: "deny",
  }),
  ev({
    event_id: "e4",
    event_type: "command.completed",
    kind: "command",
    exit_code: 0,
    command: 'echo "deploy with [REDACTED:aws-access-key-id] to staging"',
  }),
]);

function ed25519Pem(): string {
  return generateKeyPairSync("ed25519").privateKey.export({
    type: "pkcs8",
    format: "pem",
  }) as string;
}
const signer = resolveAuditSignerFromEnv({ ACTRADECK_AUDIT_SIGNING_KEY: ed25519Pem() });
/** 署名済み manifest を pin 付きで verify (信頼を確立した受け手を模す)。 */
function verifyPinned(m: AuditManifest | DecodedAuditManifest) {
  return verifyAuditManifest(m, { expectedFingerprint: m.signature!.public_key_fingerprint });
}

describe("INV-AUDIT-INTEGRITY canonicalize (単射・SEC-3)", () => {
  it("フィールド境界 injection で衝突しない (JSON.stringify 単射)", () => {
    // 隣接フィールドへ内容を移しても canonical が異なる (US-join なら衝突していた)。
    const base = {
      event_id: "x",
      timestamp: "t",
      event_type: "e",
      kind: "k",
      risk_level: "",
      decision: "",
      exit_code: "0",
      elapsed_ms: "",
      command: "1",
    };
    expect(canonicalizeEventFields(base)).not.toBe(
      canonicalizeEventFields({ ...base, exit_code: "01", command: "" }),
    );
    // 制御文字を含んでも衝突しない (display 由来の US 等)。
    expect(canonicalizeEventFields({ ...base, exit_code: "01", command: "" })).not.toBe(
      canonicalizeEventFields({ ...base, exit_code: "0", command: "1" }),
    );
  });

  it("normalizeEventForManifest: 可視 command 列は command??path??subject", () => {
    expect(normalizeEventForManifest(ev({ event_id: "a", command: "C", path: "P" })).command).toBe(
      "C",
    );
    expect(normalizeEventForManifest(ev({ event_id: "a", path: "P", subject: "S" })).command).toBe(
      "P",
    );
    expect(normalizeEventForManifest(ev({ event_id: "a", subject: "S" })).command).toBe("S");
    expect(normalizeEventForManifest(ev({ event_id: "a" })).command).toBe("");
  });
});

describe("INV-AUDIT-INTEGRITY unsigned chain", () => {
  it("無改竄 → chain_valid・ok (unsigned=内部整合)", () => {
    const m = buildAuditManifest(SAMPLE);
    expect(m.version).toBe(AUDIT_MANIFEST_VERSION);
    expect(m.event_count).toBe(4);
    expect(m.signature).toBeUndefined();
    const r = verifyAuditManifest(m);
    expect(r.chain_valid).toBe(true);
    expect(r.ok).toBe(true);
  });

  it("空 events でも root=summary+diff を binding・verify ok", () => {
    const m = buildAuditManifest(report([]));
    expect(m.event_count).toBe(0);
    expect(verifyAuditManifest(m).ok).toBe(true);
  });
});

describe("INV-AUDIT-INTEGRITY-BODY: 表示投影の改竄検知 (SEC-1)", () => {
  // 署名 + pin して「配布後改竄検知」の主用途を検証する。
  const m = buildAuditManifest(SAMPLE, signer);

  it("無改竄署名済み + pin → verified", () => {
    const r = verifyPinned(m);
    expect(r.ok).toBe(true);
    expect(r.signature_valid).toBe(true);
    expect(r.reason).toContain("verified");
  });

  it("redaction 件数の改竄を検知 (summary.secret_redaction_count)", () => {
    const t: AuditManifest = { ...m, summary: { ...m.summary, secret_redaction_count: "0" } };
    expect(verifyPinned(t).ok).toBe(false);
  });

  it("redaction by-kind の改竄を検知", () => {
    const t: AuditManifest = {
      ...m,
      summary: { ...m.summary, redaction_by_kind: [["github-token", "0"]] },
    };
    expect(verifyPinned(t).ok).toBe(false);
  });

  it("approval 判定 (deny 数) の改竄を検知", () => {
    const t: AuditManifest = {
      ...m,
      summary: { ...m.summary, approval_deny: "0", approval_allow: "1" },
    };
    expect(verifyPinned(t).ok).toBe(false);
  });

  it("high_risk_op_count の改竄を検知", () => {
    const t: AuditManifest = { ...m, summary: { ...m.summary, high_risk_op_count: "0" } };
    expect(verifyPinned(t).ok).toBe(false);
  });

  it("summary メタ (repo/state) の改竄を検知", () => {
    const t: AuditManifest = { ...m, summary: { ...m.summary, repo: "/evil", state: "failed" } };
    expect(verifyPinned(t).ok).toBe(false);
  });

  it("per-event 可視 command 列の改竄を検知 (rm -rf → ls)", () => {
    const t: AuditManifest = {
      ...m,
      events: m.events.map((e) => (e.event_id === "e2" ? { ...e, command: "ls" } : e)),
    };
    expect(verifyPinned(t).ok).toBe(false);
  });

  it("per-event decision (deny→allow) の改竄を検知", () => {
    const t: AuditManifest = {
      ...m,
      events: m.events.map((e) => (e.event_id === "e3" ? { ...e, decision: "allow" } : e)),
    };
    expect(verifyPinned(t).ok).toBe(false);
  });

  it("per-event exit_code の改竄を検知 (QA-1: 0→137)", () => {
    const t: AuditManifest = {
      ...m,
      events: m.events.map((e) => (e.event_id === "e4" ? { ...e, exit_code: "137" } : e)),
    };
    expect(verifyPinned(t).ok).toBe(false);
  });

  it("events_truncated (完全性フラグ) の改竄を検知 (TDA-1: 打ち切り subset の完全偽装を防ぐ)", () => {
    // 打ち切られた report を署名 → "truncated" を隠す (true→false) 改竄。
    const truncated = buildAuditManifest(
      { ...report([ev({ event_id: "e1" })]), events_truncated: true },
      signer,
    );
    expect(truncated.events_truncated).toBe("true");
    expect(verifyPinned(truncated).ok).toBe(true);
    expect(verifyPinned({ ...truncated, events_truncated: "false" }).ok).toBe(false);
  });

  it("root 書換え・event_count 不整合を検知", () => {
    expect(verifyPinned({ ...m, root: "deadbeef" }).ok).toBe(false);
    expect(verifyPinned({ ...m, event_count: 3 }).ok).toBe(false);
  });

  it("diff 本文の改竄を検知 (body_sha256 binding)", () => {
    const withDiff = buildAuditManifest(
      report([ev({ event_id: "e1" })], {
        available: true,
        body: "@@ -1 +1 @@\n-a\n+b",
        truncated: false,
        secret_detected: false,
        redaction_count: 0,
      }),
      signer,
    );
    expect(verifyPinned(withDiff).ok).toBe(true);
    // body 改竄 (body_sha256) と件数改竄 (redaction_count) の双方を検知 (QA-1)。
    expect(
      verifyPinned({ ...withDiff, diff: { ...withDiff.diff!, body_sha256: "0".repeat(64) } }).ok,
    ).toBe(false);
    expect(
      verifyPinned({ ...withDiff, diff: { ...withDiff.diff!, redaction_count: "9" } }).ok,
    ).toBe(false);
  });
});

describe("INV-AUDIT-INTEGRITY 署名 + fingerprint pin (SEC-2)", () => {
  const m = buildAuditManifest(SAMPLE, signer);

  it("署名済みだが expected_fingerprint 未指定 → ok=false (unpinned・tamper-evidence 不成立)", () => {
    const r = verifyAuditManifest(m);
    expect(r.signature_valid).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("unpinned");
  });

  it("fingerprint 一致 → ok・不一致 → ok=false (untrusted-key)", () => {
    expect(verifyPinned(m).ok).toBe(true);
    const wrong = verifyAuditManifest(m, { expectedFingerprint: "0".repeat(64) });
    expect(wrong.ok).toBe(false);
    expect(wrong.reason).toContain("untrusted-key");
  });

  it("攻撃者が自鍵で再署名 (chain 整合) しても pin で弾く (forge 不能)", () => {
    // 攻撃者は e3 を allow に書換え、自分の Ed25519 鍵で正しく再署名した manifest を作る。
    const attackerSigner = resolveAuditSignerFromEnv({ ACTRADECK_AUDIT_SIGNING_KEY: ed25519Pem() });
    const tampered = report(
      SAMPLE.events.map((e) => (e.event_id === "e3" ? ev({ ...e, decision: "allow" }) : e)),
    );
    const forged = buildAuditManifest(tampered, attackerSigner);
    // 受け手は元の operator 鍵 fingerprint を pin する → 攻撃者鍵と不一致で ok=false。
    const r = verifyAuditManifest(forged, {
      expectedFingerprint: m.signature!.public_key_fingerprint,
    });
    expect(r.signature_valid).toBe(true); // 攻撃者鍵での署名は「有効」だが
    expect(r.key_trusted).toBe(false); // 信頼した鍵ではない
    expect(r.ok).toBe(false);
  });

  it("旧署名の使い回し (別 root へ貼付) → signature-invalid", () => {
    const other = buildAuditManifest(report([ev({ event_id: "z1" })]));
    const forged: AuditManifest = { ...other, signature: m.signature! };
    const r = verifyAuditManifest(forged, {
      expectedFingerprint: m.signature!.public_key_fingerprint,
    });
    expect(r.signature_valid).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("SEC-1: 自鍵署名 + public_key_fingerprint を被害者 fp へ詐称しても pin で弾く (実鍵由来 fp 照合)", () => {
    // 自己申告 fp を信頼すると「攻撃者が自鍵で署名し fp を被害者の既知 fp に詐称」で ok=true になる
    // バイパスがあった (packet と共通 helper fingerprintOfPublicKey で実鍵由来 fp 照合へ修正)。
    const attackerSigner = resolveAuditSignerFromEnv({ ACTRADECK_AUDIT_SIGNING_KEY: ed25519Pem() });
    const forged = buildAuditManifest(report([ev({ event_id: "e1" })]), attackerSigner);
    const spoofed: AuditManifest = {
      ...forged,
      signature: {
        ...forged.signature!,
        public_key_fingerprint: m.signature!.public_key_fingerprint,
      },
    };
    const r = verifyAuditManifest(spoofed, {
      expectedFingerprint: m.signature!.public_key_fingerprint,
    });
    expect(r.signature_valid).toBe(true);
    expect(r.key_trusted).toBe(false);
    expect(r.ok).toBe(false);
  });
});

describe("INV-AUDIT-INTEGRITY malformed 堅牢化 (SEC-4)", () => {
  it("events:[null] → throw せず ok=false malformed", () => {
    const r = verifyAuditManifest({
      version: AUDIT_MANIFEST_VERSION,
      algorithm: "sha256-chain",
      session_id: "x",
      generated_at: "t",
      event_count: 1,
      summary: { redaction_by_kind: [] },
      events: [null],
      root: "y",
    } as unknown as AuditManifest);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("malformed-manifest");
  });

  it("events 欠落 / version 不正 / summary 非 object → malformed", () => {
    for (const bad of [
      { version: AUDIT_MANIFEST_VERSION, session_id: "x", root: "y", generated_at: "t" }, // events/summary 欠落
      { version: "wrong", session_id: "x", root: "y", generated_at: "t", summary: {}, events: [] },
      {
        version: AUDIT_MANIFEST_VERSION,
        session_id: "x",
        root: "y",
        generated_at: "t",
        summary: null,
        events: [],
      },
    ]) {
      const r = verifyAuditManifest(bad as unknown as AuditManifest);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("malformed-manifest");
    }
  });

  it("events_truncated が非文字列 (boolean) → malformed 分類 (QA-L1: string 型 guard を反証固定)", () => {
    // 有効な署名済 manifest の events_truncated を boolean に差し替える。string 型 guard が
    // 無ければ chain 再計算まで進み reason="chain-mismatch" に化ける (ok=false ではあるが分類が別)。
    // reason を "malformed-manifest" で pin することで guard 除去 MUTANT を RED 化する (load-bearing)。
    const valid = buildAuditManifest(SAMPLE, signer);
    for (const badVal of [true, 1, null, undefined, {}]) {
      const r = verifyAuditManifest({
        ...valid,
        events_truncated: badVal,
      } as unknown as AuditManifest);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("malformed-manifest");
    }
  });

  it("base64 decode: 破損/version 不正 → undefined", () => {
    expect(decodeManifestBase64("!!!not-base64")).toBeUndefined();
    expect(decodeManifestBase64(Buffer.from('{"version":"x"}').toString("base64"))).toBeUndefined();
  });
});

describe("INV-AUDIT-INTEGRITY embed round-trip + NO-RAW", () => {
  const m = buildAuditManifest(SAMPLE, signer);

  it("HTML: no <script>・埋込 base64 抽出→decode→verify(pin) ok", () => {
    const html = sessionReportToHtml(SAMPLE, m);
    expect(html).not.toMatch(/<script[\s>]/i);
    const decoded = decodeManifestBase64(extractManifestB64FromHtml(html)!)!;
    expect(verifyPinned(decoded).ok).toBe(true);
  });

  it("Markdown: 埋込 base64 抽出→decode→verify(pin) ok", () => {
    const md = sessionReportToMarkdown(SAMPLE, m);
    const decoded = decodeManifestBase64(extractManifestB64FromMarkdown(md)!)!;
    expect(verifyPinned(decoded).ok).toBe(true);
  });

  it("manifest 無しなら Integrity 章を出さない (opt-in)", () => {
    expect(sessionReportToHtml(SAMPLE)).not.toContain("Integrity (tamper-evidence)");
  });

  it("NO-RAW: manifest に raw secret を載せない (redaction 済み表示のみ)", () => {
    const json = JSON.stringify(encodeManifestBase64(m)) + JSON.stringify(m);
    expect(json).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(json).toContain("[REDACTED:aws-access-key-id]");
  });

  it("SEC-L1: Integrity 表示 fp は自己申告でなく実鍵から再計算した値 (詐称値を表示しない)", () => {
    // declared fp を詐称しても表示 fp は sig.public_key 由来の再計算値 → 目視照合の受け手も騙されない。
    const spoofed: AuditManifest = {
      ...m,
      signature: { ...m.signature!, public_key_fingerprint: "0".repeat(64) },
    };
    const realFp = fingerprintOfPublicKey(m.signature!.public_key);
    const html = sessionReportToHtml(SAMPLE, spoofed);
    expect(html).toContain(realFp); // 実鍵由来 fp を表示
    expect(html).not.toContain("0".repeat(64)); // 詐称値は表示しない
  });
});

/**
 * QA-R3-1: summary 投影の値結合。fixture 値が mutant 定数 (0/"") と一致すると定数化 mutation が
 * 生き残るため、**全 field を distinct な非ゼロ値**で与え、投影が各 field を実際に反映することを
 * 一括で固定する (manifest は投影値へ暗号署名する — 台帳値と投影の fidelity がここの契約)。
 */
describe("INV-AUDIT-INTEGRITY summary 投影の値結合 (QA-R3-1)", () => {
  it("normalizeSummaryForManifest は全 field を distinct 値で反映 (定数化 mutant で RED)", () => {
    const s: AuditSessionSummary = {
      session_id: "sid-vb",
      provider: "p-vb",
      source: "src-vb",
      agent_id: "agent-vb",
      repo: "repo-vb",
      branch: "branch-vb",
      cwd: "/cwd-vb",
      capture_mode: "managed",
      permission_mode: "pm-vb",
      state: "state-vb",
      started_at: "2026-01-01T00:00:01.000Z",
      ended_at: "2026-01-01T00:00:02.000Z",
      last_event_at: "2026-01-01T00:00:03.000Z",
      secret_detected: true,
      secret_redaction_count: 11,
      secret_redaction_count_by_kind: { "github-token": 13, "aws-access-key-id": 12 },
      approvals: {
        total: 21,
        by_decision: { allow: 3, allow_for_session: 4, deny: 5, cancel: 6 },
        synthetic_retired: 7,
        pending: 8,
      },
      high_risk_op_count: 9,
      auto_allowed_count: 10,
    };
    expect(normalizeSummaryForManifest(s)).toEqual({
      provider: "p-vb",
      source: "src-vb",
      agent_id: "agent-vb",
      repo: "repo-vb",
      branch: "branch-vb",
      cwd: "/cwd-vb",
      capture_mode: "managed",
      permission_mode: "pm-vb",
      state: "state-vb",
      started_at: "2026-01-01T00:00:01.000Z",
      ended_at: "2026-01-01T00:00:02.000Z",
      last_event_at: "2026-01-01T00:00:03.000Z",
      secret_detected: "true",
      secret_redaction_count: "11",
      redaction_by_kind: [
        ["aws-access-key-id", "12"],
        ["github-token", "13"],
      ],
      approval_total: "21",
      approval_allow: "3",
      approval_allow_for_session: "4",
      approval_deny: "5",
      approval_cancel: "6",
      approval_synthetic_retired: "7",
      approval_pending: "8",
      high_risk_op_count: "9",
    });
  });
});

/**
 * SEC-R3-1: manifest version の区別。v2→v3 bump は v0.6.0 出荷済み artifact の breaking であり、
 * 旧版を「malformed (改竄と同じ見え方)」へ潰すと evidence-continuity と honest-signalling を欠く。
 * 旧版は fail-closed のまま **distinct reason** で返す (ok=true になる経路は存在しない)。
 */
describe("INV-AUDIT-INTEGRITY manifest version 区別 (SEC-R3-1)", () => {
  it("旧 version (v2) は malformed でなく unsupported-manifest-version (fail-closed 維持)", () => {
    const v2 = {
      ...buildAuditManifest(SAMPLE),
      version: "actradeck-audit-manifest/v2",
    } as unknown as AuditManifest;
    const r = verifyAuditManifest(v2);
    expect(r.ok).toBe(false);
    expect(r.chain_valid).toBe(false);
    expect(r.reason).toBe("unsupported-manifest-version");
  });

  it("旧 version は decodeManifestBase64 を透過し verify が同 reason を返す (route 400 に潰れない)", () => {
    const v2 = {
      ...buildAuditManifest(SAMPLE),
      version: "actradeck-audit-manifest/v2",
    } as unknown as AuditManifest;
    const decoded = decodeManifestBase64(encodeManifestBase64(v2));
    expect(decoded).toBeDefined();
    expect(verifyAuditManifest(decoded!).reason).toBe("unsupported-manifest-version");
  });

  it("version 非 string / events 非配列は decode で undefined (manifest ですらない)", () => {
    const noVersion = { ...buildAuditManifest(SAMPLE), version: 3 } as unknown as AuditManifest;
    expect(decodeManifestBase64(encodeManifestBase64(noVersion))).toBeUndefined();
    const noEvents = { ...buildAuditManifest(SAMPLE), events: "x" } as unknown as AuditManifest;
    expect(decodeManifestBase64(encodeManifestBase64(noEvents))).toBeUndefined();
  });

  it("現行 version の verify は不変 (positive control)", () => {
    const r = verifyAuditManifest(buildAuditManifest(SAMPLE));
    expect(r.ok).toBe(true);
    expect(r.reason).not.toBe("unsupported-manifest-version");
  });
});

/**
 * SEC-R4-1: 保証範囲の境界 pin。`summary.entries[]` (承認 1 件ごとの itemized 列・JSON/packet JSON
 * tier のみ搬送・HTML/MD は非描画) は manifest の binding **対象外** — これは意図された範囲であり
 * module doc の「正直な保証範囲」節が開示する。本テストはその境界を**意図として**固定する:
 * entries を binding へ拡張する変更はここを赤くする = canonical form 変更 (version bump + full 監査)
 * を明示的に踏ませる。総量 (tally) と review 重要項目 (packet flagged) は binding 済み。
 */
describe("INV-AUDIT-INTEGRITY 保証範囲の境界 (SEC-R4-1)", () => {
  it("summary.entries だけ異なる 2 report の root は一致する (entries は非 binding・開示済み範囲)", () => {
    const entry = {
      event_id: "e-ent",
      timestamp: "2026-07-03T12:00:05.000Z",
      tool_name: "Bash",
      risk_level: "high",
      command: "rm -rf /tmp/actradeck-demo/build",
      path: undefined,
      decision: "deny" as const,
      resolution_origin: undefined,
      auto_allowed: undefined,
    };
    const withEntries: AuditSessionReport = {
      ...SAMPLE,
      summary: { ...sampleSummary(), entries: [entry] },
    };
    const withForgedEntries: AuditSessionReport = {
      ...SAMPLE,
      summary: {
        ...sampleSummary(),
        entries: [{ ...entry, command: "ls (forged)", decision: "allow" as const }],
      },
    };
    const rootA = buildAuditManifest(withEntries).root;
    const rootB = buildAuditManifest(withForgedEntries).root;
    const rootNone = buildAuditManifest(SAMPLE).root;
    expect(rootA).toBe(rootB);
    expect(rootA).toBe(rootNone);
  });

  it("HTML/MD renderer は entries を描画しない (QA-R5-4: 非 binding 境界の補完・renderer 側 pin)", () => {
    // SEC-R4-1 の root 一致 pin は「entries は binding 外」の片側のみ。module doc の
    // 「manifest は HTML/MD が表示する監査事実の authoritative record」が成立するには
    // **renderer が entries を表示しない**ことも必要 (表示するなら binding へ拡張 = version bump
    // + full 監査を踏ませる)。entries だけ異なる 2 report の描画が byte 一致することで固定する。
    const entry = {
      event_id: "e-ent-r5",
      timestamp: "2026-07-03T12:00:05.000Z",
      tool_name: "Bash",
      risk_level: "high",
      command: "forged-cmd-QA-R5-4-marker",
      path: undefined,
      decision: "deny" as const,
      resolution_origin: undefined,
      auto_allowed: undefined,
    };
    const withEntries: AuditSessionReport = {
      ...SAMPLE,
      summary: { ...sampleSummary(), entries: [entry] },
    };
    for (const render of [sessionReportToHtml, sessionReportToMarkdown]) {
      const withOut = render(SAMPLE);
      const withIn = render(withEntries);
      expect(withIn).toBe(withOut); // entries の有無で描画が変わらない = 非表示。
      expect(withIn).not.toContain("forged-cmd-QA-R5-4-marker");
    }
  });
});

/**
 * INV-APPROVAL-DECISION-VOCAB (SEC-R5-1 + QA-R5-1・R5 監査):
 * decision 語彙の単一出所を**参照同一性 + manifest 投影**の両面で固定する。
 *  - QA-R5-1: `AUDIT_DECISIONS = APPROVAL_DECISIONS` は代入の現形にのみ依存し回帰テストが
 *    無かった (同値の手書き literal へ戻しても 720 緑 — mutation probe P3c で実証)。参照同一性
 *    pin で手書きミラーの復活を RED にする。
 *  - SEC-R5-1: 署名 manifest の正準形 (`normalizeSummaryForManifest`) は decision 別計数を
 *    `approval_<d>` キーで手書き投影しており、正準語彙へ 5 番目の decision が入っても投影されず
 *    その計数が Ed25519 binding の外に落ちる。本 pin は語彙拡張の日に RED になり、意図的な
 *    manifest version bump (+ full 監査) を強制する。
 */
describe("INV-APPROVAL-DECISION-VOCAB: decision 語彙の単一出所 (SEC-R5-1/QA-R5-1)", () => {
  it("AUDIT_DECISIONS は正準 APPROVAL_DECISIONS と同一参照 (手書きミラー復活で RED)", () => {
    expect(AUDIT_DECISIONS).toBe(APPROVAL_DECISIONS);
  });

  it("manifest 正準形は全 decision を approval_<d> キーで投影する (語彙拡張で RED → version bump を強制)", () => {
    const keys = Object.keys(normalizeSummaryForManifest(sampleSummary()));
    for (const d of APPROVAL_DECISIONS) {
      expect(keys, `approval_${d} が manifest 正準形に投影されていない`).toContain(`approval_${d}`);
    }
  });
});
