/**
 * Audit Integrity — tamper-evident audit export (ADR 6点強化 #1・保証モデル A).
 *
 * 監査レポート export に **改竄検知 manifest** を埋め込む。脅威モデルは **配布後の改竄検知**:
 * 署名済みレポートを受け取った側が、内容が export 後に書き換えられていないことを検証できる。
 *
 * ## SEC-1 (H) 対応: manifest は「表示投影の authoritative complete record」
 * レポートが**人間に見せる監査事実の全て**を binding する — summary メタ / redaction 件数(+by-kind) /
 * approvals tally(全 decision + high_risk) / per-event の可視フィールド(timestamp/kind/event_type/
 * risk/decision/exit/ms/**可視 command 列 = command??path??subject**) / diff(件数 + 本文 sha256)。
 * root(ハッシュ連鎖の最終値)は summary→events→diff+events_truncated を順に畳んで全投影を覆い、署名は root を binding
 * する。ゆえに **表示のどれか一つでも書換えると verify が ok=false**(旧実装は per-event の狭小集合しか
 * 覆わず、可視 command 列・redaction 件数・approval 判定を改竄しても "verified" を返す欠陥があった)。
 *
 * ## 単射エンコード (SEC-3)
 * canonical 直列化は `JSON.stringify([...fields])`。文字列は quote+escape され配列で区切られるため、
 * フィールド境界の再分割衝突(区切り文字 injection)が起きない(旧 US-join は非単射だった)。
 *
 * ## 署名と鍵の信頼 (SEC-2)
 * `ACTRADECK_AUDIT_SIGNING_KEY`(Ed25519・opt-in)設定時に root へ署名し、公開鍵(SPKI)+fingerprint を
 * 埋め込む。**署名の有効性だけでは tamper-evidence にならない**(攻撃者が自鍵で再署名しうる)ため、
 * verify は **fingerprint pin を要求**する: `expectedFingerprint` 未指定で署名済みは `ok=false`
 * (`signature-valid-unpinned`)。route は server 自身の鍵 fingerprint を既定 pin にする(同一 server で
 * 署名・検証すれば自動 pin)。受け手は既知 operator 公開鍵 fingerprint を渡して信頼を確立する。
 *
 * ## 正直な保証範囲 (誇大表示しない)
 *  - manifest は **署名済みで pin されたとき** 配布後改竄(表示投影の任意フィールド)を暗号学的に検知する。
 *    manifest が authoritative record であり、HTML/MD 表はその rendering — 検証は埋込 manifest に対して
 *    行い、facts は検証済み manifest から読む(または表示と突合する)。
 *  - **表示との欠損表現の非対称 (TDA-2)**: manifest は欠損フィールド(risk/decision/exit/ms/command)を
 *    `""`(pre-fallback の生値)で binding するが、HTML/MD 表示は空値へ cosmetic な `"-"` フォールバックを
 *    当てる(機構は audit-report.ts で混在: risk/decision は `dash()`、exit/ms は inline `===undefined?"-"`、
 *    command は `subject ?? "-"`。視覚結果は一様に `"-"`)。
 *    これは **安全な方向**の非対称: manifest は表示より厳密で「真に欠損(`""`)」と「実値 `"-"`」を区別する
 *    (逆に表示へ合わせ `"-"` を binding すると両者が衝突し、その 2 状態間の改竄が検知不能になる)。
 *    受け手が表示⇔manifest を突合するときは、表示の `"-"` を manifest の `""`(または実値)と読み替える。
 *  - **at-rest 改竄 (export 前に DB を書換える攻撃)** は対象外 = ingest 時イベント連鎖(モデル B・follow-up)。
 *  - 未署名(鍵未設定)は内部整合(chain)のみ。署名+pin で初めて tamper-evidence を主張できる。
 *  - NO-RAW: 投影は既に redaction 済みの表示値のみ(raw command/secret を再導入しない)。
 */
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import { readFileSync } from "node:fs";

import type { AuditSessionSummary } from "./audit-contract.js";
import type { AuditSessionReport, AuditSessionReportDiff } from "./audit-report.js";
import type { ReplayEventDTO } from "./replay-contract.js";

/** manifest フォーマットのバージョン。 */
export const AUDIT_MANIFEST_VERSION = "actradeck-audit-manifest/v3";
/** ハッシュ連鎖のドメイン分離定数。 */
const CHAIN_DOMAIN = "actradeck-audit-manifest/v3/sha256-chain";

