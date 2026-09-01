/**
 * INV-FILELOCK-IDENTITY-V2 ヘルパ (test only・vitest 非対象 = .mts):
 * `withFileLock` の **同一性粒度 (`(dev, ino)`)** と **復元失敗の fail-loud** を、実プロセス
 * (distinct pid) で決定的に再現するワーカー。
 *
 * 役は env `ROLE`、シナリオは env `MODE`。順序は sleep でなくファイル sentinel + file-lock の
 * `testHooks` seam で決定的に作る。
 *
 *   victim(V)   : lock を取り、合図で **解放して即座に再取得**する。二度目の lock は
 *                 **逐語バイト列が一度目と同一** (内容は常に `${pid}\n`) だが **inode は別**。
 *                 ここが本 INV の核 — バイト比較だけの同一性では区別できない。
 *   taker(B)    : V が保持中に取得を試み、`isAlive` seam の中で V を「死亡」と判定しつつ
 *                 V の解放→再取得を待つ。再開後、判定した lock (一度目) と取り外した lock
 *                 (二度目) が **別 inode** なので、v2 は復元して backoff する。
 *                 旧実装 (バイト比較のみ) は同一とみなして **V の生きた lock を破棄**し、
 *                 V と B が同時に critical section へ入った。
 *   sniper(S)   : `MODE=restore-fail` のとき、B が rename で取り外した直後 (`onDetached`) の
 *                 「lockPath が空いている窓」で lock を立てる。B の復元 `linkSync` は EEXIST で
 *                 失敗し、B は critical section へ入らず throw する (fail-loud)。
 *                 このとき B が取り外した **V の inode は退避名のまま残る** (破棄しない)。
 *   observer(O) : 一連の決着後に lock を取り、直列化が壊れていない (取得できる) ことを確認する。
 *   unreadable  : SEC-FLV2-1。自分が保持している間に lock file を **inode 番号ごと再利用**した
 *                 「他者 (live pid) の lock」へ差し替え、さらに **fd を焼き尽くして** 解放側の
 *                 内容読取りだけを `EMFILE` で失敗させる。permission クラス (EACCES/EPERM/EISDIR)
 *                 でない読取り不能で content 軸を捨てると、identity だけを信じて
 *                 **他者の生きた lock を消す**。呼び元テストが「消していない」ことを assert する。
 *
 * 入出力はすべて env と `SIG_DIR` 配下の sentinel ファイル (呼び元が os.tmpdir 配下を与える)。
 * 実 ~/.actradeck / 実 settings は不可侵。
 */
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { withFileLock, type FileLockTestHooks } from "../../src/file-lock.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    process.stderr.write(`file-lock-identity-worker: ${name} is required\n`);
    process.exit(2);
  }
  return v;
}

const role = requireEnv("ROLE");
const sigDir = requireEnv("SIG_DIR");
const target = requireEnv("TARGET");
const lockPath = `${target}.actradeck-lock`;
const waitBudgetMs = Number(process.env.WAIT_MS ?? 15_000);
/** victim が二度目の lock を保持する上限 (taker が backoff で待ち切れる幅)。 */
const holdMs = Number(process.env.HOLD_MS ?? 600);

const sig = (name: string): string => join(sigDir, name);
const put = (name: string, body = "1"): void => {
  writeFileSync(sig(name), body, "utf8");
};
const has = (name: string): boolean => existsSync(sig(name));
const get = (name: string): string => readFileSync(sig(name), "utf8");

/** 同期 sleep (Atomics.wait)。busy-wait で CPU を焼かない。 */
function napMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** sentinel が現れるまで同期に待つ。timeout したら false (呼び元テストが vacuity を検出する)。 */
function waitFor(name: string, timeoutMs = waitBudgetMs): boolean {
  const deadline = Date.now() + timeoutMs;
  while (!has(name)) {
    if (Date.now() >= deadline) return false;
    napMs(2);
  }
  return true;
}

/** 現在の lock file の inode (無ければ 0)。 */
function lockIno(): number {
  try {
    return statSync(lockPath).ino;
  } catch {
    return 0;
  }
}

function runVictim(): void {
  put("v-pid", String(process.pid));
  // 一度目の lock。B に観測させてから解放する。
  withFileLock(target, () => {
    put("v1-ino", String(lockIno()));
    put("v1-enter", String(Date.now()));
    put("v1-inside");
    waitFor("v-may-cycle");
    put("v1-exit", String(Date.now()));
  });
  // 解放直後に再取得する。**同じ pid = 同じバイト列**だが inode は別にする。
  //
  // NOTE: ext4 は解放直後の inode 番号を再利用するため、素直に「解放 → 再取得」すると
  //   二度目の lock が **一度目と同じ inode 番号**になり、(dev,ino) 粒度を検査できない
  //   (実測)。囮ファイルをいくつか作って空いた inode 番号を消費させてから再取得する。
  //   inode 番号の再利用は pid 再利用と同種の残余 (v2 はそれを **狭める**のであって消しはしない)。
  const decoys: string[] = [];
  for (let i = 0; i < 8; i++) {
    const decoy = `${target}.decoy-${i}`;
    writeFileSync(decoy, "x");
    decoys.push(decoy);
  }
  withFileLock(target, () => {
    put("v2-ino", String(lockIno()));
    put("v2-enter", String(Date.now()));
    put("v2-inside");
    put("v-cycled"); // B をここで再開させる (B の判定は一度目の lock のまま)
    // B が (誤って) 入って来たら即座に観測できるよう待つ。来なければ holdMs で抜ける。
    waitFor("v-may-exit", holdMs);
    put("v2-exit", String(Date.now()));
  });
  for (const decoy of decoys) {
    try {
      unlinkSync(decoy);
    } catch {
      /* best-effort */
    }
  }
  put("v-done");
}

