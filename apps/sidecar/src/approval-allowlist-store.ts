/**
 * approval-allowlist-store — 承認の **再起動跨ぎ永続化** (Persistent Approval Allowlist, ADR 019ee0c0)。
 *
 * `allow_for_session` (in-memory・プロセス寿命限定・ADR 019e9b7a) を補完し、ユーザーが明示的に
 * 「再起動後も許可」を選んだ **medium-risk bash** の操作署名をディスクへ永続する。次回 sidecar 起動でも
 * 同一署名 (+同一 repo スコープ) なら UI を経ず即 allow できる。
 *
 * セキュリティ不変条件 (security.md / ADR 019ee0c0):
 * - **NO-RAW**: 生コマンド/パスを保存しない。**sha256 署名のみ** (encodeOperationSignature 由来)。
 *   repoLabel は表示用の basename のみ (絶対パスを書かない)。
 * - **0600 / atomic write**: fs-atomic.ts の共有ヘルパ (tmp+rename, mkdir 0700)。
 * - **TTL 必須**: 全エントリに expiresAt を持たせ、期限切れは read 時に無視し add 時に prune する
 *   (standing grant を作らない・自動失効)。
 * - **exact-signature + repo-scope**: 別操作/別 repo は構造的に命中しない (越境防止)。
 * - mutation (add/revoke/clear) は **withFileLock** で直列化 (managed + attach daemon の複数プロセス
 *   が同一ファイルへ並走書込しても lost-update しない)。read は毎回ファイル再読込 (multi-process で
 *   他プロセスの書込を取りこぼさない。承認は人間待ちで hot path でない)。
 *
 * opt-in / 既定 OFF・eligibility (medium-bash 限定) の判定は **呼び元 (ApprovalBridge)** が行う。
 * 本ストアは「与えられた署名を永続する/参照する」だけで feature flag や risk 判定を持たない (関心分離)。
 */
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import { withFileLock } from "./file-lock.js";
import { readJsonObject, writeJson0600 } from "./fs-atomic.js";

/** 永続エントリ。**生コマンドは含まない** (signature=sha256 のみ)。 */
export interface PersistedApproval {
  /** encodeOperationSignature(kind,risk,operand) の sha256 hex。生 operand は復元不能。 */
  readonly signature: string;
  /** repo root の sha256 短縮 (12 桁)。別 repo の grant が混ざらないスコープキー。 */
  readonly repoScope: string;
  /** 表示用の repo basename のみ (絶対パス/secret を書かない)。CLI/将来 UI の一覧表示用。 */
  readonly repoLabel?: string;
  /** 永続対象の risk (v1 は "medium" のみ)。将来の tier 拡張に備えフィールド化。 */
  readonly risk: string;
  /** 作成時刻 (epoch ms)。再 add (sliding) でも保持。 */
  readonly createdAt: number;
  /** 失効時刻 (epoch ms)。これを過ぎたエントリは read で無視・add で prune。 */
  readonly expiresAt: number;
}

/** ファイル形式 (version 付き・前方互換)。 */
interface AllowlistFile {
  readonly version: 1;
  readonly entries: readonly PersistedApproval[];
}

/** 永続ストアディレクトリ (~/.actradeck/approvals)。 */
export function approvalsStoreDir(home: string = homedir()): string {
  return join(home, ".actradeck", "approvals");
}

/** 永続ストアファイルパス (~/.actradeck/approvals/allowlist.json)。 */
export function approvalsStorePath(home: string = homedir()): string {
  return join(approvalsStoreDir(home), "allowlist.json");
}

/** repo root の絶対パスから表示用 basename を導出 (絶対パスは保存しない)。 */
export function repoLabelOf(repoRoot: string): string {
  const b = basename(repoRoot);
  return b.length > 0 ? b : repoRoot;
}

/** 1 エントリが構造的に妥当か (壊れたファイル/敵対入力を弾く)。 */
function isValidEntry(v: unknown): v is PersistedApproval {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Partial<PersistedApproval>;
  return (
    typeof e.signature === "string" &&
    e.signature.length > 0 &&
    typeof e.repoScope === "string" &&
    e.repoScope.length > 0 &&
    typeof e.risk === "string" &&
    typeof e.createdAt === "number" &&
    Number.isFinite(e.createdAt) &&
    typeof e.expiresAt === "number" &&
    Number.isFinite(e.expiresAt) &&
    (e.repoLabel === undefined || typeof e.repoLabel === "string")
  );
}