// ---------------------------------------------------------------------------
// Manifest 型 (表示投影の authoritative record・全て redaction 済み文字列)。
// ---------------------------------------------------------------------------

/** per-event の可視フィールド (timeline 表が表示する列そのもの)。 */
export interface AuditManifestEvent {
  readonly event_id: string;
  readonly timestamp: string;
  readonly event_type: string;
  readonly kind: string;
  readonly risk_level: string;
  readonly decision: string;
  readonly exit_code: string;
  readonly elapsed_ms: string;
  /** 可視 command/path 列 = command ?? path ?? subject (redaction 済み)。 */
  readonly command: string;
  /** ハッシュ連鎖のこのイベント時点の値 (hex・h_i)。 */
  readonly hash: string;
}

/** summary メタ + redaction + approvals の表示投影。 */
export interface AuditManifestSummary {
  readonly provider: string;
  readonly source: string;
  readonly agent_id: string;
  readonly repo: string;
  readonly branch: string;
  readonly cwd: string;
  readonly capture_mode: string;
  readonly permission_mode: string;
  readonly state: string;
  readonly started_at: string;
  readonly ended_at: string;
  readonly last_event_at: string;
  readonly secret_detected: string;
  readonly secret_redaction_count: string;
  /** kind→count を key 昇順の [kind, count] 配列で (決定論)。 */
  readonly redaction_by_kind: readonly (readonly [string, string])[];
  readonly approval_total: string;
  readonly approval_allow: string;
  readonly approval_allow_for_session: string;
  readonly approval_deny: string;
  readonly approval_cancel: string;
  /** SEC-R2-1: relay_lost 合成 retire (by_decision 非含・保存則 total = Σdecision + pending + retired)。 */
  readonly approval_synthetic_retired: string;
  readonly approval_pending: string;
  readonly high_risk_op_count: string;
}

/** diff の表示投影 (本文は sha256 で binding・件数/フラグは値で binding)。 */
export interface AuditManifestDiff {
  readonly available: string;
  readonly truncated: string;
  readonly secret_detected: string;
  readonly redaction_count: string;
  readonly unavailable_reason: string;
  /** 表示 diff 本文の SHA-256 (受け手は表示本文を hash して照合)。 */
  readonly body_sha256: string;
}

export interface AuditManifestSignature {
  readonly algorithm: "ed25519";
  /** 署名検証用公開鍵 (SPKI DER の base64)。信頼は受け手が fingerprint で外部照合。 */
  readonly public_key: string;
  /** 公開鍵の SHA-256 fingerprint (hex)。 */
  readonly public_key_fingerprint: string;
  /** root への署名 (base64)。 */
  readonly value: string;
}

export interface AuditManifest {
  readonly version: typeof AUDIT_MANIFEST_VERSION;
  readonly algorithm: "sha256-chain";
  readonly session_id: string;
  readonly generated_at: string;
  readonly event_count: number;
  /** タイムラインが上限で打ち切られたか ("true"/"false"・表示 "truncated" 注記と一致・root binding)。 */
  readonly events_truncated: string;
  /** summary 表示投影 (binding 対象)。 */
  readonly summary: AuditManifestSummary;
  readonly events: readonly AuditManifestEvent[];
  /** diff 投影 (?diff=1 のときのみ)。 */
  readonly diff?: AuditManifestDiff;
  /** 連鎖の最終ハッシュ (hex)。summary→events→diff+events_truncated を全て畳む。署名対象。 */
  readonly root: string;
  readonly signature?: AuditManifestSignature;
}

// ---------------------------------------------------------------------------
// 単射 canonical 直列化 (JSON.stringify・SEC-3) + ハッシュ。
// ---------------------------------------------------------------------------

// A1 SEC-2≡TDA-2: sha256 実装は意図的に 2 面。browser を含む fold 経路は event-model/src/hash.ts の
// pure-TS isomorphic 実装、本 Node 専用 tier は perf のため node:crypto を維持 (naive な一本化禁止)。
function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** 単射直列化: 文字列を quote+escape し配列で区切る (区切り injection 不能)。 */
function canonJSON(fields: readonly unknown[]): string {
  return JSON.stringify(fields);
}

/** 連鎖 1 段: prev(64hex 固定長) の後に canon(JSON) を連結して sha256 (injective)。 */
function chainStep(prev: string, canon: string): string {
  return sha256Hex(prev + canon);
}

