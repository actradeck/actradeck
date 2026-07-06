/**
 * Safety Demo Launcher — first-run セーフティデモの起動コントローラ (ADR 019f22a7 P1).
 *
 * cockpit の CTA から `POST /realtime/demo/safety` (realtime-server.ts) が呼ばれると、hold モードで
 * 使い捨て `demo-safety-<short>` セッションを **実パイプライン** (driver → ingestion → event store) で
 * 起動し、UI が live 一覧 / Approval Inbox / replay で focus できるよう session_id を返す。
 *
 * driver 昇格 (decision 019f387f): 起動対象は backend 自身の src に同居する **native-free 単一 driver**
 * (`safety-demo-driver.ts`) で、apps/sidecar/* / better-sqlite3 / node-pty を一切引かない。Docker cockpit
 * image は apps/backend + tsx (prod dep) + node_modules を COPY 済ゆえ、container 内で driver が解決し
 * **host 配線ゼロ**で self-run できる (旧 `apps/sidecar/e2e/run-safety-demo.mts` は image 非 COPY で 503 だった)。
 *
 * 実行サーフェスの封じ込め (security.md 最優先):
 *  - **固定コマンド / 固定コードパスのみ**を起動する。driver を backend 自身の node (`process.execPath`) +
 *    tsx ローダで **verbatim** に子プロセス spawn する (pnpm を介さず PATH 非依存)。**ユーザー入力を
 *    argv / コマンドへ一切渡さない** (session_id は内部生成の `demo-safety-<hex>`・env 経由でのみ子へ渡す
 *    = injection 皆無)。
 *  - INGEST_TOKEN は起動時に検証済みの値 (buildIngestionServer が非空を保証) を子 env へ注入する
 *    (ハードコードしない)。子 sidecar は temp SQLite を使い PG にも REALTIME_TOKEN にも実依存しない
 *    (WS 送信は `/ingest/ws` へ INGEST_TOKEN のみ)。ゆえに最小権限として backend の
 *    **REALTIME_TOKEN / DATABASE_URL / libpq 系 (PG*)** を子 env から scrub する
 *    (allowlist ではなく機微 key の scrub = node/tsx が要する基盤 env は保持しつつ機微だけ落とす)。
 *  - **多重起動は 1 本に抑止**: 走行中は新規 spawn せず現行 session_id を返す (idempotent)。
 *    子の exit / spawn error で状態をクリアし次回起動を許す。
 *  - shutdown で走行中デモを kill する (dispose)。
 *
 * 起動方式の選択 = **子プロセス spawn (方式 a)** を採用 (in-process import ではなく):
 *  - driver を **独立プロセス** に閉じることで backend プロセスの lifecycle / メモリと分離する
 *    (デモ子が異常終了しても backend は無傷)。固定 argv ゆえ shell 不要 (shell:false) で injection なし。
 *  - driver は native-free ゆえ in-process import でも native addon 混入の懸念は無いが、独立プロセスの
 *    ライフサイクル分離 (単発起動・SIGTERM kill・多重起動抑止) を素直に表現できる spawn を継続採用する。
 *
 * production の到達性 (正直な開示):
 *  - `process.execPath` (backend の node) は常在ゆえ **PATH 非依存**で起動する (旧 `spawn('pnpm', …)` は
 *    systemd --user の最小 PATH に pnpm が無いと ENOENT で黙って失敗した — ADR 019f280c 実機検出・解消済)。
 *  - **Docker cockpit / repo 実行では動く**: driver は backend src の sibling で、cwd=apps/backend から
 *    tsx (prod dep) が解決する。残る前提は `tsx` + node_modules が **実行時に存在すること**。
 *  - **素の dist-only node 配備 (tsx/node_modules なし) では依然起動できない**が、それは driver 不在で
 *    `enabled=false` に畳まれ launch() が **503** を返す (fail-loud・silent no-op にしない)。route の 404 は
 *    launcher を一切配線しない配備 (`demoLauncher===undefined`) 専用で、driver 不在ケースには到達しない。
 *  - spawn 失敗 (tsx 不在等) は spawn の性質上 **非同期 'error'** でしか判らず、その場合 launch() は
 *    既に session_id を返した後になる (子は現れない)。'error' で状態をクリアしログする。
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SAFETY_DEMO_SESSION_PREFIX } from "./safety-demo-script.js";

/** 使い捨てデモ session_id の prefix — 単一出所は safety-demo-script.ts (driver と共有・再 export)。 */
export { SAFETY_DEMO_SESSION_PREFIX };

