import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { NormalizedEvent } from "@actradeck/event-model";

import {
  normalizeRolloutLine,
  sessionIdFromRolloutPath,
  type CodexRolloutLine,
} from "./normalize-codex-rollout.js";

export interface CodexRolloutTailerOptions {
  readonly codexHome?: string;
  readonly statePath?: string;
  readonly pollIntervalMs?: number;
  readonly backfill?: boolean;
  /** SEC-1: 1 read あたりの上限バイト数 (既定 16MiB)。主にテスト用の上書き seam。 */
  readonly maxTailChunk?: number;
  /**
   * Phase A.1: daemon 起動時 (initial・非 backfill) に既存 rollout ファイルを発見したとき、
   * **最終更新が now から本値以内** のファイルだけ先頭 session_meta を先読みして即 presence
   * 登録する (既走 codex session を Live Wall に即出す)。古いファイル (= 死んだセッション) は
   * presence 登録せず従来どおり tail-from-end のみ (Live Wall の false-presence flood を防ぐ)。
   * 既定 5 分。0 以下で無効 (= 従来挙動: 新行が来るまで presence 登録しない)。
   */
  readonly presenceRecencyMs?: number;
  readonly onEvents: (
    events: readonly NormalizedEvent[],
    meta: { readonly file: string; readonly sessionId: string; readonly byteOffset: number },
  ) => void;
  readonly onSessionContext?: (ctx: {
    readonly sessionId: string;
    readonly cwd?: string | undefined;
    readonly file: string;
  }) => void;
  readonly onWarning?: (message: string) => void;
}

interface OffsetEntry {
  offset: number;
  sessionId?: string;
  cwd?: string;
  updatedAt: string;
}

interface OffsetState {
  version: 1;
  files: Record<string, OffsetEntry>;
}

interface FileRuntime {
  sessionId: string;
  cwd?: string;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;
/** Phase A.1: 既走 session 即 presence の既定 recency 窓 (5 分)。 */
const DEFAULT_PRESENCE_RECENCY_MS = 5 * 60_000;
/** session_meta 読取りの先頭バイト上限 (maxTailChunk が小さければ更に min で抑える)。 */
const PRESENCE_HEAD_READ_BYTES = 64 * 1024;

function defaultCodexHome(): string {
  return process.env.CODEX_HOME && process.env.CODEX_HOME.length > 0
    ? process.env.CODEX_HOME
    : join(homedir(), ".codex");
}

function defaultStatePath(): string {
  return join(homedir(), ".actradeck", "codex-rollout-offsets.json");
}

function emptyState(): OffsetState {
  return { version: 1, files: {} };
}

function readState(path: string): OffsetState {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<OffsetState>;
    return parsed.version === 1 && parsed.files && typeof parsed.files === "object"
      ? { version: 1, files: parsed.files as Record<string, OffsetEntry> }
      : emptyState();
  } catch {
    return emptyState();
  }
}

// NOTE (TDA-1): offset state は secret を含まない (ファイル名と byte offset のみ) ため
// fs-atomic.ts の writeJson0600 (0600 強制) は意図的に使わず、素の atomic write に留める。
function writeState(path: string, state: OffsetState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

async function listRolloutFiles(root: string): Promise<string[]> {
  async function walk(dir: string): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const files: string[] = [];
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) files.push(...(await walk(full)));
      else if (entry.isFile() && /^rollout-.+\.jsonl$/.test(entry.name)) files.push(full);
    }
    return files;
  }
  return walk(join(root, "sessions"));
}

export class CodexRolloutTailer {
  /** SEC-1: 1 read あたりの上限バイト数。新領域全体の一括 alloc による OOM を防ぐ。 */
  private static readonly MAX_TAIL_CHUNK = 16 * 1024 * 1024;