/**
 * SPKI DER(base64) 公開鍵から fingerprint (sha256 hex) を **再計算**する。
 *
 * SEC-1: verify の信頼判定は、マニフェストが自己申告する `signature.public_key_fingerprint` でなく
 * **実際に署名を検証した鍵**（`signature.public_key`）から導かねばならない。自己申告 fp フィールドは
 * 攻撃者が自由に詐称でき、`signatureValid` は別フィールド `public_key` で計算されるため、fp を
 * 実鍵から再計算しないと「攻撃者が自鍵で署名し fp を被害者の既知 fp に詐称」→ pin 通過のバイパスが
 * 成立する。`resolveAuditSignerFromEnv` の fingerprint 算出（sha256(publicKeyDer)）と同一式を共有し、
 * 単一/packet の両 verify がこの唯一の helper を呼ぶ（drift 不可・security-gate-reuse-canonical-parser）。
 */
export function fingerprintOfPublicKey(publicKeyB64: string): string {
  return createHash("sha256").update(Buffer.from(publicKeyB64, "base64")).digest("hex");
}

/** イベント表示投影の canonical 直列化 (build/verify 共有・単一出所)。 */
export function canonicalizeEventFields(e: Omit<AuditManifestEvent, "hash">): string {
  return canonJSON([
    e.event_id,
    e.timestamp,
    e.event_type,
    e.kind,
    e.risk_level,
    e.decision,
    e.exit_code,
    e.elapsed_ms,
    e.command,
  ]);
}

/** summary 表示投影の canonical 直列化。 */
export function canonicalizeSummary(s: AuditManifestSummary): string {
  return canonJSON([
    s.provider,
    s.source,
    s.agent_id,
    s.repo,
    s.branch,
    s.cwd,
    s.capture_mode,
    s.permission_mode,
    s.state,
    s.started_at,
    s.ended_at,
    s.last_event_at,
    s.secret_detected,
    s.secret_redaction_count,
    s.redaction_by_kind,
    s.approval_total,
    s.approval_allow,
    s.approval_allow_for_session,
    s.approval_deny,
    s.approval_cancel,
    s.approval_synthetic_retired,
    s.approval_pending,
    s.high_risk_op_count,
  ]);
}

/** diff 投影の canonical 直列化 (無しは空配列)。 */
export function canonicalizeDiff(d: AuditManifestDiff | undefined): string {
  if (d === undefined) return canonJSON([]);
  return canonJSON([
    d.available,
    d.truncated,
    d.secret_detected,
    d.redaction_count,
    d.unavailable_reason,
    d.body_sha256,
  ]);
}

// ---------------------------------------------------------------------------
// ReplayEventDTO / AuditSessionSummary / diff → manifest 投影 (単一出所)。
// ---------------------------------------------------------------------------

function str(v: string | number | boolean | undefined): string {
  return v === undefined ? "" : String(v);
}

/** ReplayEventDTO → manifest の可視フィールド (timeline 表と同じ導出・単一出所)。 */
export function normalizeEventForManifest(e: ReplayEventDTO): Omit<AuditManifestEvent, "hash"> {
  return {
    event_id: e.event_id,
    timestamp: e.timestamp,
    event_type: e.event_type,
    kind: e.kind,
    risk_level: str(e.risk_level),
    decision: str(e.decision),
    exit_code: str(e.exit_code),
    elapsed_ms: str(e.elapsed_ms),
    // timeline 表の可視 command/path 列と同一導出 (audit-report.ts timelineTableHtml の
    // `e.command ?? e.path ?? e.subject`)。欠損は `""` を binding し、表示側の cosmetic `"-"`
    // フォールバックは当てない (TDA-2: `""` と実値 `"-"` を区別する厳密側・module doc 参照)。
    command: e.command ?? e.path ?? e.subject ?? "",
  };
}