/**
 * 子デモへ伝播させない機微 env の名前 (最小権限・SEC-1/TDA-1)。子 sidecar は temp SQLite を使い
 * PG にも REALTIME_TOKEN にも実依存しないため、backend の credential を子プロセスへ流入させない。
 * libpq 系 (PG*) は prefix で別途 scrub する (`isLibpqEnvKey`)。
 */
export const SCRUBBED_CHILD_ENV_KEYS: readonly string[] = ["REALTIME_TOKEN", "DATABASE_URL"];

/**
 * libpq (PostgreSQL client) が参照する接続 env の prefix 判定 (PGPASSWORD/PGUSER/PGHOST/
 * PGDATABASE/PGPORT/PGSSLMODE 等)。scrub 対象を列挙でなく構造 (prefix) で捕捉しドリフトを防ぐ。
 */
export function isLibpqEnvKey(key: string): boolean {
  return /^PG[A-Z0-9_]/.test(key);
}

/**
 * process.env を基に、node/tsx 実行に要る基盤 env は保持しつつ機微 env (REALTIME_TOKEN /
 * DATABASE_URL / libpq PG*) を scrub し、デモ子プロセス用の env を組み立てる。demo vars は上書き注入。
 *
 * SEC-1 (denylist↔allowlist トレードオフ・正直な開示): これは **allowlist ではなく denylist** (機微 key を
 * 落とし残りは継承)。denylist は **ActraDeck 自身の secret を全カバー**する — INGEST_TOKEN は起動時検証済み
 * 値で authoritative に上書き注入し、REALTIME_TOKEN / DATABASE_URL / PG* (libpq) は構造 (prefix) で scrub。
 * よって ActraDeck の credential は子へ流入しない。無関係な operator secret (例: 他ツールの API key env) は
 * 継承しうるが、子 driver は固定コードパス (safety-demo-driver) で **任意 egress 経路を持たない** (ws は
 * INGEST_TOKEN 認証の /ingest/ws のみ・redaction floor 通過) ため exfil 面はゼロ。single-operator / loopback /
 * local-fs 信頼境界の内側ゆえ accepted (allowlist 化は基盤 env の網羅が脆く node/tsx 起動を壊すリスクが上回る)。
 */
export function buildDemoChildEnv(inject: {
  ingestToken: string;
  sessionId: string;
  wsUrl?: string | undefined;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (SCRUBBED_CHILD_ENV_KEYS.includes(key) || isLibpqEnvKey(key)) {
      delete env[key];
    }
  }
  // 起動時検証済みの authoritative token を注入 (env 汚染に左右されない)。
  env.INGEST_TOKEN = inject.ingestToken;
  // hold モード固定: 承認カードを pending で保持し UI の Deny を待つ (P1 の肝)。
  env.ACTRADECK_DEMO_APPROVAL = "hold";
  // 内部生成 id のみ env で渡す (argv には一切載せない)。
  env.ACTRADECK_DEMO_SESSION_ID = inject.sessionId;
  if (inject.wsUrl !== undefined) env.ACTRADECK_WS_URL = inject.wsUrl;
  return env;
}

