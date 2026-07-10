/**
 * codex-spawn-manager — cockpit からの daemon-relayed Codex Managed spawn (ADR 019f4206 A段)。
 *
 * attach daemon が既存 CodexRunner (`startManagedCodex`) を **in-process** で起動する単一出所。
 * agentmon 子プロセスは spawn しない (prompt が argv/ps に載るため・契約点1)。prompt は turn/start の
 * JSON-RPC 経由でのみ渡す (shell/argv 非接触)。承認・redaction・sink は attach daemon と同じ実体を共有する
 * (CodexApprovalBridge は startManagedCodex 内部で approvalBridge をラップし、UI 承認 relay が既存経路で効く)。
 *
 * 契約 (ADR 019f4206):
 *  - **契約点2 (spawn_capable 既定 OFF)**: `enabled=false` なら受信しても値ベース `spawn_disabled` deny。
 *  - **契約点3 (cwd 二段封じ込め)**: 本 manager は第二段 — 解決済 **物理 git root** を正準 `isPathWithinScope`
 *    (event-model 共有 helper) で resolveScope と再照合する。第一段 (入力 path lexical) は backend が担う。
 *    repo 同定は per-repo policy resolve と同じ canonical `RepoScopeResolver` を共有する (手書きコピー禁止・
 *    security-gate-reuse-canonical-parser)。
 *  - **契約点5 (多重 spawn cap)**: 同時 managed codex 数を cap し、超過は値ベース `spawn_cap_reached` deny
 *    (throw 禁止 = SEC-R3-3: control handler の拒否は return/値)。
 *  - **契約点7 (INV-ATTACH-NO-KILL 既定保存)**: attach daemon は既定でセッションを kill しないが、
 *    **本 manager が spawn した managed session に限り** stop 可 (spawn した子の所有権を持つため正当)。
 *
 * NO-RAW (契約点6): prompt / cwd を診断・ログ・at-rest に残さない。失敗は closed enum code のみ返す。
 */
import { randomBytes } from "node:crypto";

import {
  isPathWithinScope,
  type CodexSpawnParams,
  type CodexSpawnErrorCode,
  type CodexSpawnResult,
} from "@actradeck/event-model";

import type { ApprovalBridge, RepoScopeResolver } from "./approval-bridge.js";
import {
  startManagedCodex,
  type CodexManagedSession,
  type CodexRunnerOptions,
  type ChildLike,
  type ChildSpawnOptions,
} from "./codex-runner.js";
import type { EventSink } from "./sink.js";
import { SessionIdentity } from "./session-identity.js";

/** 同時 managed codex 数の既定 cap (env `ACTRADECK_CODEX_SPAWN_MAX` で上書き・0/負値は既定)。 */
export const DEFAULT_CODEX_SPAWN_MAX = 3;
/** canonical (thread.id) 確定タイムアウト (ms)。未確定 held の永久保持を防ぐ。 */
const SPAWN_IDENTITY_FLUSH_MS = 30_000;

/** spawn 1 回の入力 (backend relay から daemon handler 経由で渡る)。 */
export interface CodexSpawnRequest extends CodexSpawnParams {
  /**
   * ADR 契約点3 第二段: backend の ACTRADECK_PROJECT_SCOPE prefix 群。解決済 git root をこれと再照合する。
   * 空 = 封じ込め無し (backend default-off・per-repo policy resolve と同一意味論)。secret でない・非永続・非 echo。
   */
  readonly resolveScope?: readonly string[];
}

