/**
 * SessionIdentity (= RunIdentity) — sidecar 内の単一の権威 run 識別 (ADR 019e9462 / ADR 0014 3b-1).
 *
 * 問題: 1 回の managed claude 実行が **2 セッションに割れて**表示されていた。
 *  - hook 由来イベント(turn/command/session.ended)は claude の hook `session_id`(UUID) を使う。
 *  - 監視由来イベント(heartbeat/diff.updated/command.output.delta)は構成時 bake した
 *    `ACTRADECK_SESSION`(= `sess_<id>`) を使う。
 * backend は raw `session_id` を key に projection するため別セッション化していた。
 *
 * 解決(ADR 019e9462): canonical = **claude の hook session_id**。sidecar が learn-once で確定し、
 * 監視 emitter は固定 id を捨て emit 時に canonical を動的解決する。確定**前**の監視イベントは
 * **hold(buffer)** し、確定後に発生時刻順で canonical id を載せて flush する。
 *
 * run lineage 拡張 (ADR 0014 Phase 3b-1・decision 019f819e): learn-once の canonical は 1 つの
 * **run** を表す。resume/fork/clear で新しい run が始まる (= 境界) と canonical を **同期 swap** して
 * rotate する。境界検出は本クラスの状態機械 (`onHookSession`) が hook イベント到達時のみ行い、監視
 * イベントは境界を駆動しない (D3・projection 非分裂 019e9462 を構造で維持)。
 *  - currentRunId (= canonical): 現在の run の session_id (= common case は provider hook id)。
 *  - currentProviderSessionId: 現在の run の provider raw id (全イベントに populate・D4)。
 *  - currentRunTerminal: hook 経路が SessionEnd 等で立てる flag (reducer 非参照・projection と疎結合)。
 *  - generation: run 採番の世代 (境界ごとに +1)。
 *
 * 不変条件(本クラスが守る):
 * - **INV-REDACTION choke point 不変**: hold するのは redaction 前 raw ではなく、
 *   `() => sink.emit(builder())` を遅延実行する **thunk**。flush も必ず既存 `sink.emit`
 *   (redact→parse→persist→send) を通る。redaction 前データを SQLite/送信路に出さない。
 * - **INV-EVENT-ORDER**: held は**投入順(=発生時刻順)**で flush する。各 thunk が
 *   `buildEvent({timestamp: <観測時刻>})` を保持するので per-session 単調性も実発生順で保たれる。
 *   run 境界の canonical swap は held に **非接触** (held は最初の canonical 確定前のみ存在し、
 *   境界は確定後に起きるため held は空)。
 * - **INV-IDEMPOTENCY**: thunk は `buildEvent`(event_id 採番)を flush 時に 1 回だけ呼ぶ。
 *   hold 中は event_id を採番しない → 二重採番は無い。run mint も idempotent:
 *   provider-id-as-run-id は再送で同 id、synthetic mint は「同一 provider id + 非 terminal ⇒ 同一
 *   run」guard で post-swap 再送を畳む (hook-receiver は逐次処理)。
 *
 * 有界化(必須): hold buffer は件数上限を持つ。超過時は **heartbeat を最新優先で間引き**
 * (最新の生存状態が残れば liveness は成立)、diff/output は保持優先で落とさない。確定タイムアウトに
 * 達したら fallback id(= ACTRADECK_SESSION)で flush し永久 hold(メモリ無界)を避ける。
 */
import { newEventId, type StartKind } from "@actradeck/event-model";

/**
 * run 境界判定の入力 (hook イベント由来・D2 信号階層)。source は advisory positive のみで
 * 境界の**有無**は決めない (VSCode source='startup' 誤報告に頑健・D2#3)。
 */
export interface OnHookSessionOptions {
  /** SessionStart hook か (start_kind 細別の補助・境界判定には使わない)。 */
  readonly isSessionStart?: boolean;
  /** SessionStart の source (`startup`/`resume`/`clear`/`compact` 等・advisory)。 */
  readonly source?: string;
}

