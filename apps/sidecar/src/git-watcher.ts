/**
 * git diff watcher (plan.md §13).
 *
 *   fs event → debounce 300ms → git diff snapshot → diff hash が変わったら diff.updated 送信
 *
 * 取得コマンド (plan.md §13 厳守):
 *   git status --porcelain=v1
 *   git diff --no-ext-diff --unified=3
 *   git diff --cached --no-ext-diff --unified=3
 *
 * diff 本文そのものは大きく秘匿の塊なので、イベント payload には
 * diff_hash / changed_files / added_lines / removed_lines の「メトリクス」のみ載せる
 * (本文は UI 詳細取得時に別途扱う設計余地。MVP は要約メトリクスで一覧→詳細を成立させる)。
 *
 * ⚠️ diff 由来の値も EventSink.emit 経由で redaction される。
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import chokidar, { type FSWatcher } from "chokidar";

import { buildChildEnv } from "./child-env.js";
import { buildEvent } from "./event-factory.js";
import type { SessionIdentity } from "./session-identity.js";

const execFileAsync = promisify(execFile);

export interface DiffSnapshot {
  readonly hash: string;
  readonly changedFiles: number;
  readonly addedLines: number;
  readonly removedLines: number;
}

export interface GitWatcherOptions {
  /**
   * session 識別の権威 (ADR 019e9462)。固定 sessionId を bake せず、emit 時に canonical を
   * 動的解決する。canonical 未確定時は SessionIdentity が hold→確定後に発生時刻順で flush する。
   */
  readonly identity: SessionIdentity;
  readonly repoRoot: string;
  readonly debounceMs?: number;
  readonly onEvent: (event: ReturnType<typeof buildEvent>) => void;
}

async function git(repoRoot: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: repoRoot,
      maxBuffer: 32 * 1024 * 1024,
      // SEC-1: git 子も allowlist env で起動 (悪意ある repo の textconv/fsmonitor 経由 exfil 遮断)。
      // git は provider cred 不要 (extra なし)。GIT_* も BASE 非列挙で遮断。
      env: buildChildEnv(),
    });
    return stdout;
  } catch {
    return "";
  }
}

/** repo root を特定する (git rev-parse)。git 管理外なら undefined。 */
export async function findRepoRoot(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      // SEC-1: git 子も allowlist env で起動 (rev-parse でも config 経由 hook 駆動の余地を断つ)。
      env: buildChildEnv(),
      // SEC-3 (decision 019f0f2f): resolve endpoint は任意絶対パスで本関数を呼ぶ。rev-parse は有界だが、
      // 念のため短い timeout を付し (defense-in-depth)、異常 fs/network mount での hang を防ぐ。
      timeout: 5_000,
    });
    const root = stdout.trim();
    return root.length > 0 ? root : undefined;
  } catch {
    return undefined;
  }
}

/** porcelain + unified diff を取得して要約メトリクスと hash を計算。 */
export async function snapshotDiff(repoRoot: string): Promise<DiffSnapshot> {
  const [status, diff, cached] = await Promise.all([
    git(repoRoot, ["status", "--porcelain=v1"]),
    git(repoRoot, ["diff", "--no-ext-diff", "--unified=3"]),
    git(repoRoot, ["diff", "--cached", "--no-ext-diff", "--unified=3"]),
  ]);

  const combined = `${diff}\n${cached}`;
  const hash = createHash("sha256").update(`${status}\u0000${combined}`).digest("hex");

  const changedFiles = status.split("\n").filter((l) => l.trim().length > 0).length;
  let addedLines = 0;
  let removedLines = 0;
  for (const line of combined.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) addedLines += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removedLines += 1;
  }

  return { hash, changedFiles, addedLines, removedLines };
}

