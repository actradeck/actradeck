/**
 * Process monitor — 対象 PID の生存 / CPU / memory / elapsed を監視し heartbeat 化。
 *
 * liveness は単一シグナルで「停止」を断定しない (sidecar.md / plan.md §5)。本モジュールは
 * 「プロセス heartbeat」という 1 シグナルを供給するのみ。stalled の合成判定は Phase 3
 * (backend) が複数 heartbeat (process / event / stdout / model-stream) を合成して行う。
 *
 * プロセス制御は対象 PID に限定する (親や無関係 PID を巻き込まない)。
 */
import pidusage from "pidusage";

export interface ProcessSample {
  readonly pid: number;
  readonly alive: boolean;
  readonly cpu: number; // %
  readonly memory: number; // bytes
  readonly elapsed_ms: number;
}

// liveness 合成 (process / event / stdout / model-stream の 4 heartbeat の age を合成し、
// 単一シグナルで「停止」を断定しない) は **backend が正典** (apps/backend/src/liveness.ts、
// INV-STALLED + INV-LIVENESS-PARITY ガード付き)。sidecar は本モジュールで「process heartbeat」
// という 1 シグナルを供給するのみで、合成判定は持たない (再#3 TDA-1: sidecar 側の重複実装は
// 未配線デッドコードかつ閾値ドリフトの温床だったため撤去し、正典を一本化した)。

export interface ProcessMonitorOptions {
  readonly pid: number;
  /** heartbeat 間隔 (ms)。plan.md §17: heartbeat 5s 以内。 */
  readonly intervalMs?: number;
  readonly onSample: (sample: ProcessSample) => void;
}

export class ProcessMonitor {
  private readonly pid: number;
  private readonly intervalMs: number;
  private readonly onSample: (sample: ProcessSample) => void;
  private readonly startedAt = Date.now();
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(opts: ProcessMonitorOptions) {
    this.pid = opts.pid;
    this.intervalMs = opts.intervalMs ?? 5_000;
    this.onSample = opts.onSample;
  }

  start(): void {
    const tick = async (): Promise<void> => {
      if (this.stopped) return;
      const sample = await this.sampleOnce();
      // shutdown race: `await this.sampleOnce()` の境界で stop() が走ると (dispose→monitor.stop
      // + その後 store.close)、in-flight tick が停止後に onSample(→sink.emit→閉じた SQLite)を
      // 呼んで unhandled rejection になる (tick は void で fire-and-forget)。await 後に stopped を
      // 再チェックして停止後の emit を防ぐ。onSample/sink.emit は同期なので、この guard を通過後は
      // close と交錯せず完走する (唯一の yield 点は sampleOnce の await)。
      if (this.stopped) return;
      this.onSample(sample);
      if (!this.stopped) this.timer = setTimeout(() => void tick(), this.intervalMs);
    };
    this.timer = setTimeout(() => void tick(), this.intervalMs);
  }

  /** 1 回サンプリング (テストからも直接呼べる)。 */
  async sampleOnce(): Promise<ProcessSample> {
    try {
      const s = await pidusage(this.pid);
      return {
        pid: this.pid,
        alive: true,
        cpu: s.cpu,
        memory: s.memory,
        elapsed_ms: Date.now() - this.startedAt,
      };
    } catch {
      // pidusage は対象プロセス消滅時に throw する → 「生存していない」と観測。
      return {
        pid: this.pid,
        alive: false,
        cpu: 0,
        memory: 0,
        elapsed_ms: Date.now() - this.startedAt,
      };
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    // pidusage の内部監視をクリア (リーク防止)。
    try {
      pidusage.clear();
    } catch {
      /* noop */
    }
  }
}