/** ファイルを読み妥当エントリ配列を返す (無し/壊れは [])。期限切れ判定は呼び元/上位で行う。 */
function readEntries(path: string): PersistedApproval[] {
  const parsed = readJsonObject(path);
  if (parsed === undefined) return []; // 無し/壊れ/非オブジェクトは fail-safe で空。
  const f = parsed as Partial<AllowlistFile>;
  if (!Array.isArray(f.entries)) return [];
  return f.entries.filter(isValidEntry);
}

/** 0600 atomic 書込 (fs-atomic 共有: tmp+rename, mkdir 0700)。 */
function writeEntries(path: string, entries: readonly PersistedApproval[]): void {
  const file: AllowlistFile = { version: 1, entries };
  writeJson0600(path, file, { dirMode: 0o700 });
}

export interface ApprovalAllowlistStoreOptions {
  /** ストアファイルパス (既定 ~/.actradeck/approvals/allowlist.json)。テスト差し替え用。 */
  readonly path?: string;
}

export interface AddApprovalInput {
  readonly signature: string;
  readonly repoScope: string;
  readonly repoLabel?: string;
  readonly risk: string;
  /** 失効までの ms。expiresAt = now + ttlMs。 */
  readonly ttlMs: number;
  /** 現在時刻 (epoch ms)。テスト決定論化のため注入必須。 */
  readonly now: number;
}

/**
 * 承認永続化ストア。**eligibility (medium-bash / feature-on) は呼び元が判定済み**で渡す前提。
 * 本クラスは署名の永続/参照と TTL prune・直列化のみを担う。
 */
export class ApprovalAllowlistStore {
  private readonly path: string;

  constructor(opts: ApprovalAllowlistStoreOptions = {}) {
    this.path = opts.path ?? approvalsStorePath();
  }

  /** ストアファイルの絶対パス (CLI 表示・テスト用)。 */
  get filePath(): string {
    return this.path;
  }

  /** 期限内エントリのみを返す (期限切れは除外)。 */
  list(now: number): PersistedApproval[] {
    return readEntries(this.path).filter((e) => e.expiresAt > now);
  }

  /**
   * 同一 (signature, repoScope) の期限内エントリが存在するか。
   * 期限切れは命中しない (自動失効)。別 repo / 別署名は構造的に false。
   */
  has(signature: string, repoScope: string, now: number): boolean {
    return readEntries(this.path).some(
      (e) => e.signature === signature && e.repoScope === repoScope && e.expiresAt > now,
    );
  }

  /**
   * 署名を永続する (withFileLock で read-modify-write 直列化)。
   * - dedup: 同一 (signature, repoScope) は 1 本へ統合し expiresAt を sliding 更新 (createdAt 保持)。
   * - prune: 期限切れエントリは書込時に除去 (ファイル肥大化防止)。
   */
  add(input: AddApprovalInput): void {
    withFileLock(this.path, () => {
      const now = input.now;
      // QA-5/TDA-2: critical section 内で 1 回だけ読み、kept と existing を同一スナップショットから導出。
      const all = readEntries(this.path);
      const existing = all.find(
        (e) => e.signature === input.signature && e.repoScope === input.repoScope,
      );
      const kept = all.filter(
        (e) =>
          e.expiresAt > now && // 期限切れ prune
          !(e.signature === input.signature && e.repoScope === input.repoScope), // 既存同一は置換
      );
      const entry: PersistedApproval = {
        signature: input.signature,
        repoScope: input.repoScope,
        ...(input.repoLabel !== undefined ? { repoLabel: input.repoLabel } : {}),
        risk: input.risk,
        createdAt: existing?.createdAt ?? now,
        expiresAt: now + input.ttlMs,
      };
      writeEntries(this.path, [...kept, entry]);
    });
  }

  /**
   * 署名を失効する (withFileLock)。戻り値=除去件数。repoScope 指定時はその scope のみ、
   * 省略時は全 scope の同一署名を除去する (CLI で signature プレフィックス指定の失効に使う)。
   */
  revoke(signature: string, repoScope?: string): number {
    return withFileLock(this.path, () => {
      const before = readEntries(this.path);
      const kept = before.filter(
        (e) =>
          !(e.signature === signature && (repoScope === undefined || e.repoScope === repoScope)),
      );
      if (kept.length !== before.length) writeEntries(this.path, kept);
      return before.length - kept.length;
    });
  }

  /** 全エントリを削除する (CLI clear)。 */
  clear(): void {
    withFileLock(this.path, () => {
      if (existsSync(this.path)) {
        try {
          rmSync(this.path, { force: true });
        } catch {
          /* best-effort */
        }
      }
    });
  }
}
