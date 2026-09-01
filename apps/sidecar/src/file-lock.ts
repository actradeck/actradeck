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
 * - 解放も **取得と同じ「rename → 同一性再検証 → unlink」** で行う (下記 identity v2)。
 *
 * **奪取も解放も「同一性を保った取り外し」で行う (TOCTOU の構造修正)**: 旧実装は
 * 「holder を読む → stale と判定 → `unlinkSync(lockPath)`」が非原子で、判定と unlink の間に
 * 前保持者 A が解放し別プロセス C が新しい lock を立てると、**C の生きた lock を消して**しまい
 * C と自分 (または後続の D) が二重に critical section へ入る = lost-update を起こした
 * (PR #46 CI run 33187020993 の INV-FILELOCK-NO-EMPTY-WINDOW 8→7 の実観測)。
 * 現行は `renameSync(lockPath, ${lockPath}.stale-<pid>-<seq>)` で **原子的に取り外してから**、
 * 取り外したファイルが判定した当のファイルであるときだけ unlink する。
 * 別物なら `linkSync` で元へ**復元**して backoff retry する。復元できない (EEXIST 等) なら
 * **fail-loud (throw)** — 二重保持のまま無言継続しない。このとき取り外した inode は
 * **退避名のまま残す** (victim の lock を破棄しない・下記 identity v2 (3))。
 * `unlink` は「奪取の勝者は 1 つ」しか保証しないが、`rename` + 再検証は
 * **消すのが本当に自分が判定したその lock か** を保証する (勝者が 1 つでも、消す対象が
 * 生きた別 lock なら直列化は破れる)。
 *
 * **identity v2 (task 01a052e3 T1(b)/T2・FL-B / FL-C / FL-D)**: 同一性の粒度を
 * 生バイト列 (= lock 内容が常に `${pid}\n` である以上、実質 **pid 粒度**) から
 * **`(dev, ino)` = lock インスタンス粒度**へ上げる。
 *   1. 取得時に自分が立てた inode の `(dev, ino)` を保持する (`heldIdentity`)。
 *   2. 奪取の再検証は **`(dev, ino)` 一致 かつ 逐語バイト一致** の連言。バイト比較は補助として
 *      残す (軸削除禁止)。これにより「同じバイト列を持つ別 inode」(前保持者が解放して即再取得した、
 *      pid が再利用された 等) を破棄しなくなる。
 *   3. 解放も `renameSync` → `(dev, ino)` 再検証 → `unlink` で原子化する (旧: read → 判定 → unlink の
 *      非原子・SEC-FL-3)。自 lock 判定は identity を主・内容を補助にする:
 *      identity 不一致なら触らない / identity 一致かつ内容が自分 (or corrupt) なら外す /
 *      identity 一致だが**内容が読めない** (EACCES / EISDIR) なら **identity を信じて外す**。
 *      最後の枝が SEC-FL-1 の恒久 wedge の回復経路 — `statSync` は読み権限を要さないため、
 *      自分が保持中に lock が読めなくなっても解放できる (取得側は従来どおり読めない lock を
 *      奪取せず即 fail-loud のまま = 他人の lock を盲目的に奪わない)。
 *      identity 一致だが内容が**読めて別 pid** の場合は「自分の inode を第三者が書き換えた」
 *      とみなし触らない (既存軸「他者の lock を消さない」の保存)。
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
 * 同一性再検証も同じ境界内でのみ意味を持つ (holder が自分の pid を書き換えて偽装する系は非対象)。
 *
 * 注入 seam (TDA-FL-2 / SEC-FL-7): テスト用の差し替え点は **単一の `testHooks`** に集約してある。
 * 本番向けの {@link FileLockOptions} は `lockPath` / `maxRetries` / `retryDelayMs` の 3 つだけで、
 * seam へは型の上でも到達しない。さらに `testHooks` を渡せるのは **test モード
 * (`NODE_ENV==="test"` / `VITEST`) のときだけ**で、本番モードで渡すと **throw** する
 * (= 将来 `isAlive: () => false` を本番経路が渡しても CI 信号ゼロで stale 判定が無効化されることはない)。
 * env `ACTRADECK_TEST_LOCK_ACQUIRE_DELAY_MS` も同じ test モード gate + 60s clamp 配下。
 */
import {
  closeSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * lock file の同一性 (`(dev, ino)`)。**読み権限を要さない** (`statSync` のみ) ため、
 * 内容が読めなくなった自 lock でも「自分が立てた inode か」を判定できる。
 */
interface LockIdentity {
  readonly dev: number;
  readonly ino: number;
}

/**
 * lock file の観測結果 (3 値)。`raw` は **取り外し後の同一性再検証**に使う逐語内容、
 * `identity` は同じ観測で得た `(dev, ino)`。
 *
 * **粒度 (identity v2・TDA-FL-1 / SEC-FL-4 / QA-FL-3)**: 再検証は `identity` 一致 **かつ**
 * `raw` 一致の連言で行う。`raw` だけの比較は lock 内容が常に `${pid}\n` である以上
 * 実質 pid 粒度で、同一 pid が鋳造した別 lock を区別できなかった。`identity` は
 * lock インスタンス粒度なので、良性の pid 再利用・解放直後の再取得も区別できる。
 * ADR 0012 の out-of-scope は pid **偽装**のみ (identity も偽装耐性は持たない)。
 */
type LockHolder =
  | { readonly kind: "absent" }
  | { readonly kind: "corrupt"; readonly raw: string; readonly identity: LockIdentity }
  | {
      readonly kind: "pid";
      readonly pid: number;
      readonly raw: string;
      readonly identity: LockIdentity;
    };

/** 実在した lock の観測 (`absent` を除いた 2 値)。奪取判断はこれだけを受ける。 */
type PresentLock = Extract<LockHolder, { kind: "corrupt" | "pid" }>;

/** `onHolderObserved` seam へ渡す観測種別 (原文非依存・module 内部型)。 */
type LockHolderKind = LockHolder["kind"];

/** `onDetached` seam へ渡す取り外しの局面 (原文非依存・closed enum)。 */
type DetachPhase = "takeover" | "release";

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
/** 自プロセス内の解放シーケンス番号 (奪取側と別カウンタ = 奪取側の決定性を汚さない)。 */
let releaseSeq = 0;

/** lock 取得の調整オプション (**本番向けはこれだけ**・既定は settings 配線向けに保守的)。 */
export interface FileLockOptions {
  /** lock file パス (既定: `${targetPath}.actradeck-lock`)。 */
  readonly lockPath?: string;
  /** 取得 retry 上限回数 (超過で throw)。既定 100。 */
  readonly maxRetries?: number;
  /** retry 間隔の基準 ms。既定 20ms (実 sleep は Atomics.wait でスレッドをブロック)。 */
  readonly retryDelayMs?: number;
}

/**
 * **テスト専用**の注入 seam 束 (本番未使用)。
 *
 * 本番モード (`NODE_ENV!=="test"` かつ `VITEST` 未設定) で渡すと {@link withFileLock} が
 * **throw** する。「本番が誤って seam を渡すと CI 信号ゼロで lock 意味論が弱まる」
 * (TDA-FL-2 / SEC-FL-7) を、綴り走査ではなく**実行可能なゲート**で塞ぐための設計。
 */
export interface FileLockTestHooks {
  /** stale 判定に使う pid 生存チェック。既定 `process.kill(pid, 0)`。 */
  readonly isAlive?: (pid: number) => boolean;
  /** backoff の sleep 実装。既定: `Atomics.wait` 同期 sleep (ms 単位)。 */
  readonly sleep?: (ms: number) => void;
  /**
   * **排他生成 (linkSync) 直後・fn 実行の前** に一度だけ ms だけ sleep する。
   * INV-FILELOCK-NO-EMPTY-WINDOW が実プロセス並走下で「排他生成した契約者が deschedule されても、
   * 別プロセスが二重取得しない」ことを falsifiable に pin するための注入点。linkSync 方式では取得完了時に
   * lockPath は既に pid を持つため、この位置の遅延は安全 (単一保持を維持)。旧 openSync 方式では同じ位置が
   * 「排他生成 (openSync) と pid 書込の間」に相当し、遅延で空ファイル窓が広がって二重取得 → lost-update に
   * なる (= mutation 反証点)。cross-process worker へは env で伝えるため env 経由でも読む
   * (`ACTRADECK_TEST_LOCK_ACQUIRE_DELAY_MS`)。本番デーモンはこの env を設定しない。
   * SEC-1: env 経路は **test モード時のみ honor** し、値は 60s に clamp する。opts 明示値も同じく clamp。
   */
  readonly acquireDelayMs?: number;
  /**
   * lock 取得成功 + 自 pid 書込の直後・`fn()` 実行の前に一度だけ呼ばれる。
   * INV テストが「read が critical section 内で行われる」(直前 holder が commit した状態を読む)
   * ことを falsifiable に pin するために、ここでディスク状態を差し込む。
   */
  readonly onLockAcquired?: () => void;
  /**
   * 取得が EEXIST で競合したとき、**保持者を読む前**に毎回呼ばれる。
   * INV-FILELOCK-STALE-TAKEOVER-IDENTITY が「保持者を読む直前に前保持者が解放する」窓
   * (= readLockHolder が `absent` を返す ENOENT 経路) を実プロセスで決定的に作るための注入点。
   */
  readonly onLockContended?: () => void;
  /**
   * 保持者を読んだ**直後・奪取/backoff を決める前**に、観測種別 (`absent` / `corrupt` / `pid`)
   * を伴って毎回呼ばれる。判定と取り外しの間に別プロセスが lock を立て直す TOCTOU を
   * 実プロセスで決定的に作るための注入点。
   */
  readonly onHolderObserved?: (kind: LockHolderKind) => void;
  /**
   * **`renameSync` で lock を取り外した直後・再検証/復元の前**に呼ばれる (奪取・解放の両局面)。
   * この瞬間 lockPath は空いているので、第三者にここで lock を立てさせると
   * 「復元 `linkSync` が EEXIST で失敗する」経路 (= 二重保持を避けるための fail-loud) を
   * **決定的に**踏める (SEC-FL-2 / 復元失敗 throw の被覆)。
   */
  readonly onDetached?: (phase: DetachPhase) => void;
  /**
   * **解放で「これは自分の lock だ」と判定した直後・`renameSync` で取り外す前**に呼ばれる。
   * この窓で第三者が lockPath を差し替えると、解放の `rename` が **他者の lock を外す** ことになり、
   * 復元経路 (と、復元も失敗したときの fail-loud) を**決定的に**踏める。
   * 取得側の `onHolderObserved` と対をなす解放側の注入点 (SEC-FL-3 の被覆)。
   */
  readonly onReleaseChecked?: () => void;
}

/** {@link withFileLock} の受け口 (本番オプション + test 専用 seam 束)。 */
export interface FileLockCallOptions extends FileLockOptions {
  /**
   * テスト専用の注入 seam (本番未使用)。本番モードで渡すと throw する。
   * 本番コードは**決して**これを渡さない。
   */
  readonly testHooks?: FileLockTestHooks;
}

/** vitest / NODE_ENV=test 由来の test モード判定 (seam と env 遅延の共通ゲート)。 */
function isTestMode(): boolean {
  return process.env.NODE_ENV === "test" || Boolean(process.env.VITEST);
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
 * lock file の `(dev, ino)` を返す (ENOENT は `undefined`)。**読み権限不要**。
 * ENOENT 以外の stat 失敗は rethrow (fail-loud)。
 */
function identityOf(path: string): LockIdentity | undefined {
  try {
    const st = statSync(path);
    return { dev: st.dev, ino: st.ino };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/**
 * 解放時に「内容が読めなくても `(dev, ino)` 単独で自 lock と判定してよい」読取り失敗の errno クラス
 * (SEC-FLV2-1)。**permission / 種別**の恒久的な失敗だけを列挙する。
 *
 * - `EACCES` / `EPERM`: mode / owner が帯域外で変えられた (SEC-FL-1 の回復経路の本命)。
 * - `EISDIR`: lock path がディレクトリに差し替えられた。
 *
 * ここに **`EMFILE` / `ENFILE` / `EIO` 等の一過性失敗を足さない**。それらは「読めなかった」だけで
 * 「自分のものだ」を意味しないため、content 軸を捨てると他者の生きた lock を消す方向に倒れる。
 */
const IDENTITY_ONLY_READ_ERRNOS: ReadonlySet<string> = new Set(["EACCES", "EPERM", "EISDIR"]);

/** {@link IDENTITY_ONLY_READ_ERRNOS} に属する errno か (未知・欠落は false = 触らない側)。 */
function isIdentityOnlyReadErrno(code: string | undefined): boolean {
  return code !== undefined && IDENTITY_ONLY_READ_ERRNOS.has(code);
}

/** 同一 lock インスタンスか (`(dev, ino)` 一致)。 */
function sameIdentity(a: LockIdentity, b: LockIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * lock file を 3 値で観測する。内容と `(dev, ino)` を **同一 fd から**取る
 * (path 経由で read と stat を 2 回引くと、その間の差し替えで内容と identity が
 * 別 inode のものになりうる)。
 * - ENOENT → `absent` (**解放直後**。「壊れた lock」と混同しない)。
 * - 読めたが pid でない → `corrupt`。
 * - 読めて pid → `pid`。
 *
 * ENOENT 以外の read 失敗 (EISDIR / EACCES 等) は **rethrow** して fail-loud にする。
 * 内容が読めない lock は「他者の lock かもしれない」ので奪取してよいか判断できないため
 * (旧実装は全 error を `undefined`= stale 扱いにして奪取していた)。
 * 解放側は identity で自 lock を判定できるので本関数の失敗に縛られない (identity v2 (3))。
 */
function readLockHolder(lockPath: string): LockHolder {
  let fd: number;
  try {
    fd = openSync(lockPath, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    throw err;
  }
  let raw: string;
  let identity: LockIdentity;
  try {
    const st = fstatSync(fd);
    identity = { dev: st.dev, ino: st.ino };
    raw = readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
  const pid = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(pid) && pid > 0
    ? { kind: "pid", pid, raw, identity }
    : { kind: "corrupt", raw, identity };
}

/**
 * 観測した lock の内容が **自分のもの** か (FL-L5a: 取得側 EEXIST 枝と解放側で二重手書きだった
 * 3 値の意味論を単一の helper へ寄せる)。`corrupt` は「自分が立てた lock が壊された残骸」扱い。
 */
function isOwnLockContent(holder: LockHolder): boolean {
  if (holder.kind === "absent") return false;
  return holder.kind === "corrupt" || holder.pid === process.pid;
}

/**
 * 判定時に観測した lock と、取り外したファイルが **同一の lock インスタンス** か。
 *
 * identity v2: `(dev, ino)` 一致 **かつ** 逐語バイト一致 (連言)。identity は
 * 「同じバイト列の別 inode」(解放→即再取得・pid 再利用) を弾き、バイト比較は
 * 「同じ inode を in-place で書き換えられた」場合を弾く (どちらも復元側 = 安全側へ倒す)。
 * FL-L5c: 到達不能だった `absent` ガードは **型** で排した (呼び出し側が {@link PresentLock} を渡す)。
 */
function sameLockInstance(observed: PresentLock, detachedPath: string): boolean {
  let detached: LockHolder;
  try {
    detached = readLockHolder(detachedPath);
  } catch {
    // 取り外したものを読めない = 同一性を再検証できない → 別物とみなして復元 (安全側)。
    return false;
  }
  if (detached.kind === "absent") return false;
  return sameIdentity(observed.identity, detached.identity) && observed.raw === detached.raw;
}

/**
 * `lockPath` を退避名へ原子的に取り外す。ENOENT は「他者が先に取り外した」= `undefined`。
 * 取り外せた場合は退避パスを返す。
 */
function detachTo(lockPath: string, stalePath: string): string | undefined {
  try {
    renameSync(lockPath, stalePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  return stalePath;
}

/**
 * stale と判定した lock を **原子的に取り外し**、取り外したものが本当に判定した lock かを
 * `(dev, ino)` + 逐語内容で再検証してから破棄する。別物 (= 判定と取り外しの間に他プロセスが
 * 立て直した生きた lock) だったら元へ復元し、呼び出し側へ `"restored"` を返して backoff させる。
 *
 * 復元できなかったときは **fail-loud** で throw し、取り外した inode は退避名のまま**残す**
 * (SEC-FL-2: victim の lock を破棄しない。operator が退避ファイルから holder を辿れる)。
 *
 * @throws 復元できなかったとき (二重保持のまま無言継続しない)。
 */
function detachStaleLock(
  lockPath: string,
  observed: PresentLock,
  hooks: FileLockTestHooks,
): TakeoverResult {
  const stalePath = `${lockPath}.stale-${process.pid}-${staleSeq++}`;
  if (detachTo(lockPath, stalePath) === undefined) return "gone";
  // テスト seam (本番未使用): 取り外し済み・復元前の窓 (lockPath は空いている)。
  hooks.onDetached?.("takeover");
  let settled = false;
  let keepRemnant = false;
  try {
    if (sameLockInstance(observed, stalePath)) {
      unlinkSync(stalePath);
      settled = true;
      return "removed";
    }
    // 判定 → rename の間に差し替わった = 別プロセスの**生きた** lock を外してしまった。復元する。
    try {
      linkSync(stalePath, lockPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "unknown";
      // 退避ファイルは残す (victim の inode を破棄しない)。
      keepRemnant = true;
      throw new Error(
        `withFileLock: detached ${lockPath} as stale but it was a different lock, ` +
          `and restoring the live holder failed (${code}). ` +
          `the detached lock is kept at ${stalePath}. ` +
          `aborting to avoid double-holding the lock.`,
        { cause: err },
      );
    }
    return "restored";
  } finally {
    // 退避名の残骸を残さない (復元済みなら余分な link)。復元失敗時だけは意図的に残す。
    if (!settled && !keepRemnant) {
      try {
        unlinkSync(stalePath);
      } catch {
        /* best-effort */
      }
    }
  }
}

/**
 * 解放の前半: 「これは自分の lock か」を `(dev, ino)` 主・内容補助で判定し、自分のものなら
 * 退避名へ原子的に取り外して退避パスを返す。取り外さなかった / 取り外せなかったときは `undefined`。
 *
 * 判定の枝 (identity v2 (3)):
 * - identity 不一致 / 既に消えている → 触らない。
 * - identity 一致 + 内容が読めて自分 (`pid===self`) or `corrupt` → 自 lock。
 * - identity 一致 + 内容が読めず、その失敗が **permission クラス**
 *   ({@link IDENTITY_ONLY_READ_ERRNOS}) → identity を信じて自 lock
 *   (= SEC-FL-1 の恒久 wedge の回復経路)。
 * - identity 一致 + 内容が読めず、失敗が **それ以外** (EMFILE / ENFILE / EIO 等の一過性) →
 *   **触らない** (SEC-FLV2-1)。一過性の読取り不能で content 軸を捨てると、
 *   inode 番号が再利用された「他者の生きた lock」を消しうる。base 同等の fail-safe へ倒す。
 * - identity 一致 + 内容が読めて**別 pid** → 第三者が自分の inode を書き換えた → 触らない。
 */
function detachOwnLockForRelease(
  lockPath: string,
  held: LockIdentity,
  hooks: FileLockTestHooks,
): string | undefined {
  try {
    const current = identityOf(lockPath);
    if (current === undefined || !sameIdentity(current, held)) return undefined;
    let holder: LockHolder | undefined;
    try {
      holder = readLockHolder(lockPath);
    } catch (err) {
      // SEC-FLV2-1: 「identity を信じてよい」のは **permission クラス**の読取り不能だけ。
      // fd 枯渇 (EMFILE/ENFILE) や I/O 障害 (EIO) のような一過性の失敗まで同じ枝へ落とすと、
      // 「読めなかった」だけで content 軸 (= 別 pid なら触らない) を捨てることになり、
      // inode 番号が再利用された**他者の生きた lock** を消しうる。判別できないときは触らない。
      if (!isIdentityOnlyReadErrno((err as NodeJS.ErrnoException).code)) return undefined;
      holder = undefined; // 読めない自 inode → identity を信じる (回復経路)
    }
    if (holder !== undefined && !isOwnLockContent(holder)) return undefined;
    // テスト seam (本番未使用): 判定 → 取り外しの間の窓 (取得側 onHolderObserved の解放側の対)。
    hooks.onReleaseChecked?.();
    const releasePath = `${lockPath}.stale-rel-${process.pid}-${releaseSeq++}`;
    return detachTo(lockPath, releasePath);
  } catch {
    // best-effort: 取り外せなければ lock はそのまま (次の取得が stale として扱う)。
    return undefined;
  }
}

/**
 * 自分が保持している lock を解放する (identity v2 (3)・SEC-FL-3 / SEC-FL-1)。
 *
 * 1. `(dev, ino)` で自 lock か判定する (**読み権限不要**)。他者の inode なら何もしない。
 *    identity が一致した上で内容が読めて別 pid なら「第三者が自分の inode を書き換えた」
 *    とみなし触らない (既存軸の保存)。内容が読めない (EACCES / EISDIR) なら identity を信じて外す
 *    (= 保持中に読めなくなった自 lock の回復経路。旧実装はここで rethrow して恒久 wedge した)。
 * 2. `renameSync` で原子的に取り外し、`(dev, ino)` を再検証してから unlink する
 *    (旧実装の read → 判定 → unlink は非原子で、その窓に他者が差し替えると他者の lock を消した)。
 * 3. 取り外したものが自分のでなければ復元する。復元できなければ **fail-loud**。
 *
 * @throws 取り外した他者の lock を復元できなかったとき。それ以外の失敗 (stat / rename / unlink) は
 *         best-effort で握り潰す (解放は fn の後始末であり、その失敗で fn の結果を壊さない)。
 */
function releaseOwnLock(lockPath: string, held: LockIdentity, hooks: FileLockTestHooks): void {
  const releasePath = detachOwnLockForRelease(lockPath, held, hooks);
  if (releasePath === undefined) return;
  // テスト seam (本番未使用): 取り外し済み・再検証前の窓 (lockPath は空いている)。
  hooks.onDetached?.("release");
  let detached: LockIdentity | undefined;
  try {
    detached = identityOf(releasePath);
  } catch {
    detached = undefined;
  }
  if (detached !== undefined && sameIdentity(detached, held)) {
    try {
      unlinkSync(releasePath);
    } catch {
      /* best-effort */
    }
    return;
  }
  // 取り外したのは自分のではなかった (stat → rename の窓で差し替わった) → 復元する。
  try {
    linkSync(releasePath, lockPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown";
    throw new Error(
      `withFileLock: released ${lockPath} but the file detached was a different lock, ` +
        `and restoring it failed (${code}). ` +
        `the detached lock is kept at ${releasePath}. ` +
        `aborting so the broken serialization is not silently ignored.`,
      { cause: err },
    );
  }
  try {
    unlinkSync(releasePath);
  } catch {
    /* best-effort: 復元済み。余分な link だけが残る */
  }
}

/**
 * `targetPath` に対応する lock を取得し `fn()` を実行、終了時に必ず解放する。
 * 同期 fn 専用 (settings の read→compute→write は同期 I/O)。fn の戻り値を返す。
 *
 * @throws `testHooks` を **本番モード**で渡したとき (seam は test モード限定)。
 * @throws lock を maxRetries 以内に取得できなかったとき (fail-loud)。
 * @throws stale と判定して取り外した lock を復元できなかったとき (fail-loud)。
 * @throws 解放で取り外した他者の lock を復元できなかったとき (fn が正常終了した場合のみ。
 *         fn が throw した場合は fn のエラーを優先し、解放の失敗は握り潰す)。
 */
export function withFileLock<T>(
  targetPath: string,
  fn: () => T,
  opts: FileLockCallOptions = {},
): T {
  // TDA-FL-2 / SEC-FL-7: 注入 seam は test モードでしか受け付けない (実行可能ゲート)。
  // 本番経路が誤って seam を渡すと「stale 判定・backoff が無言で無効化される」ため、
  // 綴り走査ではなくここで **落とす**。
  if (opts.testHooks !== undefined && !isTestMode()) {
    throw new Error(
      "withFileLock: testHooks were passed outside of a test run " +
        "(NODE_ENV=test / VITEST). refusing to weaken lock semantics in production.",
    );
  }
  const hooks: FileLockTestHooks = opts.testHooks ?? {};
  const lockPath = opts.lockPath ?? `${targetPath}.actradeck-lock`;
  const maxRetries = opts.maxRetries ?? 100;
  const retryDelayMs = opts.retryDelayMs ?? 20;
  const isAlive = hooks.isAlive ?? defaultIsAlive;
  const sleep = hooks.sleep ?? defaultSleep;
  // テスト用 acquire 遅延 (本番未設定)。testHooks 明示 > env > 0。cross-process worker は env で受ける。
  // SEC-1: env 経路は **test モード時のみ** honor する (NODE_ENV==="test" / VITEST)。本番
  //   (NODE_ENV=production) では ACTRADECK_TEST_LOCK_ACQUIRE_DELAY_MS を無視し、万一 env が漏れても
  //   取得遅延を注入できない。値は sane 上限 60s に clamp し (非有限は 0)、DoS/暴走遅延を防ぐ。
  //   INV-FILELOCK-NO-EMPTY-WINDOW の spawn worker は vitest 由来の NODE_ENV=test / VITEST を継承する
  //   ため引き続き honor される。
  const envDelayHonored = isTestMode();
  const rawAcquireDelayMs =
    hooks.acquireDelayMs ??
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
  // 自分が保持する lock の同一性。temp と lockPath は **同じ inode** (hardlink) なので、
  // temp から取れば「lockPath を stat する前に他者へ差し替えられる」窓が原理的に無い。
  let heldIdentity: LockIdentity;
  try {
    // QA-3/TDA-5: writeFileSync は try 内で行う。ENOSPC/EACCES で途中 throw しても finally が
    //   残骸 tmp を掃除する (旧: try の外にあり、write 途中失敗で 0-byte tmp が残りえた)。
    writeFileSync(tmpPath, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
    const tmpIdentity = identityOf(tmpPath);
    if (tmpIdentity === undefined) {
      throw new Error(`withFileLock: lock temp ${tmpPath} vanished before it could be linked.`);
    }
    heldIdentity = tmpIdentity;
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
        hooks.onLockAcquired?.();
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        // テスト seam (本番未使用): 保持者を読む前の窓。
        hooks.onLockContended?.();
        // 既存 lock を 3 値で観測する。
        const holder = readLockHolder(lockPath);
        // テスト seam (本番未使用): 判定 → 取り外しの間の窓。
        hooks.onHolderObserved?.(holder.kind);

        // `absent` は stale ではなく **解放直後**。ここで unlink すると、この窓の内に
        // 別プロセスが立てた**生きた** lock を消してしまう (旧実装の TOCTOU)。何も消さず即再試行する。
        // `pid`/`corrupt` が stale なら rename で取り外し、同一性を再検証してから破棄する。
        let retryWithoutDelay = false;
        if (holder.kind === "absent") {
          retryWithoutDelay = true;
        } else if (isOwnLockContent(holder) || (holder.kind === "pid" && !isAlive(holder.pid))) {
          // "restored" は「判定した stale ではなく他者の生きた lock だった」= backoff すべき。
          retryWithoutDelay = detachStaleLock(lockPath, holder, hooks) !== "restored";
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

  let result: T;
  try {
    result = fn();
  } catch (err) {
    // fn のエラーを優先する (解放の失敗でそれを覆い隠さない)。
    try {
      releaseOwnLock(lockPath, heldIdentity, hooks);
    } catch {
      /* best-effort */
    }
    throw err;
  }
  // fn が成功した場合の解放は **fail-loud** (直列化が壊れたことを無言で飲み込まない)。
  releaseOwnLock(lockPath, heldIdentity, hooks);
  return result;
}