/** run 境界判定の結果。hook-receiver がこの値を NormalizeContext へ載せる。 */
export interface RunBoundaryResult {
  /** 本 hook イベントを ingest する canonical run id (= session_id)。 */
  readonly runId: string;
  /** 本 hook で新しい run 境界を切ったか (true なら start_kind/resumedFrom を run 起点に載せる)。 */
  readonly boundary: boolean;
  /** run 起点の開始種別 (境界 or generation 0 でのみ設定)。 */
  readonly startKind?: StartKind;
  /** 継続元 run の canonical id (この sidecar が親を観測した境界でのみ設定・D4)。 */
  readonly resumedFrom?: string;
}

/** hold buffer に積む 1 件の遅延 emit。`build` は canonical id を受け取り NormalizedEvent を emit する。 */
interface HeldEvent {
  /** 監視イベント種別。間引き優先度の判定に使う(heartbeat は最新優先で落とせる)。 */
  readonly category: "heartbeat" | "diff" | "output";
  /**
   * 実 emit を行う thunk。canonical(確定後 = hook session_id, fallback 時 = ACTRADECK_SESSION)と
   * その run の provider raw id を受け取り、id を session_id / provider_session_id に載せて `sink.emit`
   * する。INV-REDACTION: emit は sink を通す。provider_session_id は common case で canonical と同値。
   */
  readonly build: (canonicalSessionId: string, providerSessionId: string | undefined) => void;
}

export interface SessionIdentityOptions {
  /**
   * fallback / ローカル相関 id (= ACTRADECK_SESSION, または自動採番 `sess_<id>`)。
   * canonical 未確定時の暫定 session_id 兼、確定タイムアウト後の last-resort。
   */
  readonly fallbackSessionId: string;
  /**
   * 後方互換: 明示的に与えられた canonical を **即確定**する(learn を待たない)。
   * 既存テスト/Attach/egress-handshake(sessionIds:["s1"]) のように session_id を外部指定する
   * 経路を温存するため。自動採番(`sess_<id>`)のときは未指定にして hook 学習を待つ。
   */
  readonly explicitSessionId?: string;
  /** hold buffer の件数上限(超過で間引き/落とし)。既定 1000。 */
  readonly maxHeld?: number;
  /**
   * 確定タイムアウト(ms)。hook が来ず canonical を確定できないまま経過したら fallback で flush。
   * 0 / undefined ならタイマーを張らない(明示確定モード or テストで手動 flush する場合)。
   */
  readonly flushTimeoutMs?: number;
  /** hold 件数が上限に達したとき/間引いたときの観測フック(テスト・ロギング)。 */
  readonly onHoldDropped?: (category: HeldEvent["category"], reason: "trim" | "overflow") => void;
  /** canonical 確定時の観測フック(source: hook = 学習, fallback = タイムアウト/明示)。 */
  readonly onResolved?: (
    canonicalSessionId: string,
    source: "hook" | "fallback" | "explicit",
  ) => void;
}

export class SessionIdentity {
  private readonly fallbackSessionId: string;
  private readonly maxHeld: number;
  private readonly flushTimeoutMs: number;
  private readonly onHoldDropped: SessionIdentityOptions["onHoldDropped"];
  private readonly onResolved: SessionIdentityOptions["onResolved"];