/** AuditSessionSummary → manifest の summary 投影 (summary/redaction/approvals 表と同じ値)。 */
export function normalizeSummaryForManifest(s: AuditSessionSummary): AuditManifestSummary {
  const a = s.approvals;
  return {
    provider: str(s.provider),
    source: str(s.source),
    agent_id: str(s.agent_id),
    repo: str(s.repo),
    branch: str(s.branch),
    cwd: str(s.cwd),
    capture_mode: str(s.capture_mode),
    permission_mode: str(s.permission_mode),
    state: str(s.state),
    started_at: str(s.started_at),
    ended_at: str(s.ended_at),
    last_event_at: str(s.last_event_at),
    secret_detected: str(s.secret_detected),
    secret_redaction_count: str(s.secret_redaction_count),
    redaction_by_kind: Object.entries(s.secret_redaction_count_by_kind)
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
      .map(([k, v]) => [k, String(v)] as const),
    approval_total: str(a.total),
    approval_allow: str(a.by_decision.allow),
    approval_allow_for_session: str(a.by_decision.allow_for_session),
    approval_deny: str(a.by_decision.deny),
    approval_cancel: str(a.by_decision.cancel),
    approval_synthetic_retired: str(a.synthetic_retired),
    approval_pending: str(a.pending),
    high_risk_op_count: str(s.high_risk_op_count),
  };
}

/** AuditSessionReportDiff → manifest の diff 投影 (本文は sha256 で binding)。 */
export function normalizeDiffForManifest(d: AuditSessionReportDiff): AuditManifestDiff {
  return {
    available: str(d.available),
    truncated: str(d.truncated),
    secret_detected: str(d.secret_detected),
    redaction_count: str(d.redaction_count),
    unavailable_reason: str(d.unavailable_reason),
    body_sha256: d.body === undefined ? "" : sha256Hex(d.body),
  };
}

// ---------------------------------------------------------------------------
// 署名者 (Ed25519・env 解決)。
// ---------------------------------------------------------------------------

export interface AuditSigner {
  readonly fingerprint: string;
  sign(data: string): { value: string; publicKeyDer: string; fingerprint: string };
}

/**
 * `ACTRADECK_AUDIT_SIGNING_KEY` から Ed25519 署名者を解決する。値はファイルパス、または
 * `-----BEGIN` を含む inline PEM。未設定/不正/非 Ed25519 なら undefined (署名なしへ安全側縮退)。
 */
export function resolveAuditSignerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AuditSigner | undefined {
  const raw = env.ACTRADECK_AUDIT_SIGNING_KEY;
  if (raw === undefined || raw.trim() === "") return undefined;
  let pem: string;
  try {
    pem = raw.includes("-----BEGIN") ? raw : readFileSync(raw, "utf8");
  } catch {
    return undefined;
  }
  let privateKey;
  try {
    privateKey = createPrivateKey(pem);
  } catch {
    return undefined;
  }
  if (privateKey.asymmetricKeyType !== "ed25519") return undefined;
  const publicKey = createPublicKey(privateKey);
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const publicKeyB64 = publicKeyDer.toString("base64");
  // QA-2: verify 側の fp 再計算 (fingerprintOfPublicKey) と **真の単一出所**を共有する
  //   (sha256(SPKI-DER) の式を 2 箇所に書かない・security-gate-reuse-canonical-parser)。
  const fingerprint = fingerprintOfPublicKey(publicKeyB64);
  return {
    fingerprint,
    sign(data: string) {
      const value = cryptoSign(null, Buffer.from(data, "utf8"), privateKey).toString("base64");
      return { value, publicKeyDer: publicKeyB64, fingerprint };
    },
  };
}

// ---------------------------------------------------------------------------
// Build.
// ---------------------------------------------------------------------------

/** 署名対象 canonical header (root + メタを binding)。 */
function canonicalizeHeader(m: {
  session_id: string;
  generated_at: string;
  event_count: number;
  root: string;
}): string {
  return canonJSON([AUDIT_MANIFEST_VERSION, m.session_id, m.generated_at, m.event_count, m.root]);
}

/**
 * AuditSessionReport から tamper-evident manifest を構築する。root は summary→events→diff+events_truncated を
 * 順に畳んで **表示投影全体を binding** する。signer があれば root へ署名する。
 */