/** spawn した子プロセスの最小抽象 (テストで fake 差し替え可能・real ChildProcess を充足)。 */
export interface DemoChildHandle {
  readonly pid?: number | undefined;
  on(event: "exit", listener: (code: number | null) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

/** spawner への要求。env には INGEST_TOKEN / デモ設定が織り込まれている。 */
export interface DemoSpawnRequest {
  readonly sessionId: string;
  readonly env: NodeJS.ProcessEnv;
}

/** 子プロセスを起こす関数 (default = node(process.execPath)+tsx でドライバ直実行・test = fake)。 */
export type DemoSpawner = (req: DemoSpawnRequest) => DemoChildHandle;

/** launch() の結果 (HTTP status ヒント込み・route が値ベースで写像する)。 */
export interface SafetyDemoLaunchResult {
  readonly ok: boolean;
  readonly status: number;
  readonly sessionId?: string;
  /** 既に走行中で新規 spawn せず現行を返したか。 */
  readonly alreadyRunning?: boolean;
  readonly error?: string;
}

export interface SafetyDemoLauncherOptions {
  /** ingestion の Bearer トークン (buildIngestionServer が非空を検証済み)。子 env へ注入する。 */
  readonly ingestToken: string;
  /** 子プロセス spawner (省略時は node(process.execPath)+tsx でドライバ直実行)。テストは fake を注入する。 */
  readonly spawner?: DemoSpawner;
  /** session_id 生成器 (省略時 `demo-safety-<hex>`)。テストは決定論注入。 */
  readonly idFactory?: () => string;
  /** ログ出力 (secret を含めない・既定は no-op)。 */
  readonly log?: (msg: string) => void;
  /**
   * 起動を有効化するか。省略時は auto: spawner 注入時 (test) は true、それ以外は driver ファイルが
   * 実在するときのみ true (packaged 配備で silent 起動不能を作らず・disabled は launch() が 503 で開示)。
   */
  readonly enabled?: boolean;
  /** 子 ACTRADECK_WS_URL の上書き (省略時は子が env / 既定 55410 で解決)。 */
  readonly wsUrl?: string;
}

/**
 * デモ driver の既定パスを解決する (**backend src 内の sibling**・decision 019f387f)。
 *
 * 旧実装は `apps/sidecar/e2e/run-safety-demo.mts` を repo-root 相対で指したが、Docker cockpit image は
 * apps/sidecar を COPY しないため container 内で不在 → enabled=false → CTA 503 だった。native-free 単一
 * driver (`safety-demo-driver.ts`) を backend 自身の src に同居させ、`import.meta.url` の dir 相対で解決する
 * ことで、Docker (COPY apps/backend で載る) でも repo でも同じパスで解決する。ACTRADECK_REPO_ROOT による
 * repo-root 上書きは不要になったため撤去した (sibling は import.meta.url から決定論的)。
 */
export function resolveDefaultDriverPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "safety-demo-driver.ts");
}

/**
 * default spawner の spawn 仕様 (command / args / cwd) を純関数で返す。teeth テストが argv を
 * 検査して「pnpm でなく process.execPath+tsx を使う」ことを回帰固定できるよう純粋化している
 * (INV-DEMO-SPAWN-PATH-INDEPENDENT・ADR 019f280c)。旧実装は `spawn('pnpm', …)` で、systemd
 * --user の最小 PATH に pnpm が無いと ENOENT で黙って失敗し初回デモ CTA が route 200 のまま
 * 何も起きなかった (実機検出)。それを次の spec で排除する:
 *  - command = process.execPath: backend 自身の node。常在ゆえ PATH 非依存 (pnpm ENOENT 回避)。
 *  - args = --import tsx <driverPath>: tsx ローダで driver を直実行する。
 *  - cwd = driver の親の親: driver が backend src 同居 (apps/backend/src/…) ゆえ apps/backend。
 *    tsx (prod dep) と workspace パッケージが解決する dir (不変ロジック・driver 位置に追従)。
 */
export function defaultDemoSpawnSpec(driverPath: string): {
  command: string;
  args: readonly string[];
  cwd: string;
} {
  // driverPath = <repo>/apps/backend/src/safety-demo-driver.ts → cwd は apps/backend。
  return {
    command: process.execPath,
    args: ["--import", "tsx", driverPath],
    cwd: join(dirname(driverPath), ".."),
  };
}

/**
 * 実際に launcher へ配線される default spawner を組み立てる。`defaultDemoSpawnSpec` の spec
 * (command=process.execPath / args=--import tsx <driver> / cwd=apps/backend) を **必ず消費**して
 * spawn する。spawnFn は DI (既定 = node:child_process.spawn) で、テストが real spawn を起こさず
 * wire (spec→spawn 引数) を固定できる (QA-1: teeth を helper だけでなく load-bearing な wire にも
 * 効かせ、pnpm へ戻る回帰を CI で赤化する)。
 */
export function makeDefaultSpawner(driverPath: string, spawnFn: typeof spawn = spawn): DemoSpawner {
  const spec = defaultDemoSpawnSpec(driverPath);
  return ({ env }) =>
    spawnFn(spec.command, [...spec.args], {
      cwd: spec.cwd,
      env,
      // 子の stdout/stderr は backend ログへ流さない (万一の生データ混入面をゼロにする)。
      // 失敗は exit code / 'error' で観測する (原文非依存)。
      stdio: "ignore",
      shell: false,
    });
}