  /** 確定済み canonical session_id (= currentRunId)。undefined = 未確定(hold 中)。 */
  private canonical: string | undefined;
  /**
   * 現在の run の provider raw id (ADR 0014 D4)。canonical と同時に確定し、境界で rotate する。
   * common case は canonical と同値。terminal-reopen synthetic mint 時のみ両者が乖離する。
   */
  private providerSessionId: string | undefined;
  /**
   * 現在の run が terminal 化したか (ADR 0014 D2#2)。hook 経路が `markRunTerminal` で立てる。
   * reducer を参照しない (in-process 自己完結・projection と疎結合)。同一 provider id が terminal run へ
   * 再来したら synthetic mint で新 run を切る根拠。
   */
  private currentRunTerminal = false;
  /** run 採番の世代 (境界ごとに +1)。generation 0 = 初回 run。 */
  private generation = 0;
  /**
   * onHookSession が一度でも呼ばれたか (ADR 0014 D4)。explicit 即確定 (Attach) の identity では canonical が
   * 構築時に既に確定しているため gen0 経路を通らず start_kind 導出が漏れる。**最初の観測 hook** でだけ
   * best-effort start_kind (source→細別 or unknown) を surface するために使う (evidence 無ければ unknown)。
   */
  private hookObserved = false;
  /** 確定前の監視イベント held buffer(投入順 = 発生時刻順)。 */
  private held: HeldEvent[] = [];
  private flushTimer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(opts: SessionIdentityOptions) {
    this.fallbackSessionId = opts.fallbackSessionId;
    this.maxHeld = opts.maxHeld ?? 1000;
    this.flushTimeoutMs = opts.flushTimeoutMs ?? 0;
    this.onHoldDropped = opts.onHoldDropped;
    this.onResolved = opts.onResolved;

    if (opts.explicitSessionId !== undefined && opts.explicitSessionId.length > 0) {
      // 後方互換: 外部指定された canonical を即確定(learn 不要)。generation 0・provider id は
      // canonical と同値 (Attach では explicitSessionId = hook session_id = provider id)。
      this.canonical = opts.explicitSessionId;
      this.providerSessionId = opts.explicitSessionId;
      this.onResolved?.(this.canonical, "explicit");
    } else if (this.flushTimeoutMs > 0) {
      // 自動採番モード: hook 学習を待つ。確定が来なければ fallback-flush(永久 hold 回避)。
      this.flushTimer = setTimeout(() => this.resolveWithFallback(), this.flushTimeoutMs);
      // タイマーがプロセス終了を妨げないように(unref があれば)。
      this.flushTimer.unref?.();
    }
  }

  /** canonical が確定済みか。 */
  isResolved(): boolean {
    return this.canonical !== undefined;
  }

  /**
   * 確定済みなら canonical を返す。未確定なら **fallback id** を返す
   * (hello.session_ids / interrupt scope など「今すぐ id が要る」読み取り経路向け。
   * イベント emit 自体は未確定時 hold するので本メソッドではなく holdMonitoring を使う)。
   */
  currentSessionId(): string {
    return this.canonical ?? this.fallbackSessionId;
  }

  /** 確定済み canonical(未確定なら undefined)。 */
  resolvedSessionId(): string | undefined {
    return this.canonical;
  }

  /** fallback / ローカル相関 id(降格後の ACTRADECK_SESSION)。 */
  get fallbackId(): string {
    return this.fallbackSessionId;
  }

  /** hold buffer に現在保持している件数(テスト・監視用)。常に maxHeld 以下。 */
  get heldCount(): number {
    return this.held.length;
  }

  /**
   * **最初に届いた任意の hook の session_id** で canonical を確定する(learn-once)。
   * SessionStart 限定にしない(`-p` 非決定配信に頑健, task 019e8e5d)。
   *
   * - 初確定なら held buffer を canonical で flush する(発生時刻順)。
   * - 既に確定済みで **同じ id** なら no-op。
   * - 既に確定済みで **異なる id** なら **最初の値を保持**し warn 相当の観測のみ行う
   *   (後勝ち併合をしない = projection 分裂・所有移管の不変条件破壊を避ける, ADR Edge cases)。
   *   resume で別 id が来るケースもここで吸収する。
   *
   * @returns 本呼び出しで初確定したら true。
   */
  learn(hookSessionId: string): boolean {
    if (typeof hookSessionId !== "string" || hookSessionId.length === 0) return false;
    if (this.canonical !== undefined) {
      // 既に確定済み。
      //  - explicit(後方互換)で確定済みの場合も最初の値を保持(外部指定が勝つ)。
      //  - hook 由来で別 id が来たら最初を保持し無視(後勝ちしない)。
      return false;
    }
    this.resolve(hookSessionId, "hook");
    return true;
  }

