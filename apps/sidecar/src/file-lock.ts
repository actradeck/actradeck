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
 *   lockPath が **出現した瞬間から pid を含む** ため「作成済みだが pid 未書込」の
 *   **空ファイル窓が存在しない**。取得後 temp は unlink する (lockPath が inode を保持)。
 * - 取得失敗 (EEXIST) 時は lockPath を **3 値** で観測する (`absent` / `corrupt` / `pid`)。
 *   - `absent` (ENOENT) は **stale ではなく「解放直後」**。unlink せず delay 無しで即 re-link 再試行する。
 *   - `corrupt` / 自分の残骸 / 死亡 pid は stale。ただし **unlink では取り外さない**（下記）。
 *   - 生存 pid なら短い backoff で retry し、上限超過で **fail-loud (throw)** — 無言継続しない。
 * - finally で必ず unlink (自分が保持している lock のみ)。
 *
 * **奪取は「同一性を保った取り外し」で行う (stale 奪取 TOCTOU の構造修正)**: 旧実装は
 * 「holder を読む → stale と判定 → `unlinkSync(lockPath)`」が非原子で、判定と unlink の間に
 * 前保持者 A が解放し別プロセス C が新しい lock を立てると、**C の生きた lock を消して**しまい
 * C と自分 (または後続の D) が二重に critical section へ入る = lost-update を起こした
 * (PR #46 CI run 33187020993 の INV-FILELOCK-NO-EMPTY-WINDOW 8→7 の実観測)。
 * 現行は `renameSync(lockPath, ${lockPath}.stale-<pid>-<seq>)` で **原子的に取り外してから**、
 * 取り外したファイルの内容が判定時に読んだ逐語内容と**一致するときだけ** unlink する。
 * 一致しなければ「別プロセスの生きた lock を外した」ので `linkSync` で元へ**復元**して backoff retry
 * する。復元できない (EEXIST 等) なら **fail-loud (throw)** — 二重保持のまま無言継続しない。
 * `unlink` は「奪取の勝者は 1 つ」しか保証しないが、`rename` + 内容再検証は
 * **消すのが本当に自分が判定したその lock か** を保証する (勝者が 1 つでも、消す対象が
 * 生きた別 lock なら直列化は破れる)。
 *
 * 空ファイル窓を閉じる理由 (QA・実プロセス回帰 INV-FILELOCK-NO-EMPTY-WINDOW): 旧 openSync 方式は
 * 「排他生成」と「pid 書込」が 2 syscall に分かれ、その間に契約者が deschedule されると lockPath が
 * **pid 無しで一瞬存在**する。CPU 逼迫下 (10 プロセス cold-start 競合等) でこの窓が広がると、別プロセスが
 * 空 lockPath を stale と誤判定して奪取 → **二重保持 → lost-update** を起こす
 * (approval allowlist / policy 永続の直列化が破れる)。linkSync 方式は窓自体を消して構造的に閉じる。
 *
 * 非対象 (意図的): これは advisory lock。`linkSync`/`O_EXCL`/`rename` は同一 fs 上で原子的だが、
 * NFS 等では保証が弱い。ActraDeck の settings は local fs 前提 (ADR 019ea476)。
 * **worker_threads 非対象 (SEC-3)**: stale 奪取は holder pid を自 pid と比較して「自分の残骸」を
 * 奪うため、同一 pid を共有する worker スレッド間では self-steal になり直列化が成立しない。本 lock は
 * **同期 fn 専用・別 pid のプロセス間直列化のみ**を対象とする (スレッド並走には使わない)。
 *
 * ACCEPTED-RISK (SEC-2 / ADR 019ea476): これは **advisory lock** であり、settings dir への
 * write 権を持つ主体間でのみ意味を持つ。pid 偽装耐性 (悪意ある holder が他 pid を詐称して
 * lock を奪う/保持し続ける) は **設計外**。前提は single-operator / local fs / loopback で、
 * その境界内では advisory 直列化で lost-update を防げば十分とする。
 * 内容再検証も同じ境界内でのみ意味を持つ (holder が自分の pid を書き換えて偽装する系は非対象)。
 *
 * 注入 seam (TDA-2/TDA-4): 本番呼び出しは **既定値のみ** を使う。`isAlive` / `sleep` /
 * `onLockAcquired` / `acquireDelayMs` / `onLockContended` / `onHolderObserved` は INV テスト
 * (生存 holder の擬装・budget 計測・critical section 内 read の pin・取得直後 deschedule 窓と
 * stale 奪取 TOCTOU の実プロセス反証) 専用の差し替え点であり本番コードパスでは渡さない
 * (env `ACTRADECK_TEST_LOCK_ACQUIRE_DELAY_MS` も本番デーモンは設定しない)。
 */
import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * lock file の観測結果 (3 値)。`raw` は **取り外し後の同一性再検証**に使う逐語内容
 * (pid へ正規化した値ではなく生バイト列で比べる: 同じ pid を書き直した別 lock も別物として扱う)。
 */
type LockHolder =
  | { readonly kind: "absent" }
  | { readonly kind: "corrupt"; readonly raw: string }
  | { readonly kind: "pid"; readonly pid: number; readonly raw: string };

/** `onHolderObserved` seam へ渡す観測種別 (テスト専用の公開型・原文非依存)。 */
export type LockHolderKind = LockHolder["kind"];

/**
 * lock が free ↔ held を無限に往復した場合の fail-loud 上限。
 * `absent` / 奪取成功は backoff を挟まず即再試行するため、これが無いと病的な状況で
 * 無言の busy-loop になりうる。到達したら throw する (無言継続しない)。
 */
const MAX_CONTENTION_SPINS = 1000;

/** 奪取 (stale 取り外し) の結果。 */
type TakeoverResult =
  /** 判定した lock を原子的に取り外して破棄した。即再試行してよい。 */
  | "removed"
  /** 取り外す前に他者が先に取り外していた (rename が ENOENT)。即再試行してよい。 */
  | "gone"
  /** 取り外したものが判定した lock と別物だった。復元済み → backoff retry すべき。 */
  | "restored";

/** 自プロセス内の奪取シーケンス番号 (stale 退避名の衝突回避)。 */
let staleSeq = 0;

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
  /**
   * テスト用 seam (本番未使用): 取得が EEXIST で競合したとき、**保持者を読む前**に毎回呼ばれる。
   * INV-FILELOCK-STALE-TAKEOVER-IDENTITY が「保持者を読む直前に前保持者が解放する」窓
   * (= readLockHolder が `absent` を返す ENOENT 経路) を実プロセスで決定的に作るための注入点。
   * 本番呼び出しは渡さない。
   */
  readonly onLockContended?: () => void;
  /**
   * テスト用 seam (本番未使用): 保持者を読んだ**直後・奪取/backoff を決める前**に、観測種別
   * (`absent` / `corrupt` / `pid`) を伴って毎回呼ばれる。判定と取り外しの間に別プロセスが lock を
   * 立て直す TOCTOU を実プロセスで決定的に作るための注入点。本番呼び出しは渡さない。
   */
  readonly onHolderObserved?: (kind: LockHolderKind) => void;
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

/**
 * lock file を 3 値で観測する。
 * - ENOENT → `absent` (**解放直後**。「壊れた lock」と混同しない)。
 * - 読めたが pid でない → `corrupt`。
 * - 読めて pid → `pid`。
 *
 * ENOENT 以外の read 失敗 (EISDIR / EACCES 等) は **rethrow** して fail-loud にする。
 * 内容が読めない lock は同一性を再検証できず、奪取してよいか判断できないため
 * (旧実装は全 error を `undefined`= stale 扱いにして奪取していた)。
 */
function readLockHolder(lockPath: string): LockHolder {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    throw err;
  }
  const pid = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(pid) && pid > 0 ? { kind: "pid", pid, raw } : { kind: "corrupt", raw };
}

