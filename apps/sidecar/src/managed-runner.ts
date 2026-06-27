/**
 * Managed runner (`agentmon claude`) — node-pty で claude を子プロセス起動する。
 *
 * 責務 (plan.md §11 Managed Mode):
 * - claude を PTY 子プロセスとして起動し、PID / PTY / stdout-stderr / hook を取得。
 * - hook 設定 (sidecar HTTP endpoint) を注入して起動する。
 * - プロセス監視 (PID/CPU/mem/elapsed) → heartbeat。
 * - PTY 出力収集 → command.output.delta。
 * - **ユーザー実端末との双方向接続** (LIVE-2): 子 PTY 出力をユーザー端末にエコーし、
 *   ユーザーのキー入力を子へ転送する。これにより起動した claude を実端末で操作・視認でき、
 *   プロンプト送信 → SessionStart/turn hook 発火 → canonical session 学習が成立する。
 *   監視取り込み (OutputCollector) と両立させる (両方に流す)。
 * - セッション開始/終了検知 (PTY exit)。stop/interrupt は kill 対象を PID に限定。
 *
 * graceful shutdown: 終了時に collector flush + 未送信 flush は呼び出し側 (CLI) が担う。
 * 端末状態 (raw mode / リスナ) は本モジュールが exit・stop・例外いずれの経路でも確実に復元する
 * (raw のまま放置 = 端末が無反応になる事故を防ぐ)。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as pty from "node-pty";

import { buildChildEnv, CLAUDE_EXTRA_ENV_KEYS, CLAUDE_EXTRA_ENV_PREFIXES } from "./child-env.js";
import { buildEvent } from "./event-factory.js";
import { escalateKill } from "./kill-escalation.js";
import { OutputCollector } from "./output-collector.js";
import { ProcessMonitor, type ProcessSample } from "./process-monitor.js";
import type { SessionIdentity } from "./session-identity.js";
import type { EventSink } from "./sink.js";
import { writeHookSettings } from "./settings-injection.js";

export interface ManagedRunnerOptions {
  readonly sink: EventSink;
  /** hook receiver の HTTP endpoint (settings へ注入)。 */
  readonly hookEndpoint: string;
  /** SEC-3: hook 認証トークン (settings の hook ヘッダへ注入)。 */
  readonly hookToken?: string;
  /** claude に渡す追加引数 (例: ["-p", "..."])。 */
  readonly claudeArgs?: readonly string[];
  /** claude 実行パス (既定: PATH 上の "claude")。 */
  readonly claudeBin?: string;
  readonly cwd?: string;
  /**
   * session 識別の権威 (ADR 019e9462)。固定 sessionId を bake せず、process heartbeat /
   * PTY output は emit 時に canonical を動的解決する。起動直後 (hook 確定前) の heartbeat /
   * 早期 output は SessionIdentity が hold→確定後に発生時刻順で flush する。
   */
  readonly identity: SessionIdentity;
  readonly heartbeatMs?: number;
  /**
   * 強み(a) 停止の確実性: stop/interrupt の signal 送出後 SIGKILL までの猶予 (ms)。既定 5s。
   * codex-runner の `killGraceMs` と同名・同既定。SIGINT を握り潰す子 (TUI / 子シェル) でも
   * 猶予後に SIGKILL で確実に停止する。テストは短い値を注入して決定論化する。
   */
  readonly killGraceMs?: number;
  /**
   * ユーザー実端末 (LIVE-2)。既定は本物の `process`。テスト/非対話実行ではフェイク端末を注入し、
   * raw mode 化・resize・stdin 転送を検証/スキップできる。
   */
  readonly terminal?: TerminalLike;
  /**
   * テスト注入用 spawn seam (QA-1)。既定は `pty.spawn`。env は **ランナー側で buildChildEnv 構築**して
   * opts.env に渡すため、fake seam が受け取った `opts.env` を観測して leak ガードを falsifiable に固定できる
   * (codex-runner の `spawnChild`/`ChildLike` の PTY 版 mirror)。
   */
  readonly spawnPty?: (file: string, args: readonly string[], opts: PtySpawnOptions) => PtyLike;
}