  /** 現在の run の provider raw id (未確定なら undefined)。監視 emit の provider_session_id 出所。 */
  currentProviderSessionId(): string | undefined {
    return this.providerSessionId;
  }

  /** 現在の run の canonical id (= currentSessionId のエイリアス・run 語彙での明示読み取り)。 */
  currentRunId(): string {
    return this.currentSessionId();
  }

  /** 現在の run の世代 (境界ごとに +1・テスト/観測用)。 */
  currentGeneration(): number {
    return this.generation;
  }

  /** 現在の run が terminal 化済みか (markRunTerminal 済み)。 */
  isRunTerminal(): boolean {
    return this.currentRunTerminal;
  }

  /**
   * ADR 0014 Phase 3b-1 (D2 run 境界状態機械)。**hook イベント到達時のみ**呼ぶ (監視イベントは
   * 境界を駆動しない・D3)。provider の raw session id と advisory な source から、この hook を
   * どの run へ ingest するか (境界を切るか) を判定して {runId, boundary, startKind, resumedFrom} を返す。
   *
   * 信号階層 (decision 019f819e D2):
   *  1. **主信号 = provider_session_id 変化** → 新 run (新 provider id を run id に採用・D1)。
   *     SessionStart 限定にしない (`-p` 非決定配信に頑健)。
   *  2. **terminal-reopen** (同一 provider id + currentRunTerminal) → 新 run (synthetic `sess_<uuidv7>`
   *     mint・provider id が terminal run と衝突し採用不可のため)。
   *  3. **source は advisory positive のみ** (start_kind 細別に使い境界の有無は決めない・#3)。
   *  4. **compact は negative guard** (provider id が rotate しても run を切らない・#4)。
   *  5. 同一 provider id + 非 terminal ⇒ 常に同一 run (idempotent fold・分裂しない・D3)。
   */
  onHookSession(providerSessionId: string, opts: OnHookSessionOptions = {}): RunBoundaryResult {
    const src = normalizeSource(opts.source);

    // 不正な provider id / dispose 後: 境界を切らず現在値 (or 暫定 fallback) を返す (副作用なし)。
    if (typeof providerSessionId !== "string" || providerSessionId.length === 0) {
      return { runId: this.canonical ?? this.fallbackSessionId, boundary: false };
    }
    if (this.disposed) {
      return { runId: this.canonical ?? providerSessionId, boundary: false };
    }

    const firstObservation = !this.hookObserved;
    this.hookObserved = true;

    // (A) generation 0: 初回確定 (fresh identity・managed)。learn と同じく resolve で held を flush する。
    if (this.canonical === undefined) {
      this.resolve(providerSessionId, "hook");
      const startKind = deriveStartKind(src, /*hasParent*/ false);
      return { runId: providerSessionId, boundary: false, startKind };
    }

    // 現在 run あり。
    if (providerSessionId === this.providerSessionId) {
      if (this.currentRunTerminal) {
        // (B) D2#2 terminal-reopen (同一 provider id) → 新 run・synthetic mint・親観測済 lineage。
        const parent = this.canonical;
        const newRunId = mintSyntheticRunId();
        this.rotateRun(newRunId, providerSessionId);
        const startKind = deriveStartKind(src, /*hasParent*/ true);
        return { runId: newRunId, boundary: true, startKind, resumedFrom: parent };
      }
      // (C) D3 / D2#5 同一 provider id + 非 terminal ⇒ 同一 run (重複 SessionStart を idempotent に畳む)。
      //   ただし explicit 即確定 (Attach) の **最初の観測 hook** は gen0 経路を通らないため、ここで
      //   best-effort run 起点 start_kind を surface する (source→細別 or unknown・D4)。以降の再送は畳む。
      if (firstObservation) {
        return { runId: this.canonical, boundary: false, startKind: deriveStartKind(src, false) };
      }
      return { runId: this.canonical, boundary: false };
    }

    // (D) provider id 変化。
    if (src === "compact") {
      // D2#4 negative guard: compact は run を切らない。rotate した provider id だけ追従する。
      this.providerSessionId = providerSessionId;
      return { runId: this.canonical, boundary: false };
    }
    // D2#1 provider id 変化 → 新 run。新 provider id をそのまま run id に採用 (D1・synthetic 不要)。
    const parent = this.canonical;
    this.rotateRun(providerSessionId, providerSessionId);
    const startKind = deriveStartKind(src, /*hasParent*/ true);
    return { runId: providerSessionId, boundary: true, startKind, resumedFrom: parent };
  }

