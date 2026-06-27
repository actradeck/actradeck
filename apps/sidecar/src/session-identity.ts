/**
 * SessionIdentity — sidecar 内の単一の権威 session 識別 (ADR 019e9462, task 019e943b).
 *
 * 問題: 1 回の managed claude 実行が **2 セッションに割れて**表示されていた。
 *  - hook 由来イベント(turn/command/session.ended)は claude の hook `session_id`(UUID) を使う。
 *  - 監視由来イベント(heartbeat/diff.updated/command.output.delta)は構成時 bake した
 *    `ACTRADECK_SESSION`(= `sess_<id>`) を使う。
 * backend は raw `session_id` を key に projection するため別セッション化していた。
 *
 * 解決(ADR 確定): canonical = **claude の hook session_id**。sidecar が learn-once で確定し、
 * 監視 emitter は固定 id を捨て emit 時に canonical を動的解決する。確定**前**の監視イベントは
 * **hold(buffer)** し、確定後に発生時刻順で canonical id を載せて flush する。
 *
 * 不変条件(本クラスが守る):
 * - **INV-REDACTION choke point 不変**: hold するのは redaction 前 raw ではなく、
 *   `() => sink.emit(builder())` を遅延実行する **thunk**。flush も必ず既存 `sink.emit`
 *   (redact→parse→persist→send) を通る。redaction 前データを SQLite/送信路に出さない。
 * - **INV-EVENT-ORDER**: held は**投入順(=発生時刻順)**で flush する。各 thunk が
 *   `buildEvent({timestamp: <観測時刻>})` を保持するので per-session 単調性も実発生順で保たれる。
 * - **INV-IDEMPOTENCY**: thunk は `buildEvent`(event_id 採番)を flush 時に 1 回だけ呼ぶ。
 *   hold 中は event_id を採番しない → 二重採番は無い。
 *
 * 有界化(必須): hold buffer は件数上限を持つ。超過時は **heartbeat を最新優先で間引き**
 * (最新の生存状態が残れば liveness は成立)、diff/output は保持優先で落とさない。確定タイムアウトに
 * 達したら fallback id(= ACTRADECK_SESSION)で flush し永久 hold(メモリ無界)を避ける。
 */

/** hold buffer に積む 1 件の遅延 emit。`build` は canonical id を受け取り NormalizedEvent を emit する。 */
interface HeldEvent {
  /** 監視イベント種別。間引き優先度の判定に使う(heartbeat は最新優先で落とせる)。 */
  readonly category: "heartbeat" | "diff" | "output";
  /**
   * 実 emit を行う thunk。canonical(確定後 = hook session_id, fallback 時 = ACTRADECK_SESSION)を
   * 受け取り、その id を session_id に載せて `sink.emit` する。INV-REDACTION: emit は sink を通す。
   */
  readonly build: (canonicalSessionId: string) => void;
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

  /** 確定済み canonical session_id。undefined = 未確定(hold 中)。 */
  private canonical: string | undefined;
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
      // 後方互換: 外部指定された canonical を即確定(learn 不要)。
      this.canonical = opts.explicitSessionId;
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
    build: (canonicalSessionId: string) => void,
  ): void {
    if (this.canonical !== undefined) {
      build(this.canonical);
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

  /** canonical を確定し held を flush する(共通)。 */
  private resolve(id: string, source: "hook" | "fallback" | "explicit"): void {
    this.canonical = id;
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
      ev.build(canonical);
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
