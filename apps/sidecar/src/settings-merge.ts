/**
 * settings-merge — Attach Mode のユーザー settings 非破壊配線 (ADR 019ea476 D2)。
 *
 * Managed Mode の `settings-injection.ts`(temp-file 専用) とは **別モジュール**。理由 (ADR):
 * temp 注入 (cleanup ライフサイクル) と永続ユーザー settings 改変 (reversible detach ライフサイクル)
 * は責務が衝突するため分離する。
 *
 * Attach は ActraDeck が起動を所有しない CC を、ユーザーの settings.json の hooks へ
 * **安定 endpoint を配線**して後付け観測する。既存ユーザー hooks を **clobber しない** ため、
 * マーカー (`__actradeck: true`) 付き hook entry を **append** する。
 *
 * 不変条件 (INV-ATTACH-SETTINGS-MERGE / INV-ATTACH-DETACH-REVERSIBLE):
 * - merge: 既存ユーザー hooks を保持し ActraDeck entry を追記する (置換しない)。
 * - 冪等: 再 merge で重複追加しない (マーカー entry を in-place 更新)。
 * - backup: 改変前に `<path>.actradeck-bak-<ts>` を作る (原状復帰の最終手段)。
 * - atomic: tmp 書込 → rename。
 * - reversible detach: マーカー entry **のみ** 除去しユーザー hooks を温存する。
 * - dry-run (preview): diff を返すのみ書き込まない。
 *
 * SECURITY (token の書き方):
 * - token-mode `literal`: headers に `X-ActraDeck-Hook-Token: <nonce>` を直書き。
 *   平文リスクは loopback bind + settings 0600 + project-local(gitignore) + 再起動 rotation で減殺。
 *   (CC HTTP hook の literal header 値は補間されずそのまま送られる — WebFetch 2026-06 確定。)
 * - token-mode `env`: headers に `Authorization: Bearer $ACTRADECK_HOOK_TOKEN` +
 *   `allowedEnvVars:["ACTRADECK_HOOK_TOKEN"]` を書く (非リテラル, forward-compat)。
 *   $VAR は allowedEnvVars 列挙時のみ CC プロセス env から解決される (非列挙は空文字)。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { withFileLock, type FileLockOptions } from "./file-lock.js";
import { writeJson0600 } from "./fs-atomic.js";
import { HOOK_TOKEN_HEADER, MANAGED_HOOK_EVENTS } from "./settings-injection.js";

export type { FileLockOptions };

/** Attach も managed と同一の hook event 集合を使う (差分 events は forward-compat)。 */
export const ATTACH_HOOK_EVENTS = MANAGED_HOOK_EVENTS;

/** ActraDeck が配線した hook entry を識別する安定マーカーキー。 */
export const ACTRADECK_MARKER = "__actradeck" as const;

/** env トークンモードで使う環境変数名。 */
export const HOOK_TOKEN_ENV_VAR = "ACTRADECK_HOOK_TOKEN" as const;

export type TokenMode = "literal" | "env";

/** settings.json の hook entry (http)。CC スキーマ準拠 + ActraDeck マーカー。 */
export interface AttachHookEntry {
  readonly type: "http";
  readonly url: string;
  readonly timeout?: number;
  readonly headers?: Record<string, string>;
  readonly allowedEnvVars?: readonly string[];
  /** ActraDeck が配線した entry の識別子 (detach の限定除去に使う)。 */
  readonly [ACTRADECK_MARKER]?: true;
}

/** hooks.<event> 配列の 1 要素 (matcher + hooks 群)。 */
interface HookGroup {
  matcher?: string;
  hooks?: unknown[];
  [k: string]: unknown;
}

/** settings.json の最小型 (hooks 以外のキーは温存するため index で受ける)。 */
interface ClaudeSettingsFile {
  hooks?: Record<string, HookGroup[]>;
  [k: string]: unknown;
}

export interface MergeOptions {
  readonly settingsPath: string;
  /** 安定 hook endpoint (例 http://127.0.0.1:<port>/hook)。 */
  readonly endpoint: string;
  readonly tokenMode: TokenMode;
  /** literal モードの nonce。env モードでは未使用 (settings には書かない)。 */
  readonly token?: string;
  /** 配線する event 群 (既定 ATTACH_HOOK_EVENTS)。 */
  readonly events?: readonly string[];
  /**
   * file lock の調整オプション (本番未使用・INV テスト用の注入 seam)。
   * `withFileLock` へそのまま渡る。`onLockAcquired` で critical section 内 read を pin し、
   * `maxRetries`/`sleep`/`isAlive` で本番呼び出し経路の retry budget を縛るために使う。
   */
  readonly lockOptions?: FileLockOptions;
}

