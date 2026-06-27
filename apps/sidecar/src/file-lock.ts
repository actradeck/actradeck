/**
 * file-lock — 汎用のプロセス間 advisory file lock (ADR: attach settings 配線 race 恒久対策)。
 *
 * 目的: `read → compute → write` を跨ぐ critical section を、複数プロセス
 * (systemctl restart で旧 detach と新 merge が重なる等) から **直列化**する。
 * settings 専用にせず汎用 API とする (再利用道具は汎用化する規律)。
 *
 * 設計:
 * - `openSync(lockPath, 'wx', 0o600)` で **排他生成**して取得 (O_CREAT|O_EXCL)。
 *   既存ならば取得失敗 = 他者が保持中。
 * - lock file には holder の pid を書く。取得失敗時は中の pid を読み
 *   `process.kill(pid, 0)` で生存判定し、**死んでいれば stale とみなして奪取** (unlink → 再試行)。
 *   生存していれば短い backoff で retry。上限超過で **fail-loud (throw)** — 無言継続しない。
 * - finally で必ず unlink (自分が保持している lock のみ)。
 *
 * 非対象 (意図的): これは advisory lock。`O_EXCL` は同一 fs 上で原子的だが、
 * NFS 等では保証が弱い。ActraDeck の settings は local fs 前提 (ADR 019ea476)。
 *
 * ACCEPTED-RISK (SEC-2 / ADR 019ea476): これは **advisory lock** であり、settings dir への
 * write 権を持つ主体間でのみ意味を持つ。pid 偽装耐性 (悪意ある holder が他 pid を詐称して
 * lock を奪う/保持し続ける) は **設計外**。前提は single-operator / local fs / loopback で、
 * その境界内では advisory 直列化で lost-update を防げば十分とする。
 *
 * 注入 seam (TDA-2/TDA-4): 本番呼び出しは **既定値のみ** を使う。`isAlive` / `sleep` /
 * `onLockAcquired` は INV テスト (生存 holder の擬装・budget 計測・critical section 内 read の
 * pin) 専用の差し替え点であり本番コードパスでは渡さない。
 */
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** lock 取得の調整オプション (既定は settings 配線向けに保守的)。 */
export interface FileLockOptions {
  /** lock file パス (既定: `${targetPath}.actradeck-lock`)。 */
  readonly lockPath?: string;
  /** 取得 retry 上限回数 (超過で throw)。既定 100。 */
  readonly maxRetries?: number;
  /** retry 間隔の基準 ms。既定 20ms (実 sleep は Atomics.wait でスレッドをブロック)。 */
  readonly retryDelayMs?: number;
  /** stale 判定に使う pid 生存チェック (テスト差し替え用)。既定 process.kill(pid,0)。 */
  readonly isAlive?: (pid: number) => boolean;
  /** backoff の sleep 実装 (テスト差し替え用)。既定: Atomics.wait 同期 sleep (ms 単位)。 */
  readonly sleep?: (ms: number) => void;
  /**
   * テスト用 seam (本番未使用): lock 取得成功 + 自 pid 書込の直後・`fn()` 実行の前に
   * 一度だけ呼ばれる。INV テストが「read が critical section 内で行われる」(直前 holder が
   * commit した状態を読む) ことを falsifiable に pin するために、ここでディスク状態を
   * 差し込む。本番呼び出しは渡さない。
   */
  readonly onLockAcquired?: () => void;
}

/** 既定の pid 生存判定 (signal 0)。EPERM=存在 (権限なし) は生存扱い。 */
function defaultIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 既定の同期 sleep。`Atomics.wait` で「決して通知されない」 SharedArrayBuffer 上で
 * `ms` だけブロックする (timeout で戻る)。CPU を焼く busy-wait を避けつつ同期 I/O
 * (settings の read→compute→write) と同じ同期コンテキストで待てる。
 * worst-case の待ち時間は ≈ `maxRetries × retryDelayMs` だが Atomics.wait で CPU 非消費。
 */
function defaultSleep(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** lock file から保持者 pid を読む (壊れていれば undefined)。 */
function readLockPid(lockPath: string): number | undefined {
  try {
    const raw = readFileSync(lockPath, "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `targetPath` に対応する lock を取得し `fn()` を実行、終了時に必ず解放する。
 * 同期 fn 専用 (settings の read→compute→write は同期 I/O)。fn の戻り値を返す。
 *
 * @throws lock を maxRetries 以内に取得できなかったとき (fail-loud)。
 */
export function withFileLock<T>(targetPath: string, fn: () => T, opts: FileLockOptions = {}): T {
  const lockPath = opts.lockPath ?? `${targetPath}.actradeck-lock`;
  const maxRetries = opts.maxRetries ?? 100;
  const retryDelayMs = opts.retryDelayMs ?? 20;
  const isAlive = opts.isAlive ?? defaultIsAlive;
  const sleep = opts.sleep ?? defaultSleep;

  // lock file の親ディレクトリを保証する (初回配線で .claude/ が未作成のことがある)。
  // settings 本体の atomicWrite も mkdir するが、lock は本体 write より前に取るため
  // ここで先に作らないと openSync('wx') が ENOENT になる。
  mkdirSync(dirname(lockPath), { recursive: true });

  let fd: number | undefined;
  let attempts = 0;
  // 取得ループ: O_EXCL 生成で取得、失敗時は stale 奪取 or backoff。
  for (;;) {
    try {
      fd = openSync(lockPath, "wx", 0o600);
      // 取得成功: 自 pid を書く (stale 判定の根拠)。
      writeFileSync(fd, `${process.pid}\n`, { encoding: "utf8" });
      // テスト seam: lock 取得 + 自 pid 書込の直後・fn 実行の前に一度だけ呼ぶ
      // (本番未使用。critical section 内 read を pin する INV のための注入点)。
      opts.onLockAcquired?.();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // 既存 lock。保持者の生存を確認。
      const holder = readLockPid(lockPath);
      if (holder === undefined || holder === process.pid || !isAlive(holder)) {
        // stale (保持者が死亡 / 壊れた lock / 自分の残骸) → 奪取。
        // race: 別プロセスも同時に奪取しうるが、unlink 後の openSync('wx') が
        // 再び排他生成を保証する (奪取の勝者は 1 つ)。
        try {
          unlinkSync(lockPath);
        } catch {
          /* 既に他者が unlink/奪取済 → 次ループの openSync で再判定 */
        }
        continue; // delay を挟まず即再試行 (stale 奪取は速やかに)
      }
      // 生存保持者あり → backoff retry。
      attempts += 1;
      if (attempts > maxRetries) {
        throw new Error(
          `withFileLock: failed to acquire ${lockPath} after ${maxRetries} retries ` +
            `(held by live pid ${holder}). aborting to avoid corrupting ${targetPath}.`,
        );
      }
      sleep(retryDelayMs);
    }
  }

  try {
    return fn();
  } finally {
    // 自分が保持している lock のみ解放 (奪取された後に他者の lock を消さない)。
    try {
      const holder = readLockPid(lockPath);
      if (holder === undefined || holder === process.pid) {
        unlinkSync(lockPath);
      }
    } catch {
      /* best-effort 解放。既に消えていれば無視。 */
    }
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort */
      }
    }
  }
}
