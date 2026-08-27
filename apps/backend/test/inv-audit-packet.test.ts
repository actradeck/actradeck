/**
 * INV-AUDIT-PACKET: 改竄検知レビュー・パケット (ADR 6点強化 #2).
 *
 * 検証:
 *  - **ガバナンス導出 (EU AI Act Art.12 hook)**: hard=deny+cancel / soft=allow+allow_for_session /
 *    auto=events の auto_allowed 件数。auto は summary でなく **events** から数える (唯一の真の信号・
 *    entries.auto_allowed はデッドフィールド)。
 *  - **cross-session 集計**: 各分類の合算 + redaction by-kind マージ + flagged (denied/high_risk) 集約。
 *  - **INV-AUDIT-PACKET-BODY (tamper-evidence)**: セッション root / governance 集計 / flagged / session
 *    hash / packet root / session_count のいずれを書換えても verify ok=false (Merkle 的合成)。
 *  - 署名 + **fingerprint pin 必須** (SEC-2 と同契約): 未 pin 署名は ok=false・自鍵 forge も ok=false。
 *  - ドメイン分離: packet root は単一 manifest root と別領域 (h0 が別定数)。
 *  - malformed は throw せず ok=false 値返し。
 *  - NO-RAW: packet manifest は redaction 済み表示値のみ (flagged subject = redacted command)。
 *  - HTML/MD 埋込 round-trip: 描画物から packet manifest を抽出→decode→verify ok。
 */
import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";

import { emptyDecisionTally } from "../src/audit-contract.js";
import type { AuditApprovalEntry, AuditSessionSummary } from "../src/audit-contract.js";
import {
  buildAuditManifest,
  decodeManifestBase64,
  fingerprintOfPublicKey,
  resolveAuditSignerFromEnv,
  verifyAuditManifest,
  decodePacketManifestBase64,
  encodePacketManifestBase64,
  verifyPacketManifest,
  AUDIT_MANIFEST_MARKER,
  AUDIT_CHAIN_ALGORITHM,
  AUDIT_PACKET_MANIFEST_VERSION,
  AUDIT_PACKET_MANIFEST_MARKER,
  PACKET_CHAIN_DOMAIN,
  type DecodedPacketManifest,
  type PacketManifest,
} from "../src/audit-integrity.js";
import {
  buildReviewPacket,
  deriveSessionGovernance,
  renderReviewPacketHtml,
  renderReviewPacketMarkdown,
  type ReviewPacket,
} from "../src/audit-packet.js";
import type { AuditSessionReport } from "../src/audit-report.js";
import type { ReplayEventDTO } from "../src/replay-contract.js";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

