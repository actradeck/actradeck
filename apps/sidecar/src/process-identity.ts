/**
 * process-identity — state file に記録した pid が「記録した当の daemon プロセス」かを判定する
 * (Triangle ADR 01a10ddb D7・task 01a10c42 PR-A・SEC-DC-2)。
 *
 * pid は OS が再利用するので、pid の生存 (signal 0) だけでは「記録した daemon がまだ動いている」とは
 * 言えない (再利用された無関係のプロセスに SIGTERM を送りうる・生存 daemon の判定を誤る)。(pid, 開始時刻)
 * は再利用されないので、開始時刻で照合する。
 *
 * - Linux で state に `procIdentity` (boot_id + `/proc/<pid>/stat` field 22 の start ticks) があれば、
 *   boot_id 一致かつ start ticks の**完全一致**で alive、不一致は dead (pid 再利用)。wall-clock に依存しない。
 * - それ以外 (Linux 以外・または `procIdentity` の無い旧 state): `ps -o etime= -p <pid>` から開始時刻
 *   (`now − etime`) を求め、state の `startedAt` + 許容 {@link ETIME_TOLERANCE_MS} 以前に始まったプロセスなら
 *   alive。それより後に始まったように見えるプロセスは、boot_id が読めない (Linux 以外) なら dead (state を
 *   書いた後に pid が再利用された)、boot_id が読める (Linux の旧 state) なら **unknown** (SEC-STA-2: 壁時計が
 *   state の書込後に進むと生きた旧 daemon もこう見えるので、dead と断定しない = alive 扱い・kill しない)。
 * - pid が存在しない (ESRCH) → dead。存在するが権限が無い (EPERM)・`/proc` や `ps` が読めない → unknown。
 *
 * 使い方 (ADR 採用判断 01a10ddc): **unknown は非対称に安全側**。alive 判定 (二重起動防止・拒否起動の後始末・
 * status) では alive 扱い (base 同値)、`daemon stop` の SIGTERM では送らない (無関係なプロセスを止めない)。
 *
 * **残余 (開示)**: etime 経路は秒単位の切り捨てと wall-clock (state 書込時刻と現在時刻) に依存する。
 * - 許容 2s 以内の pid 再利用 (state 書込 → daemon 死亡 → 同じ pid の新プロセス起動が 2 秒以内) は alive と
 *   誤判定する (kill しうる)。
 * - 書込後に時計が**戻された**場合 (SEC-STA-R2-2)、state 書込から「戻り量 + 2s」以内に起動した再利用 pid は
 *   alive と誤判定しうる (kill しうる)。本関数に OS 情報を注入して実測: 戻り量 0 / 5s / 10s で、書込から
 *   2s / 7s / 12s 後までに起動したプロセスが alive (boot_id の可読・不可読で同じ)。
 * - 書込後に時計が**進んだ**場合: Linux (boot_id が読める) は上記のとおり unknown に倒す (生きた旧 daemon を
 *   dead にしないことを実プロセスで実測)。Linux 以外の挙動は未実測。
 * - Windows では `ps` が無く常に unknown。
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** state に記録する自プロセスの同一性 (Linux のみ)。 */
export interface ProcIdentity {
  /** `/proc/sys/kernel/random/boot_id` (再起動ごとに変わる)。 */
  readonly bootId: string;
  /** `/proc/<pid>/stat` の field 22 (boot からの clock ticks・プロセスごとに不変)。 */
  readonly startTicks: number;
}

/** 記録した daemon プロセスか。 */
export type ProcessLiveness = "alive" | "dead" | "unknown";

/** `process.kill(pid, 0)` の結果を分類したもの。 */
export type Signal0Result = "exists" | "esrch" | "eperm" | "error";

/** etime 経路の許容 (state の startedAt より何 ms 後に始まったプロセスまでを同一とみなすか)。 */
export const ETIME_TOLERANCE_MS = 2000;

