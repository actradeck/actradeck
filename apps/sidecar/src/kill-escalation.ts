/**
 * kill-escalation — 強み(a)「停止の確実性」の共有ヘルパ。
 *
 * 真因 / 背景:
 *   managed-runner (claude / node-pty) と codex-runner (codex / child_process) はどちらも
 *   「停止要求 → 指定シグナル送出 → 猶予内に exit しなければ SIGKILL」という同一の段階的停止
 *   (escalation) を必要とする。codex-runner には既に SIGTERM→killGraceMs→SIGKILL の escalation が
 *   あったが、managed-runner は `child.kill(signal)` のみで escalation が無く、SIGINT を握り潰す
 *   子 (例: claude が起動した TUI / 子シェル) を確実に停止できなかった。
 *
 *   escalation は **PID 限定 kill** + **猶予タイマの冪等管理** という security-load-bearing な
 *   不変条件を持つため、両 runner で byte 近接の重複を避けて単一の choke point に集約する
 *   (TDA: 重複ロジックの一元化。一箇所だけ監査すれば「負 PID を撃たない / 二重停止安全 /
 *   exit で確実に timer を解除」が両 runner で保証される)。
 *
 * 不変条件 (INV-STOP-*):
 *   - **PID 限定**: 子オブジェクトの `kill()` のみを呼ぶ (所有 child PID のみ)。プロセスグループ
 *     (負 PID) / 親 / foreign PID を撃たない。`process.kill(-pid)` 系は本ヘルパに存在しない。
 *   - **段階的**: まず `signal` (既定 SIGINT) を送り、`graceMs` 以内に child が exit しなければ
 *     SIGKILL を送る。child が既に消滅していれば双方の kill は no-op (try/catch で吸収)。
 *   - **冪等 / double-stop 安全**: 返り値の timer を child exit / 再 stop / teardown で
 *     `clearTimeout` して再武装できる。timer は `unref()` してプロセスを掴んだままにしない。
 */

/** escalateKill が必要とする子プロセスの最小 surface (PtyLike / ChildLike 双方が満たす)。 */
export interface KillableChild {
  /**
   * 所有 child PID のみへシグナルを送る。`NodeJS.Signals` は `string` の部分型なので
   * PtyLike(`kill(signal?: string)`) / ChildLike(`kill(signal?: NodeJS.Signals)`) 双方が代入可能。
   */
  kill(signal?: string): unknown;
}

export interface EscalateKillOptions {
  /** 1 段目に送るシグナル (既定 SIGINT)。 */
  readonly signal?: NodeJS.Signals;
  /** signal 後 SIGKILL までの猶予 (ms)。 */
  readonly graceMs: number;
}

/**
 * 子へ `signal` を送り、`graceMs` 以内に exit しなければ SIGKILL へ段階昇格する。
 *
 * 返り値は SIGKILL 予約タイマ。呼び出し側は **child の exit / 再 stop / teardown** で必ず
 * `clearTimeout` し、(a) 既に exit した子へ無駄な SIGKILL を撃たない (b) 再 stop 前に前回の
 * タイマを解除して二重武装しない、を担保する。再 stop 時は前回 timer を clear してから本関数を
 * 呼び直す (codex/managed 双方の stop で同パターン)。
 *
 * PID 限定: 本関数は引数 `child.kill()` 以外のプロセス操作を行わない。負 PID / プロセスグループ
 * kill は構造的に発生しない。
 */
export function escalateKill(child: KillableChild, opts: EscalateKillOptions): NodeJS.Timeout {
  const signal: NodeJS.Signals = opts.signal ?? "SIGINT";
  try {
    child.kill(signal);
  } catch {
    /* already gone — no-op */
  }
  // 猶予後に SIGKILL (対象 child PID 限定)。child exit 時に呼び出し側が clearTimeout する。
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone — no-op */
    }
  }, opts.graceMs);
  timer.unref?.();
  return timer;
}
