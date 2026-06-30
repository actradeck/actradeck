"use client";

/**
 * ADR 019f0eca per-repo 承認ポリシー画面 (ApprovalPolicyView) の **クライアント側 localStorage キャッシュ**。
 *
 * 目的 (ユーザー指摘 2026-06-29):
 *  - 接続中セッションが 0 でも **最後に取得したポリシー (last-known)** を read-only で閲覧できる
 *    (mutation は依然 relay = 接続中デーモン必須。キャッシュは表示専用)。
 *  - 手動 add した **未保存 candidate** (default 継承の repo) をリロードを跨いで一覧へ保持する。
 *
 * セキュリティ (security.md NO-RAW / 表示ポリシー):
 *  - localStorage は **untrusted source** として扱う (手編集 policy.json と同格)。load 時に必ず
 *    closed-enum 再射影 (parsePolicyAdmin 内 projectPolicyCategories) と repo_label 再サニタイズ
 *    (sanitizeRepoLabel) を通す。生パス・生コマンド・非 enum 値は構造的に弾く。
 *  - 保存するのは UI が既に描画している公開メタのみ: closed-enum categories / repo_scope (hash) /
 *    repo_label (basename・sanitize 済) / boolean フラグ。**秘匿値・生パスは保存しない**。
 *  - 本キャッシュは live gate に一切影響しない (sidecar の memory-authoritative 判定は不変)。
 *    書込 (set/unset/resolve) は接続中 relay のみで成立する。
 *  - localStorage 不可 (プライベートモード等) や破損 JSON でも throw せず、その場合は揮発する。
 */
import { sanitizeRepoLabel } from "@actradeck/event-model";

/**
 * localStorage キー (TDA-5: test がハードコード再掲で silent drift しないよう **単一ソースを export**)。
 */
export const POLICY_ADMIN_CACHE_KEY = "actradeck.policy.admin-cache.v1";
export const POLICY_CANDIDATES_KEY = "actradeck.policy.candidates.v1";

/**
 * repo_scope は sha256(git root) 由来の hex。untrusted 入力 (localStorage・cache 復元) を
 * **server 側 gate と同 bound** `/^[0-9a-f]{1,64}$/` でゲートする (QA-1/SEC-1/TDA-1: admin-cache 経路と
 * candidate 経路で repo_scope 検証を**単一規則に揃える**・webui 内ドリフト解消)。bound を server (`{1,64}`)
 * に合わせ、webui が server の認める scope を取りこぼさないようにする (より厳しい min は誤 drop を生む)。
 * NB: backend×2/sidecar×2 の `{1,64}` コピーとの cross-tier 正準統合 (event-model `isRepoScope` 共有) は
 * 別 PR の deferred follow-up (境界ゲート跨ぎゆえ full 監査・本修正は webui-local)。
 */
const REPO_SCOPE_RE = /^[0-9a-f]{1,64}$/;

/** repo_scope が hex(1-64) か (untrusted source ゲートの単一述語・policy-cache と parser で共有)。 */
export function isPolicyRepoScope(v: unknown): v is string {
  return typeof v === "string" && REPO_SCOPE_RE.test(v);
}

function readJson(key: string): unknown {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return undefined;
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function writeJson(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* localStorage 不可は無視 (キャッシュは揮発するが機能は保つ)。 */
  }
}

/** admin cache のエンベロープ: server wire 形 raw + 取得時刻 (SEC-2: offline 表示で stale 度を示す)。 */
export interface PolicyAdminCache {
  /** server wire 形 list 応答 (revive は parsePolicyAdmin が担う・projection パス単一化)。 */
  readonly raw: unknown;
  /** 取得時刻 (epoch ms・0=不明)。offline バナーで「最終取得から N」表示に使う。 */
  readonly fetchedAt: number;
}

/**
 * 取得成功した list 応答 (raw) を取得時刻と共に保存する。形を変えず保持し revive を parsePolicyAdmin に
 * 単一化する (ネットワークとキャッシュで同一 parser)。
 */
export function savePolicyAdminCache(raw: unknown, fetchedAt: number): void {
  writeJson(POLICY_ADMIN_CACHE_KEY, { raw, fetchedAt });
}

/** キャッシュ済エンベロープを返す。raw の parse/sanitize は呼び出し側 (parsePolicyAdmin) が行う。 */
export function loadPolicyAdminCache(): PolicyAdminCache | undefined {
  const env = readJson(POLICY_ADMIN_CACHE_KEY);
  if (typeof env !== "object" || env === null) return undefined;
  const e = env as { raw?: unknown; fetchedAt?: unknown };
  if (!("raw" in e) || e.raw === undefined) return undefined;
  const fetchedAt =
    typeof e.fetchedAt === "number" && Number.isFinite(e.fetchedAt) ? e.fetchedAt : 0;
  return { raw: e.raw, fetchedAt };
}

/** 未保存 candidate の永続スタブ (default 継承ゆえ categories は持たず、load 時に現 Default から再構築)。 */
export interface PersistedCandidate {
  readonly repoScope: string;
  readonly repoLabel?: string;
}

/**
 * 未保存 candidate スタブ群を保存する。repo_scope の hex 検証と repo_label の再サニタイズを
 * **保存時にも**通し、不正値を at-rest に残さない (load 時と二重で防御)。
 */
export function saveCandidateStubs(stubs: readonly PersistedCandidate[]): void {
  const clean = sanitizeCandidates(stubs);
  writeJson(POLICY_CANDIDATES_KEY, clean);
}

/** 永続 candidate スタブ群を返す。untrusted ゆえ hex 検証 + label 再サニタイズで畳む。 */
export function loadCandidateStubs(): PersistedCandidate[] {
  const raw = readJson(POLICY_CANDIDATES_KEY);
  if (!Array.isArray(raw)) return [];
  return sanitizeCandidates(
    raw.filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null),
  );
}

/** hex scope のみ通し、label を canonical sanitize へ畳む (重複 scope は先勝ち)。 */
function sanitizeCandidates(
  entries: readonly { repoScope?: unknown; repoLabel?: unknown }[],
): PersistedCandidate[] {
  const out: PersistedCandidate[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const scope = e.repoScope;
    if (!isPolicyRepoScope(scope) || seen.has(scope)) continue;
    seen.add(scope);
    const label = sanitizeRepoLabel(e.repoLabel);
    out.push({ repoScope: scope, ...(label !== undefined ? { repoLabel: label } : {}) });
  }
  return out;
}