function ev(partial: Partial<ReplayEventDTO> & { event_id: string }): ReplayEventDTO {
  return {
    provider: "claude_code",
    source: "hooks",
    session_id: "s1",
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

function summary(over: Partial<AuditSessionSummary> = {}): AuditSessionSummary {
  return {
    session_id: "s1",
    provider: "claude_code",
    source: "hooks",
    agent_id: undefined,
    repo: "/tmp/r",
    branch: undefined,
    cwd: "/tmp/r",
    capture_mode: "attach",
    permission_mode: undefined,
    state: "completed",
    started_at: "2026-07-03T12:00:00.000Z",
    ended_at: "2026-07-03T12:10:00.000Z",
    last_event_at: "2026-07-03T12:10:00.000Z",
    secret_detected: false,
    secret_redaction_count: 0,
    secret_redaction_count_by_kind: {},
    approvals: {
      total: 0,
      by_decision: { ...emptyDecisionTally() },
      synthetic_retired: 0,
      pending: 0,
    },
    high_risk_op_count: 0,
    auto_allowed_count: 0,
    ...over,
  };
}

function report(s: AuditSessionSummary, events: ReplayEventDTO[]): AuditSessionReport {
  return { generated_at: "2026-07-03T12:11:00.000Z", summary: s, events, events_truncated: false };
}

function ed25519Pem(): string {
  return generateKeyPairSync("ed25519").privateKey.export({
    type: "pkcs8",
    format: "pem",
  }) as string;
}
const signer = resolveAuditSignerFromEnv({ ACTRADECK_AUDIT_SIGNING_KEY: ed25519Pem() });

/** 署名なしで per-session manifest を作り packet 入力にする。 */
function entry(s: AuditSessionSummary, events: ReplayEventDTO[]) {
  const r = report(s, events);
  return { report: r, manifest: buildAuditManifest(r) };
}

function verifyPinned(m: PacketManifest | DecodedPacketManifest) {
  return verifyPacketManifest(m, { expectedFingerprint: m.signature!.public_key_fingerprint });
}

function extractPacketB64FromHtml(html: string): string | undefined {
  return html.match(
    new RegExp(`<!-- ${AUDIT_PACKET_MANIFEST_MARKER}\\+base64:([A-Za-z0-9+/=]+):end-`),
  )?.[1];
}
function extractPacketB64FromMarkdown(md: string): string | undefined {
  return md.match(
    new RegExp("```" + AUDIT_PACKET_MANIFEST_MARKER + "\\n([A-Za-z0-9+/=]+)\\n```"),
  )?.[1];
}

// ---------------------------------------------------------------------------
// Governance derivation.
// ---------------------------------------------------------------------------

describe("INV-AUDIT-PACKET governance derivation (hard/soft/auto)", () => {
  it("hard=deny+cancel / soft=allow+allow_for_session", () => {
    const g = deriveSessionGovernance(
      summary({
        approvals: {
          total: 10,
          by_decision: { allow: 2, allow_for_session: 3, deny: 4, cancel: 1 },
          synthetic_retired: 0,
          pending: 0,
        },
      }),
    );
    expect(g.hard_gate).toBe(5); // 4 deny + 1 cancel
    expect(g.soft_gate).toBe(5); // 2 allow + 3 afs
  });

  it("auto_allowed は summary.auto_allowed_count (full-session 集計) 由来 (TDA-1: 打切非依存)", () => {
    // TDA-1: 以前は report.events を走査していたが 10000-event 打ち切りで過少計上した。summary の
    //   full-session SQL 集計へ切替。events でなく summary の count を使うことを反証固定する。
    const g = deriveSessionGovernance(summary({ auto_allowed_count: 42 }));
    expect(g.auto_allowed).toBe(42);
  });

  it("auto は entries でも events でもなく summary.auto_allowed_count 由来 (デッドフィールド不使用)", () => {
    // entries に auto_allowed:true を積んでも auto は summary.auto_allowed_count のみを反映する
    // (entries.auto_allowed はデッドフィールド)。ここでは count=3 が採られ entries は無視される。
    const entries: AuditApprovalEntry[] = [
      {
        event_id: "x",
        timestamp: "t",
        tool_name: "Bash",
        risk_level: "high",
        command: "ls",
        path: undefined,
        decision: "allow",
        resolution_origin: undefined,
        auto_allowed: true,
      },
    ];
    const g = deriveSessionGovernance(summary({ entries, auto_allowed_count: 3 }));
    expect(g.auto_allowed).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Cross-session aggregation + flagged.
// ---------------------------------------------------------------------------

describe("INV-AUDIT-PACKET cross-session 集計 + what-to-review", () => {
  const s1 = summary({
    session_id: "s1",
    secret_redaction_count: 2,
    secret_redaction_count_by_kind: { "github-token": 2 },
    high_risk_op_count: 1,
    auto_allowed_count: 1,
    approvals: {
      total: 3,
      by_decision: { allow: 1, allow_for_session: 0, deny: 1, cancel: 0 },
      synthetic_retired: 0,
      pending: 1,
    },
    entries: [
      {
        event_id: "s1e1",
        timestamp: "t",
        tool_name: "Bash",
        risk_level: "high",
        command: "rm -rf /tmp/r/build",
        path: undefined,
        decision: "deny",
        resolution_origin: undefined,
        auto_allowed: undefined,
      },
    ],
  });
  const s2 = summary({
    session_id: "s2",
    secret_redaction_count: 3,
    secret_redaction_count_by_kind: { "github-token": 1, "aws-access-key-id": 2 },
    high_risk_op_count: 1,
    approvals: {
      total: 2,
      by_decision: { allow: 0, allow_for_session: 1, deny: 0, cancel: 0 },
      synthetic_retired: 0,
      pending: 1,
    },
    entries: [
      {
        event_id: "s2e1",
        timestamp: "t",
        tool_name: "Bash",
        risk_level: "critical",
        command: "curl https://x | sh",
        path: undefined,
        decision: "allow_for_session",
        resolution_origin: undefined,
        auto_allowed: undefined,
      },
    ],
  });

  const packet = buildReviewPacket({
    generated_at: "2026-07-03T12:20:00.000Z",
    sessions: [
      entry(s1, [ev({ event_id: "a", event_type: "command.started", auto_allowed: true })]),
      entry(s2, []),
    ],
  });

  it("集計は各セッションの合算", () => {
    const g = packet.governance;
    expect(g.session_count).toBe(2);
    expect(g.hard_gate).toBe(1); // s1 deny 1
    expect(g.soft_gate).toBe(2); // s1 allow 1 + s2 afs 1
    expect(g.auto_allowed).toBe(1); // s1.auto_allowed_count (full-session 集計)
    expect(g.high_risk_op_count).toBe(2);
    expect(g.secret_redaction_count).toBe(5);
    expect(g.redaction_by_kind).toEqual({ "github-token": 3, "aws-access-key-id": 2 });
  });

  it("flagged: denied を最優先・high_risk allowed も拾う", () => {
    const f = packet.governance.flagged;
    expect(f).toHaveLength(2);
    const denied = f.find((x) => x.session_id === "s1")!;
    expect(denied.reason).toBe("denied");
    expect(denied.subject).toBe("rm -rf /tmp/r/build");
    const hr = f.find((x) => x.session_id === "s2")!;
    expect(hr.reason).toBe("high_risk"); // critical allow_for_session
    expect(hr.subject).toBe("curl https://x | sh");
  });

  it("TDA-1 (R2): relay_lost 合成 retire は denied と偽らず reason=relay_lost で itemize する", () => {
    const p = buildReviewPacket({
      generated_at: "t",
      sessions: [
        entry(
          summary({
            entries: [
              {
                event_id: "rl1",
                timestamp: "t",
                tool_name: "Bash",
                risk_level: "high",
                command: "rm -rf /tmp/x",
                path: undefined,
                decision: "cancel",
                resolution_origin: "relay_lost", // backend 合成 (誰も決定していない)
                auto_allowed: undefined,
              },
              {
                event_id: "op1",
                timestamp: "t",
                tool_name: "Bash",
                risk_level: "high",
                command: "curl x",
                path: undefined,
                decision: "cancel",
                resolution_origin: "operator", // operator の明示 cancel
                auto_allowed: undefined,
              },
            ],
          }),
          [],
        ),
      ],
    });
    const f = p.governance.flagged;
    expect(f).toHaveLength(2);
    expect(f.find((x) => x.subject === "rm -rf /tmp/x")!.reason).toBe("relay_lost");
    expect(f.find((x) => x.subject === "curl x")!.reason).toBe("denied");
  });

  it("low-risk allow は flag しない", () => {
    const p = buildReviewPacket({
      generated_at: "t",
      sessions: [
        entry(
          summary({
            entries: [
              {
                event_id: "z",
                timestamp: "t",
                tool_name: "Bash",
                risk_level: "low",
                command: "ls",
                path: undefined,
                decision: "allow",
                resolution_origin: undefined,
                auto_allowed: undefined,
              },
            ],
          }),
          [],
        ),
      ],
    });
    expect(p.governance.flagged).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Packet manifest tamper-evidence.
// ---------------------------------------------------------------------------

function samplePacket(sign = false): ReviewPacket {
  return buildReviewPacket({
    generated_at: "2026-07-03T12:30:00.000Z",
    sessions: [
      entry(
        summary({
          session_id: "s1",
          secret_redaction_count: 1,
          secret_redaction_count_by_kind: { "github-token": 1 },
          high_risk_op_count: 1,
          auto_allowed_count: 1,
          approvals: {
            total: 2,
            by_decision: { ...emptyDecisionTally(), deny: 1 },
            synthetic_retired: 0,
            pending: 1,
          },
          entries: [
            {
              event_id: "e",
              timestamp: "t",
              tool_name: "Bash",
              risk_level: "high",
              command: "rm -rf /tmp/r/build",
              path: undefined,
              decision: "deny",
              resolution_origin: undefined,
              auto_allowed: undefined,
            },
          ],
        }),
        [ev({ event_id: "a", event_type: "command.started", auto_allowed: true, command: "ls" })],
      ),
      entry(summary({ session_id: "s2" }), []),
    ],
    ...(sign && signer !== undefined ? { signer } : {}),
  });
}

describe("INV-AUDIT-PACKET unsigned chain", () => {
  it("chain domain は version と結合して bump される (QA-R5-2)", () => {
    // commit body は「v1→v2 (+ chain domain)」を一体の変更として提示するが、chain domain 側は
    // 参照テストが無く、version だけ bump して domain を据え置く半端な変更が 720 緑で通った
    // (mutation probe P16)。prefix 結合を pin して片側 bump を RED にする。
    expect(PACKET_CHAIN_DOMAIN.startsWith(AUDIT_PACKET_MANIFEST_VERSION + "/")).toBe(true);
    // SEC-V9-4 / QA-V9-4: template 導出後の exact 値を pin する (suffix / algorithm 部の改変で RED)。
    // この値を変える = 既存 packet の chain が全て不一致になる = version bump が必要。
    expect(PACKET_CHAIN_DOMAIN).toBe("actradeck-audit-packet-manifest/v2/sha256-chain");
    expect(PACKET_CHAIN_DOMAIN).toBe(`${AUDIT_PACKET_MANIFEST_VERSION}/${AUDIT_CHAIN_ALGORITHM}`);
  });

  it("無改竄 → chain_valid・ok (unsigned=内部整合)", () => {
    const m = samplePacket().manifest;
    expect(m.version).toBe(AUDIT_PACKET_MANIFEST_VERSION);
    expect(m.session_count).toBe(2);
    expect(m.signature).toBeUndefined();
    const r = verifyPacketManifest(m);
    expect(r.chain_valid).toBe(true);
    expect(r.ok).toBe(true);
  });

  it("空セッションでも root=governance を binding・verify ok", () => {
    const m = buildReviewPacket({ generated_at: "t", sessions: [] }).manifest;
    expect(m.session_count).toBe(0);
    expect(verifyPacketManifest(m).ok).toBe(true);
  });
});

describe("INV-AUDIT-PACKET-BODY: packet 改竄検知 (Merkle 的合成)", () => {
  const m = samplePacket(true).manifest;

  it("無改竄署名済み + pin → verified", () => {
    const r = verifyPinned(m);
    expect(r.ok).toBe(true);
    expect(r.signature_valid).toBe(true);
    expect(r.reason).toContain("verified");
  });

  it("セッション root の改竄を検知 (per-session 内容改竄 = root 変化)", () => {
    const t: PacketManifest = {
      ...m,
      sessions: m.sessions.map((s, i) => (i === 0 ? { ...s, root: "0".repeat(64) } : s)),
    };
    expect(verifyPinned(t).ok).toBe(false);
  });

  it("session hash の改竄を検知", () => {
    const t: PacketManifest = {
      ...m,
      sessions: m.sessions.map((s, i) => (i === 0 ? { ...s, hash: "0".repeat(64) } : s)),
    };
    expect(verifyPinned(t).ok).toBe(false);
  });

  it("governance 集計 (hard_gate) の改竄を検知", () => {
    const t: PacketManifest = {
      ...m,
      governance: { ...m.governance, hard_gate: "0" },
    };
    expect(verifyPinned(t).ok).toBe(false);
  });

  it("flagged (denied subject) の改竄を検知 (what-to-review 偽装を防ぐ)", () => {
    const t: PacketManifest = {
      ...m,
      governance: {
        ...m.governance,
        flagged: m.governance.flagged.map((f) => [f[0], f[1], f[2], f[3], "ls"] as const),
      },
    };
    expect(verifyPinned(t).ok).toBe(false);
  });

  it("session の per-session 集計 (auto_allowed) の改竄を検知", () => {
    const t: PacketManifest = {
      ...m,
      sessions: m.sessions.map((s, i) => (i === 0 ? { ...s, auto_allowed: "9" } : s)),
    };
    expect(verifyPinned(t).ok).toBe(false);
  });

  it("packet root 書換え・session_count 不整合を検知", () => {
    expect(verifyPinned({ ...m, root: "deadbeef" }).ok).toBe(false);
    expect(verifyPinned({ ...m, session_count: 1 }).ok).toBe(false);
  });

  it("セッション並び替え (root 順序) の改竄を検知", () => {
    const t: PacketManifest = { ...m, sessions: [...m.sessions].reverse() };
    expect(verifyPinned(t).ok).toBe(false);
  });
});

describe("INV-AUDIT-PACKET 署名 + fingerprint pin", () => {
  const m = samplePacket(true).manifest;

  it("署名済みだが expected_fingerprint 未指定 → ok=false (unpinned)", () => {
    const r = verifyPacketManifest(m);
    expect(r.signature_valid).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("unpinned");
  });

  it("fingerprint 一致 → ok・不一致 → ok=false (untrusted-key)", () => {
    expect(verifyPinned(m).ok).toBe(true);
    const wrong = verifyPacketManifest(m, { expectedFingerprint: "0".repeat(64) });
    expect(wrong.ok).toBe(false);
    expect(wrong.reason).toContain("untrusted-key");
  });

  it("攻撃者が自鍵で再署名 (chain 整合) しても pin で弾く (forge 不能)", () => {
    const attacker = resolveAuditSignerFromEnv({ ACTRADECK_AUDIT_SIGNING_KEY: ed25519Pem() });
    // 攻撃者は hard_gate を 0 に偽装し、自鍵で正しく再署名する。
    const forged = buildReviewPacket({
      generated_at: "2026-07-03T12:30:00.000Z",
      sessions: [entry(summary({ session_id: "s1" }), [])],
      ...(attacker !== undefined ? { signer: attacker } : {}),
    }).manifest;
    const r = verifyPacketManifest(forged, {
      expectedFingerprint: m.signature!.public_key_fingerprint,
    });
    expect(r.signature_valid).toBe(true);
    expect(r.key_trusted).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("SEC-1: 自鍵署名 + public_key_fingerprint を被害者 fp へ詐称しても pin で弾く (実鍵由来 fp 照合)", () => {
    // 上の forge は fp フィールドに攻撃者の実 fp が載るため弾ける。ここは fp フィールド自体を被害者の
    // 既知 fp へ **詐称** する攻撃 (自己申告 fp を信頼すると ok=true になる SEC-1 バイパス)。
    const attacker = resolveAuditSignerFromEnv({ ACTRADECK_AUDIT_SIGNING_KEY: ed25519Pem() });
    const forged = buildReviewPacket({
      generated_at: "2026-07-03T12:30:00.000Z",
      sessions: [entry(summary({ session_id: "s1" }), [])],
      ...(attacker !== undefined ? { signer: attacker } : {}),
    }).manifest;
    const spoofed: PacketManifest = {
      ...forged,
      signature: {
        ...forged.signature!,
        public_key_fingerprint: m.signature!.public_key_fingerprint,
      },
    };
    const r = verifyPacketManifest(spoofed, {
      expectedFingerprint: m.signature!.public_key_fingerprint,
    });
    expect(r.signature_valid).toBe(true); // 攻撃者鍵での署名は有効
    expect(r.key_trusted).toBe(false); // だが実鍵由来 fp は被害者と不一致
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Domain separation / malformed / NO-RAW / embed round-trip.
// ---------------------------------------------------------------------------

describe("INV-AUDIT-PACKET ドメイン分離", () => {
  it("packet root は単一 manifest root と別 (h0 が別領域)", () => {
    const r = report(summary({ session_id: "solo" }), [ev({ event_id: "e1" })]);
    const single = buildAuditManifest(r);
    const packet = buildReviewPacket({
      generated_at: "t",
      sessions: [{ report: r, manifest: single }],
    }).manifest;
    // packet は同一セッション 1 件を束ねるが、packet root は single root と一致しない (領域分離)。
    expect(packet.root).not.toBe(single.root);
    // ただし束ねた session root は single root と同一 (per-session manifest を再利用)。
    expect(packet.sessions[0]!.root).toBe(single.root);
  });
});

describe("INV-AUDIT-PACKET malformed 堅牢化", () => {
  it("sessions:[null] / sessions 欠落 / version 不正 → throw せず ok=false", () => {
    for (const bad of [
      {
        version: AUDIT_PACKET_MANIFEST_VERSION,
        generated_at: "t",
        root: "y",
        session_count: 1,
        governance: { redaction_by_kind: [], flagged: [] },
        sessions: [null],
      },
      { version: AUDIT_PACKET_MANIFEST_VERSION, generated_at: "t", root: "y" }, // governance/sessions 欠落
      {
        version: "wrong",
        generated_at: "t",
        root: "y",
        session_count: 0,
        governance: { redaction_by_kind: [], flagged: [] },
        sessions: [],
      },
    ]) {
      const r = verifyPacketManifest(bad as unknown as PacketManifest);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("malformed-packet-manifest");
    }
  });

  it("SEC-R9-1: 署名 + pin 済み packet でも algorithm 改変は malformed-packet-manifest (fail-closed)", () => {
    const valid = samplePacket(true).manifest;
    expect(verifyPinned(valid).ok).toBe(true); // positive control
    for (const bad of ["sha1-chain", "SHA256-CHAIN", "", undefined, null, 1, {}]) {
      const r = verifyPinned({ ...valid, algorithm: bad } as unknown as PacketManifest);
      expect(r.ok, `algorithm=${JSON.stringify(bad)} が verify を通る`).toBe(false);
      expect(r.reason).toBe("malformed-packet-manifest");
      expect(r.signed).toBe(false);
    }
    expect(valid.algorithm).toBe(AUDIT_CHAIN_ALGORITHM);
  });

  it("TDA-V9-3: packet の sessions[i] (hash 除く) と governance は全 key が root-sensitive (auto-extending)", () => {
    // session manifest 側の tier 2/3 と同型: interface に key を足しても canonicalizePacketSession /
    // canonicalizePacketGovernance の位置列挙へ加え忘れれば「宣言したのに畳まれない」field が生まれる。
    // key を列挙せず Object.keys で走査し、追加時に自動拡張・非空虚ガードで縮小を RED にする。
    const signed = samplePacket(true).manifest;
    const probe = (v: unknown): unknown =>
      Array.isArray(v)
        ? [...v, ["zz", "1", "2", "3", "4"]]
        : typeof v === "number"
          ? v + 1
          : `${String(v)}-probe`;
    const s0 = signed.sessions[0]! as unknown as Record<string, unknown>;
    const sessionKeys = Object.keys(s0).filter((k) => k !== "hash");
    expect(sessionKeys.length).toBeGreaterThanOrEqual(7); // 現行 7 field。
    for (const key of sessionKeys) {
      const sessions = [{ ...s0, [key]: probe(s0[key]) }, ...signed.sessions.slice(1)];
      const r = verifyPinned({ ...signed, sessions } as unknown as PacketManifest);
      expect(
        r.ok,
        `sessions[0].${key} の改変が検知されない (canonicalizePacketSession から漏れている)`,
      ).toBe(false);
    }
    const g = signed.governance as unknown as Record<string, unknown>;
    const govKeys = Object.keys(g);
    expect(govKeys.length).toBeGreaterThanOrEqual(8); // 現行 8 field。
    for (const key of govKeys) {
      const r = verifyPinned({
        ...signed,
        governance: { ...g, [key]: probe(g[key]) },
      } as unknown as PacketManifest);
      expect(
        r.ok,
        `governance.${key} の改変が検知されない (canonicalizePacketGovernance から漏れている)`,
      ).toBe(false);
    }
  });

  it("SEC-R9-1: packet envelope 最上位 field は署名 + pin 済みでも改変で verify が落ちる (第 4 tier)", () => {
    // session manifest の INV-AUDIT-BINDING-COMPLETENESS tier 4 と同型。sessions/governance は
    // INV-AUDIT-PACKET-BODY が担い、signature は SEC-2 群が担う。
    const signed = samplePacket(true).manifest;
    const NESTED = new Set(["sessions", "governance", "signature"]);
    const envelope = signed as unknown as Record<string, unknown>;
    const keys = Object.keys(envelope).filter((k) => !NESTED.has(k));
    expect(keys.sort()).toEqual(
      ["algorithm", "generated_at", "root", "session_count", "version"].sort(),
    );
    for (const key of keys) {
      const value = envelope[key];
      const mutated = typeof value === "number" ? value + 1 : `${String(value)}-probe`;
      const r = verifyPinned({ ...signed, [key]: mutated } as unknown as PacketManifest);
      expect(r.ok, `packet envelope.${key} の改変が検知されない`).toBe(false);
    }
  });

  it("base64 decode: 破損/version 不正 → undefined", () => {
    expect(decodePacketManifestBase64("!!!not-base64")).toBeUndefined();
    expect(
      decodePacketManifestBase64(Buffer.from('{"version":"x"}').toString("base64")),
    ).toBeUndefined();
  });
});

describe("INV-AUDIT-PACKET NO-RAW + embed round-trip", () => {
  // github-token を含む raw secret は decodePacketManifest には決して現れない (redacted 表示のみ)。
  const packet = buildReviewPacket({
    generated_at: "2026-07-03T12:40:00.000Z",
    sessions: [
      entry(
        summary({
          session_id: "s1",
          secret_redaction_count: 1,
          secret_redaction_count_by_kind: { "github-token": 1 },
          entries: [
            {
              event_id: "e",
              timestamp: "t",
              tool_name: "Bash",
              risk_level: "high",
              command: 'echo "token=[REDACTED:github-token]"',
              path: undefined,
              decision: "deny",
              resolution_origin: undefined,
              auto_allowed: undefined,
            },
          ],
        }),
        [ev({ event_id: "a" })],
      ),
    ],
    ...(signer !== undefined ? { signer } : {}),
  });

  it("NO-RAW: packet manifest に raw secret を載せない (redacted マーカーのみ)", () => {
    const json = encodePacketManifestBase64(packet.manifest) + JSON.stringify(packet.manifest);
    expect(json).not.toContain("ghp_");
    expect(JSON.stringify(packet.manifest)).toContain("[REDACTED:github-token]");
  });

  it("HTML: no <script>・埋込 packet manifest 抽出→decode→verify(pin) ok", () => {
    const html = renderReviewPacketHtml(packet);
    expect(html).not.toMatch(/<script[\s>]/i);
    const decoded = decodePacketManifestBase64(extractPacketB64FromHtml(html)!)!;
    expect(verifyPinned(decoded).ok).toBe(true);
  });

  it("Markdown: 埋込 packet manifest 抽出→decode→verify(pin) ok", () => {
    const md = renderReviewPacketMarkdown(packet);
    const decoded = decodePacketManifestBase64(extractPacketB64FromMarkdown(md)!)!;
    expect(verifyPinned(decoded).ok).toBe(true);
  });
});

describe("INV-AUDIT-PACKET SEC-2: HTML/MD per-session body verifiability", () => {
  // per-session manifest (marker=AUDIT_MANIFEST_MARKER) を全て抽出する。packet marker
  //   (actradeck-audit-packet-manifest) は "packet-" を含むため本 regex に一致しない (別マーカー)。
  function allSingleB64Html(html: string): string[] {
    return [
      ...html.matchAll(
        new RegExp(`<!-- ${AUDIT_MANIFEST_MARKER}\\+base64:([A-Za-z0-9+/=]+):end-`, "g"),
      ),
    ].map((m) => m[1]!);
  }
  function allSingleB64Md(md: string): string[] {
    return [
      ...md.matchAll(new RegExp("```" + AUDIT_MANIFEST_MARKER + "\\n([A-Za-z0-9+/=]+)\\n```", "g")),
    ].map((m) => m[1]!);
  }

  const packet = samplePacket(true); // 2 セッション (s1 は timeline event あり)・packet 署名済み

  it("各セッションの per-session manifest が HTML に埋込まれ root が packet.sessions[i].root と一致 (body 検証可能)", () => {
    // SEC-2: HTML は per-session body (timeline/diff) を描画する。per-session manifest を埋込み、その
    //   root が packet-署名された sessions[i].root と一致することで、body 改竄が成果物単体から検知可能。
    const html = renderReviewPacketHtml(packet);
    const b64s = allSingleB64Html(html);
    expect(b64s).toHaveLength(packet.sessions.length); // 各セッション 1 manifest
    const boundRoots = new Set(packet.manifest.sessions.map((s) => s.root));
    for (const b64 of b64s) {
      const m = decodeManifestBase64(b64)!;
      // packet が束ねた (署名で守られた) root と一致 → body はこの root へ binding される。
      expect(boundRoots.has(m.root)).toBe(true);
      // per-session manifest の chain は内部整合 (body を改竄すると root が変わり boundRoots と外れる)。
      expect(verifyAuditManifest(m).chain_valid).toBe(true);
    }
  });

  it("各セッションの per-session manifest が Markdown にも埋込まれる", () => {
    const md = renderReviewPacketMarkdown(packet);
    expect(allSingleB64Md(md)).toHaveLength(packet.sessions.length);
  });

  it("SEC-L1: packet Integrity 表示 fp は自己申告でなく実鍵から再計算した値", () => {
    const signed = samplePacket(true);
    const spoofed: ReviewPacket = {
      ...signed,
      manifest: {
        ...signed.manifest,
        signature: { ...signed.manifest.signature!, public_key_fingerprint: "0".repeat(64) },
      },
    };
    const realFp = fingerprintOfPublicKey(signed.manifest.signature!.public_key);
    const html = renderReviewPacketHtml(spoofed);
    expect(html).toContain(realFp);
    expect(html).not.toContain("0".repeat(64));
  });
});

/**
 * TDA-R4-4: packet manifest version の区別。governance 意味論 (hard_gate から relay_lost 除外・
 * reason 語彙) が Phase 4 で変わったため v1→v2 へ bump した — 旧 v1 は「改竄」と区別可能な
 * distinct reason で fail-closed に返す (session manifest の SEC-R3-1 と同一契約・共有 helper)。
 */
describe("INV-AUDIT-PACKET version 区別 (TDA-R4-4)", () => {
  it("旧 v1 は malformed でなく unsupported-packet-manifest-version (fail-closed 維持)", () => {
    const v1 = {
      ...samplePacket().manifest,
      version: "actradeck-audit-packet-manifest/v1",
    } as unknown as Parameters<typeof verifyPacketManifest>[0];
    const r = verifyPacketManifest(v1);
    expect(r.ok).toBe(false);
    expect(r.chain_valid).toBe(false);
    expect(r.reason).toBe("unsupported-packet-manifest-version");
  });

  it("壊れ version は従来どおり malformed・現行版は ok (positive control)", () => {
    const bad = {
      ...samplePacket().manifest,
      version: "wrong",
    } as unknown as Parameters<typeof verifyPacketManifest>[0];
    expect(verifyPacketManifest(bad).reason).toBe("malformed-packet-manifest");
    expect(verifyPacketManifest(samplePacket().manifest).ok).toBe(true);
  });

  it("decodePacketManifestBase64 は旧 version を透過し verify が同 reason を返す", () => {
    const v1 = {
      ...samplePacket().manifest,
      version: "actradeck-audit-packet-manifest/v1",
    } as unknown as Parameters<typeof encodePacketManifestBase64>[0];
    const decoded = decodePacketManifestBase64(encodePacketManifestBase64(v1));
    expect(decoded).toBeDefined();
    expect(verifyPacketManifest(decoded!).reason).toBe("unsupported-packet-manifest-version");
  });

  it("session family の manifest を packet verify に渡すと malformed (family 非交差)", () => {
    // 2 family の marker は互いに prefix 関係に無い — cross-family は unsupported でなく malformed。
    const cross = {
      ...samplePacket().manifest,
      version: `${AUDIT_MANIFEST_MARKER}/v3`,
    } as unknown as Parameters<typeof verifyPacketManifest>[0];
    expect(verifyPacketManifest(cross).reason).toBe("malformed-packet-manifest");
  });
});