export class GitWatcher {
  private readonly identity: SessionIdentity;
  private readonly repoRoot: string;
  private readonly debounceMs: number;
  private readonly onEvent: (event: ReturnType<typeof buildEvent>) => void;
  private watcher: FSWatcher | undefined;
  private debounceTimer: NodeJS.Timeout | undefined;
  private lastHash = "";
  private running = false;
  // in-flight captureAndEmit の promise。stop() が debounce 由来の in-flight capture を確実に
  // drain し、store.close (attach-daemon が registry.dispose→GitWatcher.stop の後に呼ぶ) より前に
  // emit を完走させるための握り (shutdown race・TDA-4 H)。
  private currentCapture: Promise<DiffSnapshot | undefined> | undefined;

  constructor(opts: GitWatcherOptions) {
    this.identity = opts.identity;
    this.repoRoot = opts.repoRoot;
    this.debounceMs = opts.debounceMs ?? 300;
    this.onEvent = opts.onEvent;
  }

  start(): void {
    this.watcher = chokidar.watch(this.repoRoot, {
      ignoreInitial: true,
      ignored: (p: string) =>
        /(^|[/\\])\.git([/\\]|$)|node_modules|[/\\]dist[/\\]|[/\\]\.next[/\\]/.test(p),
      persistent: true,
    });
    const onFsEvent = (): void => this.scheduleSnapshot();
    this.watcher.on("add", onFsEvent);
    this.watcher.on("change", onFsEvent);
    this.watcher.on("unlink", onFsEvent);
  }

  private scheduleSnapshot(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.captureAndEmit(), this.debounceMs);
  }

  /** スナップショットを取り、hash が変わっていれば diff.updated を emit。 */
  async captureAndEmit(): Promise<DiffSnapshot | undefined> {
    // scan 中の再呼出は **in-flight promise を返す** (早期 undefined で握りつぶさない)。これにより
    // stop() が in-flight capture を確実に await でき、shutdown 時の emit-after-close を防ぐ (TDA-4)。
    if (this.running) return this.currentCapture ?? Promise.resolve(undefined);
    this.running = true;
    const run = (async (): Promise<DiffSnapshot | undefined> => {
      try {
        const snap = await snapshotDiff(this.repoRoot);
        if (snap.hash === this.lastHash) return undefined; // 変化なし → 送らない。
        this.lastHash = snap.hash;
        // 発生時刻を**今**固定する。canonical 未確定で hold されても flush 時刻でなく観測時刻が
        // timestamp に乗る → INV-EVENT-ORDER 単調性が実発生順で保たれる (ADR 019e9462)。
        const observedAt = new Date().toISOString();
        // diff は情報価値が高いので有界化時も保持優先 (category="diff")。
        this.identity.emitMonitoring("diff", (canonicalSessionId) => {
          this.onEvent(
            buildEvent({
              session_id: canonicalSessionId,
              event_type: "diff.updated",
              timestamp: observedAt,
              cwd: this.repoRoot,
              summary: `差分更新: ${snap.changedFiles} files (+${snap.addedLines}/-${snap.removedLines})`,
              payload: {
                kind: "diff.updated",
                diff_hash: snap.hash,
                changed_files: snap.changedFiles,
                added_lines: snap.addedLines,
                removed_lines: snap.removedLines,
              },
            }),
          );
        });
        return snap;
      } finally {
        this.running = false;
        this.currentCapture = undefined;
      }
    })();
    this.currentCapture = run;
    return run;
  }

  async stop(): Promise<void> {
    // shutdown race (TDA-4 H): debounce が撃った in-flight captureAndEmit は await snapshotDiff
    // (git 子プロセス) を跨いで emit→sink.emit→store.append する。待たずに store.close
    // (attach-daemon が registry.dispose→GitWatcher.stop の後に呼ぶ) すると閉じた DB へ append し、
    // attach daemon は unhandledRejection handler を持たない (cli.ts mainDaemon) ためクラッシュする。
    // ① watcher を閉じ新規 fs イベントを止める → ② 残 debounce を消す → ③ in-flight capture を drain
    // (emit を close 前に完走させる・diff は実イベントゆえ drop でなく drain で取りこぼさない)。
    await this.watcher?.close();
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
    if (this.currentCapture) await this.currentCapture;
  }
}