export function buildAuditManifest(
  report: AuditSessionReport,
  signer?: AuditSigner,
): AuditManifest {
  const sessionId = report.summary.session_id;
  const summary = normalizeSummaryForManifest(report.summary);
  const diff = report.diff !== undefined ? normalizeDiffForManifest(report.diff) : undefined;
  // タイムライン完全性フラグ (表示 "truncated" 注記)。TDA-1: これも表示事実ゆえ root へ binding
  // (打ち切り subset を「完全」に偽装する改竄を検知する)。
  const eventsTruncated = report.events_truncated ? "true" : "false";

  // h0 = domain + session、次に summary を畳む。
  let prev = chainStep(
    sha256Hex(CHAIN_DOMAIN + canonJSON([sessionId])),
    canonicalizeSummary(summary),
  );
  const events: AuditManifestEvent[] = report.events.map((e) => {
    const fields = normalizeEventForManifest(e);
    const h = chainStep(prev, canonicalizeEventFields(fields));
    prev = h;
    return { ...fields, hash: h };
  });
  // 最後に diff + events_truncated を畳んで root を確定 (表示投影全体を覆う)。
  const root = chainStep(prev, canonJSON([canonicalizeDiff(diff), eventsTruncated]));

  const base: AuditManifest = {
    version: AUDIT_MANIFEST_VERSION,
    algorithm: "sha256-chain",
    session_id: sessionId,
    generated_at: report.generated_at,
    event_count: events.length,
    events_truncated: eventsTruncated,
    summary,
    events,
    ...(diff !== undefined ? { diff } : {}),
    root,
  };
  if (signer === undefined) return base;
  const sig = signer.sign(canonicalizeHeader(base));
  return {
    ...base,
    signature: {
      algorithm: "ed25519",
      public_key: sig.publicKeyDer,
      public_key_fingerprint: sig.fingerprint,
      value: sig.value,
    },
  };
}

// ---------------------------------------------------------------------------
// Encode / decode (HTML コメント / MD fence へ verbatim 埋込)。
// ---------------------------------------------------------------------------

export const AUDIT_MANIFEST_MARKER = "actradeck-audit-manifest";

export function encodeManifestBase64(manifest: AuditManifest): string {
  return Buffer.from(JSON.stringify(manifest), "utf8").toString("base64");
}

export function decodeManifestBase64(b64: string): AuditManifest | undefined {
  try {
    const obj = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as AuditManifest;
    if (obj.version !== AUDIT_MANIFEST_VERSION || !Array.isArray(obj.events)) return undefined;
    return obj;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Verify.
// ---------------------------------------------------------------------------

export interface AuditVerifyResult {
  /** 総合判定 (chain 整合 かつ 署名済みなら署名有効 + fingerprint pin 成立)。 */
  readonly ok: boolean;
  readonly chain_valid: boolean;
  readonly signed: boolean;
  readonly signature_valid?: boolean;
  readonly key_trusted?: boolean;
  readonly reason: string;
}

/** manifest 要素の構造検証 (untrusted 入力・SEC-4)。壊れていれば false。 */
function isWellFormedManifest(m: AuditManifest): boolean {
  if (
    m === null ||
    typeof m !== "object" ||
    m.version !== AUDIT_MANIFEST_VERSION ||
    typeof m.session_id !== "string" ||
    typeof m.generated_at !== "string" ||
    typeof m.events_truncated !== "string" ||
    typeof m.root !== "string" ||
    m.summary === null ||
    typeof m.summary !== "object" ||
    !Array.isArray(m.summary.redaction_by_kind) ||
    !Array.isArray(m.events)
  ) {
    return false;
  }
  for (const e of m.events) {
    if (
      e === null ||
      typeof e !== "object" ||
      typeof e.event_id !== "string" ||
      typeof e.hash !== "string"
    ) {
      return false;
    }
  }
  return true;
}

/**
 * manifest を検証する。build と同一の canonicalize/chain で root を再計算し (summary→events→diff+events_truncated)、
 * 署名があれば Ed25519 検証 + **fingerprint pin を要求** (SEC-2)。malformed は throw せず ok=false
 * を値返し (SEC-4)。`expectedFingerprint` 未指定で署名済みは ok=false (未 pin は tamper-evidence 不成立)。
 */
export function verifyAuditManifest(
  manifest: AuditManifest,
  opts: { expectedFingerprint?: string } = {},
): AuditVerifyResult {
  if (!isWellFormedManifest(manifest)) {
    return { ok: false, chain_valid: false, signed: false, reason: "malformed-manifest" };
  }

  // root 再計算 (summary→events→diff+events_truncated・全投影)。build と同一経路。
  let prev = chainStep(
    sha256Hex(CHAIN_DOMAIN + canonJSON([manifest.session_id])),
    canonicalizeSummary(manifest.summary),
  );
  let chainValid = manifest.events.length === manifest.event_count;
  for (const e of manifest.events) {
    const h = chainStep(prev, canonicalizeEventFields(e));
    if (h !== e.hash) chainValid = false;
    prev = h;
  }
  const root = chainStep(
    prev,
    canonJSON([canonicalizeDiff(manifest.diff), manifest.events_truncated]),
  );
  if (root !== manifest.root) chainValid = false;

  const signed = manifest.signature !== undefined;
  if (!chainValid) {
    return {
      ok: false,
      chain_valid: false,
      signed,
      reason: "chain-mismatch (tampered or corrupt)",
    };
  }
  if (!signed) {
    return {
      ok: true,
      chain_valid: true,
      signed: false,
      reason:
        "chain-consistent (unsigned: internal integrity only; enable signing for tamper-evidence)",
    };
  }

  // 署名検証。
  const sig = manifest.signature!;
  let signatureValid = false;
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(sig.public_key, "base64"),
      format: "der",
      type: "spki",
    });
    signatureValid = cryptoVerify(
      null,
      Buffer.from(canonicalizeHeader(manifest), "utf8"),
      publicKey,
      Buffer.from(sig.value, "base64"),
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    return {
      ok: false,
      chain_valid: true,
      signed: true,
      signature_valid: false,
      reason: "signature-invalid (tampered or wrong key)",
    };
  }

  // SEC-2: fingerprint pin を要求。未 pin では署名有効でも tamper-evidence にならない
  // (攻撃者が自鍵で再署名しうる)。
  if (opts.expectedFingerprint === undefined) {
    return {
      ok: false,
      chain_valid: true,
      signed: true,
      signature_valid: true,
      reason: "signature-valid-unpinned (provide expected_fingerprint to establish trust)",
    };
  }
  // SEC-1: 実際に署名を検証した鍵から fp を再計算して pin 照合する (自己申告 fp は信頼しない)。
  const actualFp = fingerprintOfPublicKey(sig.public_key);
  const keyTrusted = actualFp === opts.expectedFingerprint;
  return {
    ok: keyTrusted,
    chain_valid: true,
    signed: true,
    signature_valid: true,
    key_trusted: keyTrusted,
    reason: keyTrusted
      ? "verified (chain + ed25519 signature, fingerprint pinned)"
      : "signature-valid-but-untrusted-key (fingerprint mismatch)",
  };
}

