/**
 * attach-session-registry — 1 daemon = N attach session の多重化 (ADR 019ea476 D6)。
 *
 * Managed は「1 sidecar = 1 session」前提だが、Attach は単一 daemon が複数の CC を
 * hooks 経由で観測する。session_id ごとに **独立した projection** を保つため、
 * `Map<sessionId, AttachSession>` で per-session の SessionIdentity / GitWatcher / cwd を持つ。
 *
 * 不変条件:
 * - INV-ATTACH-MULTIPLEX: 異なる session_id の hook が来たら 2 つの独立 identity になり
 *   相互汚染しない (片方の cwd/git が他方に混ざらない)。
 * - INV-ATTACH-REDACTION: GitWatcher の emit は **必ず sink.emit** (redact→parse→persist→send)
 *   を通る (choke 迂回なし)。capture_mode="attach" を全 emit に付与する。
 *
 * canonical 確定 (D6): hook session_id を **explicitSessionId で即確定** (hold 最小)。
 * Attach は ActraDeck が採番しないため fallback 採番経路は無効 (hook 駆動 = hook 皆無は観測対象外)。
 */
import { findRepoRoot, GitWatcher } from "./git-watcher.js";
import { SessionIdentity } from "./session-identity.js";
import type { buildEvent } from "./event-factory.js";

type BuiltEvent = ReturnType<typeof buildEvent>;

/**
 * idle reap の既定閾値 (ms)。`lastHookAt` からの無 hook 経過がこれを超えた session を reap する。
 *
 * これは **SessionEnd を取りこぼした abrupt-exit の backstop** であって liveness シグナルではない。
 * GitWatcher 由来の diff.updated は意図的に `lastHookAt` を更新しない (幻 diff を老化させ掃除する)
 * ため、正常稼働でも hook 間隔がこの値を超える session は誤 reap されうる。誤 reap は次 hook の
 * observeHook で self-heal する (新 entry + GitWatcher 再起動 + reannounce で復帰) が、その間
 * 「動いているのに居ない」窓が出る。窓を狭めたい/広げたい運用は env で上書きする
 * (cli.resolveAttachReaperConfig / ACTRADECK_ATTACH_IDLE_TTL_MS)。QA-2 / ADR 019eb448。
 */
export const DEFAULT_ATTACH_IDLE_TTL_MS = 30 * 60_000;
/** idle sweep の既定間隔 (ms)。 */
export const DEFAULT_ATTACH_REAPER_INTERVAL_MS = 60_000;

/** 1 attach session が保持する状態。 */
export interface AttachSession {
  readonly sessionId: string;
  readonly identity: SessionIdentity;
  gitWatcher?: GitWatcher;
  cwd?: string;
  /**
   * GitWatcher 起動時に resolveRepoRoot(cwd) が確定した git root。
   * on-demand diff (diff.request) 応答で generateRedactedDiff へ渡す出所。GitWatcher と同一 root を使い
   * 二重解決しない (managed の Sidecar.repoRoot と同型)。git 管理外 / 未起動なら undefined のまま。
   */
  repoRoot?: string;
  /** 最終 hook 受信時刻 (epoch ms)。liveness_state の鮮度判定 / status 表示に使う。 */
  lastHookAt: number;
}

export interface AttachSessionRegistryOptions {
  /**
   * GitWatcher の emit を sink へ流す前に capture_mode="attach" を必ず付与する wrapper。
   * GitWatcher 自身は capture_mode を知らないため、registry の呼び元 (daemon) が被せて sink.emit する。
   * INV-ATTACH-REDACTION: この経路も最終的に sink.emit (redact→parse→persist→send) を通る。
   */
  readonly onGitEvent: (event: BuiltEvent) => void;
  /** repo root 解決の注入 (テスト用)。既定 findRepoRoot。 */
  readonly resolveRepoRoot?: (cwd: string) => Promise<string | undefined>;
  /** GitWatcher 生成の注入 (テスト用)。既定 new GitWatcher。 */
  readonly makeGitWatcher?: (args: {
    identity: SessionIdentity;
    repoRoot: string;
    onEvent: (event: BuiltEvent) => void;
  }) => GitWatcher;
  /**
   * 観測中 session 集合が **reap で縮小** したとき発火 (ADR 019eb365)。daemon が
   * wsClient.reannounce() を配線し、backend が authoritative hello で release する。
   */
  readonly onChange?: () => void;
  /** idle reap の閾値 (ms)。既定 DEFAULT_ATTACH_IDLE_TTL_MS。 */
  readonly idleTtlMs?: number;
  /** idle sweep の間隔 (ms)。0 以下なら自動 sweep を起動しない (テストは reapIdle を直接呼ぶ)。 */
  readonly reaperIntervalMs?: number;
}

export class AttachSessionRegistry {
  private readonly sessions = new Map<string, AttachSession>();
  private readonly onGitEvent: (event: BuiltEvent) => void;
  private readonly resolveRepoRoot: (cwd: string) => Promise<string | undefined>;
  private readonly makeGitWatcher: NonNullable<AttachSessionRegistryOptions["makeGitWatcher"]>;
  private readonly onChange: () => void;
  private readonly idleTtlMs: number;
  private reaperTimer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;