export interface MergeResult {
  /** 実際に書き込んだか (dry-run / 変化なし冪等のときは false)。 */
  readonly wired: boolean;
  /** 作成した backup ファイルパス (新規作成 or 変化なしのとき undefined)。 */
  readonly backupPath?: string;
  /** 追加/更新された event 名一覧。 */
  readonly events: readonly string[];
  /** 書き込み後の settings (preview ではマージ後の予定形)。 */
  readonly settings: ClaudeSettingsFile;
}

/** PreToolUse / PermissionRequest は承認待ちがあるので timeout を長めに (managed と同方針)。 */
function timeoutForEvent(ev: string): number {
  return ev === "PreToolUse" || ev === "PermissionRequest" ? 35 : 10;
}

/** ActraDeck の hook entry を生成する (token-mode に応じて headers/allowedEnvVars を切替)。 */
function buildAttachEntry(endpoint: string, ev: string, opts: MergeOptions): AttachHookEntry {
  const timeout = timeoutForEvent(ev);
  if (opts.tokenMode === "env") {
    return {
      type: "http",
      url: endpoint,
      timeout,
      headers: { Authorization: `Bearer $${HOOK_TOKEN_ENV_VAR}` },
      allowedEnvVars: [HOOK_TOKEN_ENV_VAR],
      [ACTRADECK_MARKER]: true,
    };
  }
  // literal: nonce を直書き (loopback + 0600 + project-local + rotation で減殺)。
  const headers: Record<string, string> =
    opts.token !== undefined && opts.token.length > 0 ? { [HOOK_TOKEN_HEADER]: opts.token } : {};
  return {
    type: "http",
    url: endpoint,
    timeout,
    headers,
    [ACTRADECK_MARKER]: true,
  };
}

/**
 * hook entry が ActraDeck 由来か判定する。
 *
 * 識別子は 2 系統 (legacy orphan の取りこぼし防止・SEC self-heal):
 *  1. canonical マーカー `__actradeck: true` (現行 merge が必ず付与)。
 *  2. ActraDeck 専用トークン署名 (マーカー以前 = legacy entry 対応・{@link hasActradeckTokenSignature}):
 *     - literal: headers に `X-ActraDeck-Hook-Token` ヘッダを持つ。
 *     - env: allowedEnvVars に `ACTRADECK_HOOK_TOKEN` を列挙している。
 *
 * これらヘッダ名 / 環境変数名は ActraDeck 名前空間であり、ユーザー hook が用いることは実質ない。
 * マーカー以前に配線され marker を欠く dead-port orphan を self-heal / detach が取りこぼすと、
 * loopback hook が CC payload + 旧 token を port squatter へ送り続ける窓が残る
 * (SEC: orphan loopback leak)。署名識別でこの legacy orphan を回収する。
 */
export function isActradeckEntry(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const rec = entry as Record<string, unknown>;
  if (rec[ACTRADECK_MARKER] === true) return true;
  return hasActradeckTokenSignature(rec);
}

/**
 * legacy (マーカー以前) ActraDeck entry を識別する ActraDeck 専用トークン署名。
 * - literal token-mode: headers が ActraDeck 専用ヘッダ `X-ActraDeck-Hook-Token` を
 *   **own-property** として持つ (prototype 経由は無視 = 汚染を踏まない / TDA-1)。
 * - env token-mode: allowedEnvVars (配列) に ActraDeck 専用環境変数 `ACTRADECK_HOOK_TOKEN`
 *   を**値として**列挙 (配列値メンバシップ判定ゆえ prototype 非依存 / TDA-1)。
 *
 * SEC-1 (accepted residue): token を持たず配線された literal entry (空 token →
 * `headers:{}`・marker 無し) は署名を欠くため回収対象外。**漏洩面は無い** (流出する
 * token が存在しない) ため許容する。url/port ヒューリスティックでの回収は正当な
 * ユーザー loopback hook の誤除去リスクを上げるため採らない。
 */
