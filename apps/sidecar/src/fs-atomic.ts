/**
 * fs-atomic — 0600 atomic JSON 書込/読取の共有ヘルパ (TDA-1 consolidation・sweep 019ee0ec)。
 *
 * daemon-state.ts / approval-allowlist-store.ts / settings-merge.ts に散在していた
 * 「tmp 書込 → 同一 fs 内 rename (atomic) → mode 0600」パターンを 1 箇所へ集約する。
 * 元コードはコメントで明示的に「daemon-state.ts と同型」と相互参照しており、ドリフト源だった。
 *
 * セキュリティ不変条件 (security.md・ファイル権限):
 * - secret/token を含みうる state file は **必ず 0600** で生成する (group/other 読取不可)。
 * - tmp + rename で **partial write を可視化しない** (rename は同一 fs 内 atomic)。
 * - tmp 名は pid + プロセス内単調カウンタで衝突回避する (同一プロセスの連続/並走書込でも衝突せず、
 *   元実装の Date.now()/entries.length 由来の弁別より堅牢。tmp 名は即 rename され外部契約でない)。
 *
 * 非対象 (意図的):
 * - codex-rollout-tailer.ts の offset state は **secret を含まない**ため 0600 を課さない (素の atomic write)。
 * - file-lock.ts は `openSync(lockPath, 'wx', 0o600)` の **排他生成 (O_CREAT|O_EXCL)** で目的が異なる。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** プロセス内単調カウンタ (tmp 名の弁別子)。時間/件数に依存せず衝突しない。 */
let tmpCounter = 0;

export interface WriteJson0600Options {
  /**
   * 親ディレクトリ作成時の mode。daemon state / approvals dir は 0o700 を渡す。
   * project file (.claude 等) のように dir perms を repo に委ねる場合は省略 (umask 既定)。
   */
  readonly dirMode?: number;
  /**
   * rename 後に本体へ chmod 0600 を best-effort で試行する。
   * 既存 file の perms を引き継ぐ環境 (project file 上書き) 向け。失敗は握り潰す。
   */
  readonly chmodAfter?: boolean;
}

/**
 * 値を JSON 化し **0600 で atomic 書込**する (mkdir parent → tmp 書込 0600 → rename)。
 * 出力は `${JSON.stringify(value, null, 2)}\n` (末尾改行) で元実装と一致。
 */
export function writeJson0600(path: string, value: unknown, opts: WriteJson0600Options = {}): void {
  const dir = dirname(path);
  if (opts.dirMode !== undefined) {
    mkdirSync(dir, { recursive: true, mode: opts.dirMode });
  } else {
    mkdirSync(dir, { recursive: true });
  }
  tmpCounter += 1;
  const tmp = `${path}.tmp-${process.pid}-${tmpCounter}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path); // rename は同一 fs 内 atomic。
  if (opts.chmodAfter === true) {
    try {
      chmodSync(path, 0o600);
    } catch {
      /* best-effort: 既存 file の perms は環境依存 (loopback + token 非リテラルで二重防御済) */
    }
  }
}

/**
 * file を読み JSON.parse し、**non-null かつ非配列の object** なら返す。
 * 無し / 空でない不正 JSON / 非オブジェクト / 配列 はすべて undefined (fail-safe)。
 * ドメイン妥当性 (必須フィールド等) の検証は呼び元が行う。
 *
 * 配列を undefined に倒すのは元 2 実装と観測等価 (どちらも配列はドメイン検証で弾かれ
 * 既定値に縮退していた) で、かつ「object を返す」契約を明確化する。
 */
export function readJsonObject(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