/**
 * 単一 in-flight のセーフティデモを管理するコントローラ。JS シングルスレッドゆえ launch() の
 * check-and-set は spawner が同期に handle を返す限りアトミック (spawn は ChildProcess を同期返却)。
 */
export class SafetyDemoLauncher {
  private readonly ingestToken: string;
  private readonly spawner: DemoSpawner;
  private readonly idFactory: () => string;
  private readonly log: (msg: string) => void;
  private readonly enabled: boolean;
  private readonly wsUrl: string | undefined;
  private current: { sessionId: string; handle: DemoChildHandle } | undefined;

  constructor(opts: SafetyDemoLauncherOptions) {
    this.ingestToken = opts.ingestToken;
    this.idFactory =
      opts.idFactory ?? (() => `${SAFETY_DEMO_SESSION_PREFIX}${randomBytes(4).toString("hex")}`);
    this.log = opts.log ?? (() => {});
    this.wsUrl = opts.wsUrl;
    if (opts.spawner !== undefined) {
      this.spawner = opts.spawner;
      this.enabled = opts.enabled ?? true;
    } else {
      const driverPath = resolveDefaultDriverPath();
      // driver の存在で auto-enable する (packaged 配備で silent 起動不能を作らない)。
      this.enabled = opts.enabled ?? existsSync(driverPath);
      this.spawner = makeDefaultSpawner(driverPath);
    }
  }

  /** 走行中か (テスト / 監視)。 */
  get running(): boolean {
    return this.current !== undefined;
  }

  /** 現行デモ session_id (無ければ undefined)。 */
  currentSessionId(): string | undefined {
    return this.current?.sessionId;
  }

  /**
   * デモを起動する (値ベース・throw しない = SEC-R3-3)。
   *  - disabled → 503 (この配備では起動不可・開示)。
   *  - 走行中 → 200 + 現行 session_id + alreadyRunning (新規 spawn せず = 多重起動抑止)。
   *  - spawn 同期失敗 → 500 (状態は据え置き)。
   *  - 成功 → 200 + 新 session_id。exit/error で current をクリアし次回起動を許す。
   */
  launch(): SafetyDemoLaunchResult {
    if (!this.enabled) {
      return {
        ok: false,
        status: 503,
        error: "safety demo is not available in this deployment (requires repo/tsx)",
      };
    }
    if (this.current !== undefined) {
      return { ok: true, status: 200, sessionId: this.current.sessionId, alreadyRunning: true };
    }
    const sessionId = this.idFactory();
    const env = buildDemoChildEnv({
      ingestToken: this.ingestToken,
      sessionId,
      wsUrl: this.wsUrl,
    });
    let handle: DemoChildHandle;
    try {
      handle = this.spawner({ sessionId, env });
    } catch (err) {
      this.log(`[safety-demo] spawn failed: ${err instanceof Error ? err.name : "error"}`);
      return { ok: false, status: 500, error: "failed to start safety demo" };
    }
    const entry = { sessionId, handle };
    this.current = entry;
    const clear = (): void => {
      // 置き換えられていない (自分が current の) ときのみクリア (race 安全)。
      if (this.current === entry) this.current = undefined;
    };
    handle.on("exit", (code) => {
      clear();
      this.log(`[safety-demo] session ${sessionId} exited (code=${code ?? "null"})`);
    });
    handle.on("error", (err) => {
      // spawn ENOENT 等 (pnpm 不在) は非同期にここへ来る。状態をクリアし再試行を許す。
      clear();
      this.log(`[safety-demo] session ${sessionId} spawn error: ${err.name}`);
    });
    this.log(`[safety-demo] launched session ${sessionId}`);
    return { ok: true, status: 200, sessionId };
  }

  /** 走行中デモを kill して状態をクリアする (graceful shutdown / preClose)。冪等。 */
  dispose(): void {
    const cur = this.current;
    this.current = undefined;
    if (cur === undefined) return;
    try {
      cur.handle.kill("SIGTERM");
    } catch {
      // 既に終了している等は無視 (best-effort)。
    }
  }
}