  /**
   * ADR 0014 Phase 3b-1 (D2#2): 現在 run を terminal 化する (hook 経路が SessionEnd 受信時等に呼ぶ)。
   * 以後、同一 provider id の hook が再来したら terminal-reopen として新 run (synthetic) を切る根拠になる。
   * reducer は参照しない (in-process 自己完結)。冪等 (二重 SessionEnd は同一効果)。
   */
  markRunTerminal(): void {
    if (this.canonical === undefined) return;
    this.currentRunTerminal = true;
  }

  /**
   * run 境界の canonical **同期 swap** (D5)。held には非接触 (held は最初の canonical 確定前のみ存在し、
   * 境界は確定後に起きるため held は空)。generation を +1 し terminal flag を落とす (新 run は非 terminal)。
   */
  private rotateRun(newRunId: string, newProviderSessionId: string): void {
    this.canonical = newRunId;
    this.providerSessionId = newProviderSessionId;
    this.currentRunTerminal = false;
    this.generation += 1;
  }

  /**
   * 監視イベントの emit を identity 経由にする。
   * - 確定済み → 即 `build(canonical)`(従来どおり sink.emit, 遅延なし)。
   * - 未確定 → thunk を hold buffer に積む(emit を遅らせる)。確定/タイムアウト後に flush。
   *
   * `category` は有界化時の間引き優先度に使う(heartbeat は最新優先で落とせる)。
   * `build` は **canonical id を引数に受け取り**、その id で `buildEvent`→`sink.emit` する。
   * hold 中は build を呼ばない = event_id 未採番(INV-IDEMPOTENCY)・redaction 未実施だが
   * raw も持たない(thunk が後で sink.emit を通す, INV-REDACTION)。
   */
  emitMonitoring(
    category: HeldEvent["category"],
    build: (canonicalSessionId: string, providerSessionId: string | undefined) => void,
  ): void {
    if (this.canonical !== undefined) {
      build(this.canonical, this.providerSessionId);
      return;
    }
    this.hold({ category, build });
  }

  /** held buffer に積む(有界化付き)。 */
  private hold(ev: HeldEvent): void {
    if (this.disposed) return;
    this.held.push(ev);
    if (this.held.length <= this.maxHeld) return;
    this.trimToBound();
  }

  /**
   * 上限超過時の有界化: heartbeat を**最新優先で間引く**(最古の heartbeat から落とす)。
   * heartbeat が無ければ最古の 1 件を落とす(diff/output が無界に積み上がるのを防ぐ最終手段)。
   * 落とし対象の `category` を観測フックで報告する。
   */
  private trimToBound(): void {
    while (this.held.length > this.maxHeld) {
      // 最古の heartbeat を探して落とす(diff/output は保持優先)。
      const idx = this.held.findIndex((e) => e.category === "heartbeat");
      if (idx >= 0) {
        const [dropped] = this.held.splice(idx, 1);
        if (dropped) this.onHoldDropped?.(dropped.category, "trim");
        continue;
      }
      // heartbeat が無い(diff/output だけで溢れた)→ 最古を落とす(over-bound 防止の最終手段)。
      const [dropped] = this.held.splice(0, 1);
      if (dropped) this.onHoldDropped?.(dropped.category, "overflow");
    }
  }

