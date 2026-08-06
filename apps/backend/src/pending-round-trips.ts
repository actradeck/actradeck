/**
 * PendingRoundTrips<T> — 制御チャネル round-trip の pending envelope 単一出所。
 *
 * 出所: codex spawn full 監査 TDA-1 (M・decision 019f4241)。sidecar-registry の
 * diff / allowlist / policy / spawn の 4 面が同型 envelope
 * (Map<request_id, {resolve, timer}> + set-with-timeout-delete + resolve 前段ガード +
 * dispose reject-loop + count getter) を独立に 4 度書いており、5 本目が
 * timer.unref / delete-on-timeout / dispose-reject を取りこぼすと pending resolver の
 * leak / hang (relay 安全側 deny 意味論の崩れ) になるため抽出した。
 * per-type の payload build・応答投影・fan-out は呼び出し側 (sidecar-registry) に残す。
 *
 * 意味論 (既存 4 実装と同一・変更しないこと):
 *  - `register`: timeout タイマを張り (`unref` — event loop を掴まない)、満了で
 *    **先に delete → resolve(timeoutResult())** (安全側 reject 値で解決)。
 *  - `settle`: 未知 request_id (タイムアウト済 / 二重応答) は undefined = 黙殺。
 *    既知なら clearTimeout + delete して resolver を返す (応答本文を at-rest に
 *    貯めない — 呼び出し側が投影した値で即時 resolve する)。
 *  - `abort`: send 失敗経路。既知なら clearTimeout + delete + resolve(result)。
 *  - `rejectAll`: dispose 経路。全 pending を clearTimeout + resolve(shutdownResult())
 *    して clear する (shutdown 後に resolver が宙吊りにならない)。
 *  - request_id は呼び出し側が randomUUID で採番する (重複 register は想定外・本番到達不能)。
 *    万一重複させると挙動は抽出前 4 実装と同じ「後勝ち + 旧タイマ orphan 化」だが、orphan
 *    タイマは満了時に **後勝ち側の live エントリを delete し旧 resolver を timeout 値で解決**
 *    する (QA-2 実測・no-op ではない)。採番方式を randomUUID から変える場合はこの端を塞ぐこと。
 */
export class PendingRoundTrips<T> {
  private readonly pending = new Map<
    string,
    { resolve: (r: T) => void; timer: ReturnType<typeof setTimeout> }
  >();

  /** @param timeoutMs 応答が来ないときに安全側 reject するまでの時間 (ms)。 */
  constructor(private readonly timeoutMs: number) {}

  /**
   * pending を登録し timeout を武装する。満了時は **先に delete → resolve(timeoutResult())**
   * (既存 4 実装と同順・満了後の settle は未知 id として黙殺される)。
   */
  register(requestId: string, resolve: (r: T) => void, timeoutResult: () => T): void {
    const timer = setTimeout(() => {
      this.pending.delete(requestId);
      resolve(timeoutResult());
    }, this.timeoutMs);
    timer.unref?.();
    this.pending.set(requestId, { resolve, timer });
  }

  /**
   * 応答到達: 該当 pending を破棄して resolver を返す。未知 (タイムアウト済 / 二重応答) は
   * undefined (呼び出し側は黙殺する)。
   *
   * ⚠️ 呼び出し側の契約 (TDA-1 L): settle が返った時点で **timeout backstop は消えている**
   * (clearTimeout + delete 済み)。呼び出し側は**全経路で必ず** resolver を即時呼ぶこと —
   * 途中 return / throw で呼び損ねると該当 Promise は永久 hang する (timeout 救済なし)。
   * また resolver を保持し続けると応答が at-rest 化する (即時呼びで両方を守る)。
   */
  settle(requestId: string): ((r: T) => void) | undefined {
    const p = this.pending.get(requestId);
    if (p === undefined) return undefined;
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    return p.resolve;
  }

  /** send 失敗経路: 該当 pending を破棄し `result` で即時解決する (未知 id は no-op)。 */
  abort(requestId: string, result: T): void {
    const resolve = this.settle(requestId);
    resolve?.(result);
  }

  /**
   * dispose 経路: 全 pending を安全側の shutdown 値で解決してタイマを解放する。
   * `shutdownResult` は entry ごとに呼ぶ (呼び出し側が同一オブジェクトを共有したい場合も
   * factory 経由で新値を返せる — 既存実装はリテラル値で毎回新オブジェクトだった)。
   */
  rejectAll(shutdownResult: () => T): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve(shutdownResult());
    }
    this.pending.clear();
  }

  /** 未解決の要求数 (テスト/監視: タイムアウト・解決後の破棄を pin する)。 */
  get size(): number {
    return this.pending.size;
  }
}
