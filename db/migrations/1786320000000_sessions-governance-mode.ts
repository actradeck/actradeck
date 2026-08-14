/**
 * sessions にガバナンス保証水準を追加する。
 *
 * event-model の GovernanceMode が closed enum の正典。DB は既存方針どおり TEXT + NULL で
 * 前方互換を保ち、read/集計時に `enforcement` の明示値だけを Protected として扱う。
 * NULL は「旧イベントまたは保証不明」であり、managed 等から推測して埋めない。
 */
import type { ColumnDefinitions, MigrationBuilder } from "node-pg-migrate";

export const shorthands: ColumnDefinitions | undefined = undefined;

export async function up(pgm: MigrationBuilder): Promise<void> {
  // 意図的に index 無し (audit finding TDA-14): 3 値 + NULL の低カーディナリティ列で、唯一の
  // 読み手 (UsageStore) は started_at 範囲限定スキャン内のフィルタとして読む。兄弟の投影列
  // (capture_mode / permission_mode) と同様、書込み増幅だけが残るため張らない。
  pgm.addColumn("sessions", {
    governance_mode: {
      type: "text",
      notNull: false,
    },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn("sessions", "governance_mode");
}