  /** canonical を確定し held を flush する(共通・generation 0 初回確定)。 */
  private resolve(id: string, source: "hook" | "fallback" | "explicit"): void {
    this.canonical = id;
    // generation 0 の初回 run: provider id は canonical と同値 (fallback 確定時も暫定 id を出所とする)。
    this.providerSessionId = id;
    this.clearTimer();
    this.onResolved?.(id, source);
    this.flushHeld();
  }

  /**
   * 確定タイムアウト: hook 皆無で canonical を確定できないまま経過 → fallback id で flush。
   * 「動いている」(監視イベント)は degraded でも見せる(恒久喪失を避ける, ADR②)。
   */
  private resolveWithFallback(): void {
    if (this.canonical !== undefined || this.disposed) return;
    this.resolve(this.fallbackSessionId, "fallback");
  }

  /** 手動で fallback 確定する(テスト/明示シャットダウン経路)。既に確定済みなら no-op。 */
  flushWithFallback(): void {
    this.resolveWithFallback();
  }

  /**
   * held を **投入順(=発生時刻順)で** canonical id を載せて flush する。
   * 各 thunk は `buildEvent({timestamp: 観測時刻})` を保持するため、flush 時刻でなく
   * 発生時刻が timestamp に乗る → INV-EVENT-ORDER の per-session 単調性が保たれる。
   */
  private flushHeld(): void {
    if (this.canonical === undefined) return;
    const canonical = this.canonical;
    const batch = this.held;
    this.held = [];
    for (const ev of batch) {
      ev.build(canonical, this.providerSessionId);
    }
  }

  private clearTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  /**
   * shutdown: タイマーを止め、未確定なら fallback で held を flush して**取りこぼさない**。
   * (graceful shutdown で hold したまま捨てると「何をしていたか」を失う。)
   */
  dispose(): void {
    if (this.disposed) return;
    this.clearTimer();
    if (this.canonical === undefined && this.held.length > 0) {
      this.resolveWithFallback();
    }
    this.disposed = true;
  }
}

/** RunIdentity = SessionIdentity の run 語彙エイリアス (ADR 0014・呼び出し側の意図明示用)。 */
export type RunIdentity = SessionIdentity;

/**
 * source を既知の advisory トークンへ正規化する (D2#3)。未知値は undefined (= 非 advisory)。
 * 版依存で信頼できないため境界の**有無**には使わず start_kind 細別と compact negative guard のみに使う。
 */
function normalizeSource(source: string | undefined): string | undefined {
  if (typeof source !== "string" || source.length === 0) return undefined;
  const s = source.toLowerCase();
  if (s === "startup" || s === "fresh") return "startup";
  if (s === "resume") return "resume";
  if (s === "clear") return "clear";
  if (s === "compact") return "compact";
  return undefined;
}

/**
 * start_kind を導出する (D4)。source(advisory positive) を優先し、無ければ observed lineage の
 * 有無で決める。
 *  - source=resume → resume / clear → clear / startup → fresh。
 *  - source 無し + 観測済み親 (境界) → resume (in-process の観測済 lineage は継続の positive evidence)。
 *  - source 無し + 親なし (generation 0) → unknown (over-claim しない・enum 既定哲学)。
 * compact は境界を切らないため本関数へ来ない (negative guard で先に return する)。
 */
function deriveStartKind(src: string | undefined, hasParent: boolean): StartKind {
  if (src === "resume") return "resume";
  if (src === "clear") return "clear";
  if (src === "startup") return "fresh";
  return hasParent ? "resume" : "unknown";
}

/**
 * terminal-reopen で衝突する provider id を採用できないときの synthetic run id を鋳造する (D1)。
 * 既存 fallback id shape (`sess_<uuidv7>`・cli.ts resolveManagedSession と同型) を再利用する。
 * 全層 (redaction allowlist / relay / webui) が既に処理済みの 2 種類目の id 形。
 * 冪等性は「同一 provider id + 非 terminal ⇒ 同一 run」guard が担保するため deterministic 派生は不要
 * (hook-receiver は逐次処理・rotate 後の再送は case (C) で畳まれ再 mint しない)。
 */
function mintSyntheticRunId(): string {
  return `sess_${newEventId()}`;
}