/** 判定時に読んだ lock と、取り外した lock が **同一内容** か (absent は同一とみなさない)。 */
function sameLockContent(observed: LockHolder, detached: LockHolder): boolean {
  return observed.kind !== "absent" && detached.kind !== "absent" && observed.raw === detached.raw;
}

/**
 * stale と判定した lock を **原子的に取り外し**、取り外したものが本当に判定した lock かを
 * 内容で再検証してから破棄する。別物 (= 判定と取り外しの間に他プロセスが立て直した生きた lock)
 * だったら元へ復元し、呼び出し側へ `"restored"` を返して backoff させる。
 *
 * @throws 復元できなかったとき (fail-loud・二重保持のまま無言継続しない)。
 */
function detachStaleLock(lockPath: string, observed: LockHolder): TakeoverResult {
  const stalePath = `${lockPath}.stale-${process.pid}-${staleSeq++}`;
  try {
    renameSync(lockPath, stalePath);
  } catch (err) {
    // 他者が先に取り外した → 何も壊していない。即再試行させる。
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "gone";
    throw err;
  }
  let removed = false;
  try {
    if (sameLockContent(observed, readLockHolder(stalePath))) {
      unlinkSync(stalePath);
      removed = true;
      return "removed";
    }
    // 判定 → rename の間に内容が変わった = 別プロセスの**生きた** lock を外してしまった。復元する。
    try {
      linkSync(stalePath, lockPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "unknown";
      throw new Error(
        `withFileLock: detached ${lockPath} as stale but its content changed in between, ` +
          `and restoring the live holder failed (${code}). ` +
          `aborting to avoid double-holding the lock.`,
        { cause: err },
      );
    }
    return "restored";
  } finally {
    // 退避名の残骸を残さない (復元済みなら余分な link、復元失敗なら孤児 inode)。
    if (!removed) {
      try {
        unlinkSync(stalePath);
      } catch {
        /* best-effort */
      }
    }
  }
}

/**
 * `targetPath` に対応する lock を取得し `fn()` を実行、終了時に必ず解放する。
 * 同期 fn 専用 (settings の read→compute→write は同期 I/O)。fn の戻り値を返す。
 *
 * @throws lock を maxRetries 以内に取得できなかったとき (fail-loud)。
 * @throws stale と判定して取り外した lock を復元できなかったとき (fail-loud)。
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
    let spins = 0;
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
        // テスト seam (本番未使用): 保持者を読む前の窓。
        opts.onLockContended?.();
        // 既存 lock を 3 値で観測する。
        const holder = readLockHolder(lockPath);
        // テスト seam (本番未使用): 判定 → 取り外しの間の窓。
        opts.onHolderObserved?.(holder.kind);

        // `absent` は stale ではなく **解放直後**。ここで unlink すると、この窓の内に
        // 別プロセスが立てた**生きた** lock を消してしまう (旧実装の TOCTOU)。何も消さず即再試行する。
        // `pid`/`corrupt` が stale なら rename で取り外し、内容一致を再検証してから破棄する。
        let retryWithoutDelay = false;
        if (holder.kind === "absent") {
          retryWithoutDelay = true;
        } else if (
          holder.kind === "corrupt" ||
          holder.pid === process.pid ||
          !isAlive(holder.pid)
        ) {
          // "restored" は「判定した stale ではなく他者の生きた lock だった」= backoff すべき。
          retryWithoutDelay = detachStaleLock(lockPath, holder) !== "restored";
        }

        if (retryWithoutDelay) {
          // delay を挟まず即再試行 (解放直後 / stale 奪取は速やかに)。病的な flapping は fail-loud。
          spins += 1;
          if (spins > MAX_CONTENTION_SPINS) {
            throw new Error(
              `withFileLock: ${lockPath} kept flapping between free and stale for ` +
                `${MAX_CONTENTION_SPINS} immediate retries. ` +
                `aborting to avoid corrupting ${targetPath}.`,
            );
          }
          continue;
        }

        // 生存保持者あり (または復元した他者の lock) → backoff retry。
        attempts += 1;
        if (attempts > maxRetries) {
          throw new Error(
            `withFileLock: failed to acquire ${lockPath} after ${maxRetries} retries ` +
              `(held by live pid ${holder.kind === "pid" ? holder.pid : "unknown"}). ` +
              `aborting to avoid corrupting ${targetPath}.`,
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
    // absent = 既に消えている → 何もしない。corrupt = 自分が立てた lock が壊された残骸とみなし掃除する。
    try {
      const holder = readLockHolder(lockPath);
      if (holder.kind === "corrupt" || (holder.kind === "pid" && holder.pid === process.pid)) {
        unlinkSync(lockPath);
      }
    } catch {
      /* best-effort 解放。既に消えていれば無視。 */
    }
  }
}