  constructor(opts: AttachSessionRegistryOptions) {
    this.onGitEvent = opts.onGitEvent;
    this.resolveRepoRoot = opts.resolveRepoRoot ?? findRepoRoot;
    this.makeGitWatcher = opts.makeGitWatcher ?? ((args) => new GitWatcher(args));
    this.onChange = opts.onChange ?? (() => {});
    this.idleTtlMs = opts.idleTtlMs ?? DEFAULT_ATTACH_IDLE_TTL_MS;
    const interval = opts.reaperIntervalMs ?? DEFAULT_ATTACH_REAPER_INTERVAL_MS;
    if (interval > 0) {
      this.reaperTimer = setInterval(() => this.reapIdle(Date.now()), interval);
      this.reaperTimer.unref?.();
    }
  }

  /** 観測中の全 attach session の canonical id (hello.session_ids 用)。 */
  sessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  /** 観測中の session 数 (status 表示用)。 */
  get size(): number {
    return this.sessions.size;
  }

  /** session を取得 (テスト・status 用)。 */
  get(sessionId: string): AttachSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * hook の初出で per-session entry を生成・既出なら lastHookAt を更新する。
   * 戻り値の SessionIdentity を hook-receiver の learn/emit 経路へ渡す。
   *
   * @param sessionId canonical = hook の session_id (即確定)。
   * @param cwd hook payload の cwd (GitWatcher の repo root 特定に使う)。初出時のみ反映。
   */
  observeHook(sessionId: string, cwd?: string): AttachSession {
    if (this.disposed) {
      // dispose 後の遅延 hook: 新規 entry を作らず ephemeral identity を返す (副作用なし)。
      const identity = new SessionIdentity({
        fallbackSessionId: sessionId,
        explicitSessionId: sessionId,
      });
      return { sessionId, identity, lastHookAt: Date.now() };
    }
    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.lastHookAt = Date.now();
      return existing;
    }
    // 初出: canonical を即確定する SessionIdentity を生成 (D6: hold 最小, fallback 採番無効)。
    const identity = new SessionIdentity({
      fallbackSessionId: sessionId,
      explicitSessionId: sessionId,
    });
    const session: AttachSession = {
      sessionId,
      identity,
      ...(cwd !== undefined ? { cwd } : {}),
      lastHookAt: Date.now(),
    };
    this.sessions.set(sessionId, session);
    // per-session GitWatcher を cwd の repo root で起動 (非同期, best-effort)。
    if (cwd !== undefined && cwd.length > 0) {
      void this.startGitWatcher(session, cwd);
    }
    return session;
  }

  /** per-session GitWatcher を repo root 解決後に起動する。 */
  private async startGitWatcher(session: AttachSession, cwd: string): Promise<void> {
    const root = await this.resolveRepoRoot(cwd);
    // dispose 済 / 既に watcher 有り / repo 外 なら起動しない。
    if (this.disposed || root === undefined || session.gitWatcher !== undefined) return;
    if (this.sessions.get(session.sessionId) !== session) return; // 競合除去後の stale guard
    // on-demand diff (diff.request) 応答のため解決済 root を保持 (GitWatcher と同一 root, 二重解決なし)。
    session.repoRoot = root;
    const watcher = this.makeGitWatcher({
      identity: session.identity,
      repoRoot: root,
      // INV-ATTACH-REDACTION: onGitEvent (= sink.emit に capture_mode=attach を被せる) を通す。
      onEvent: (ev) => this.onGitEvent(ev),
    });
    session.gitWatcher = watcher;
    watcher.start();
    void watcher.captureAndEmit(); // 初期差分を 1 回確定。
  }

  /**
   * 1 session を内部除去する (GitWatcher 停止 + identity dispose + Map から削除)。onChange は発火しない。
   * GitWatcher.stop() は best-effort (await せず: reaper/hook 経路を遅延させない)。除去できたら true。
   */
  private reapOne(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return false;
    session.identity.dispose();
    if (session.gitWatcher) void session.gitWatcher.stop();
    this.sessions.delete(sessionId);
    return true;
  }

  /**
   * session を即時 reap する (SessionEnd hook 経路)。除去できたら onChange を発火して hello 再送を促す
   * (presence release・ADR 019eb365 / INV-ATTACH-REAP)。終了済 CC の GitWatcher 幻 diff を止める。
   */
  reap(sessionId: string): void {
    if (this.reapOne(sessionId)) this.onChange();
  }

  /**
   * idle sweep: `nowMs - lastHookAt > idleTtlMs` の session を一括 reap する (abrupt-exit backstop)。
   * GitWatcher 由来 event は lastHookAt を更新しない (hook のみ) ため、幻 diff だけの session は老化して
   * ここで掃除される。変化があれば onChange を 1 回発火。テストは本メソッドを直接呼べる。
   */
  reapIdle(nowMs: number): void {
    if (this.disposed) return;
    let changed = false;
    for (const [sid, session] of [...this.sessions]) {
      if (nowMs - session.lastHookAt > this.idleTtlMs && this.reapOne(sid)) changed = true;
    }
    if (changed) this.onChange();
  }

  /** 全 session の GitWatcher 停止 + identity dispose (graceful shutdown)。 */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.reaperTimer) clearInterval(this.reaperTimer);
    // TDA-2 (ADR 019eb448): teardown 手順は reapOne と同型だが、dispose は graceful shutdown ゆえ
    // GitWatcher.stop() を **Promise.all で await** する (flush 完了を待つ)。reapOne は reaper/hook
    // 経路を遅延させないため stop を best-effort fire-and-forget にする ── この await 差分が意図的な
    // ため reapOne へは集約しない。
    const stops: Array<Promise<void>> = [];
    for (const session of this.sessions.values()) {
      session.identity.dispose();
      if (session.gitWatcher) stops.push(session.gitWatcher.stop());
    }
    await Promise.all(stops);
    this.sessions.clear();
  }
}