  private readonly codexHome: string;
  private readonly statePath: string;
  private readonly pollIntervalMs: number;
  private readonly backfill: boolean;
  private readonly maxTailChunk: number;
  private readonly presenceRecencyMs: number;
  private readonly onEvents: CodexRolloutTailerOptions["onEvents"];
  private readonly onSessionContext: CodexRolloutTailerOptions["onSessionContext"];
  private readonly onWarning: (message: string) => void;
  private readonly state: OffsetState;
  private readonly runtime = new Map<string, FileRuntime>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private started = false;
  private scanning = false;
  // in-flight scan の promise。stop() が setInterval 由来の in-flight scan を確実に await し、
  // store.close (daemon.shutdown が stop() の後に呼ぶ) より前に emit を完走させるための握り
  // (shutdown race・TDA-1 H / QA-4)。scanOnce が scan 中に再呼出されたら早期 undefined でなく
  // この promise を返す。
  private currentScan: Promise<void> | undefined;

  constructor(opts: CodexRolloutTailerOptions) {
    this.codexHome = opts.codexHome ?? defaultCodexHome();
    this.statePath = opts.statePath ?? defaultStatePath();
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.backfill = opts.backfill ?? false;
    this.maxTailChunk =
      opts.maxTailChunk !== undefined && opts.maxTailChunk > 0
        ? opts.maxTailChunk
        : CodexRolloutTailer.MAX_TAIL_CHUNK;
    this.presenceRecencyMs = opts.presenceRecencyMs ?? DEFAULT_PRESENCE_RECENCY_MS;
    this.onEvents = opts.onEvents;
    this.onSessionContext = opts.onSessionContext;
    this.onWarning = opts.onWarning ?? (() => {});
    this.state = readState(this.statePath);
  }

  get offsets(): Readonly<Record<string, OffsetEntry>> {
    return this.state.files;
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.scanOnce({ initial: true });
    this.timer = setInterval(() => void this.scanOnce({ initial: false }), this.pollIntervalMs);
    this.timer.unref?.();
    this.started = true;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    // shutdown race の核心: in-flight scan があれば scanOnce はその promise を返すので、この
    // `await` が setInterval 由来の in-flight scan を **drain** する (早期 return で握りつぶさない)。
    // daemon.shutdown は stop() の後に store.close を呼ぶため、in-flight scan の emit は close 前に
    // 完了する。握りつぶすと閉じた DB へ append し、rollout daemon 経路は unhandledRejection handler
    // を持たない (cli.ts mainCodexRolloutAttach) ためプロセスクラッシュになる (TDA-1 H / QA-4)。
    // in-flight が無ければ最終ドレインの fresh scan を実行する。
    await this.scanOnce({ initial: false });
    this.persist();
  }

  async scanOnce(opts: { initial?: boolean } = {}): Promise<void> {
    // 既に scan 中なら **その in-flight scan の promise を返す** (早期に undefined を返して
    // 握りつぶさない)。これにより stop() / 同時呼出が in-flight scan の完了を確実に await でき、
    // shutdown 時の emit-after-close race を防ぐ (TDA-1 H / QA-4)。
    if (this.scanning) return this.currentScan ?? Promise.resolve();
    this.scanning = true;
    this.currentScan = (async (): Promise<void> => {
      try {
        const files = await listRolloutFiles(this.codexHome);
        files.sort();
        for (const file of files) {
          await this.processFile(file, opts.initial ?? false);
        }
        this.persist();
      } finally {
        this.scanning = false;
        this.currentScan = undefined;
      }
    })();
    return this.currentScan;
  }