// ===========================================================================
// Packet manifest (ADR 6点強化 #2・改竄検知レビュー・パケット).
//
// 多セッションを 1 つの共有可能・独立検証可能なレビュー・パケットに束ねる。各セッションの
// per-session manifest.root は **既にそのセッションの表示投影全体を binding** している(SEC-1)。
// packet_root はそれら root を順に畳み、cross-session governance 集計 canonical を畳んで確定する
// (Merkle 的合成)。ゆえに **いずれかのセッション内容 or governance 集計を書換えると packet verify が
// ok=false**。署名・fingerprint pin モデルは単一 manifest と同一を再利用する。
//
// ドメイン分離: PACKET_CHAIN_DOMAIN は単一 manifest の CHAIN_DOMAIN と別文字列ゆえ、
//   単一 root と packet root は構造的に衝突しない (h0 が別領域)。
// NO-RAW: governance 投影は集計値(非負整数の文字列)と、flagged の redacted 表示列(session_id/
//   reason(enum)/risk/decision(enum)/subject=redacted command??path)のみ。生 secret を再導入しない。
// ===========================================================================

/** packet manifest フォーマットのバージョン。 */
export const AUDIT_PACKET_MANIFEST_VERSION = "actradeck-audit-packet-manifest/v1";
/** packet ハッシュ連鎖のドメイン分離定数 (単一 manifest と別領域)。 */
const PACKET_CHAIN_DOMAIN = "actradeck-audit-packet-manifest/v1/sha256-chain";
/** HTML コメント / MD fence へ埋め込む packet manifest マーカー (単一 manifest と別)。 */
export const AUDIT_PACKET_MANIFEST_MARKER = "actradeck-audit-packet-manifest";

/** cross-session governance 集計の canonical 投影 (全て文字列・root binding 対象)。 */
export interface PacketManifestGovernance {
  readonly session_count: string;
  readonly hard_gate: string;
  readonly soft_gate: string;
  readonly auto_allowed: string;
  readonly high_risk_op_count: string;
  readonly secret_redaction_count: string;
  /** kind→count を key 昇順の [kind, count] 配列で (決定論)。 */
  readonly redaction_by_kind: readonly (readonly [string, string])[];
  /** what-to-review flagged の canonical 投影 [session_id, reason, risk, decision, subject]。 */
  readonly flagged: readonly (readonly [string, string, string, string, string])[];
}