export interface CodexSpawnManagerOptions {
  readonly sink: EventSink;
  readonly approvalBridge: ApprovalBridge;
  /** ADR 契約点3: cwd→git root 解決器 (per-repo policy resolve と同一 canonical 実体を共有)。 */
  readonly resolveRepoScope: RepoScopeResolver;
  /**
   * ADR 契約点2: `ACTRADECK_ENABLE_CODEX_SPAWN=1` opt-in 時のみ true。false なら受信しても値ベース deny。
   */
  readonly enabled: boolean;
  /** 同時 managed codex 数の cap (既定 DEFAULT_CODEX_SPAWN_MAX)。 */
  readonly spawnMax?: number;
  /** codex 実行パス (既定 PATH 上の "codex")。 */
  readonly codexBin?: string;
  /**
   * テスト注入: 実 startManagedCodex を差し替える seam。既定は本物。INV-SPAWN-PROMPT-VIA-JSONRPC は
   * spawnChild を注入して argv を捕捉するため、既定経路 (実 startManagedCodex) を保つ。
   */
  readonly startCodex?: (opts: CodexRunnerOptions) => CodexManagedSession;
  /**
   * テスト注入: startManagedCodex へ渡す child_process spawn seam。INV は fake child で argv/env を捕捉する。
   * NO-RAW: 本 manager は prompt/cwd を seam へ渡さない (prompt は runner 内 turn/start・cwd は spawn opts.cwd)。
   */
  readonly spawnChild?: (
    file: string,
    args: readonly string[],
    opts: ChildSpawnOptions,
  ) => ChildLike;
}

interface ActiveSpawn {
  readonly session: CodexManagedSession;
  readonly identity: SessionIdentity;
}

/**
 * spawn した managed codex を追跡し、cap / 封じ込め / lifecycle を管理する。1 attach daemon に 1 インスタンス。
 */
export class CodexSpawnManager {
  private readonly opts: CodexSpawnManagerOptions;
  private readonly spawnMax: number;
  private readonly active = new Set<ActiveSpawn>();
  /**
   * 契約点5 (cap TOCTOU hard-cap・QA-1): `handleSpawn` が `resolveRepoScope` を await している間に予約中の
   * スロット数。cap 判定は「active + 予約中」に対して行い、並行 spawn が全員 cap gate を通過する race を閉じる。
   */
  private reserved = 0;
  private disposed = false;

  constructor(opts: CodexSpawnManagerOptions) {
    this.opts = opts;
    this.spawnMax =
      opts.spawnMax !== undefined && opts.spawnMax > 0 ? opts.spawnMax : DEFAULT_CODEX_SPAWN_MAX;
  }

  /** 現在アクティブな spawned managed codex 数。 */
  get activeCount(): number {
    return this.active.size;
  }

  /**
   * 確定済み canonical (thread.id) の session_id 群 (hello.session_ids へ相乗り)。未確定 (handshake 前) の
   * fallback id は載せない — events に現れない phantom presence を作らないため (確定後に canonical で出現する)。
   */
  activeSessionIds(): string[] {
    const out: string[] = [];
    for (const a of this.active) {
      if (a.identity.isResolved()) {
        const id = a.identity.resolvedSessionId();
        if (id !== undefined) out.push(id);
      }
    }
    return out;
  }