  private persist(): void {
    try {
      writeState(this.statePath, this.state);
    } catch (err) {
      this.onWarning(
        `codex rollout offset persist failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async processFile(file: string, initial: boolean): Promise<void> {
    let st;
    try {
      st = await stat(file);
    } catch {
      return;
    }
    if (!st.isFile()) return;

    let entry = this.state.files[file];
    const isKnown = entry !== undefined;
    if (entry === undefined) {
      const inferredSessionId = sessionIdFromRolloutPath(file) ?? basename(file);
      entry = {
        offset: initial && !this.backfill ? st.size : 0,
        sessionId: inferredSessionId,
        updatedAt: new Date().toISOString(),
      };
      this.state.files[file] = entry;
      this.runtime.set(file, { sessionId: inferredSessionId });
    }
    if (entry.offset > st.size) {
      entry.offset = this.backfill ? 0 : st.size;
      entry.updatedAt = new Date().toISOString();
    }
    if (!isKnown && initial && !this.backfill) {
      // Phase A.1: tail-from-end で既存ファイルを初回発見したとき、**最近書き込まれた (= 既走)**
      //   ファイルなら先頭 session_meta だけ読み presence を即登録する (events は emit せず offset
      //   は st.size のまま)。古いファイル (死んだセッション) は登録せず Live Wall の flood を防ぐ。
      if (this.presenceRecencyMs > 0 && Date.now() - st.mtimeMs <= this.presenceRecencyMs) {
        await this.primePresence(file, entry);
      }
      return;
    }
    if (st.size <= entry.offset) return;

    await this.readNewLines(file, entry, st.size);
  }

  /**
   * Phase A.1: ファイルの先頭 session_meta だけを bounded read し presence を登録する
   * (events は emit しない・offset は変えない)。既走 codex session を daemon 起動直後に
   * Live Wall へ即出すための presence-only prime。先頭行が壊れている / 手がかり (session_meta id
   * か cwd) が無い場合は何もしない (通常の tail が後続行で presence を登録する)。
   */
  private async primePresence(file: string, entry: OffsetEntry): Promise<void> {
    if (this.onSessionContext === undefined) return;
    let handle;
    try {
      handle = await open(file, "r");
    } catch {
      return;
    }
    try {
      // session_meta は小さいので先頭最大 64KiB (maxTailChunk が小さければ更に上限化) だけ読めば十分。
      const cap = Math.min(this.maxTailChunk, PRESENCE_HEAD_READ_BYTES);
      const chunk = Buffer.alloc(cap);
      const { bytesRead } = await handle.read(chunk, 0, cap, 0);
      if (bytesRead === 0) return;
      const nl = chunk.indexOf(0x0a);
      if (nl < 0) return; // 改行が cap 内に無い = 異常に長い先頭行 → tail に委ねる。
      const firstLine = chunk.subarray(0, nl).toString("utf8").trim();
      if (firstLine.length === 0) return;
      let line: CodexRolloutLine;
      try {
        line = JSON.parse(firstLine) as CodexRolloutLine;
      } catch {
        return; // 壊れた先頭行は presence 登録しない。
      }
      const payload = line.payload !== null && typeof line.payload === "object" ? line.payload : {};
      const p = payload as Record<string, unknown>;
      const sessionMetaId =
        line.type === "session_meta" && typeof p.id === "string" ? p.id : undefined;
      const cwd =
        (line.type === "session_meta" || line.type === "turn_context") && typeof p.cwd === "string"
          ? p.cwd
          : undefined;
      // presence の手がかり (session_meta id か cwd) が無ければ何もしない。
      if ((sessionMetaId === undefined || sessionMetaId.length === 0) && cwd === undefined) return;
      const runtime = this.runtime.get(file) ?? {
        sessionId: entry.sessionId ?? sessionIdFromRolloutPath(file) ?? basename(file),
      };
      if (sessionMetaId !== undefined && sessionMetaId.length > 0)
        runtime.sessionId = sessionMetaId;
      if (cwd !== undefined) runtime.cwd = cwd;
      this.runtime.set(file, runtime);
      entry.sessionId = runtime.sessionId;
      if (runtime.cwd !== undefined) entry.cwd = runtime.cwd;
      this.onSessionContext({ sessionId: runtime.sessionId, cwd: runtime.cwd, file });
    } finally {
      await handle.close();
    }
  }

  private async readNewLines(file: string, entry: OffsetEntry, size: number): Promise<void> {
    // SEC-1: 1 read を MAX_TAIL_CHUNK で上限化し、1 scan 内で複数 read を回して全行を処理する。
    //   旧実装は新領域全体 (size-offset) を単一 Buffer.alloc していたため、巨大 rollout
    //   (実例 61MB) や glob に置かれた巨大 JSONL の発見/backfill で OOM しうる。メモリは常に
    //   <= cap に有界。改行を含まない完全な末尾行は offset を進めず次データを待つ (従来挙動)。
    const cap = this.maxTailChunk;
    const handle = await open(file, "r");
    try {
      while (entry.offset < size) {
        const startOffset = entry.offset;
        const length = Math.min(size - startOffset, cap);
        const chunk = Buffer.alloc(length);
        await handle.read(chunk, 0, length, startOffset);
        const completeEnd = chunk.lastIndexOf(0x0a);
        if (completeEnd < 0) {
          // chunk 内に改行なし。
          if (length < cap) return; // EOF までの未完了な末尾行 → 次データ/改行を待つ (offset 据置)。
          // 単一行が cap 超過 → stall 回避のため cap 分 offset を前進し当該行を drop+warn。
          //   残バイトは次反復で読まれ、行末改行までの断片は processLine の JSON.parse 失敗で drop。
          this.onWarning(
            `codex rollout oversized line skipped (> ${cap} bytes) file=${file} offset=${startOffset}`,
          );
          entry.offset = startOffset + length;
          entry.updatedAt = new Date().toISOString();
          continue;
        }
        let lineStart = 0;
        for (let i = 0; i <= completeEnd; i++) {
          if (chunk[i] !== 0x0a) continue;
          const lineOffset = startOffset + lineStart;
          const line = chunk.subarray(lineStart, i).toString("utf8");
          lineStart = i + 1;
          if (line.trim().length === 0) continue;
          this.processLine(file, entry, line, lineOffset);
        }
        entry.offset = startOffset + completeEnd + 1;
        entry.updatedAt = new Date().toISOString();
      }
    } finally {
      await handle.close();
    }
  }

  private processLine(file: string, entry: OffsetEntry, raw: string, byteOffset: number): void {
    let line: CodexRolloutLine;
    try {
      line = JSON.parse(raw) as CodexRolloutLine;
    } catch {
      this.onWarning(`codex rollout invalid JSON dropped file=${file} offset=${byteOffset}`);
      return;
    }

    const payload = line.payload !== null && typeof line.payload === "object" ? line.payload : {};
    const p = payload as Record<string, unknown>;
    const runtime = this.runtime.get(file) ?? {
      sessionId: entry.sessionId ?? sessionIdFromRolloutPath(file) ?? basename(file),
    };

    const sessionMetaId =
      line.type === "session_meta" && typeof p.id === "string" ? p.id : undefined;
    if (sessionMetaId !== undefined && sessionMetaId.length > 0) runtime.sessionId = sessionMetaId;
    const cwd =
      (line.type === "session_meta" || line.type === "turn_context") && typeof p.cwd === "string"
        ? p.cwd
        : undefined;
    if (cwd !== undefined) runtime.cwd = cwd;
    this.runtime.set(file, runtime);
    entry.sessionId = runtime.sessionId;
    if (runtime.cwd !== undefined) entry.cwd = runtime.cwd;

    if (cwd !== undefined || line.type === "session_meta") {
      this.onSessionContext?.({ sessionId: runtime.sessionId, cwd: runtime.cwd, file });
    }

    const events = normalizeRolloutLine(line, {
      sessionId: runtime.sessionId,
      cwd: runtime.cwd,
      byteOffset,
      sourcePath: file,
      onWarning: this.onWarning,
    });
    if (events.length > 0) {
      this.onEvents(events, { file, sessionId: runtime.sessionId, byteOffset });
    }
  }
}