/** 判定に使う OS 情報の源 (テストで差し替える・本番は {@link defaultIdentitySources})。 */
export interface IdentitySources {
  signal0(pid: number): Signal0Result;
  /** boot_id (読めなければ undefined = Linux 以外を含む)。 */
  readBootId(): string | undefined;
  /** start ticks (読めなければ undefined)。 */
  readStartTicks(pid: number | "self"): number | undefined;
  /** `ps -o etime=` の経過秒数 (取れなければ undefined)。 */
  elapsedSeconds(pid: number): number | undefined;
  now(): number;
}

/** `/proc/<pid>/stat` の本文から field 22 (starttime) を取り出す。comm (field 2) は括弧内に空白や `)` を含みうる。 */
export function parseStartTicks(stat: string): number | undefined {
  const close = stat.lastIndexOf(")");
  if (close < 0) return undefined;
  // `)` の後ろは field 3 (state) から始まる。field 22 はその 20 番目 (index 19)。
  const rest = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const v = rest[19];
  if (v === undefined || !/^\d+$/.test(v)) return undefined;
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** `ps -o etime=` の出力 (`[[DD-]HH:]MM:SS`) を秒数にする。 */
export function parseEtimeSeconds(out: string): number | undefined {
  const m = /^\s*(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)\s*$/.exec(out);
  if (m === null) return undefined;
  const [, d, h, mi, s] = m;
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(mi) * 60 + Number(s);
}

function readTrimmed(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
}

export const defaultIdentitySources: IdentitySources = {
  signal0(pid) {
    try {
      process.kill(pid, 0);
      return "exists";
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return code === "ESRCH" ? "esrch" : code === "EPERM" ? "eperm" : "error";
    }
  },
  readBootId() {
    const v = readTrimmed("/proc/sys/kernel/random/boot_id");
    return v !== undefined && v.length > 0 ? v : undefined;
  },
  readStartTicks(pid) {
    const stat = readTrimmed(`/proc/${pid}/stat`);
    return stat === undefined ? undefined : parseStartTicks(stat);
  },
  elapsedSeconds(pid) {
    try {
      const out = execFileSync("ps", ["-o", "etime=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
      });
      return parseEtimeSeconds(out);
    } catch {
      return undefined;
    }
  },
  now: () => Date.now(),
};

/** 自プロセスの同一性 (Linux 以外・`/proc` が読めなければ undefined = state に書かない)。 */
export function captureSelfIdentity(
  src: IdentitySources = defaultIdentitySources,
): ProcIdentity | undefined {
  const bootId = src.readBootId();
  const startTicks = src.readStartTicks("self");
  if (bootId === undefined || startTicks === undefined) return undefined;
  return { bootId, startTicks };
}

/** state の pid が、その state を書いた daemon プロセスかを判定する (本ファイル冒頭の規則)。 */
export function isDaemonProcess(
  state: { readonly pid: number; readonly startedAt: string; readonly procIdentity?: ProcIdentity },
  src: IdentitySources = defaultIdentitySources,
): ProcessLiveness {
  const sig = src.signal0(state.pid);
  if (sig === "esrch") return "dead";
  if (sig !== "exists") return "unknown";
  const bootId = state.procIdentity === undefined ? undefined : src.readBootId();
  if (state.procIdentity !== undefined && bootId !== undefined) {
    if (bootId !== state.procIdentity.bootId) return "dead";
    const ticks = src.readStartTicks(state.pid);
    if (ticks === undefined) return "unknown";
    return ticks === state.procIdentity.startTicks ? "alive" : "dead";
  }
  const elapsed = src.elapsedSeconds(state.pid);
  if (elapsed === undefined) {
    // ps の直前にプロセスが終わった場合は ps が何も返さない。もう一度 signal 0 で確かめる。
    return src.signal0(state.pid) === "esrch" ? "dead" : "unknown";
  }
  const procStart = src.now() - elapsed * 1000;
  const startedAt = Date.parse(state.startedAt);
  if (!Number.isFinite(startedAt)) return "unknown";
  if (procStart <= startedAt + ETIME_TOLERANCE_MS) return "alive";
  return src.readBootId() === undefined ? "dead" : "unknown";
}
