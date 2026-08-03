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
import { stat } from "node:fs/promises";
import { join } from "node:path";
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
  /**
   * ADR 0015 §D5 (B1): snapshot 時点の `git rev-parse HEAD`。tree fingerprint
   *   = sha256(head ∥ \0 ∥ diff_hash) の素。unborn/非 git では undefined (fingerprint は diff_hash-only へ縮退)。
   */
  readonly headSha: string | undefined;
}

/** 未追跡ファイル stat 行の DoS 境界 (異常に多い未追跡ファイルで stat 洪水を避ける)。 */
const MAX_UNTRACKED_STAT = 10_000;

/**
 * 未追跡 (非 ignored) ファイルの stat 行 (path/size/mtime) を決定的な文字列にまとめる (§D5)。
 *
 * porcelain status はファイル**名**のみを列挙するため、未追跡ファイルの**内容**変更 (編集/追記) は
 * status/diff のどちらにも映らず diff_hash が動かない盲点があった。`git ls-files --others
 * --exclude-standard -z` で個別の未追跡ファイルを列挙し (ディレクトリ collapse しない・.gitignore 尊重)、
 * 各ファイルの size + mtime を hash 入力へ含めて盲点を閉じる。mtime は touch でも動く (safe-direction・
 * 過検出=stale 側で ADR の honest limit どおり)。
 */
async function untrackedStatDigest(repoRoot: string): Promise<string> {
  const raw = await git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (raw.length === 0) return "";
  const paths = raw
    .split("\0")
    .filter((p) => p.length > 0)
    .sort(); // 決定的順序 (列挙順に依存しない)。
  const limited = paths.slice(0, MAX_UNTRACKED_STAT);
  const parts: string[] = [];
  for (const rel of limited) {
    try {
      const st = await stat(join(repoRoot, rel));
      parts.push(`${rel}\u0000${st.size}\u0000${Math.trunc(st.mtimeMs)}`);
    } catch {
      parts.push(`${rel}\u0000?`); // stat 不能 (削除競合等) は存在痕跡のみ載せる。
    }
  }
  if (paths.length > MAX_UNTRACKED_STAT) parts.push(`+${paths.length - MAX_UNTRACKED_STAT}`); // 超過数 (観測性)。
  // TDA-B1R2-2 (L・correctness 隣接): parts 連結も **NUL 区切り**にする (以前は "\n" join)。`rel` は
  //   `ls-files -z` 由来で POSIX filename に改行が入りうる = NUL-free だが LF は含みうるため、"\n" join では
  //   改行入り filename が part 境界を跨いで衝突しうる (外側 diff_hash で閉じた straddle クラスの内側残存・
  //   偽装方向は false-green)。rel は NUL-free ゆえ `rel\0size\0mtime\0rel2...` (join("\u0000")) が一意。
  return untrackedDigestJoin(parts);
}

/**
 * diff_hash の入力文字列を組み立てる単一出所 (QA-B1R2-3)。3 フィールド (status / combined diff / untracked
 * stat digest) を **NUL 区切り**で連結して domain separation を保つ。空白区切りへ戻すと、あるフィールド末尾と
 * 次フィールド先頭に跨るコンテンツが衝突し (例: status 行末が diff 先頭へ流れ込む)、実変更を隠蔽して staleness
 * 検知を破る。NUL は git のテキスト出力に一切現れないため偽造不能な区切り (SEC-B1-2 / QA-B1-5 / TDA-B1-3)。
 * ソースは 6 文字エスケープ (backslash u 0000) で書き、生 NUL バイトをファイルへ混入させない。
 */
export function diffHashInput(status: string, combined: string, untracked: string): string {
  return `${status}\u0000${combined}\u0000${untracked}`;
}

/**
 * untracked stat digest の parts 連結 (TDA-B1R2-2)。各 part は `rel\0size\0mtime` (NUL 区切りフィールド)
 * だが、以前は parts 同士を **改行 (\n)** で連結していた。`rel` は `ls-files -z` 由来 = POSIX で filename に改行が
 * 入りうる (NUL-free だが LF は含みうる) ため、\n 連結だと改行入り filename が part 境界を跨いで衝突しうる
 * (外側 diff_hash で閉じた straddle クラスの内側残存・偽装方向は false-green)。rel が NUL-free ゆえ **NUL 連結**
 * (`rel\0size\0mtime\0rel2...`) が一意。straddle テストで空白/改行連結への退行を赤化する。
 * ソースは 6 文字エスケープ (backslash u 0000) で書き、生 NUL バイトを混入させない。
 */
export function untrackedDigestJoin(parts: readonly string[]): string {
  return parts.join("\u0000");
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
  const [status, diff, cached, head, untracked] = await Promise.all([
    git(repoRoot, ["status", "--porcelain=v1"]),
    git(repoRoot, ["diff", "--no-ext-diff", "--unified=3"]),
    git(repoRoot, ["diff", "--cached", "--no-ext-diff", "--unified=3"]),
    // ADR 0015 §D5 (B1): HEAD commit id (tree fingerprint の素)。unborn/非 git は空 → undefined。
    git(repoRoot, ["rev-parse", "HEAD"]),
    // ADR 0015 §D5 (B1): 未追跡ファイルの内容変更を捕捉する stat 行 (path/size/mtime)。
    untrackedStatDigest(repoRoot),
  ]);
  const headTrimmed = head.trim();
  const headSha = headTrimmed.length > 0 ? headTrimmed : undefined;

  const combined = `${diff}\n${cached}`;
  // hash input gains untracked stat (D5): captures untracked-file content edits invisible to porcelain names.
  //   diff_hash is compared only to the in-memory previous value; at-rest history is opaque, so this is safe.
  // SEC-B1-2 / QA-B1-5 / TDA-B1-3: separate the three fields with a NUL byte (the 6-char escape written
  //   below, never a raw NUL), not a space, for unambiguous field boundaries (domain separation). Space
  //   joining lets content straddling a boundary collide (a status line running into where the diff begins),
  //   masking a real change and defeating staleness detection. NUL never appears in git's text output, so it
  //   is an unforgeable separator.
  const hash = createHash("sha256")
    .update(diffHashInput(status, combined, untracked))
    .digest("hex");

  const changedFiles = status.split("\n").filter((l) => l.trim().length > 0).length;
  let addedLines = 0;
  let removedLines = 0;
  for (const line of combined.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) addedLines += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removedLines += 1;
  }

  return { hash, changedFiles, addedLines, removedLines, headSha };
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
        this.identity.emitMonitoring("diff", (canonicalSessionId, providerSessionId) => {
          this.onEvent(
            buildEvent({
              session_id: canonicalSessionId,
              // ADR 0014 D4: 監視イベントにも provider raw id を populate (従来 NULL)。
              ...(providerSessionId !== undefined
                ? { provider_session_id: providerSessionId }
                : {}),
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
                // ADR 0015 §D5 (B1): tree fingerprint の素 (commit id・content-free)。unborn/非 git は省略。
                ...(snap.headSha !== undefined ? { head_sha: snap.headSha } : {}),
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
