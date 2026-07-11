/**
 * seq-drop — client 申告 `seq` (NormalizedEvent.seq) による中間 silent-drop の **下限検知** の
 * 正準導出 (T1・ADR 019f4cdb Phase2・eval R2 項目5後半・decision 019f502c + 抑制規則 019f50xx).
 *
 * 背景: external adapter は at-most-once / silent-drop ゆえ「adapter は送ったが store に無い」中間
 * イベントを検知する手段が無い。adapter が **per-session で 0 起点・1 ずつ増分する連続 seq** を全 emit に
 * 載せると、backend は保存済み seq 集合の穴から欠落を**下限**で数えられる。
 *
 * ## 正準式 (raw)
 *   `missing_lower_bound = (max_seq − min_seq + 1) − distinct(seq)`
 *   - 受信した seq の張る区間長 `(max − min + 1)` から実際に受信した distinct 数を引く = 区間内の穴。
 *   - **非負**: distinct(seq) ≤ (max − min + 1) が整数区間で常に成立するため結果は必ず ≥ 0。
 *   - **重複 seq は collapse**: at-least-once 再送で同一 seq が二重取り込みされても distinct が吸収する
 *     (event_id 冪等と対称・二重挿入を欠落と誤認しない)。
 *
 * ## 密性前提と抑制 (SEC-1≡QA-4・非密カウンタの暴走抑制)
 * この下限は「seq が **per-session の連続(dense)カウンタ**である」ことを前提とする。もし adapter が
 * global カウンタを誤用したり sparse/ランダムな seq を載せると、区間が巨大化し `missing` が無意味な
 * 巨大値 (偽警報 + overflow) になる。そこで **per-session で `raw_missing > distinct(seq) 数`**
 * (= 区間の過半が穴 = 密性前提違反の疑い) のとき、その session の寄与を **抑制** し「信号不能」として扱う
 * (0 でなく suppressed フラグで可観測化する)。抑制後の per-session `missing` は必ず `≤ distinct` に有界で
 * あり、provider 集約 (Σ missing) は Σ distinct ≤ 総イベント数へ構造的に有界化する (overflow の芽を摘む)。
 *   - 正常な dense session (穴が少数) は抑制されず検知が保たれる。
 *   - 抑制は **正準関数 (evaluateSeqMissing) と backend SQL の両方で同一規則** (real-PG parity INV が拘束)。
 *
 * ## 「下限」の正直な限界 (誇張しない開示)
 *   - **末尾 drop** (受信済み max_seq より後ろの連番が丸ごと落ちた) は検知不能 — max が縮むだけ。
 *   - **先頭 drop** (min_seq より前が落ちた) も検知不能 — min が上がるだけ。
 *   - 検知できるのは **受信区間 [min, max] の内部の穴** のみ。ゆえに「下限 (lower bound)」であり、
 *     真の欠落数はこれ以上でありうる。UI/docs はこれを hedge した文言で表示する。
 *
 * 純粋・依存ゼロ・fs/net 非アクセス ＝ browser/edge/backend/adapter で共有できる単一出所。
 */

/** 1 session の seq 集合の走査結果 (内部)。有効な非負整数のみ distinct へ集約する。 */
function scanSeqs(seqs: readonly number[]): { min: number; max: number; distinct: Set<number> } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  const distinct = new Set<number>();
  for (const s of seqs) {
    // 非負整数でない値 (負・非整数・非有限・非数) は除外 (schema が reject する前提だが at-rest 破損・
    // 直接書込への防御として dirty 値を無視・throw しない)。
    if (typeof s !== "number" || !Number.isInteger(s) || s < 0) continue;
    if (s < min) min = s;
    if (s > max) max = s;
    distinct.add(s);
  }
  return { min, max, distinct };
}

/**
 * 1 session 分の seq 配列から **raw** な欠落下限を導く関数 (抑制前の生の式)。
 *
 * - 有効な seq が 0 件なら 0 (seq-bearing でない ⇒ 欠落を主張しない)。
 * - 単一 seq / 連続 seq は 0。区間内に穴があるぶんだけ正の下限。
 * - **抑制は適用しない** (密性違反時も生の値を返す)。**provider 集約には絶対に使わない** (この raw 値を
 *   直接総和すると非密 seq で偽の巨大値になる — SEC-1)。集約は必ず抑制込みの `evaluateSeqMissing().missing`
 *   を使う。raw 値は「なぜ抑制するか」を示す診断・境界テスト専用。
 *
 * **N-TDA-1**: 本関数は event-model の **public barrel (`index.ts`) から意図的に非公開**。package の
 * consumer (backend/webui) が raw 下限を誤って集約に使う footgun を構造的に塞ぐため、export は
 * seq-drop.ts 内に留め、テストのみ `./seq-drop.js` 相対 import で参照する。集約の公開 API は
 * `evaluateSeqMissing` 単一。
 */
export function computeSeqMissingLowerBound(seqs: readonly number[]): number {
  const { min, max, distinct } = scanSeqs(seqs);
  if (distinct.size === 0) return 0;
  const missing = max - min + 1 - distinct.size;
  // span >= distinct.size が整数区間で常に成立するため missing >= 0。防御的に clamp。
  return missing > 0 ? missing : 0;
}

/** `evaluateSeqMissing` の結果 (per-session の欠落下限 + 密性抑制フラグ)。 */
export interface SeqMissingEvaluation {
  /** 集約へ寄与する欠落下限 (非負)。**抑制時は 0** (信号不能ゆえ加算しない)。 */
  readonly missing: number;
  /** distinct(seq) 数 (密性の分母・抑制判定に使う)。 */
  readonly distinctCount: number;
  /** 密性前提違反 (raw_missing > distinctCount) で「信号不能」として抑制したか。 */
  readonly suppressed: boolean;
}

/**
 * 1 session 分の seq 配列を **抑制規則込み**で評価する正準関数 (provider 集約 + backend SQL が鏡写しに
 * する単一出所)。
 *
 * 規則: `raw_missing > distinctCount` のとき suppressed=true・missing=0 (区間の過半が穴 = 密性前提違反)。
 * それ以外は missing=raw_missing (`≤ distinctCount` に有界)。正常な dense session の検知は保たれる。
 * distinct(seq)=0 (seq-bearing でない) は suppressed=false・missing=0。
 */
export function evaluateSeqMissing(seqs: readonly number[]): SeqMissingEvaluation {
  const { min, max, distinct } = scanSeqs(seqs);
  const distinctCount = distinct.size;
  if (distinctCount === 0) return { missing: 0, distinctCount: 0, suppressed: false };
  const raw = max - min + 1 - distinctCount;
  const rawMissing = raw > 0 ? raw : 0;
  const suppressed = rawMissing > distinctCount;
  return { missing: suppressed ? 0 : rawMissing, distinctCount, suppressed };
}
