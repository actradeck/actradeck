/**
 * file-lock — 汎用のプロセス間 advisory file lock (ADR: attach settings 配線 race 恒久対策)。
 *
 * 目的: `read → compute → write` を跨ぐ critical section を、複数プロセス
 * (systemctl restart で旧 detach と新 merge が重なる等) から **直列化**する。
 * settings 専用にせず汎用 API とする (再利用道具は汎用化する規律)。
 *
 * 設計:
 * - **pid を含む temp を書いてから `linkSync(tmp, lockPath)` で atomic に立てる** (旧: `openSync('wx')`
 *   で空ファイルを排他生成してから pid を追記していた)。`linkSync` は EEXIST で排他を保証しつつ、
 *   lockPath が **出現した瞬間から pid を含む** ため「作成済みだが pid 未書込 (holder===undefined)」の
 *   **空ファイル窓が存在しない**。取得後 temp は unlink する (lockPath が inode を保持)。
 * - 取得失敗 (EEXIST) 時は lockPath の pid を読み `process.kill(pid, 0)` で生存判定し、
 *   **死んでいれば stale とみなして奪取** (unlink → 再試行)。生存していれば短い backoff で retry。
 *   上限超過で **fail-loud (throw)** — 無言継続しない。
 * - finally で必ず unlink (自分が保持している lock のみ)。
 *
 * 空ファイル窓を閉じる理由 (QA・実プロセス回帰 INV-FILELOCK-NO-EMPTY-WINDOW): 旧 openSync 方式は
 * 「排他生成」と「pid 書込」が 2 syscall に分かれ、その間に契約者が deschedule されると lockPath が
 * **pid 無しで一瞬存在**する。CPU 逼迫下 (10 プロセス cold-start 競合等) でこの窓が広がると、別プロセスが
 * 空 lockPath を `holder===undefined`=stale と誤判定して奪取 → **二重保持 → lost-update** を起こす
 * (approval allowlist / policy 永続の直列化が破れる)。linkSync 方式は窓自体を消して構造的に閉じる。
 *
 * 非対象 (意図的): これは advisory lock。`linkSync`/`O_EXCL` は同一 fs 上で原子的だが、
 * NFS 等では保証が弱い。ActraDeck の settings は local fs 前提 (ADR 019ea476)。
 * **worker_threads 非対象 (SEC-3)**: stale 奪取は holder pid を自 pid と比較して「自分の残骸」を
 * 奪うため、同一 pid を共有する worker スレッド間では self-steal になり直列化が成立しない。本 lock は
 * **同期 fn 専用・別 pid のプロセス間直列化のみ**を対象とする (スレッド並走には使わない)。
 *
 * ACCEPTED-RISK (SEC-2 / ADR 019ea476): これは **advisory lock** であり、settings dir への
 * write 権を持つ主体間でのみ意味を持つ。pid 偽装耐性 (悪意ある holder が他 pid を詐称して
 * lock を奪う/保持し続ける) は **設計外**。前提は single-operator / local fs / loopback で、
 * その境界内では advisory 直列化で lost-update を防げば十分とする。
 *
 * 注入 seam (TDA-2/TDA-4): 本番呼び出しは **既定値のみ** を使う。`isAlive` / `sleep` /
 * `onLockAcquired` / `acquireDelayMs` は INV テスト (生存 holder の擬装・budget 計測・critical
 * section 内 read の pin・取得直後 deschedule 窓の実プロセス反証) 専用の差し替え点であり本番
 * コードパスでは渡さない (env `ACTRADECK_TEST_LOCK_ACQUIRE_DELAY_MS` も本番デーモンは設定しない)。
 */
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
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
  /**
   * テスト用 seam (本番未使用): **排他生成 (linkSync) 直後・fn 実行の前** に一度だけ ms だけ sleep する。
   * INV-FILELOCK-NO-EMPTY-WINDOW が実プロセス並走下で「排他生成した契約者が deschedule されても、
   * 別プロセスが二重取得しない」ことを falsifiable に pin するための注入点。linkSync 方式では取得完了時に
   * lockPath は既に pid を持つため、この位置の遅延は安全 (単一保持を維持)。旧 openSync 方式では同じ位置が
   * 「排他生成 (openSync) と pid 書込の間」に相当し、遅延で空ファイル窓が広がって二重取得 → lost-update に
   * なる (= mutation 反証点)。cross-process worker へは env で伝えるため env 経由でも読む
   * (`ACTRADECK_TEST_LOCK_ACQUIRE_DELAY_MS`)。本番デーモンはこの env を設定しない。
   * SEC-1: env 経路は **test モード (NODE_ENV==="test" / VITEST) 時のみ honor** し、値は 60s に
   * clamp する (本番で env が漏れても取得遅延を注入できない)。opts 明示値も同じく 60s に clamp。
   */
  readonly acquireDelayMs?: number;
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
  // テスト用 acquire 遅延 (本番未設定)。opts 明示 > env > 0。cross-process worker は env で受ける。
  // SEC-1: env 経路は **test モード時のみ** honor する (NODE_ENV==="test" / VITEST)。本番
  //   (NODE_ENV=production) では ACTRADECK_TEST_LOCK_ACQUIRE_DELAY_MS を無視し、万一 env が漏れても
  //   取得遅延を注入できない。値は sane 上限 60s に clamp し (非有限は 0)、DoS/暴走遅延を防ぐ。
  //   INV-FILELOCK-NO-EMPTY-WINDOW の spawn worker は vitest 由来の NODE_ENV=test / VITEST を継承する
  //   ため引き続き honor される。
  const envDelayHonored = process.env.NODE_ENV === "test" || Boolean(process.env.VITEST);
  const rawAcquireDelayMs =
    opts.acquireDelayMs ??
    (envDelayHonored && process.env.ACTRADECK_TEST_LOCK_ACQUIRE_DELAY_MS
      ? Number(process.env.ACTRADECK_TEST_LOCK_ACQUIRE_DELAY_MS)
      : 0);
  const acquireDelayMs = Number.isFinite(rawAcquireDelayMs)
    ? Math.min(Math.max(0, rawAcquireDelayMs), 60_000)
    : 0;

  // lock file の親ディレクトリを保証する (初回配線で .claude/ が未作成のことがある)。
  // settings 本体の atomicWrite も mkdir するが、lock は本体 write より前に取るため
  // ここで先に作らないと linkSync が ENOENT になる。
  mkdirSync(dirname(lockPath), { recursive: true });

  // pid を含む temp を書き、linkSync で lockPath へ atomic に立てる。
  // linkSync 成功の瞬間から lockPath は pid を持つ (空ファイル窓なし)。temp は同一 dir・自 pid 名で衝突しない。
  const tmpPath = `${lockPath}.${process.pid}.acquire`;
  try {
    // QA-3/TDA-5: writeFileSync は try 内で行う。ENOSPC/EACCES で途中 throw しても finally が
    //   残骸 tmp を掃除する (旧: try の外にあり、write 途中失敗で 0-byte tmp が残りえた)。
    writeFileSync(tmpPath, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
    let attempts = 0;
    // 取得ループ: linkSync 排他生成で取得、失敗 (EEXIST) 時は stale 奪取 or backoff。
    for (;;) {
      try {
        linkSync(tmpPath, lockPath);
        // 取得成功。lockPath は既に pid を持つ (linkSync は content-complete)。
        // テスト seam (本番未使用): 排他生成直後・fn 前の deschedule 窓を模す。linkSync 方式では
        // 取得完了時に pid が在るため安全 = 二重取得しないことを実プロセスで falsifiable に pin する。
        if (acquireDelayMs > 0) sleep(acquireDelayMs);
        // テスト seam: lock 取得直後・fn 実行の前に一度だけ呼ぶ
        // (本番未使用。critical section 内 read を pin する INV のための注入点)。
        opts.onLockAcquired?.();
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        // 既存 lock。保持者の生存を確認。
        const holder = readLockPid(lockPath);
        if (holder === undefined || holder === process.pid || !isAlive(holder)) {
          // stale (壊れた lock / 自分の残骸 / 保持者が死亡) → 奪取。
          // race: 別プロセスも同時に奪取しうるが、unlink 後の linkSync が
          // 再び排他生成を保証する (奪取の勝者は 1 つ)。
          try {
            unlinkSync(lockPath);
          } catch {
            /* 既に他者が unlink/奪取済 → 次ループの linkSync で再判定 */
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
  } finally {
    // temp は用済み: link 済みなら lockPath が inode を保持、未取得 throw でも残骸を掃除。
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best-effort */
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
  }
}