/** packet manifest 内の 1 セッション要素 (per-session root を束ねる)。 */
export interface PacketManifestSession {
  readonly session_id: string;
  /** per-session manifest の root (そのセッションの表示投影全体を binding 済)。 */
  readonly root: string;
  readonly event_count: number;
  readonly events_truncated: string;
  readonly hard_gate: string;
  readonly soft_gate: string;
  readonly auto_allowed: string;
  /** 連鎖のこのセッション時点の値 (hex)。 */
  readonly hash: string;
}

export interface PacketManifest {
  readonly version: typeof AUDIT_PACKET_MANIFEST_VERSION;
  readonly algorithm: "sha256-chain";
  readonly generated_at: string;
  readonly session_count: number;
  readonly sessions: readonly PacketManifestSession[];
  readonly governance: PacketManifestGovernance;
  /** 連鎖の最終ハッシュ (hex)。session roots→governance を全て畳む。署名対象。 */
  readonly root: string;
  readonly signature?: AuditManifestSignature;
}

/** build/verify が入力とする 1 セッション (hash は build が確定)。 */
export interface PacketManifestSessionInput {
  readonly session_id: string;
  readonly root: string;
  readonly event_count: number;
  readonly events_truncated: boolean;
  readonly hard_gate: number;
  readonly soft_gate: number;
  readonly auto_allowed: number;
}

function canonicalizePacketSession(s: Omit<PacketManifestSession, "hash">): string {
  return canonJSON([
    s.session_id,
    s.root,
    s.event_count,
    s.events_truncated,
    s.hard_gate,
    s.soft_gate,
    s.auto_allowed,
  ]);
}

function canonicalizePacketGovernance(g: PacketManifestGovernance): string {
  return canonJSON([
    g.session_count,
    g.hard_gate,
    g.soft_gate,
    g.auto_allowed,
    g.high_risk_op_count,
    g.secret_redaction_count,
    g.redaction_by_kind,
    g.flagged,
  ]);
}

/** packet 署名対象 canonical header (root + メタを binding)。 */
function canonicalizePacketHeader(m: {
  generated_at: string;
  session_count: number;
  root: string;
}): string {
  return canonJSON([AUDIT_PACKET_MANIFEST_VERSION, m.generated_at, m.session_count, m.root]);
}

/**
 * per-session root 群 + governance 集計から packet manifest を構築する。root は各 session root を
 * 順に畳み、最後に governance canonical を畳んで確定する。signer があれば root へ署名する。
 */
export function buildPacketManifest(
  input: {
    readonly generated_at: string;
    readonly sessions: readonly PacketManifestSessionInput[];
    readonly governance: PacketManifestGovernance;
  },
  signer?: AuditSigner,
): PacketManifest {
  const sessionCount = input.sessions.length;
  // h0 = packet domain + version + generated_at + session_count。
  let prev = sha256Hex(
    PACKET_CHAIN_DOMAIN +
      canonJSON([AUDIT_PACKET_MANIFEST_VERSION, input.generated_at, sessionCount]),
  );
  const sessions: PacketManifestSession[] = input.sessions.map((s) => {
    const proj: Omit<PacketManifestSession, "hash"> = {
      session_id: s.session_id,
      root: s.root,
      event_count: s.event_count,
      events_truncated: s.events_truncated ? "true" : "false",
      hard_gate: String(s.hard_gate),
      soft_gate: String(s.soft_gate),
      auto_allowed: String(s.auto_allowed),
    };
    const h = chainStep(prev, canonicalizePacketSession(proj));
    prev = h;
    return { ...proj, hash: h };
  });
  const root = chainStep(prev, canonicalizePacketGovernance(input.governance));

  const base: PacketManifest = {
    version: AUDIT_PACKET_MANIFEST_VERSION,
    algorithm: "sha256-chain",
    generated_at: input.generated_at,
    session_count: sessionCount,
    sessions,
    governance: input.governance,
    root,
  };
  if (signer === undefined) return base;
  const sig = signer.sign(canonicalizePacketHeader(base));
  return {
    ...base,
    signature: {
      algorithm: "ed25519",
      public_key: sig.publicKeyDer,
      public_key_fingerprint: sig.fingerprint,
      value: sig.value,
    },
  };
}