/** spawnPty seam が受け取る spawn オプション (node-pty `IPty` spawn の本モジュール使用分)。 */
export interface PtySpawnOptions {
  readonly name: string;
  readonly cols: number;
  readonly rows: number;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * node-pty `IPty` の本モジュールが使う部分集合。実 PTY の代わりにフェイクを注入してユニット化する。
 */
export interface PtyLike {
  readonly pid: number;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

/** 既定 spawn seam: 実 node-pty で claude を起動する。テストは opts.spawnPty で差し替える。 */
function defaultSpawnPty(file: string, args: readonly string[], opts: PtySpawnOptions): PtyLike {
  return pty.spawn(file, [...args], {
    name: opts.name,
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd,
    env: opts.env,
  });
}

/** ユーザー端末の stdin 側 (process.stdin の部分集合)。 */
export interface TerminalInput {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): void;
  resume?(): void;
  pause?(): void;
  on(event: "data", listener: (chunk: Buffer | string) => void): void;
  off(event: "data", listener: (chunk: Buffer | string) => void): void;
}

/** ユーザー端末の stdout 側 (process.stdout の部分集合)。 */
export interface TerminalOutput {
  readonly isTTY?: boolean;
  readonly columns?: number;
  readonly rows?: number;
  write(data: string): boolean;
  on(event: "resize", listener: () => void): void;
  off(event: "resize", listener: () => void): void;
}

export interface TerminalLike {
  readonly stdin: TerminalInput;
  readonly stdout: TerminalOutput;
}

/** wireTerminal が返す復元ハンドル (idempotent)。 */
export interface TerminalBridge {
  /**
   * 端末状態 (raw mode / stdin/stdout/resize リスナ) を確実に復元する。
   * exit・stop・例外いずれの経路から複数回呼ばれても安全 (idempotent)。
   */
  restore(): void;
}

/**
 * 子 PTY とユーザー実端末を双方向接続する (LIVE-2)。collector への取り込みとは独立した「エコー」配線。
 *
 * (a) child data → terminal.stdout: 子出力を端末へエコー。
 * (b) terminal.stdin → child.write: キー入力を子へ転送。TTY なら raw mode。
 * (c) terminal resize (SIGWINCH) → child.resize。初期サイズも実端末に合わせる。
 * (d) restore(): raw mode を false に戻し全リスナを解除 (idempotent)。
 * (e) 非 TTY (CI/パイプ/テスト) では raw 化・resize・stdin 転送をスキップ (collector のみの既存挙動)。
 *
 * @param onChildData 子データを追加で流す先 (OutputCollector など)。エコーと両立させる。
 */
export function wireTerminal(
  child: PtyLike,
  term: TerminalLike,
  onChildData: (data: string) => void,
): TerminalBridge {
  const stdinIsTTY = term.stdin.isTTY === true && typeof term.stdin.setRawMode === "function";
  const stdoutIsTTY = term.stdout.isTTY === true;

  // (a) child data → collector (監視) + terminal.stdout (エコー)。両立させる。
  const onData = (data: string): void => {
    // 監視取り込みを先に行い、エコーで例外が出ても監視を落とさない。
    onChildData(data);
    try {
      term.stdout.write(data);
    } catch {
      /* 端末が閉じている等。監視は継続。 */
    }
  };
  const dataSub = child.onData(onData);

  // (b) terminal.stdin → child.write。TTY のときのみ raw mode + 転送を配線する。
  // 非 TTY (パイプ/CI/テスト) では setRawMode が無い/throw するため転送・raw 化をスキップ。
  let rawApplied = false;
  let stdinListener: ((chunk: Buffer | string) => void) | undefined;
  if (stdinIsTTY) {
    try {
      term.stdin.setRawMode?.(true);
      rawApplied = true;
    } catch {
      /* raw 化に失敗しても致命でない。エコーは継続。 */
    }
    term.stdin.resume?.();
    stdinListener = (chunk: Buffer | string): void => {
      try {
        child.write(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      } catch {
        /* 子が消滅。restore 経路で解除される。 */
      }
    };
    term.stdin.on("data", stdinListener);
  }

  // (c) 端末 resize (SIGWINCH) → child.resize。初期サイズも実端末に合わせる。
  let resizeListener: (() => void) | undefined;
  const applySize = (): void => {
    const cols = term.stdout.columns;
    const rows = term.stdout.rows;
    if (typeof cols === "number" && typeof rows === "number" && cols > 0 && rows > 0) {
      try {
        child.resize(cols, rows);
      } catch {
        /* 子が消滅。 */
      }
    }
  };
  if (stdoutIsTTY) {
    applySize(); // 初期サイズを実端末へ (ハードコード 120x40 を上書き)。
    resizeListener = applySize;
    term.stdout.on("resize", resizeListener);
  }

  // (d) restore(): raw mode を戻し全リスナ解除。idempotent。
  let restored = false;
  const disposeEcho = (): void => {
    try {
      dataSub.dispose();
    } catch {
      /* noop */
    }
  };
  const restore = (): void => {
    if (restored) return;
    restored = true;
    if (stdinListener) {
      try {
        term.stdin.off("data", stdinListener);
      } catch {
        /* noop */
      }
    }
    if (resizeListener) {
      try {
        term.stdout.off("resize", resizeListener);
      } catch {
        /* noop */
      }
    }
    if (rawApplied) {
      try {
        term.stdin.setRawMode?.(false);
      } catch {
        /* noop */
      }
    }
    // raw 化に伴い resume した stdin を pause し、プロセスを掴んだままにしない。
    if (stdinIsTTY) {
      try {
        term.stdin.pause?.();
      } catch {
        /* noop */
      }
    }
    disposeEcho();
  };

  return { restore };
}

export interface ManagedSession {
  readonly pid: number;
  readonly settingsPath: string;
  /** プロセス終了の Promise (exit code)。 */
  readonly exited: Promise<number>;
  /** PTY へ入力を書く (UI からの interrupt 等)。 */
  write(data: string): void;
  /** 対象 PID に限定して停止 (親や無関係 PID を巻き込まない)。 */
  stop(signal?: NodeJS.Signals): void;
  /** collector / monitor を停止し残バッファを flush。端末状態も復元する。 */
  dispose(): void;
}

export function startManagedClaude(opts: ManagedRunnerOptions): ManagedSession {
  const claudeBin = opts.claudeBin ?? "claude";
  const cwd = opts.cwd ?? process.cwd();
  const killGraceMs = opts.killGraceMs ?? 5_000;
  const term: TerminalLike = opts.terminal ?? process;

  // sidecar 専用 settings を一時ディレクトリへ生成 (ユーザー settings を汚さない)。
  const dir = mkdtempSync(join(tmpdir(), "actradeck-sidecar-"));
  const settingsPath = join(dir, "settings.json");
  writeHookSettings(settingsPath, opts.hookEndpoint, opts.hookToken);

  // --settings で sidecar hook 設定を読ませる。
  const args = ["--settings", settingsPath, ...(opts.claudeArgs ?? [])];

  // 初期 PTY サイズ: 実端末 (TTY) があればそれに合わせる。非 TTY なら従来の 120x40。
  const initialCols =
    term.stdout.isTTY === true && typeof term.stdout.columns === "number" && term.stdout.columns > 0
      ? term.stdout.columns
      : 120;
  const initialRows =
    term.stdout.isTTY === true && typeof term.stdout.rows === "number" && term.stdout.rows > 0
      ? term.stdout.rows
      : 40;

  // SEC: 全 env 継承をやめ allowlist 化 (task 019ea341-270f)。INGEST_TOKEN / ACTRADECK_* を
  // claude 子 (及び claude が起動する任意 shell) へ漏らさない。claude 自身の provider 認証
  // (Anthropic API / Bedrock / Vertex) のみ CLAUDE_EXTRA_ENV_KEYS / _PREFIXES で追加許可する。
  // env はランナー側で構築し seam に渡す → QA-1 で fake seam が opts.env を観測して配線を pin できる。
  const childEnv = buildChildEnv({
    extraAllowedKeys: CLAUDE_EXTRA_ENV_KEYS,
    extraAllowedPrefixes: CLAUDE_EXTRA_ENV_PREFIXES,
  });
  const spawnPty = opts.spawnPty ?? defaultSpawnPty;
  const child = spawnPty(claudeBin, args, {
    name: "xterm-color",
    cols: initialCols,
    rows: initialRows,
    cwd,
    env: childEnv,
  });

  // PTY 出力 collector。session 識別は SessionIdentity へ委譲 (固定 id を bake しない)。
  const collector = new OutputCollector({
    identity: opts.identity,
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    onEvent: (ev) => opts.sink.emit(ev),
  });

  // LIVE-2: 子 PTY とユーザー実端末を双方向接続する。collector への取り込み (監視) と
  // 端末エコー (視認) を両立させ、stdin (raw mode) を子へ転送する。非 TTY ではエコー配線のみ
  // を行い、collector は常に駆動する (= 既存挙動を保つ)。
  const bridge = wireTerminal(child, term, (d) => collector.push(d));

  // プロセス監視 → heartbeat。process heartbeat は単一シグナル (停止断定しない)。
  const monitor = new ProcessMonitor({
    pid: child.pid,
    ...(opts.heartbeatMs !== undefined ? { intervalMs: opts.heartbeatMs } : {}),
    onSample: (sample: ProcessSample) => {
      // 発生時刻を**今**固定 (hold されても観測時刻が timestamp に乗る)。
      const observedAt = new Date().toISOString();
      // heartbeat は周期的なので有界化時は最新優先で間引いてよい (category="heartbeat")。
      opts.identity.emitMonitoring("heartbeat", (canonicalSessionId) => {
        opts.sink.emit(
          buildEvent({
            session_id: canonicalSessionId,
            event_type: "heartbeat",
            timestamp: observedAt,
            ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
            summary: sample.alive ? "プロセス稼働中" : "プロセス消滅",
            payload: { kind: "heartbeat", process_alive: sample.alive },
            metrics: {
              elapsed_ms: sample.elapsed_ms,
              cpu_pct: sample.cpu,
              memory_bytes: sample.memory,
            },
          }),
        );
      });
    },
  });
  monitor.start();

  let resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  // exit / dispose の二重実行を防ぐ。端末復元は冪等だが collector/monitor.stop も一度に絞る。
  let teardownDone = false;
  // 強み(a): stop の SIGINT→SIGKILL escalation タイマ。child exit / teardown / 再 stop で clear する
  // (冪等・double-stop 安全・既 exit なら SIGKILL を撃たない)。
  let killTimer: NodeJS.Timeout | undefined;
  const teardown = (): void => {
    if (teardownDone) return;
    teardownDone = true;
    // child が exit したら未発火の SIGKILL 予約を解除する (死んだ PID へ撃たない)。
    if (killTimer) clearTimeout(killTimer);
    // (d) どの経路でも端末状態を確実に復元 (raw のまま放置しない)。
    bridge.restore();
    collector.stop();
    monitor.stop();
  };

  child.onExit(({ exitCode }) => {
    teardown();
    resolveExit(exitCode);
  });

  return {
    pid: child.pid,
    settingsPath,
    exited,
    write: (data: string) => child.write(data),
    stop: (signal: NodeJS.Signals = "SIGTERM") => {
      // 対象 PID に限定して kill (sidecar.md: 無関係 PID を巻き込まない)。
      // stop 時点でも端末状態を復元する (子 exit を待たずユーザー端末を戻す)。onExit でも
      // teardown するが冪等なので二重でも安全。
      bridge.restore();
      // 強み(a) 停止の確実性: signal (interrupt 経路では SIGINT) を送り、killGraceMs 以内に child が
      // exit しなければ SIGKILL へ昇格する (SIGINT を握り潰す TUI / 子シェルでも確実に停止)。
      // PID 限定 (escalateKill は child.kill のみ・負 PID/プロセスグループを撃たない)。child exit で
      // teardown が killTimer を clear する (冪等・double-stop 安全)。再 stop 時は前回 timer を解除して
      // から再武装する (二重武装しない)。
      if (killTimer) clearTimeout(killTimer);
      killTimer = escalateKill(child, { signal, graceMs: killGraceMs });
    },
    dispose: () => {
      teardown();
    },
  };
}