function hasActradeckTokenSignature(rec: Record<string, unknown>): boolean {
  const hasOwn = Object.prototype.hasOwnProperty;
  // literal: ActraDeck 専用ヘッダ (own-property のみ)。
  const headers = rec.headers;
  if (
    typeof headers === "object" &&
    headers !== null &&
    !Array.isArray(headers) &&
    hasOwn.call(headers, HOOK_TOKEN_HEADER)
  ) {
    return true;
  }
  // env: ActraDeck 専用環境変数名を allowedEnvVars に列挙。
  const allowed = rec.allowedEnvVars;
  return Array.isArray(allowed) && allowed.includes(HOOK_TOKEN_ENV_VAR);
}

/** hook group が ActraDeck マーカー entry を (1 つ以上) 含むか。 */
function groupHasActradeckEntry(group: HookGroup): boolean {
  return Array.isArray(group.hooks) && group.hooks.some(isActradeckEntry);
}

/** settings.json を読む (無ければ {})。JSON 不正は throw (誤って上書きしないため)。 */
function readSettings(path: string): ClaudeSettingsFile {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  if (raw.trim().length === 0) return {};
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`settings file is not a JSON object: ${path}`);
  }
  return parsed as ClaudeSettingsFile;
}

/**
 * deep clone (構造化複製)。preview がディスクを触らず予定形を返すため、
 * また in-place 変異が呼び元の入力を汚さないために使う。
 */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * ある hook entry が「自 endpoint と同じ canonical」な ActraDeck entry か。
 * url 一致で判定する (canonical endpoint 概念: 自 daemon が今配線している唯一の正)。
 *
 * QA-4: canonical endpoint は daemon が機械生成する固定文字列。url の **exact-match** は
 * 意図的 — 似た別 url (旧 port 等) は dead-port residue として self-heal で purge する。
 */
function isCanonicalActradeckEntry(entry: unknown, canonicalEndpoint: string): boolean {
  return (
    isActradeckEntry(entry) &&
    typeof (entry as AttachHookEntry).url === "string" &&
    (entry as AttachHookEntry).url === canonicalEndpoint
  );
}

/**
 * SELF-HEAL (INV-ATTACH-SELF-HEAL): settings 全体を走査し **canonical endpoint 以外の
 * ActraDeck マーカー entry をすべて除去**する (純関数, in-place 変異)。
 *
 * 回収対象 (Step 1 実証の residue 窓):
 * - 旧 daemon が別 port で配線し crash/lost-update で残った dead-port entry。
 * - 新 merge が touch しない event (event 集合縮小) に残る dead-port entry。
 * - 同一 event 内の複数 ActraDeck group (find() で 1 つしか更新されない死角)。
 * - **marker を欠く legacy orphan** (マーカー導入以前に配線され `__actradeck` が無い entry)。
 *   {@link isActradeckEntry} が ActraDeck 専用トークン署名で識別するため回収できる
 *   (これを欠くと dead-port orphan が永続し SEC: orphan loopback leak の窓が残る)。
 *
 * 不変条件: **ユーザー hooks (非 ActraDeck entry) は一切触らない**。除去は
 * `isActradeckEntry === true` (marker または legacy 署名) かつ `url !== canonicalEndpoint`
 * の entry のみ。group/event が空になったら掃除する (detach と同じ片付け規約)。
 */