  /**
   * spawn 要求を処理する。**値ベース** (deny も throw せず CodexSpawnResult を返す = SEC-R3-3)。
   *  - disabled → spawn_disabled。
   *  - cap 超過 → spawn_cap_reached。
   *  - cwd が git root 解決不能 / 解決済 root が resolveScope 外 → cwd_out_of_scope。
   *  - 子プロセス起動失敗 (pid 不在) → spawn_failed。
   */
  async handleSpawn(req: CodexSpawnRequest): Promise<CodexSpawnResult> {
    if (this.disposed || !this.opts.enabled) return this.deny("spawn_disabled");
    // 契約点5 (cap TOCTOU hard-cap・QA-1): cap 判定は「active + 予約中」に対して行い、await
    //   (resolveRepoScope) の**前**に同期でスロットを予約する。JS は single-thread ゆえ interleave は await
    //   跨ぎでのみ起きる — 予約を await の手前に置くことで、並行 spawn が全員 cap gate を通過する race を
    //   構造的に閉じる (旧: 判定が await 前・active.add が await 後 → spawnMax=1 でも 3 並行が 3 起動しえた)。
    //   その後の全 deny/失敗/例外経路は finally が予約を解放する (deny 後に再 spawn 可能)。値ベース deny 契約
    //   (throw 禁止 = SEC-R3-3) は維持。
    if (this.active.size + this.reserved >= this.spawnMax) return this.deny("spawn_cap_reached");
    this.reserved += 1;
    try {
      // 契約点3 第二段: 解決済 **物理 git root** を resolveScope と再照合する (canonical helper 共有)。
      const scope = req.resolveScope ?? [];
      const resolved = await this.opts.resolveRepoScope(req.cwd);
      if (resolved === undefined) return this.deny("cwd_out_of_scope"); // 非 git / 解決不能 → 封じ込め不能。
      if (scope.length > 0 && !isPathWithinScope(resolved.root, scope)) {
        return this.deny("cwd_out_of_scope"); // symlink 脱出 / ancestor-root が scope 外。
      }

      // 契約点1: in-process spawn。prompt は turn/start (JSON-RPC) のみ・argv 非接触。
      const identity = new SessionIdentity({
        fallbackSessionId: `codex-managed-${randomBytes(8).toString("hex")}`,
        flushTimeoutMs: SPAWN_IDENTITY_FLUSH_MS,
      });
      const runnerOpts: CodexRunnerOptions = {
        sink: this.opts.sink,
        approvalBridge: this.opts.approvalBridge,
        identity,
        cwd: req.cwd,
        initialPrompt: req.prompt,
        ...(this.opts.codexBin !== undefined ? { codexBin: this.opts.codexBin } : {}),
        ...(this.opts.spawnChild !== undefined ? { spawnChild: this.opts.spawnChild } : {}),
      };
      const start = this.opts.startCodex ?? startManagedCodex;
      let session: CodexManagedSession;
      try {
        session = start(runnerOpts);
      } catch {
        // 同期 spawn 例外 (稀) も NO-RAW な closed enum へ縮退 (原文非依存)。
        identity.dispose();
        return this.deny("spawn_failed");
      }
      // 子プロセスが OS レベルで起動しなかった (ENOENT 等) → pid 未定義。dispose して cap を消費しない。
      if (session.pid === undefined) {
        session.dispose();
        identity.dispose();
        return this.deny("spawn_failed");
      }

      const entry: ActiveSpawn = { session, identity };
      this.active.add(entry);
      // exit で active から除去 (cap を解放)。dispose は teardown 済でも二重呼び安全。
      void session.exited.finally(() => {
        this.active.delete(entry);
      });
      // 契約点6: 応答に prompt/cwd を載せない。session_id は未確定 (handshake 前) ゆえ省略。
      return { ok: true };
    } finally {
      // 予約を解放する。成功時は active へ移譲済 (同期区間で active.add→return→finally ゆえ二重計上窓なし)、
      // deny/失敗/例外時は cap を消費しない。
      this.reserved -= 1;
    }
  }

  /**
   * 契約点7: spawn した managed session に限り stop する (opt-in・INV-ATTACH-NO-KILL の例外)。所有していない
   * 任意 session_id は no-op (非所有 PID を kill しない)。戻り値 = 停止対象が見つかったか。
   *
   * **未配線の開示 (SEC-3 / TDA-5・裁定 019f4244)**: 本メソッドは API-only であり、backend route / UI 導線から
   * は**未配線**である (現 caller は `dispose()` 内 teardown と本 manager の test のみ)。したがって cockpit の
   * 操作経路から任意 session を kill する手段は存在せず、**INV-ATTACH-NO-KILL は既定で保存される** (spawn した
   * 子の所有権に基づく停止という設計上の例外口は用意済だが、外部トリガは配線されていない)。stop 導線を将来
   * 配線する際は、非所有 PID no-op と所有権チェックがこの単一出所を通ることを保つこと。
   */
  stop(sessionId: string): boolean {
    for (const a of this.active) {
      if (a.identity.resolvedSessionId() === sessionId) {
        a.session.stop();
        return true;
      }
    }
    return false;
  }

  /** graceful shutdown: 全 spawned session を dispose (未送信は sink 経由 flush)。 */
  dispose(): void {
    this.disposed = true;
    for (const a of this.active) {
      a.session.dispose();
      a.identity.dispose();
    }
    this.active.clear();
  }

  private deny(error: CodexSpawnErrorCode): CodexSpawnResult {
    return { ok: false, error };
  }
}
