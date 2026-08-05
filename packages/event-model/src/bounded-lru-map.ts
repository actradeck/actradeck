/**
 * 挿入順 Map による bounded LRU (A2 TDA-4・単一出所).
 *
 * 手書きの「delete→set で末尾へ移動 + 上限超過で先頭 evict」LRU が
 * BoundedMonotonicTimestampChecker (timestamp.ts) と backend ingest-store の work-items
 * 投影キャッシュで 2 度書かれていたため抽出した (generalize-reusable-tooling)。
 *
 * 意味論 (両利用箇所の既存挙動と同一・変更しないこと):
 *  - `set` は既存キーを末尾 (最近使用) へ移動し、上限超過で最古 (先頭) を evict する。
 *  - `get` / `has` は **LRU 順を変えない** (参照 = touch ではない。touch したい caller が
 *    set し直す)。TTL は本 map の責務外 (BoundedMonotonicTimestampChecker が値側 touchedAt
 *    で実装する)。
 */
export class BoundedLruMap<K, V> {
  private readonly map = new Map<K, V>();
  private readonly maxEntries: number;

  constructor(maxEntries: number) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new Error("maxEntries must be a positive integer");
    }
    this.maxEntries = maxEntries;
  }

  /** 参照 (LRU 順は不変)。 */
  get(key: K): V | undefined {
    return this.map.get(key);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  /** LRU set: 既存キーは末尾 (最近使用) へ移動し、上限超過で最古 (先頭) を evict する。 */
  set(key: K, value: V): this {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    return this;
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }
}