function purgeNonCanonicalActradeck(settings: ClaudeSettingsFile, canonicalEndpoint: string): void {
  if (settings.hooks === undefined) return;
  for (const ev of Object.keys(settings.hooks)) {
    const groups = settings.hooks[ev] ?? [];
    const cleanedGroups: HookGroup[] = [];
    for (const group of groups) {
      if (!Array.isArray(group.hooks)) {
        cleanedGroups.push(group);
        continue;
      }
      const hadActradeck = group.hooks.some(isActradeckEntry);
      // canonical 以外の ActraDeck entry を落とす。ユーザー hooks + canonical AD entry は温存。
      const keptHooks = group.hooks.filter(
        (h) => !isActradeckEntry(h) || isCanonicalActradeckEntry(h, canonicalEndpoint),
      );
      if (keptHooks.length > 0) {
        cleanedGroups.push({ ...group, hooks: keptHooks });
      } else if (!hadActradeck) {
        // 元々 ActraDeck を含まない空ユーザー group は形を保つ (改変しない)。
        cleanedGroups.push(group);
      }
      // hooks が空 かつ ActraDeck 由来 group → 丸ごと除去 (cleanedGroups に積まない)。
    }
    if (cleanedGroups.length > 0) {
      settings.hooks[ev] = cleanedGroups;
    } else {
      delete settings.hooks[ev];
    }
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
}

/**
 * settings に Attach hooks を merge した **新しい** settings を計算する (純関数, ディスク非依存)。
 * - **self-heal**: まず canonical endpoint (= opts.endpoint) 以外の ActraDeck entry を全除去
 *   (dead-port group を毎回回収。Step 1 で実証した residue 窓を塞ぐ)。
 * - 既存ユーザー hooks は温存 (append)。
 * - canonical な ActraDeck マーカー entry があれば in-place 更新 (冪等 = 重複追加しない)。
 */
export function computeMergedSettings(
  current: ClaudeSettingsFile,
  opts: MergeOptions,
): { settings: ClaudeSettingsFile; events: string[] } {
  const events = [...(opts.events ?? ATTACH_HOOK_EVENTS)];
  const next = clone(current);

  // SELF-HEAL: 自 endpoint 以外の ActraDeck entry を全イベント・全 group から除去。
  // (これにより dead-port residue / event 集合縮小 / 多重 AD group の死角を回収する。)
  purgeNonCanonicalActradeck(next, opts.endpoint);

  if (next.hooks === undefined) next.hooks = {};

  for (const ev of events) {
    const entry = buildAttachEntry(opts.endpoint, ev, opts);
    const groups = next.hooks[ev] ?? [];
    // 既存の ActraDeck group を探す (冪等 in-place 更新)。purge 後なので canonical のみ残存。
    const existing = groups.find(groupHasActradeckEntry);
    if (existing) {
      // ActraDeck entry のみ差し替え (ユーザーが同 group に足した非マーカー hooks は温存)。
      const userHooks = (existing.hooks ?? []).filter((h) => !isActradeckEntry(h));
      existing.hooks = [...userHooks, entry];
    } else {
      // 新規 ActraDeck group を append (既存ユーザー group は触らない)。
      groups.push({ hooks: [entry] });
    }
    next.hooks[ev] = groups;
  }
  return { settings: next, events };
}

/**
 * dry-run プレビュー: マージ後の予定形と追加 events を返す (書き込まない)。
 *
 * SEC-2: dry-run は **意図的に lock 非取得** (read-only・write しない)。並行 merge 中は
 * 中間状態を読みうるが、これは概算プレビューゆえ許容する (実書き込みは mergeAttachHooks の
 * lock 下でのみ行われ、そこで lost-update を防ぐ)。
 */
export function previewAttachHooks(opts: MergeOptions): MergeResult {
  const current = readSettings(opts.settingsPath);
  const { settings, events } = computeMergedSettings(current, opts);
  return { wired: false, events, settings };
}

/**
 * atomic 書込 (tmp + rename) + 0600 試行 (project file は best-effort)。
 * fs-atomic.ts の共有ヘルパへ委譲する。dir mode は project file (.claude 等) の perms を
 * repo に委ねるため省略 (umask 既定)、rename 後の chmod 0600 は既存 file 上書き向けに試行。
 */
function atomicWrite(path: string, settings: ClaudeSettingsFile): void {
  writeJson0600(path, settings, { chmodAfter: true });
}

/**
 * Attach hooks をユーザー settings へ **非破壊 merge** する (実書き込み)。
 * - 既存ユーザー hooks 温存 (append) / 冪等 / backup / atomic / 0600 試行 / self-heal。
 * - 既に同一内容 (再 merge で変化なし) なら書き込まず wired=false を返す (無駄な backup を作らない)。
 *
 * INV-ATTACH-WIRE-LOCK: read→compute→write 全体を `withFileLock` で直列化する。
 * これにより systemctl restart 等で旧 detach と新 merge が重なっても lost update しない
 * (Step 1 で実証した「OBSERVED ZERO entries」窓を塞ぐ)。
 */
export function mergeAttachHooks(opts: MergeOptions): MergeResult {
  return withFileLock(
    opts.settingsPath,
    () => {
      const current = readSettings(opts.settingsPath);
      const { settings, events } = computeMergedSettings(current, opts);

      // 変化が無ければ no-op (冪等: 同一 merge を繰り返しても backup を量産しない)。
      const before = JSON.stringify(current);
      const after = JSON.stringify(settings);
      if (before === after) {
        return { wired: false, events, settings };
      }

      // backup: 既存 settings がある場合のみ作る (新規作成 settings には backup 不要)。
      // TDA-3: backup は単発 copy (tmp+rename 不要) のため fs-atomic helper 非対象。0600 のみ維持。
      let backupPath: string | undefined;
      if (existsSync(opts.settingsPath)) {
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        backupPath = `${opts.settingsPath}.actradeck-bak-${ts}`;
        const original = readFileSync(opts.settingsPath, "utf8");
        writeFileSync(backupPath, original, { encoding: "utf8", mode: 0o600 });
      }

      atomicWrite(opts.settingsPath, settings);
      return backupPath !== undefined
        ? { wired: true, backupPath, events, settings }
        : { wired: true, events, settings };
    },
    opts.lockOptions,
  );
}

export interface DetachResult {
  /** 何らかの ActraDeck entry を除去したか。 */
  readonly removed: boolean;
  /** detach 後の settings。 */
  readonly settings: ClaudeSettingsFile;
}

/**
 * settings から ActraDeck マーカー entry **のみ** を除去した settings を計算する (純関数)。
 * - ユーザー hooks は温存 (マーカー一致のみ除去)。
 * - ActraDeck group 内の非マーカー hooks (ユーザーが後から同 group に足したもの) は温存。
 * - hooks 群が空になった event キーは削除し、hooks 自体が空なら hooks キーも削除する。
 */
export function computeDetachedSettings(current: ClaudeSettingsFile): {
  settings: ClaudeSettingsFile;
  removed: boolean;
} {
  const next = clone(current);
  if (next.hooks === undefined) return { settings: next, removed: false };
  let removed = false;

  for (const ev of Object.keys(next.hooks)) {
    const groups = next.hooks[ev] ?? [];
    const cleaned: HookGroup[] = [];
    for (const group of groups) {
      if (!Array.isArray(group.hooks)) {
        cleaned.push(group);
        continue;
      }
      const kept = group.hooks.filter((h) => {
        if (isActradeckEntry(h)) {
          removed = true;
          return false; // ActraDeck entry のみ除去
        }
        return true; // ユーザー hooks は温存
      });
      // group 内に hooks が残ればその group を保持 (ユーザーが同 group に足した分を消さない)。
      if (kept.length > 0) {
        cleaned.push({ ...group, hooks: kept });
      } else if (!groupHasActradeckEntryOriginally(group)) {
        // 元々 ActraDeck entry を含まず、かつ空になった group は元の形のまま保持
        // (理論上 hooks:[] の空ユーザー group。改変しない)。
        cleaned.push(group);
      }
      // kept===0 かつ ActraDeck 由来の group → 丸ごと削除 (cleaned に積まない)。
    }
    if (cleaned.length > 0) {
      next.hooks[ev] = cleaned;
    } else {
      delete next.hooks[ev]; // 空になった event キーは削除
    }
  }
  if (Object.keys(next.hooks).length === 0) {
    delete next.hooks; // hooks が空なら hooks キー自体を削除 (元が {} 同等に戻る)
  }
  return { settings: next, removed };
}

/** group が (フィルタ前に) ActraDeck entry を含んでいたか。 */
function groupHasActradeckEntryOriginally(group: HookGroup): boolean {
  return Array.isArray(group.hooks) && group.hooks.some(isActradeckEntry);
}

/**
 * settings から ActraDeck hooks を **reversible に detach** する (実書き込み)。
 * マーカー entry のみ除去しユーザー hooks を温存する。変化が無ければ書き込まない。
 *
 * INV-ATTACH-WIRE-LOCK: merge と同じ lock で直列化し、並行 merge と detach が
 * 互いの read→compute→write を踏まないようにする (lost update 防止)。
 */
export function detachAttachHooks(
  settingsPath: string,
  lockOptions?: FileLockOptions,
): DetachResult {
  if (!existsSync(settingsPath)) return { removed: false, settings: {} };
  return withFileLock(
    settingsPath,
    () => {
      if (!existsSync(settingsPath)) return { removed: false, settings: {} };
      const current = readSettings(settingsPath);
      const { settings, removed } = computeDetachedSettings(current);
      if (!removed) return { removed: false, settings };
      atomicWrite(settingsPath, settings);
      return { removed: true, settings };
    },
    lockOptions,
  );
}