function runTaker(): void {
  const mode = requireEnv("MODE");
  const vPid = Number(get("v-pid").trim());
  let armed = true;

  const hooks: { -readonly [K in keyof FileLockTestHooks]: FileLockTestHooks[K] } = {
    isAlive: (pid) => {
      if (pid === vPid && armed) {
        armed = false;
        put("b-observed", String(pid));
        put("b-observed-ino", String(lockIno()));
        // V に「解放 → 再取得」をさせ、二度目の lock が立つまで待つ。
        put("v-may-cycle");
        waitFor("v-cycled");
        return false; // 一度目の観測だけ「死亡」= 奪取経路へ入れる
      }
      // 以降は生存扱い = backoff させる (v2 は V の解放を待って正当に取得する)。
      return true;
    },
  };

  if (mode === "restore-fail") {
    hooks.onDetached = (phase) => {
      if (phase !== "takeover" || has("s-go")) return;
      // 取り外し済み・復元前。lockPath は空いている → sniper に埋めさせる。
      put("s-go");
      waitFor("s-inside");
    };
  }

  try {
    withFileLock(
      target,
      () => {
        put("b-enter", String(Date.now()));
        if (has("v2-inside") && !has("v2-exit")) {
          put("violation", "taker entered the critical section while victim still held the lock");
        }
        napMs(40);
        put("b-inside");
        if (has("v2-inside") && !has("v2-exit")) {
          put("violation", "taker held the lock while victim was still inside");
        }
        put("b-exit", String(Date.now()));
      },
      { testHooks: hooks },
    );
  } finally {
    // V を待たせ続けない (成功/fail-loud のどちらでも解放してよい合図)。
    put("v-may-exit");
    put("b-done");
  }
}

function runSniper(): void {
  waitFor("s-go");
  withFileLock(target, () => {
    put("s-ino", String(lockIno()));
    put("s-enter", String(Date.now()));
    put("s-inside");
    waitFor("b-done", holdMs);
    put("s-exit", String(Date.now()));
  });
  put("s-done");
}

/**
 * SEC-FLV2-1: 解放側の「内容が読めない」枝が **permission クラスに限定**されていることを、
 * 実プロセスで踏む。`stat` / `rename` / `link` / `unlink` は fd を要さず成功し、
 * `openSync` だけが `EMFILE` で失敗する状態を作る (呼び元が `ulimit -n` を絞って起動する)。
 *
 * sentinel は **fd を閉じてから**書く (焼いている間は writeFileSync も EMFILE になるため)。
 */
function runUnreadableRelease(): void {
  const foreignPid = Number(process.env.FOREIGN_PID ?? 1); // init は常に生存 = 他者の生きた lock
  const ballast = `${target}.ballast`;
  writeFileSync(ballast, "x");
  const fds: number[] = [];
  let reused = false;
  let foreignIno = 0;
  let heldIno = 0;
  let openErr = "none";

  withFileLock(target, () => {
    const st0 = statSync(lockPath);
    heldIno = Number(st0.ino);
    unlinkSync(lockPath);
    // ext4 は解放直後の inode 番号を再利用する。再利用されるまで作り直す
    // (再利用できなければ reused=false のまま → 呼び元の vacuity guard が loud に落ちる)。
    for (let i = 0; i < 2000; i++) {
      writeFileSync(lockPath, `${foreignPid}\n`, { mode: 0o600 });
      const st = statSync(lockPath);
      if (Number(st.ino) === heldIno && Number(st.dev) === Number(st0.dev)) break;
      unlinkSync(lockPath);
    }
    const stC = statSync(lockPath);
    foreignIno = Number(stC.ino);
    reused = foreignIno === heldIno && Number(stC.dev) === Number(st0.dev);
    if (process.env.EXHAUST !== "0") {
      // 残りの fd を焼き尽くす → 解放側の openSync が EMFILE になる。
      for (;;) {
        try {
          fds.push(openSync(ballast, "r"));
        } catch (err) {
          openErr = (err as NodeJS.ErrnoException).code ?? "unknown";
          break;
        }
      }
    }
  });

  for (const fd of fds) {
    try {
      closeSync(fd);
    } catch {
      /* best-effort */
    }
  }
  put("u-held-ino", String(heldIno));
  put("u-foreign-ino", String(foreignIno));
  put("u-reused", String(reused));
  put("u-open-error", openErr);
  put("u-fds-burned", String(fds.length));
  put("u-victim-survived", String(existsSync(lockPath)));
  if (existsSync(lockPath)) {
    put("u-victim-body", readFileSync(lockPath, "utf8"));
    put("u-victim-ino", String(statSync(lockPath).ino));
  }
  put("u-done");
}

function runObserver(): void {
  // 決着後に取得できる = 直列化が wedge していない。
  waitFor("b-done");
  waitFor("s-done", holdMs);
  waitFor("v-done", holdMs);
  withFileLock(target, () => {
    put("o-enter", String(Date.now()));
    put("o-inside");
    put("o-exit", String(Date.now()));
  });
  put("o-done");
}

try {
  if (role === "victim") runVictim();
  else if (role === "taker") runTaker();
  else if (role === "sniper") runSniper();
  else if (role === "observer") runObserver();
  else if (role === "unreadable") runUnreadableRelease();
  else {
    process.stderr.write(`file-lock-identity-worker: unknown ROLE ${role}\n`);
    process.exit(2);
  }
} catch (err) {
  put(`${role}-error`, err instanceof Error ? err.message : String(err));
  process.stderr.write(`file-lock-identity-worker(${role}): ${String(err)}\n`);
  process.exit(3);
}
process.exit(0);