export function encodePacketManifestBase64(manifest: PacketManifest): string {
  return Buffer.from(JSON.stringify(manifest), "utf8").toString("base64");
}

export function decodePacketManifestBase64(b64: string): PacketManifest | undefined {
  try {
    const obj = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as PacketManifest;
    if (obj.version !== AUDIT_PACKET_MANIFEST_VERSION || !Array.isArray(obj.sessions)) {
      return undefined;
    }
    return obj;
  } catch {
    return undefined;
  }
}

/** packet manifest の構造検証 (untrusted 入力)。壊れていれば false。 */
function isWellFormedPacketManifest(m: PacketManifest): boolean {
  if (
    m === null ||
    typeof m !== "object" ||
    m.version !== AUDIT_PACKET_MANIFEST_VERSION ||
    typeof m.generated_at !== "string" ||
    typeof m.root !== "string" ||
    m.governance === null ||
    typeof m.governance !== "object" ||
    !Array.isArray(m.governance.redaction_by_kind) ||
    !Array.isArray(m.governance.flagged) ||
    !Array.isArray(m.sessions)
  ) {
    return false;
  }
  for (const s of m.sessions) {
    if (
      s === null ||
      typeof s !== "object" ||
      typeof s.session_id !== "string" ||
      typeof s.root !== "string" ||
      typeof s.hash !== "string"
    ) {
      return false;
    }
  }
  return true;
}

/**
 * packet manifest を検証する。build と同一の canonicalize/chain で packet root を再計算し、署名が
 * あれば Ed25519 検証 + fingerprint pin を要求 (単一 manifest と同一契約)。malformed は throw せず
 * ok=false を値返し。`expectedFingerprint` 未指定で署名済みは ok=false (未 pin)。
 */
export function verifyPacketManifest(
  manifest: PacketManifest,
  opts: { expectedFingerprint?: string } = {},
): AuditVerifyResult {
  if (!isWellFormedPacketManifest(manifest)) {
    return { ok: false, chain_valid: false, signed: false, reason: "malformed-packet-manifest" };
  }

  let prev = sha256Hex(
    PACKET_CHAIN_DOMAIN +
      canonJSON([AUDIT_PACKET_MANIFEST_VERSION, manifest.generated_at, manifest.session_count]),
  );
  let chainValid = manifest.sessions.length === manifest.session_count;
  for (const s of manifest.sessions) {
    const h = chainStep(prev, canonicalizePacketSession(s));
    if (h !== s.hash) chainValid = false;
    prev = h;
  }
  const root = chainStep(prev, canonicalizePacketGovernance(manifest.governance));
  if (root !== manifest.root) chainValid = false;

  const signed = manifest.signature !== undefined;
  if (!chainValid) {
    return {
      ok: false,
      chain_valid: false,
      signed,
      reason: "chain-mismatch (tampered or corrupt)",
    };
  }
  if (!signed) {
    return {
      ok: true,
      chain_valid: true,
      signed: false,
      reason:
        "chain-consistent (unsigned: internal integrity only; enable signing for tamper-evidence)",
    };
  }

  const sig = manifest.signature!;
  let signatureValid = false;
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(sig.public_key, "base64"),
      format: "der",
      type: "spki",
    });
    signatureValid = cryptoVerify(
      null,
      Buffer.from(canonicalizePacketHeader(manifest), "utf8"),
      publicKey,
      Buffer.from(sig.value, "base64"),
    );
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    return {
      ok: false,
      chain_valid: true,
      signed: true,
      signature_valid: false,
      reason: "signature-invalid (tampered or wrong key)",
    };
  }
  if (opts.expectedFingerprint === undefined) {
    return {
      ok: false,
      chain_valid: true,
      signed: true,
      signature_valid: true,
      reason: "signature-valid-unpinned (provide expected_fingerprint to establish trust)",
    };
  }
  // SEC-1: 実際に署名を検証した鍵から fp を再計算して pin 照合する (自己申告 fp は信頼しない)。
  const actualFp = fingerprintOfPublicKey(sig.public_key);
  const keyTrusted = actualFp === opts.expectedFingerprint;
  return {
    ok: keyTrusted,
    chain_valid: true,
    signed: true,
    signature_valid: true,
    key_trusted: keyTrusted,
    reason: keyTrusted
      ? "verified (chain + ed25519 signature, fingerprint pinned)"
      : "signature-valid-but-untrusted-key (fingerprint mismatch)",
  };
}
