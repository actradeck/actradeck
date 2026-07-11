/**
 * Migration: events に `seq` (bigint) 列を追加する — client 申告の per-session 連続カウンタで、
 * 中間 silent-drop の**下限検知**の入力 (ADR 019f4cdb Phase2・eval R2 項目5後半・decision 019f502c)。
 *
 * 背景 (欠落検知の入力):
 * - external adapter は at-most-once / silent-drop ゆえ「adapter は送ったが store に無い」中間イベントを
 *   検知する手段が無い。adapter が同一 session_id 内で 0 起点・1 増分の連続 seq を全 emit に載せると、
 *   AuditStore.providerCoverage が保存済み seq 集合の穴から欠落を下限で数えられる
 *   (`(max−min+1)−distinct(seq)`・密性抑制込み・event-model evaluateSeqMissing の鏡写し SQL)。
 *
 * 型 (bigint nullable・NormalizedEvent.seq = z.number().int().nonnegative().optional() と整合):
 * - seq は non-negative integer だが将来の大きな連番に備え **bigint** で保存する (JS number は 2^53-1
 *   まで安全・schema が safe-integer を強制)。**nullable・default なし**。
 * - 旧行 / seq を送らない adapter は **NULL** のまま (集約 SQL は `seq IS NOT NULL` で除外＝検知対象外)。
 * - **CHECK 制約 (SEC-2≡TDA-2)**: `seq IS NULL OR seq >= 0`。schema (event-model) の非負性を DB でも
 *   保証し、直接書込/破損での負値混入を構造遮断する (audit-store の「鏡写し」SQL が非負域上で成立する
 *   前提を DB 側でも固定)。NULL は許容 (検知対象外)。
 *
 * 索引 (TDA-1・partial index):
 * - `events (provider, session_id, seq) WHERE seq IS NOT NULL`。providerCoverage の seqagg CTE は
 *   `WHERE seq IS NOT NULL GROUP BY provider, session_id` で per-session の max/min/count(DISTINCT) を
 *   取るため、この partial covering index を planner が自動採用し full seq-scan を避ける (クエリ無改変・
 *   EXPLAIN 実測で採用を確認)。partial ゆえ seq=NULL の hot な append 行 (大多数) を索引に載せず書込増幅を
 *   最小化する (seq を送る adapter の行のみが索引対象)。
 *
 * 安全性 (database.md マイグレーション安全・append-only):
 * - 列「追加」+ CHECK + partial index のみ (削除・型変更なし) で前方/後方互換。**backfill 不要**
 *   (旧行 NULL は検知から除外・CHECK は NULL 許容ゆえ既存行に違反なし)。
 * - up = addColumn → addConstraint(CHECK) → createIndex。down = dropIndex → dropConstraint → dropColumn
 *   (ロールバック可能・冪等)。events は append-only の監査証跡ゆえ既存行を UPDATE しない。
 *
 * ⚠️ 大規模既存 events テーブルでの運用注意 (コード変更不要・fresh deploy は無影響):
 * - 本 migration は **ADD CONSTRAINT CHECK (full-table validate) + 非 CONCURRENT な CREATE INDEX** を
 *   行う。空/小規模テーブル (fresh deploy・CI・本 slice の対象) では一瞬だが、**既に数百万行が積まれた
 *   events テーブル**では CHECK の全行検証と index build が **ACCESS EXCLUSIVE ロックで書込 (ingest) を
 *   ブロック**しうる。
 * - そのような大規模稼働環境で後追い適用する場合は、メンテ窓を取るか、手動で
 *   `ADD CONSTRAINT ... NOT VALID` → 別 tx で `VALIDATE CONSTRAINT` / `CREATE INDEX CONCURRENTLY`
 *   相当へ分割すること (node-pg-migrate の単一 tx ラップ外で運用手順として実施)。
 * - ActraDeck の現行デプロイは fresh migrate 前提ゆえ既定経路では無影響。
 *
 * T1 整合: packages/event-model の NormalizedEvent.seq が正典形。backend ingest-store が INSERT に載せ、
 *   audit-store.providerCoverage が provider 別 seq 集約 (per-session の欠落下限を総和・密性抑制) を導く。
 */
import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

const SEQ_INDEX = "events_provider_session_seq_partial";
const SEQ_CHECK = "events_seq_nonneg";

export async function up(pgm: MigrationBuilder): Promise<void> {
  // nullable・default なし。旧行 / seq 非送出 adapter は NULL (= 検知対象外)。
  pgm.addColumn("events", {
    seq: {
      type: "bigint",
      notNull: false,
    },
  });
  // SEC-2≡TDA-2: 非負性を DB でも保証 (schema の nonnegative を CHECK で二重化)。NULL 許容。
  pgm.addConstraint("events", SEQ_CHECK, {
    check: "seq IS NULL OR seq >= 0",
  });
  // TDA-1: seqagg CTE (WHERE seq IS NOT NULL GROUP BY provider, session_id) 用の partial covering index。
  pgm.createIndex("events", ["provider", "session_id", "seq"], {
    name: SEQ_INDEX,
    where: "seq IS NOT NULL",
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // 依存順に破棄 (index → constraint → column)。dropColumn は cascade するが明示的に落とす。
  pgm.dropIndex("events", ["provider", "session_id", "seq"], { name: SEQ_INDEX });
  pgm.dropConstraint("events", SEQ_CHECK);
  pgm.dropColumn("events", "seq");
}
